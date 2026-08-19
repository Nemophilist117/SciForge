import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// @ts-expect-error The vendored dynamic Ed25519 fixture is intentionally plain ESM.
import { createDeviceFixture } from '../../../test-fixtures/collaboration/unified-identity/device-fixture.mjs'
import { AuthenticationService, type UserActor } from './auth.js'
import { CollaborationServiceError } from './errors.js'
import { IdentityService } from './identity-service.js'
import {
  COLLABORATION_SCHEMA_VERSION,
  isCollaborationDatabaseReady,
  runCollaborationMigrations
} from './migrations.js'
import type { StoredAgent } from './model.js'
import type { VerifiedOidcIdentity } from './oidc.js'
import {
  createPostgresPool,
  PostgresCollaborationRepository,
  type SqlPool
} from './postgres.js'
import { CollaborationService } from './service.js'

const INTEGRATION_ENABLED = process.env.SCIFORGE_POSTGRES_V5_INTEGRATION === '1'
const describePostgresV5 = INTEGRATION_ENABLED ? describe : describe.skip
const NOW = new Date('2026-08-18T12:00:00.000Z')
const now = () => new Date(NOW)
const nowEpochSeconds = Math.floor(NOW.getTime() / 1_000)

type MigrationEvidence = Readonly<{
  postgresVersion: string
  postgresVersionNumber: string
  versionsAtV1: number[]
  versionsAtCurrent: number[]
  readyAtV1: boolean
  readyAtCurrent: boolean
  legacyAgentStatus: string
  legacyAgentDeviceId: unknown
  legacyCredentialRevoked: boolean
}>

describePostgresV5('real PostgreSQL v1 -> current-schema unified identity integration', () => {
  let adminPool: SqlPool | undefined
  let databasePool: SqlPool | undefined
  let repository: PostgresCollaborationRepository | undefined
  let identities: IdentityService | undefined
  let collaboration: CollaborationService | undefined
  let authentication: AuthenticationService | undefined
  let databaseName: string | undefined
  let databaseCreated = false
  let migrationEvidence: MigrationEvidence | undefined

  beforeAll(async () => {
    const adminConnectionString = integrationAdminConnectionString()
    databaseName = temporaryDatabaseName()
    adminPool = createPostgresPool({
      connectionString: adminConnectionString,
      maxConnections: 1,
      statementTimeoutMs: 120_000
    })
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseIdentifier(databaseName)}`)
    databaseCreated = true

    const databaseUrl = new URL(adminConnectionString)
    databaseUrl.pathname = `/${databaseName}`
    databasePool = createPostgresPool({
      connectionString: databaseUrl.toString(),
      maxConnections: 32,
      statementTimeoutMs: 120_000
    })
    repository = new PostgresCollaborationRepository(databasePool)

    const version = await databasePool.query<{ server_version: unknown }>('SHOW server_version')
    const versionNumber = await databasePool.query<{ server_version_num: unknown }>('SHOW server_version_num')
    const migrationV1 = await readFile(
      new URL('../migrations/0001_collaboration_schema.sql', import.meta.url),
      'utf8'
    )
    await databasePool.query(migrationV1)
    await seedLegacyV1Agent(databasePool)
    const versionsAtV1 = await migrationVersions(databasePool)
    const readyAtV1 = await isCollaborationDatabaseReady(databasePool)

    await runCollaborationMigrations(databasePool)
    const versionsAtCurrent = await migrationVersions(databasePool)
    const readyAtCurrent = await isCollaborationDatabaseReady(databasePool)
    const legacyAgent = await databasePool.query<{
      status: unknown
      device_id: unknown
      credential_revoked: unknown
    }>(
      `SELECT agent.status, agent.device_id,
              credential.revoked_at IS NOT NULL AS credential_revoked
       FROM sciforge_collaboration.agent_nodes AS agent
       JOIN sciforge_collaboration.credentials AS credential
         ON credential.subject_agent_id=agent.agent_id
       WHERE agent.agent_id=$1`,
      ['agt_pg_legacy_agent_0001']
    )
    const legacy = legacyAgent.rows[0]
    if (!legacy) throw new Error('Migration did not preserve the legacy Agent fixture.')
    migrationEvidence = {
      postgresVersion: String(version.rows[0]?.server_version),
      postgresVersionNumber: String(versionNumber.rows[0]?.server_version_num),
      versionsAtV1,
      versionsAtCurrent,
      readyAtV1,
      readyAtCurrent,
      legacyAgentStatus: String(legacy.status),
      legacyAgentDeviceId: legacy.device_id,
      legacyCredentialRevoked: legacy.credential_revoked === true
    }

    identities = new IdentityService({ repository, now })
    collaboration = new CollaborationService({ repository, now })
    authentication = new AuthenticationService(repository, now)
    process.stdout.write(
      `[postgres-v5-integration] node=${process.version} postgres=${migrationEvidence.postgresVersion} ` +
      `postgresVersionNumber=${migrationEvidence.postgresVersionNumber} migrations=${versionsAtCurrent.join(',')} ready=${String(readyAtCurrent)}\n`
    )
  }, 120_000)

  afterAll(async () => {
    try {
      if (repository) await repository.close()
      else if (databasePool) await databasePool.end()
    } finally {
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
      } finally {
        if (adminPool) await adminPool.end()
      }
    }
  }, 120_000)

  it('migrates an isolated v1 database to exact schema v6 readiness and revokes unmapped legacy Agents', async () => {
    expect(COLLABORATION_SCHEMA_VERSION).toBe(6)
    expect(migrationEvidence).toMatchObject({
      versionsAtV1: [1],
      versionsAtCurrent: [1, 2, 3, 4, 5, 6],
      readyAtV1: false,
      readyAtCurrent: true,
      legacyAgentStatus: 'revoked',
      legacyAgentDeviceId: null,
      legacyCredentialRevoked: true
    })
    expect(await isCollaborationDatabaseReady(required(databasePool, 'database pool'))).toBe(true)
  })

  it('serializes concurrent first use of one issuer/subject into one User and one audit fact', async () => {
    const service = required(identities, 'Identity Service')
    const verified = verifiedIdentity('postgres-concurrent-subject', { email: 'concurrent@example.invalid' })
    const actors = await Promise.all(Array.from({ length: 24 }, () => service.resolveOidcUser(verified)))
    expect(new Set(actors.map((actor) => actor.userId))).toHaveLength(1)
    expect(new Set(actors.map((actor) => actor.identityId))).toHaveLength(1)

    const counts = await required(databasePool, 'database pool').query<{
      identity_count: unknown
      user_count: unknown
      audit_count: unknown
    }>(
      `SELECT
         (SELECT count(*) FROM sciforge_collaboration.oidc_identities
          WHERE issuer=$1 AND subject=$2) AS identity_count,
         (SELECT count(DISTINCT user_id) FROM sciforge_collaboration.oidc_identities
          WHERE issuer=$1 AND subject=$2) AS user_count,
         (SELECT count(*) FROM sciforge_collaboration.audit_events
          WHERE action='oidc.user.jit' AND actor_user_id=$3) AS audit_count`,
      [verified.issuer, verified.subject, actors[0]?.userId]
    )
    expect(counts.rows[0]).toMatchObject({ identity_count: '1', user_count: '1', audit_count: '1' })
  }, 60_000)

  it('enforces enrollment single consumption, installation ownership, Device cascade, and Agent linkage', async () => {
    const identityService = required(identities, 'Identity Service')
    const collaborationService = required(collaboration, 'Collaboration Service')
    const authenticationService = required(authentication, 'Authentication Service')
    const postgresRepository = required(repository, 'PostgreSQL repository')
    const owner = await identityService.resolveOidcUser(verifiedIdentity('postgres-device-owner'))
    const other = await identityService.resolveOidcUser(verifiedIdentity('postgres-device-other'))
    const installationId = 'ins_pg_identity_device_0001'
    const enrollment = await identityService.createDeviceEnrollment(owner, {
      installationId,
      idempotencyKey: 'idem_pg_device_enrollment_0001'
    })
    const fixture = createDeviceFixture({
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      userId: owner.userId,
      installationId,
      expiresAt: enrollment.expiresAt,
      capabilitySummary: ['local-files']
    })
    const createInput = {
      ...fixture.deviceRequest,
      nonce: enrollment.nonce
    }
    const outcomes = await Promise.allSettled([
      identityService.createDevice(owner, {
        ...createInput,
        idempotencyKey: 'idem_pg_device_create_race_0001'
      }),
      identityService.createDevice(owner, {
        ...createInput,
        idempotencyKey: 'idem_pg_device_create_race_0002'
      })
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    if (!rejected) throw new Error('Expected exactly one Device creation to be rejected.')
    expect(serviceErrorCode(rejected.reason)).toBe('invalid_state_transition')
    const fulfilled = outcomes.find((outcome) => outcome.status === 'fulfilled')
    if (!fulfilled) throw new Error('Expected exactly one Device creation to succeed.')
    const created = fulfilled.value

    const storedEnrollment = await postgresRepository.getDeviceEnrollment(enrollment.enrollmentId)
    expect(storedEnrollment).toMatchObject({ status: 'consumed', revision: 2 })
    expect((await postgresRepository.listDevicesForUser(owner.userId))).toHaveLength(1)

    const conflictingEnrollment = await identityService.createDeviceEnrollment(other, {
      installationId,
      idempotencyKey: 'idem_pg_device_enrollment_other_0001'
    })
    const conflictingFixture = createDeviceFixture({
      enrollmentId: conflictingEnrollment.enrollmentId,
      nonce: conflictingEnrollment.nonce,
      userId: other.userId,
      installationId,
      expiresAt: conflictingEnrollment.expiresAt
    })
    await expectServiceCode(() => identityService.createDevice(other, {
      ...conflictingFixture.deviceRequest,
      nonce: conflictingEnrollment.nonce,
      idempotencyKey: 'idem_pg_device_create_other_0001'
    }), 'ownership_conflict')

    await expectServiceCode(() => collaborationService.registerAgent(other, {
      deviceId: created.device.deviceId,
      displayName: 'Cross-owner Agent',
      nodeType: 'desktop',
      capabilities: ['runtime-exec'],
      idempotencyKey: 'idem_pg_agent_cross_owner_0001'
    }), 'permission_denied')
    const registered = await collaborationService.registerAgent(owner, {
      deviceId: created.device.deviceId,
      displayName: 'PostgreSQL Runtime Agent',
      nodeType: 'desktop',
      capabilities: ['runtime-exec'],
      idempotencyKey: 'idem_pg_agent_register_0001'
    })
    expect(registered.agent.deviceId).toBe(created.device.deviceId)
    expect(registered.deviceCredential).toEqual(expect.any(String))

    const constraintAgentBase = storedAgentFixture(other, NOW.toISOString())
    await expectServiceCode(() => postgresRepository.transaction((tx) => tx.insertAgent({
      ...constraintAgentBase,
      agentId: 'agt_pg_active_without_device_0001'
    })), 'validation_failed')
    await expectServiceCode(() => postgresRepository.transaction((tx) => tx.insertAgent({
      ...constraintAgentBase,
      agentId: 'agt_pg_cross_owner_device_0001',
      deviceId: created.device.deviceId
    })), 'ownership_conflict')
    await expect(postgresRepository.transaction((tx) => tx.insertAgent({
      ...constraintAgentBase,
      agentId: 'agt_pg_revoked_without_device_0001',
      status: 'revoked',
      connectionStatus: 'offline',
      revokedAt: NOW.toISOString()
    }))).resolves.toBeUndefined()

    const credential = registered.deviceCredential
    if (!credential) throw new Error('Expected a one-time Agent credential.')
    await expect(authenticationService.resolveBearer(credential)).resolves.toMatchObject({
      kind: 'agent_device',
      deviceId: created.device.deviceId,
      agentId: registered.agent.agentId
    })
    await identityService.revokeDevice(owner, created.device.deviceId, 'idem_pg_device_revoke_0001')
    await expectServiceCode(() => authenticationService.resolveBearer(credential), 'credential_revoked')
    const credentialState = await required(databasePool, 'database pool').query<{ revoked: unknown }>(
      `SELECT revoked_at IS NOT NULL AS revoked
       FROM sciforge_collaboration.credentials
       WHERE subject_agent_id=$1 AND kind='agent_device'`,
      [registered.agent.agentId]
    )
    expect(credentialState.rows).toEqual([{ revoked: true }])
  }, 60_000)

  it('enforces both ACTIVE Zulip uniqueness dimensions and creates new history on rebind', async () => {
    const identityService = required(identities, 'Identity Service')
    const owner = await identityService.resolveOidcUser(verifiedIdentity('postgres-binding-owner'))
    const contender = await identityService.resolveOidcUser(verifiedIdentity('postgres-binding-contender'))
    const serviceActor = { kind: 'service' as const, clientId: 'postgres-v5-integration' }
    const realmUrl = 'https://zulip-pg.example.invalid'
    const realmId = 'postgres-zulip-realm-0001'
    const zulipUserId = 'postgres-zulip-user-0001'

    const firstBegin = await identityService.beginZulipBinding(owner, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_owner_0001'
    })
    const first = await identityService.confirmZulipBinding(serviceActor, {
      bindingCode: firstBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId,
      providerEventId: 'postgres-provider-event-owner-0001',
      idempotencyKey: 'idem_pg_binding_confirm_owner_0001'
    })

    const contenderBegin = await identityService.beginZulipBinding(contender, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_contender_0001'
    })
    await expectServiceCode(() => identityService.confirmZulipBinding(serviceActor, {
      bindingCode: contenderBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId,
      providerEventId: 'postgres-provider-event-contender-0001',
      idempotencyKey: 'idem_pg_binding_confirm_contender_0001'
    }), 'IDENTITY_ALREADY_BOUND')

    const secondIdentityBegin = await identityService.beginZulipBinding(owner, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_second_0001'
    })
    await expectServiceCode(() => identityService.confirmZulipBinding(serviceActor, {
      bindingCode: secondIdentityBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId: 'postgres-zulip-user-0002',
      providerEventId: 'postgres-provider-event-second-0001',
      idempotencyKey: 'idem_pg_binding_confirm_second_0001'
    }), 'identity_conflict')

    await identityService.revokeExternalIdentity(
      owner,
      first.identity.externalIdentityId,
      'idem_pg_binding_revoke_owner_0001'
    )
    const rebindBegin = await identityService.beginZulipBinding(owner, {
      realmUrl,
      idempotencyKey: 'idem_pg_binding_begin_rebind_0001'
    })
    const rebound = await identityService.confirmZulipBinding(serviceActor, {
      // Revocation invalidates every older pending code, so rebind starts a fresh request.
      bindingCode: rebindBegin.bindingCode,
      realmUrl,
      realmId,
      zulipUserId,
      providerEventId: 'postgres-provider-event-rebind-0001',
      idempotencyKey: 'idem_pg_binding_confirm_rebind_0001'
    })
    expect(rebound.identity.externalIdentityId).not.toBe(first.identity.externalIdentityId)

    const identitiesForOwner = (await identityService.listExternalIdentities(owner)).identities
      .filter((identity) => identity.realmId === realmId)
    expect(identitiesForOwner).toHaveLength(2)
    expect(identitiesForOwner.map((identity) => identity.status).sort()).toEqual(['active', 'revoked'])
    expect(identitiesForOwner.filter((identity) => identity.status === 'active')).toMatchObject([{
      externalIdentityId: rebound.identity.externalIdentityId,
      zulipUserId
    }])
  }, 60_000)
})

function integrationAdminConnectionString(): string {
  const value = process.env.SCIFORGE_POSTGRES_V5_ADMIN_URL
  if (!value) {
    throw new Error(
      'SCIFORGE_POSTGRES_V5_ADMIN_URL is required when SCIFORGE_POSTGRES_V5_INTEGRATION=1.'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('SCIFORGE_POSTGRES_V5_ADMIN_URL must be a valid PostgreSQL URL.')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('SCIFORGE_POSTGRES_V5_ADMIN_URL must use postgres:// or postgresql://.')
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('SCIFORGE_POSTGRES_V5_ADMIN_URL must name an explicit administrative database.')
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (!loopback && process.env.SCIFORGE_POSTGRES_V5_ALLOW_REMOTE !== '1') {
    throw new Error(
      'Remote PostgreSQL integration is disabled; use loopback or explicitly set SCIFORGE_POSTGRES_V5_ALLOW_REMOTE=1.'
    )
  }
  return value
}

function temporaryDatabaseName(): string {
  return `sciforge_identity_v5_it_${process.pid}_${randomBytes(6).toString('hex')}`
}

function quotedDatabaseIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error('Unsafe temporary database identifier.')
  return `"${value}"`
}

async function migrationVersions(pool: SqlPool): Promise<number[]> {
  const result = await pool.query<{ version: unknown }>(
    'SELECT version FROM sciforge_collaboration.schema_migrations ORDER BY version'
  )
  return result.rows.map((row) => Number(row.version))
}

async function seedLegacyV1Agent(pool: SqlPool): Promise<void> {
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

function verifiedIdentity(
  subject: string,
  overrides: Partial<VerifiedOidcIdentity> = {}
): VerifiedOidcIdentity {
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

function storedAgentFixture(owner: UserActor, updatedAt: string): StoredAgent {
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

async function expectServiceCode(work: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CollaborationServiceError)
  expect(serviceErrorCode(thrown)).toBe(code)
}

function serviceErrorCode(error: unknown): string | undefined {
  return error instanceof CollaborationServiceError ? error.code : undefined
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing initialized ${label}.`)
  return value
}
