import { describe, expect, it } from 'vitest'

import { FakeCollaborationRepository } from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import type {
  StoredDevice,
  StoredExternalIdentity,
  StoredOidcIdentity,
  StoredUser,
  StoredZulipBindingRequest
} from './model.js'
import { PostgresCollaborationRepository, type SqlConnection } from './postgres.js'

const createdAt = '2026-08-18T12:00:00.000Z'
const expiresAt = '2026-08-18T12:05:00.000Z'

function user(userId: string): StoredUser {
  return { userId, displayName: userId, status: 'active', revision: 1, createdAt, updatedAt: createdAt }
}

function oidc(identityId: string, userId: string, subject: string): StoredOidcIdentity {
  return {
    identityId,
    userId,
    issuer: 'https://identity.example.test/realms/sciforge',
    subject,
    emailAtLinkTime: 'same@example.test',
    status: 'active',
    revision: 1,
    createdAt,
    updatedAt: createdAt
  }
}

function device(deviceId: string, userId: string, installationId: string): StoredDevice {
  return {
    deviceId,
    userId,
    installationId,
    displayName: deviceId,
    platform: { os: 'linux', arch: 'x64', appVersion: '1.0.0' },
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: 'fixture', x: 'x'.repeat(43) },
    capabilitySummary: ['research.execute'],
    status: 'active',
    revision: 1,
    createdAt,
    updatedAt: createdAt
  }
}

function externalIdentity(
  externalIdentityId: string,
  humanEndpointId: string,
  userId: string,
  zulipUserId: string
): StoredExternalIdentity {
  return {
    externalIdentityId,
    humanEndpointId,
    userId,
    provider: 'zulip',
    realmUrl: 'https://zulip.example.test',
    realmId: 'realm-test',
    zulipUserId,
    status: 'active',
    revision: 1,
    verifiedAt: createdAt,
    createdAt,
    updatedAt: createdAt
  }
}

describe('identity persistence Fake parity', () => {
  it('serializes concurrent first OIDC use and never merges equal email across subjects', async () => {
    const repository = new FakeCollaborationRepository()
    const resolve = (candidateUserId: string) => repository.transaction(async (tx) => {
      await tx.lockOidcIdentity('https://identity.example.test/realms/sciforge', 'subject-one')
      const existing = await tx.getOidcIdentityByIssuerSubjectForUpdate(
        'https://identity.example.test/realms/sciforge',
        'subject-one'
      )
      if (existing) return existing.userId
      await tx.insertUser(user(candidateUserId))
      await tx.insertOidcIdentity(oidc(`oid_${candidateUserId}`, candidateUserId, 'subject-one'))
      return candidateUserId
    })

    await expect(Promise.all([resolve('usr_FirstIdentity01'), resolve('usr_SecondIdentity1')]))
      .resolves.toEqual(['usr_FirstIdentity01', 'usr_FirstIdentity01'])
    expect(repository.state.users.size).toBe(1)
    expect(repository.state.oidcIdentities.size).toBe(1)

    await repository.transaction(async (tx) => {
      await tx.insertUser(user('usr_SeparateSubject1'))
      await tx.insertOidcIdentity(oidc('oid_SeparateSubject1', 'usr_SeparateSubject1', 'subject-two'))
    })
    expect(repository.state.users.size).toBe(2)
    expect(repository.state.oidcIdentities.size).toBe(2)
  })

  it('consumes an enrollment once and revokes only credentials linked through the revoked Device', async () => {
    const repository = new FakeCollaborationRepository()
    await repository.transaction(async (tx) => {
      await tx.insertUser(user('usr_DeviceOwner001'))
      await tx.insertDeviceEnrollment({
        enrollmentId: 'enr_DeviceEnroll01',
        userId: 'usr_DeviceOwner001',
        installationId: 'ins_DeviceInstall01',
        nonceDigest: '11'.repeat(32),
        status: 'pending',
        revision: 1,
        expiresAt,
        createdAt,
        updatedAt: createdAt
      })
    })

    await expect(Promise.all([
      repository.transaction((tx) => tx.consumeDeviceEnrollment('enr_DeviceEnroll01', '2026-08-18T12:01:00.000Z', 1)),
      repository.transaction((tx) => tx.consumeDeviceEnrollment('enr_DeviceEnroll01', '2026-08-18T12:01:01.000Z', 1))
    ])).resolves.toEqual([true, false])

    const firstDevice = device('dev_DeviceOne0001', 'usr_DeviceOwner001', 'ins_DeviceInstall01')
    const secondDevice = device('dev_DeviceTwo0002', 'usr_DeviceOwner001', 'ins_DeviceInstall02')
    await repository.transaction(async (tx) => {
      await tx.insertDevice(firstDevice)
      await tx.insertDevice(secondDevice)
      await tx.insertAgent({
        agentId: 'agt_DeviceAgent001', deviceId: firstDevice.deviceId, ownerUserId: firstDevice.userId,
        displayName: 'first agent', nodeType: 'desktop', capabilities: ['research.execute'], status: 'active',
        connectionStatus: 'online', credentialGeneration: 1, revision: 1, updatedAt: createdAt
      })
      await tx.insertAgent({
        agentId: 'agt_DeviceAgent002', deviceId: secondDevice.deviceId, ownerUserId: secondDevice.userId,
        displayName: 'second agent', nodeType: 'desktop', capabilities: ['research.execute'], status: 'active',
        connectionStatus: 'online', credentialGeneration: 1, revision: 1, updatedAt: createdAt
      })
      await tx.insertCredential({
        credentialId: 'cred_DeviceAgent01', kind: 'agent_device', subjectUserId: firstDevice.userId,
        subjectAgentId: 'agt_DeviceAgent001', tokenDigest: '22'.repeat(32), assurance: 'device',
        generation: 1, createdAt
      })
      await tx.insertCredential({
        credentialId: 'cred_DeviceAgent02', kind: 'agent_device', subjectUserId: secondDevice.userId,
        subjectAgentId: 'agt_DeviceAgent002', tokenDigest: '33'.repeat(32), assurance: 'device',
        generation: 1, createdAt
      })
      await tx.updateDevice({
        ...firstDevice,
        status: 'revoked',
        revision: 2,
        updatedAt: '2026-08-18T12:02:00.000Z',
        revokedAt: '2026-08-18T12:02:00.000Z'
      }, 1)
      await expect(tx.revokeAgentCredentialsForDevice(firstDevice.deviceId, '2026-08-18T12:02:00.000Z'))
        .resolves.toBe(1)
    })

    expect(repository.state.credentials.get('cred_DeviceAgent01')?.revokedAt)
      .toBe('2026-08-18T12:02:00.000Z')
    expect(repository.state.credentials.get('cred_DeviceAgent02')?.revokedAt).toBeUndefined()
    expect(await repository.listAgentsForDevice(firstDevice.deviceId)).toHaveLength(1)
  })

  it('keeps one endpoint-backed ACTIVE Zulip authority while preserving revoked history', async () => {
    const repository = new FakeCollaborationRepository()
    await repository.transaction(async (tx) => {
      await tx.insertUser(user('usr_BindingOwner001'))
      await tx.insertUser(user('usr_BindingOwner002'))
      await tx.insertExternalIdentity(externalIdentity(
        'xid_BindingIdentity1', 'hep_BindingEndpoint1', 'usr_BindingOwner001', 'zulip-user-1'
      ))
    })

    await expect(repository.transaction(async (tx) => {
      await tx.lockZulipBindingIdentity('usr_BindingOwner002', 'realm-test', 'zulip-user-1')
      await tx.insertExternalIdentity(externalIdentity(
        'xid_BindingIdentity2', 'hep_BindingEndpoint2', 'usr_BindingOwner002', 'zulip-user-1'
      ))
    })).rejects.toThrow('active external identity conflict')
    expect(repository.state.endpoints.size).toBe(1)

    await repository.transaction(async (tx) => {
      const current = await tx.getExternalIdentityForUpdate('xid_BindingIdentity1')
      if (!current) throw new Error('missing fixture identity')
      await tx.updateExternalIdentity({
        ...current,
        status: 'revoked',
        revision: 2,
        updatedAt: '2026-08-18T12:03:00.000Z',
        revokedAt: '2026-08-18T12:03:00.000Z'
      }, 1)
      await tx.insertExternalIdentity(externalIdentity(
        'xid_BindingIdentity2', 'hep_BindingEndpoint2', 'usr_BindingOwner002', 'zulip-user-1'
      ))
    })
    expect(repository.state.endpoints.size).toBe(2)
    expect((await repository.getExternalIdentityByProviderIdentity('realm-test', 'zulip-user-1'))?.userId)
      .toBe('usr_BindingOwner002')
    expect(await repository.listExternalIdentitiesForUser('usr_BindingOwner001')).toMatchObject([{ status: 'revoked' }])
  })

  it('expires an older pending binding request before accepting its replacement', async () => {
    const repository = new FakeCollaborationRepository()
    const request = (bindingRequestId: string, codeDigest: string): StoredZulipBindingRequest => ({
      bindingRequestId,
      userId: 'usr_BindingRequest1',
      realmUrl: 'https://zulip.example.test',
      codeDigest,
      status: 'pending',
      revision: 1,
      expiresAt,
      createdAt,
      updatedAt: createdAt
    })
    await repository.transaction(async (tx) => {
      await tx.insertUser(user('usr_BindingRequest1'))
      await tx.insertZulipBindingRequest(request('zbr_BindingRequest1', '44'.repeat(32)))
      await expect(tx.expirePendingZulipBindingRequests(
        'usr_BindingRequest1', 'https://zulip.example.test', '2026-08-18T12:00:01.000Z'
      )).resolves.toBe(1)
      await tx.insertZulipBindingRequest(request('zbr_BindingRequest2', '55'.repeat(32)))
    })
    expect(repository.state.zulipBindingRequests.get('zbr_BindingRequest1')?.status).toBe('expired')
    expect(repository.state.zulipBindingRequests.get('zbr_BindingRequest2')?.status).toBe('pending')
  })
})

describe('PostgreSQL identity locking boundary', () => {
  it('uses digest-derived advisory keys and locks both Zulip uniqueness dimensions in stable order', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })
    await repository.transaction(async (tx) => {
      await tx.lockOidcIdentity('https://private-issuer.example.test', 'private-subject')
      await tx.lockZulipBindingIdentity('usr_PrivateUser001', 'private-realm', 'private-zulip-user')
    })

    const locks = queries.filter(({ text }) => text.includes('pg_advisory_xact_lock'))
    expect(locks).toHaveLength(3)
    expect(locks.every(({ values }) => /^-?\d+$/u.test(String(values[0])))).toBe(true)
    const renderedValues = JSON.stringify(locks.map(({ values }) => values))
    expect(renderedValues).not.toContain('private-issuer')
    expect(renderedValues).not.toContain('private-subject')
    expect(renderedValues).not.toContain('private-realm')
    const bindingKeys = locks.slice(1).map(({ values }) => BigInt(String(values[0])))
    expect(bindingKeys[0] <= bindingKeys[1]).toBe(true)
    expect(queries[0]?.text).toBe('BEGIN')
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })

  it.each([
    ['23505', 'human_endpoint_bindings_zulip_provider_identity_active_unique', 'IDENTITY_ALREADY_BOUND'],
    ['23505', 'devices_installation_unique', 'ownership_conflict'],
    ['23503', 'agent_nodes_device_owner_fk', 'ownership_conflict'],
    ['23514', 'devices_public_key_shape', 'validation_failed']
  ] as const)('maps allowlisted identity constraint %s/%s without database detail', async (sqlState, constraint, code) => {
    const sensitiveMarker = 'PRIVATE_DATABASE_DETAIL'
    const connection: SqlConnection = {
      query: async (text) => {
        if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
        throw Object.assign(new Error(sensitiveMarker), { code: sqlState, constraint, detail: sensitiveMarker })
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })
    const rejected = repository.transaction((tx) => tx.insertExternalIdentity(externalIdentity(
      'xid_ConstraintTest1', 'hep_ConstraintTest1', 'usr_ConstraintTest01', 'zulip-user-test'
    )))
    await expect(rejected).rejects.toMatchObject({ code })
    await expect(rejected).rejects.not.toThrow(sensitiveMarker)
  })
})
