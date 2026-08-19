#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes
} from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'

const RUNTIME_INDEX_URL = 'file:///app/node_modules/@sciforge/collaboration-server/dist/index.js'
const PG_INDEX_URL = 'file:///app/node_modules/pg/esm/index.mjs'
const MIGRATION_V1_URL = new URL(
  'file:///app/node_modules/@sciforge/collaboration-server/migrations/0001_collaboration_schema.sql'
)
const PASSWORD_FILE_ENV = 'SCIFORGE_POSTGRES_V5_ADMIN_PASSWORD_FILE'
const SNAPSHOT_PASSWORD_FILE_ENV = 'SCIFORGE_POSTGRES_V5_SNAPSHOT_PASSWORD_FILE'
const EXPECTED_COMMIT_ENV = 'SCIFORGE_COLLAB_CONTRACT_COMMIT'
const NOW = new Date()
const now = () => new Date(NOW)
const nowEpochSeconds = Math.floor(NOW.getTime() / 1_000)

const snapshotMode = process.argv.length === 3 && process.argv[2] === '--production-snapshot'
const supportedInvocation = process.argv.length === 2 || snapshotMode
let stage = snapshotMode ? 'production_snapshot' : 'runtime_import'

const outcome = supportedInvocation
  ? await (snapshotMode ? runProductionSnapshot() : run()).catch((error) => ({
      ok: false,
      failureCode: safeFailureCode(error)
    }))
  : { ok: false, failureCode: 'invalid_arguments' }

if (!outcome.ok) {
  process.stderr.write(`${JSON.stringify({
    event: 'postgres.v5.integration',
    status: 'failed',
    stage,
    failureCode: outcome.failureCode
  })}\n`)
  process.exitCode = 1
} else if (snapshotMode) {
  process.stdout.write(`${JSON.stringify(outcome.snapshot)}\n`)
} else {
  process.stdout.write(`${JSON.stringify({
    event: 'postgres.v5.integration',
    status: 'passed',
    node: process.version,
    postgresVersion: outcome.postgresVersion,
    postgresVersionNumber: outcome.postgresVersionNumber,
    migrations: outcome.migrations,
    checks: outcome.checks
  })}\n`)
}

async function runProductionSnapshot() {
  await assertRuntimeRevision()
  const pg = await import(PG_INDEX_URL)
  assert.ok(pg.Client)
  const connectionString = await databaseUrlFromPasswordFile({
    envName: SNAPSHOT_PASSWORD_FILE_ENV,
    expectedPath: '/run/secrets/postgres-v5-snapshot-password',
    username: 'sciforge_collab',
    database: 'sciforge_collaboration'
  })
  const client = new pg.Client({ connectionString, statement_timeout: 120_000 })
  let transactionStarted = false
  try {
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionStarted = true
    const versions = await client.query(
      'SELECT version FROM sciforge_collaboration.schema_migrations ORDER BY version'
    )
    const tableRows = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='sciforge_collaboration' AND table_type='BASE TABLE'
       ORDER BY table_name`
    )
    const tables = []
    for (const [index, record] of tableRows.rows.entries()) {
      const table = String(record.table_name)
      assert.match(table, /^[a-z][a-z0-9_]*$/u)
      const digest = createHash('sha256')
      const count = await streamTableDigest({ client, table, digest, cursorIndex: index })
      tables.push({ table, count, digest: digest.digest('hex') })
    }
    await client.query('COMMIT')
    transactionStarted = false
    return {
      ok: true,
      snapshot: {
        schemaVersions: versions.rows.map((row) => String(row.version)),
        tables
      }
    }
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function streamTableDigest({ client, table, digest, cursorIndex }) {
  const cursor = `snapshot_${cursorIndex}`
  assert.match(cursor, /^snapshot_[0-9]+$/u)
  await client.query(
    `DECLARE "${cursor}" NO SCROLL CURSOR FOR
     SELECT to_jsonb(row_value)::text AS value
     FROM sciforge_collaboration."${table}" AS row_value
     ORDER BY to_jsonb(row_value)::text`
  )
  let count = 0
  try {
    while (true) {
      const batch = await client.query(`FETCH FORWARD 512 FROM "${cursor}"`)
      for (const row of batch.rows) {
        const value = String(row.value)
        digest.update(`${Buffer.byteLength(value, 'utf8')}:`, 'utf8')
        digest.update(value, 'utf8')
        digest.update('\n', 'utf8')
        count += 1
      }
      if (batch.rows.length < 512) break
    }
  } finally {
    await client.query(`CLOSE "${cursor}"`).catch(() => undefined)
  }
  return count
}

async function run() {
  let runtime
  let adminPool
  let databasePool
  let repository
  let databaseName
  let databaseCreated = false
  let primaryFailure
  let evidence

  try {
    runtime = await import(RUNTIME_INDEX_URL)
    assertRuntimeExports(runtime)

    stage = 'runtime_revision'
    await assertRuntimeRevision()

    stage = 'admin_secret'
    const adminConnectionString = await databaseUrlFromPasswordFile({
      envName: PASSWORD_FILE_ENV,
      expectedPath: '/run/secrets/postgres-v5-admin-password',
      username: 'sciforge_admin',
      database: 'postgres'
    })
    databaseName = temporaryDatabaseName()
    adminPool = runtime.createPostgresPool({
      connectionString: adminConnectionString,
      maxConnections: 1,
      statementTimeoutMs: 120_000
    })

    stage = 'temporary_database_create'
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseIdentifier(databaseName)}`)
    databaseCreated = true

    const databaseUrl = new URL(adminConnectionString)
    databaseUrl.pathname = `/${databaseName}`
    databasePool = runtime.createPostgresPool({
      connectionString: databaseUrl.toString(),
      maxConnections: 32,
      statementTimeoutMs: 120_000
    })
    databaseUrl.password = ''
    repository = new runtime.PostgresCollaborationRepository(databasePool)

    stage = 'migration_v1_install'
    const version = await databasePool.query('SHOW server_version')
    const versionNumber = await databasePool.query('SHOW server_version_num')
    const migrationV1 = await readFile(MIGRATION_V1_URL, 'utf8')
    await databasePool.query(migrationV1)
    await seedLegacyV1Agent(databasePool)
    const versionsAtV1 = await migrationVersions(databasePool)
    const readyAtV1 = await runtime.isCollaborationDatabaseReady(databasePool)

    stage = 'migration_v1_to_current'
    await runtime.runCollaborationMigrations(databasePool)
    const versionsAtCurrent = await migrationVersions(databasePool)
    const readyAtCurrent = await runtime.isCollaborationDatabaseReady(databasePool)
    const legacyAgent = await databasePool.query(
      `SELECT agent.status, agent.device_id,
              credential.revoked_at IS NOT NULL AS credential_revoked
       FROM sciforge_collaboration.agent_nodes AS agent
       JOIN sciforge_collaboration.credentials AS credential
         ON credential.subject_agent_id=agent.agent_id
       WHERE agent.agent_id=$1`,
      ['agt_pg_legacy_agent_0001']
    )
    const legacy = legacyAgent.rows[0]
    assert.ok(legacy)
    assert.equal(runtime.COLLABORATION_SCHEMA_VERSION, 6)
    assert.deepEqual(versionsAtV1, [1])
    assert.deepEqual(versionsAtCurrent, [1, 2, 3, 4, 5, 6])
    assert.equal(readyAtV1, false)
    assert.equal(readyAtCurrent, true)
    assert.equal(legacy.status, 'revoked')
    assert.equal(legacy.device_id, null)
    assert.equal(legacy.credential_revoked, true)

    const identities = new runtime.IdentityService({ repository, now })
    const collaboration = new runtime.CollaborationService({ repository, now })
    const authentication = new runtime.AuthenticationService(repository, now)

    stage = 'oidc_concurrency'
    await verifyConcurrentOidcJit({ identities, databasePool })

    stage = 'device_agent_lifecycle'
    await verifyDeviceAndAgentLifecycle({
      identities,
      collaboration,
      authentication,
      repository,
      databasePool,
      runtime
    })

    stage = 'zulip_binding_uniqueness'
    await verifyZulipBindingUniqueness({ identities, runtime })

    evidence = {
      postgresVersion: String(version.rows[0]?.server_version),
      postgresVersionNumber: String(versionNumber.rows[0]?.server_version_num),
      migrations: versionsAtCurrent,
      checks: [
        'v1_to_current_readiness',
        'legacy_agent_revocation',
        'concurrent_oidc_jit',
        'device_agent_lifecycle',
        'zulip_binding_uniqueness'
      ]
    }
  } catch (error) {
    primaryFailure = error
  } finally {
    stage = primaryFailure ? stage : 'temporary_database_cleanup'
    let cleanupFailure
    try {
      if (repository) await repository.close()
      else if (databasePool) await databasePool.end()
    } catch (error) {
      cleanupFailure = error
    }
    try {
      if (adminPool && databaseCreated && databaseName) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_catalog.pg_stat_activity
           WHERE datname=$1 AND pid<>pg_backend_pid()`,
          [databaseName]
        )
        await adminPool.query(`DROP DATABASE ${quotedDatabaseIdentifier(databaseName)}`)
        databaseCreated = false
      }
    } catch (error) {
      cleanupFailure ??= error
    }
    try {
      if (adminPool) await adminPool.end()
    } catch (error) {
      cleanupFailure ??= error
    }
    if (cleanupFailure) {
      stage = 'temporary_database_cleanup'
      primaryFailure ??= cleanupFailure
    }
  }

  if (primaryFailure) throw primaryFailure
  assert.ok(evidence)
  return { ok: true, ...evidence }
}

function assertRuntimeExports(runtime) {
  for (const exportName of [
    'AuthenticationService',
    'CollaborationService',
    'CollaborationServiceError',
    'IdentityService',
    'PostgresCollaborationRepository',
    'canonicalEnrollmentBytes',
    'createPostgresPool',
    'isCollaborationDatabaseReady',
    'runCollaborationMigrations'
  ]) {
    assert.ok(runtime[exportName], `missing runtime export: ${exportName}`)
  }
}

async function assertRuntimeRevision() {
  const expectedCommit = process.env[EXPECTED_COMMIT_ENV]
  assert.match(expectedCommit ?? '', /^[0-9a-f]{40}$/u)
  const installedCommit = (await readFile('/app/CONTRACT_COMMIT', 'utf8')).replace(/[\r\n]/gu, '')
  assert.equal(installedCommit, expectedCommit)
}

async function databaseUrlFromPasswordFile({ envName, expectedPath, username, database }) {
  const passwordPath = process.env[envName]
  assert.equal(passwordPath, expectedPath)
  const metadata = await lstat(passwordPath)
  assert.ok(metadata.isFile())
  assert.equal(metadata.isSymbolicLink(), false)
  assert.equal(metadata.uid, 0)
  assert.equal(metadata.gid, 10001)
  assert.equal(metadata.mode & 0o777, 0o440)
  assert.equal(metadata.size, 64)

  const secretBuffer = await readFile(passwordPath)
  try {
    const password = secretBuffer.toString('ascii')
    assert.match(password, /^[0-9A-Fa-f]{64}$/u)
    const url = new URL(`postgresql://postgres:5432/${database}`)
    url.username = username
    url.password = password
    return url.toString()
  } finally {
    secretBuffer.fill(0)
  }
}

async function verifyConcurrentOidcJit({ identities, databasePool }) {
  const verified = verifiedIdentity('postgres-concurrent-subject', {
    email: 'concurrent@example.invalid'
  })
  const actors = await Promise.all(
    Array.from({ length: 24 }, () => identities.resolveOidcUser(verified))
  )
  assert.equal(new Set(actors.map((actor) => actor.userId)).size, 1)
  assert.equal(new Set(actors.map((actor) => actor.identityId)).size, 1)

  const counts = await databasePool.query(
    `SELECT
       (SELECT count(*) FROM sciforge_collaboration.oidc_identities
        WHERE issuer=$1 AND subject=$2) AS identity_count,
       (SELECT count(DISTINCT user_id) FROM sciforge_collaboration.oidc_identities
        WHERE issuer=$1 AND subject=$2) AS user_count,
       (SELECT count(*) FROM sciforge_collaboration.audit_events
        WHERE action='oidc.user.jit' AND actor_user_id=$3) AS audit_count`,
    [verified.issuer, verified.subject, actors[0]?.userId]
  )
  assert.deepEqual(counts.rows[0], {
    identity_count: '1',
    user_count: '1',
    audit_count: '1'
  })
}

async function verifyDeviceAndAgentLifecycle({
  identities,
  collaboration,
  authentication,
  repository,
  databasePool,
  runtime
}) {
  const owner = await identities.resolveOidcUser(verifiedIdentity('postgres-device-owner'))
  const other = await identities.resolveOidcUser(verifiedIdentity('postgres-device-other'))
  const installationId = 'ins_pg_identity_device_0001'
  const enrollment = await identities.createDeviceEnrollment(owner, {
    installationId,
    idempotencyKey: 'idem_pg_device_enrollment_0001'
  })
  const fixture = createDeviceFixture(runtime.canonicalEnrollmentBytes, {
    enrollmentId: enrollment.enrollmentId,
    nonce: enrollment.nonce,
    userId: owner.userId,
    installationId,
    expiresAt: enrollment.expiresAt,
    capabilitySummary: ['local-files']
  })
  const createInput = { ...fixture.deviceRequest, nonce: enrollment.nonce }
  const outcomes = await Promise.allSettled([
    identities.createDevice(owner, {
      ...createInput,
      idempotencyKey: 'idem_pg_device_create_race_0001'
    }),
    identities.createDevice(owner, {
      ...createInput,
      idempotencyKey: 'idem_pg_device_create_race_0002'
    })
  ])
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(serviceErrorCode(rejected[0].reason, runtime), 'invalid_state_transition')
  const created = fulfilled[0].value

  const storedEnrollment = await repository.getDeviceEnrollment(enrollment.enrollmentId)
  assert.equal(storedEnrollment?.status, 'consumed')
  assert.equal(storedEnrollment?.revision, 2)
  assert.equal((await repository.listDevicesForUser(owner.userId)).length, 1)

  const conflictingEnrollment = await identities.createDeviceEnrollment(other, {
    installationId,
    idempotencyKey: 'idem_pg_device_enrollment_other_0001'
  })
  const conflictingFixture = createDeviceFixture(runtime.canonicalEnrollmentBytes, {
    enrollmentId: conflictingEnrollment.enrollmentId,
    nonce: conflictingEnrollment.nonce,
    userId: other.userId,
    installationId,
    expiresAt: conflictingEnrollment.expiresAt
  })
  await expectServiceCode(runtime, () => identities.createDevice(other, {
    ...conflictingFixture.deviceRequest,
    nonce: conflictingEnrollment.nonce,
    idempotencyKey: 'idem_pg_device_create_other_0001'
  }), 'ownership_conflict')

  await expectServiceCode(runtime, () => collaboration.registerAgent(other, {
    deviceId: created.device.deviceId,
    displayName: 'Cross-owner Agent',
    nodeType: 'desktop',
    capabilities: ['runtime-exec'],
    idempotencyKey: 'idem_pg_agent_cross_owner_0001'
  }), 'permission_denied')
  const registered = await collaboration.registerAgent(owner, {
    deviceId: created.device.deviceId,
    displayName: 'PostgreSQL Runtime Agent',
    nodeType: 'desktop',
    capabilities: ['runtime-exec'],
    idempotencyKey: 'idem_pg_agent_register_0001'
  })
  assert.equal(registered.agent.deviceId, created.device.deviceId)
  assert.equal(typeof registered.deviceCredential, 'string')

  const constraintAgentBase = storedAgentFixture(other, NOW.toISOString())
  await expectServiceCode(runtime, () => repository.transaction((tx) => tx.insertAgent({
    ...constraintAgentBase,
    agentId: 'agt_pg_active_without_device_0001'
  })), 'validation_failed')
  await expectServiceCode(runtime, () => repository.transaction((tx) => tx.insertAgent({
    ...constraintAgentBase,
    agentId: 'agt_pg_cross_owner_device_0001',
    deviceId: created.device.deviceId
  })), 'ownership_conflict')
  await repository.transaction((tx) => tx.insertAgent({
    ...constraintAgentBase,
    agentId: 'agt_pg_revoked_without_device_0001',
    status: 'revoked',
    connectionStatus: 'offline',
    revokedAt: NOW.toISOString()
  }))

  const credential = registered.deviceCredential
  assert.equal(typeof credential, 'string')
  const actor = await authentication.resolveBearer(credential)
  assert.equal(actor.kind, 'agent_device')
  assert.equal(actor.deviceId, created.device.deviceId)
  assert.equal(actor.agentId, registered.agent.agentId)
  await identities.revokeDevice(owner, created.device.deviceId, 'idem_pg_device_revoke_0001')
  await expectServiceCode(runtime, () => authentication.resolveBearer(credential), 'credential_revoked')
  const credentialState = await databasePool.query(
    `SELECT revoked_at IS NOT NULL AS revoked
     FROM sciforge_collaboration.credentials
     WHERE subject_agent_id=$1 AND kind='agent_device'`,
    [registered.agent.agentId]
  )
  assert.deepEqual(credentialState.rows, [{ revoked: true }])
}

async function verifyZulipBindingUniqueness({ identities, runtime }) {
  const owner = await identities.resolveOidcUser(verifiedIdentity('postgres-binding-owner'))
  const contender = await identities.resolveOidcUser(verifiedIdentity('postgres-binding-contender'))
  const serviceActor = { kind: 'service', clientId: 'postgres-v5-integration' }
  const realmUrl = 'https://zulip-pg.example.invalid'
  const realmId = 'postgres-zulip-realm-0001'
  const zulipUserId = 'postgres-zulip-user-0001'

  const firstBegin = await identities.beginZulipBinding(owner, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_owner_0001'
  })
  const first = await identities.confirmZulipBinding(serviceActor, {
    bindingCode: firstBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId,
    providerEventId: 'postgres-provider-event-owner-0001',
    idempotencyKey: 'idem_pg_binding_confirm_owner_0001'
  })

  const contenderBegin = await identities.beginZulipBinding(contender, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_contender_0001'
  })
  await expectServiceCode(runtime, () => identities.confirmZulipBinding(serviceActor, {
    bindingCode: contenderBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId,
    providerEventId: 'postgres-provider-event-contender-0001',
    idempotencyKey: 'idem_pg_binding_confirm_contender_0001'
  }), 'IDENTITY_ALREADY_BOUND')

  const secondIdentityBegin = await identities.beginZulipBinding(owner, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_second_0001'
  })
  await expectServiceCode(runtime, () => identities.confirmZulipBinding(serviceActor, {
    bindingCode: secondIdentityBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId: 'postgres-zulip-user-0002',
    providerEventId: 'postgres-provider-event-second-0001',
    idempotencyKey: 'idem_pg_binding_confirm_second_0001'
  }), 'identity_conflict')

  await identities.revokeExternalIdentity(
    owner,
    first.identity.externalIdentityId,
    'idem_pg_binding_revoke_owner_0001'
  )
  const rebindBegin = await identities.beginZulipBinding(owner, {
    realmUrl,
    idempotencyKey: 'idem_pg_binding_begin_rebind_0001'
  })
  const rebound = await identities.confirmZulipBinding(serviceActor, {
    bindingCode: rebindBegin.bindingCode,
    realmUrl,
    realmId,
    zulipUserId,
    providerEventId: 'postgres-provider-event-rebind-0001',
    idempotencyKey: 'idem_pg_binding_confirm_rebind_0001'
  })
  assert.notEqual(rebound.identity.externalIdentityId, first.identity.externalIdentityId)

  const identitiesForOwner = (await identities.listExternalIdentities(owner)).identities
    .filter((identity) => identity.realmId === realmId)
  assert.equal(identitiesForOwner.length, 2)
  assert.deepEqual(
    identitiesForOwner.map((identity) => identity.status).sort(),
    ['active', 'revoked']
  )
  const active = identitiesForOwner.filter((identity) => identity.status === 'active')
  assert.equal(active.length, 1)
  assert.equal(active[0].externalIdentityId, rebound.identity.externalIdentityId)
  assert.equal(active[0].zulipUserId, zulipUserId)
}

function createDeviceFixture(canonicalEnrollmentBytes, overrides) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicJwk = publicKey.export({ format: 'jwk' })
  assert.equal(publicJwk.kty, 'OKP')
  assert.equal(publicJwk.crv, 'Ed25519')
  assert.equal(typeof publicJwk.x, 'string')
  const enrollment = {
    enrollmentId: overrides.enrollmentId,
    nonce: overrides.nonce,
    userId: overrides.userId,
    installationId: overrides.installationId,
    expiresAt: overrides.expiresAt
  }
  const signature = signBytes(
    null,
    canonicalEnrollmentBytes(enrollment),
    privateKey
  ).toString('base64url')
  return {
    deviceRequest: {
      enrollmentId: enrollment.enrollmentId,
      installationId: enrollment.installationId,
      displayName: 'PostgreSQL Identity Test Desktop',
      platform: {
        os: 'linux',
        arch: 'x64',
        osVersion: 'bookworm',
        appVersion: '0.1.0'
      },
      publicKeyJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicJwk.x,
        alg: 'EdDSA',
        use: 'sig',
        kid: 'postgres-v5-integration-device-key'
      },
      capabilitySummary: overrides.capabilitySummary ?? ['agent-runtime'],
      signature
    }
  }
}

function temporaryDatabaseName() {
  return `sciforge_identity_v5_it_${process.pid}_${randomBytes(6).toString('hex')}`
}

function quotedDatabaseIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/u)
  return `"${value}"`
}

async function migrationVersions(pool) {
  const result = await pool.query(
    'SELECT version FROM sciforge_collaboration.schema_migrations ORDER BY version'
  )
  return result.rows.map((row) => Number(row.version))
}

async function seedLegacyV1Agent(pool) {
  await pool.query(
    `INSERT INTO sciforge_collaboration.user_principals
       (user_id,display_name,status,revision,created_at,updated_at)
     VALUES ($1,$2,'active',1,$3,$3)`,
    ['usr_pg_legacy_user_0001', 'Legacy PostgreSQL User', NOW.toISOString()]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.agent_nodes
       (agent_id,installation_id,owner_user_id,display_name,node_type,capabilities,status,
        connection_status,credential_generation,revision,updated_at)
     VALUES ($1,$2,$3,$4,'desktop','[]'::jsonb,'active','online',1,1,$5)`,
    [
      'agt_pg_legacy_agent_0001',
      'ins_pg_legacy_install_0001',
      'usr_pg_legacy_user_0001',
      'Legacy PostgreSQL Agent',
      NOW.toISOString()
    ]
  )
  await pool.query(
    `INSERT INTO sciforge_collaboration.credentials
       (credential_id,kind,subject_user_id,subject_agent_id,token_digest,assurance,generation,created_at)
     VALUES ($1,'agent_device',$2,$3,$4,'device',1,$5)`,
    [
      'credential_pg_legacy_agent_0001',
      'usr_pg_legacy_user_0001',
      'agt_pg_legacy_agent_0001',
      randomBytes(32),
      NOW.toISOString()
    ]
  )
}

function verifiedIdentity(subject, overrides = {}) {
  return {
    issuer: 'https://login-pg.example.invalid/realms/SciForge',
    subject,
    audience: ['sciforge-cloud-api'],
    authorizedParty: 'sciforge-desktop',
    issuedAt: nowEpochSeconds,
    notBefore: nowEpochSeconds - 1,
    expiresAt: nowEpochSeconds + 300,
    authTime: nowEpochSeconds,
    preferredUsername: subject,
    ...overrides
  }
}

function storedAgentFixture(owner, updatedAt) {
  return {
    agentId: 'agt_pg_constraint_agent_0001',
    ownerUserId: owner.userId,
    displayName: 'PostgreSQL Constraint Agent',
    nodeType: 'desktop',
    capabilities: ['runtime-exec'],
    status: 'active',
    connectionStatus: 'offline',
    credentialGeneration: 1,
    revision: 1,
    updatedAt
  }
}

async function expectServiceCode(runtime, work, code) {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof runtime.CollaborationServiceError)
  assert.equal(thrown.code, code)
}

function serviceErrorCode(error, runtime) {
  return error instanceof runtime.CollaborationServiceError ? error.code : undefined
}

function safeFailureCode(error) {
  if (error && typeof error === 'object') {
    const candidate = Reflect.get(error, 'code')
    if (typeof candidate === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(candidate)) {
      return candidate
    }
    if (Reflect.get(error, 'name') === 'AssertionError') return 'assertion_failed'
  }
  return 'integration_failed'
}
