import { describe, expect, it } from 'vitest'

import { AuthenticationService } from './auth.js'
import { CollaborationServiceError } from './errors.js'
import { IdentityService } from './identity-service.js'
import { CollaborationService } from './service.js'

import {
  FakeClock,
  FakeCollaborationRepository
} from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import { createDeviceFixture } from '../../../test-fixtures/collaboration/unified-identity/device-fixture.mjs'
import { createZulipBindingFixture } from '../../../test-fixtures/collaboration/unified-identity/binding-fixture.mjs'

function verifiedIdentity(clock: FakeClock, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(clock.now().getTime() / 1_000)
  return {
    issuer: 'https://login-test.sciforge.cn/realms/SciForge',
    subject: 'oidc-sub-test-owner',
    audience: ['sciforge-cloud-api'],
    authorizedParty: 'sciforge-desktop',
    issuedAt: now,
    notBefore: now - 1,
    expiresAt: now + 300,
    authTime: now,
    preferredUsername: 'identity-owner',
    ...overrides
  }
}

async function expectServiceCode(work: () => Promise<unknown>, code: string) {
  let thrown: unknown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CollaborationServiceError)
  expect((thrown as CollaborationServiceError).code).toBe(code)
}

describe('A unified identity Service', () => {
  it('converges concurrent first OIDC login and never merges equal email across subjects', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const verified = verifiedIdentity(clock, { email: 'same@example.invalid' })

    const actors = await Promise.all(Array.from({ length: 24 }, () => identities.resolveOidcUser(verified)))
    expect(new Set(actors.map((actor) => actor.userId))).toHaveLength(1)
    expect(new Set(actors.map((actor) => actor.actorKey))).toHaveLength(1)
    expect(repository.state.users.size).toBe(1)
    expect(repository.state.oidcIdentities.size).toBe(1)
    expect(repository.state.auditEvents.filter((event: { action: string }) => event.action === 'oidc.user.jit')).toHaveLength(1)

    const other = await identities.resolveOidcUser(verifiedIdentity(clock, {
      subject: 'oidc-sub-test-other',
      email: 'same@example.invalid'
    }))
    expect(other.userId).not.toBe(actors[0].userId)
    expect(repository.state.users.size).toBe(2)
  })

  it('rejects a locally inactive OIDC User and records only local, redacted resolution facts', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const verified = verifiedIdentity(clock, { subject: 'private-oidc-subject-marker' })
    const actor = await identities.resolveOidcUser(verified)
    const user = repository.state.users.get(actor.userId)
    repository.state.users.set(actor.userId, { ...user, status: 'suspended', revision: user.revision + 1 })

    await expectServiceCode(() => identities.resolveOidcUser(verified), 'credential_revoked')

    const audit = repository.state.auditEvents.at(-1)
    expect(audit).toMatchObject({
      actorKind: 'oidc',
      actorUserId: actor.userId,
      action: 'oidc.user.resolve',
      resourceKind: 'oidc_identity',
      outcome: 'rejected',
      metadata: { errorCode: 'credential_revoked' }
    })
    expect(JSON.stringify(audit)).not.toContain('private-oidc-subject-marker')
    expect(JSON.stringify(audit)).not.toContain(verified.issuer)
  })

  it('creates a Device only after fixture-backed Ed25519 proof and keeps Device facts separate from Agent capabilities', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const collaboration = new CollaborationService({ repository, now: clock.now })
    const actor = await identities.resolveOidcUser(verifiedIdentity(clock))
    const enrollment = await identities.createDeviceEnrollment(actor, {
      installationId: 'ins_identity_test_0001',
      idempotencyKey: 'idem_device_enrollment_0001'
    })
    const fixture = createDeviceFixture({
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      userId: actor.userId,
      installationId: 'ins_identity_test_0001',
      expiresAt: enrollment.expiresAt,
      capabilitySummary: ['local-files']
    })
    const created = await identities.createDevice(actor, {
      ...fixture.deviceRequest,
      nonce: enrollment.nonce,
      idempotencyKey: 'idem_device_create_0001'
    })
    expect(created.device.status).toBe('active')
    expect(created.device.capabilitySummary).toEqual(['local-files'])
    expect(repository.state.deviceEnrollments.get(enrollment.enrollmentId)).not.toHaveProperty('nonce')
    expect(repository.state.devices.get(created.device.deviceId)).not.toHaveProperty('signature')

    const registered = await collaboration.registerAgent(actor, {
      deviceId: created.device.deviceId,
      displayName: 'Runtime Agent',
      nodeType: 'desktop',
      capabilities: ['runtime-exec'],
      idempotencyKey: 'idem_agent_device_link_0001'
    })
    expect(registered.agent.deviceId).toBe(created.device.deviceId)
    expect(registered.agent.capabilities).toEqual(['runtime-exec'])
    expect(registered.agent).not.toHaveProperty('platform')
    expect(registered.agent).not.toHaveProperty('publicKeyJwk')
    expect((await identities.listDevices(actor)).devices[0].capabilitySummary).toEqual(['local-files'])

    const authentication = new AuthenticationService(repository, clock.now)
    const agentActor = await authentication.resolveBearer(registered.deviceCredential)
    if (agentActor.kind !== 'agent_device') throw new Error('fixture credential did not resolve to an Agent')
    expect(agentActor.deviceId).toBe(created.device.deviceId)

    await identities.revokeDevice(actor, created.device.deviceId, 'idem_device_revoke_0001')
    await expectServiceCode(() => authentication.resolveBearer(registered.deviceCredential), 'credential_revoked')
    await expectServiceCode(() => collaboration.heartbeatAgent(agentActor, {
      expectedRevision: registered.agent.revision,
      connectionStatus: 'online',
      idempotencyKey: 'idem_device_revoked_stale_actor_write'
    }), 'credential_revoked')
    expect(repository.state.devices.get(created.device.deviceId).status).toBe('revoked')
    expect(repository.state.agents.get(registered.agent.agentId).status).toBe('active')
  })

  it('rejects wrong owner, tampered proof, consumed enrollment, expiry, and stale recent authentication', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const owner = await identities.resolveOidcUser(verifiedIdentity(clock))
    const other = await identities.resolveOidcUser(verifiedIdentity(clock, { subject: 'oidc-sub-test-other' }))
    const enrollment = await identities.createDeviceEnrollment(owner, {
      installationId: 'ins_identity_test_0002',
      idempotencyKey: 'idem_device_enrollment_0002'
    })
    const fixture = createDeviceFixture({ ...enrollment, userId: owner.userId, installationId: 'ins_identity_test_0002' })
    const request = { ...fixture.deviceRequest, nonce: enrollment.nonce, idempotencyKey: 'idem_device_create_0002' }

    await expectServiceCode(() => identities.createDevice(other, request), 'not_found')
    await expectServiceCode(() => identities.createDevice(owner, {
      ...request,
      installationId: 'ins_identity_test_wrong',
      idempotencyKey: 'idem_device_create_wrong_installation'
    }), 'ownership_conflict')
    await expectServiceCode(() => identities.createDevice(owner, {
      ...request,
      publicKeyJwk: { ...request.publicKeyJwk, d: 'private-key-material-must-not-pass' },
      idempotencyKey: 'idem_device_create_private_jwk'
    } as never), 'validation_failed')
    await expectServiceCode(() => identities.createDevice(owner, {
      ...request,
      signature: Buffer.alloc(64).toString('base64url'),
      idempotencyKey: 'idem_device_create_tampered_0002'
    }), 'validation_failed')
    const created = await identities.createDevice(owner, request)
    expect((await identities.createDevice(owner, request)).device.deviceId).toBe(created.device.deviceId)
    expect((await identities.listDevices(other)).devices).toEqual([])
    await expectServiceCode(() => identities.createDevice(owner, {
      ...request,
      idempotencyKey: 'idem_device_create_reuse_0002'
    }), 'invalid_state_transition')

    const conflictingEnrollment = await identities.createDeviceEnrollment(other, {
      installationId: request.installationId,
      idempotencyKey: 'idem_device_enrollment_global_owner'
    })
    const conflictingFixture = createDeviceFixture({ ...conflictingEnrollment, userId: other.userId,
      installationId: request.installationId })
    await expectServiceCode(() => identities.createDevice(other, {
      ...conflictingFixture.deviceRequest,
      nonce: conflictingEnrollment.nonce,
      idempotencyKey: 'idem_device_create_global_owner'
    }), 'ownership_conflict')

    const racingEnrollment = await identities.createDeviceEnrollment(other, {
      installationId: 'ins_identity_test_racing',
      idempotencyKey: 'idem_device_enrollment_racing'
    })
    const racingFixture = createDeviceFixture({ ...racingEnrollment, userId: other.userId,
      installationId: 'ins_identity_test_racing' })
    const racingResults = await Promise.allSettled([
      identities.createDevice(other, { ...racingFixture.deviceRequest, nonce: racingEnrollment.nonce,
        idempotencyKey: 'idem_device_create_racing_first' }),
      identities.createDevice(other, { ...racingFixture.deviceRequest, nonce: racingEnrollment.nonce,
        idempotencyKey: 'idem_device_create_racing_second' })
    ])
    expect(racingResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(racingResults.filter((result) => result.status === 'rejected')).toHaveLength(1)

    clock.tick(301_000)
    await expectServiceCode(() => identities.revokeDevice(owner, created.device.deviceId,
      'idem_device_revoke_stale_0002'), 'assurance_insufficient')

    const expiring = await identities.createDeviceEnrollment(other, {
      installationId: 'ins_identity_test_expired',
      idempotencyKey: 'idem_device_enrollment_expired'
    })
    const expiredFixture = createDeviceFixture({ ...expiring, userId: other.userId,
      installationId: 'ins_identity_test_expired' })
    clock.tick(300_000)
    await expectServiceCode(() => identities.createDevice(other, {
      ...expiredFixture.deviceRequest,
      nonce: expiring.nonce,
      idempotencyKey: 'idem_device_create_expired'
    }), 'request_expired')
  })

  it('revokes an Agent without changing its owning Device lifecycle', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const collaboration = new CollaborationService({ repository, now: clock.now })
    const actor = await identities.resolveOidcUser(verifiedIdentity(clock))
    const enrollment = await identities.createDeviceEnrollment(actor, {
      installationId: 'ins_identity_agent_revoke',
      idempotencyKey: 'idem_identity_agent_revoke_enrollment'
    })
    const fixture = createDeviceFixture({ ...enrollment, userId: actor.userId,
      installationId: 'ins_identity_agent_revoke' })
    const created = await identities.createDevice(actor, { ...fixture.deviceRequest, nonce: enrollment.nonce,
      idempotencyKey: 'idem_identity_agent_revoke_device' })
    const registered = await collaboration.registerAgent(actor, {
      deviceId: created.device.deviceId,
      displayName: 'Revocable Agent',
      nodeType: 'desktop',
      capabilities: ['runtime-exec'],
      idempotencyKey: 'idem_identity_agent_revoke_register'
    })

    await collaboration.revokeAgent(actor, {
      agentId: registered.agent.agentId,
      expectedRevision: registered.agent.revision,
      idempotencyKey: 'idem_identity_agent_revoke_only'
    })

    expect(repository.state.devices.get(created.device.deviceId)).toMatchObject({ status: 'active', revision: 1 })
  })

  it('binds an existing OIDC User through an injected service actor with dual uniqueness and no User creation', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const owner = await identities.resolveOidcUser(verifiedIdentity(clock))
    const fixture = createZulipBindingFixture({ userId: owner.userId, requestedAt: clock.now() })
    const beforeUsers = repository.state.users.size
    const begun = await identities.beginZulipBinding(owner, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_begin_0001'
    })
    const confirm = {
      ...fixture.confirmRequest,
      bindingCode: begun.bindingCode,
      idempotencyKey: 'idem_zulip_binding_confirm_0001'
    }
    const bound = await identities.confirmZulipBinding(fixture.serviceActor, confirm)
    expect(bound.identity.userId).toBe(owner.userId)
    expect(repository.state.users.size).toBe(beforeUsers)
    expect((await identities.listExternalIdentities(owner)).identities).toHaveLength(1)

    const replay = await identities.confirmZulipBinding(fixture.serviceActor, confirm)
    expect(replay.identity.externalIdentityId).toBe(bound.identity.externalIdentityId)
    await expectServiceCode(() => identities.confirmZulipBinding(fixture.serviceActor, {
      ...confirm,
      providerEventId: 'zulip-event-test-used-0002',
      idempotencyKey: 'idem_zulip_binding_used_0002'
    }), 'BINDING_CODE_USED')

    const other = await identities.resolveOidcUser(verifiedIdentity(clock, { subject: 'oidc-sub-binding-other' }))
    const otherBegin = await identities.beginZulipBinding(other, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_begin_other'
    })
    await expectServiceCode(() => identities.confirmZulipBinding(fixture.serviceActor, {
      ...fixture.confirmRequest,
      bindingCode: otherBegin.bindingCode,
      providerEventId: 'zulip-event-test-conflict',
      idempotencyKey: 'idem_zulip_binding_conflict'
    }), 'IDENTITY_ALREADY_BOUND')

    const sameUserBegin = await identities.beginZulipBinding(owner, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_same_user_begin'
    })
    const sameUser = await identities.confirmZulipBinding(fixture.serviceActor, {
      ...fixture.confirmRequest,
      bindingCode: sameUserBegin.bindingCode,
      providerEventId: 'zulip-event-test-same-user',
      idempotencyKey: 'idem_zulip_binding_same_user_confirm'
    })
    expect(sameUser.identity.externalIdentityId).toBe(bound.identity.externalIdentityId)

    await identities.revokeExternalIdentity(owner, bound.identity.externalIdentityId,
      'idem_zulip_binding_revoke_0001')
    expect(await repository.getExternalIdentityByProviderIdentity(fixture.confirmRequest.realmId,
      fixture.confirmRequest.zulipUserId)).toBeNull()
    expect(repository.state.endpoints.get(bound.identity.humanEndpointId).status).toBe('revoked')
    expect((await identities.listExternalIdentities(other)).identities).toEqual([])

    const rebindBegin = await identities.beginZulipBinding(owner, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_rebind_begin'
    })
    const rebound = await identities.confirmZulipBinding(fixture.serviceActor, {
      ...fixture.confirmRequest,
      bindingCode: rebindBegin.bindingCode,
      providerEventId: 'zulip-event-test-rebind',
      idempotencyKey: 'idem_zulip_binding_rebind_confirm'
    })
    expect(rebound.identity.externalIdentityId).not.toBe(bound.identity.externalIdentityId)
    expect((await identities.listExternalIdentities(owner)).identities.map((identity) => identity.status).sort())
      .toEqual(['active', 'revoked'])
    expect((await repository.getExternalIdentityByProviderIdentity(fixture.confirmRequest.realmId,
      fixture.confirmRequest.zulipUserId))?.externalIdentityId).toBe(rebound.identity.externalIdentityId)
  })

  it('expires old same-Realm codes and distinguishes expiration from single use', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const actor = await identities.resolveOidcUser(verifiedIdentity(clock))
    const fixture = createZulipBindingFixture({ userId: actor.userId, requestedAt: clock.now() })
    const first = await identities.beginZulipBinding(actor, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_expire_first'
    })
    const second = await identities.beginZulipBinding(actor, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_expire_second'
    })
    await expectServiceCode(() => identities.confirmZulipBinding(fixture.serviceActor, {
      ...fixture.confirmRequest,
      bindingCode: first.bindingCode,
      idempotencyKey: 'idem_zulip_binding_old_code'
    }), 'BINDING_CODE_EXPIRED')
    clock.tick(301_000)
    await expectServiceCode(() => identities.confirmZulipBinding(fixture.serviceActor, {
      ...fixture.confirmRequest,
      bindingCode: second.bindingCode,
      providerEventId: 'zulip-event-test-expired-by-time',
      idempotencyKey: 'idem_zulip_binding_expired_by_time'
    }), 'BINDING_CODE_EXPIRED')
  })

  it('keeps a confirmed binding readable after the one-time code lifetime ends', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const actor = await identities.resolveOidcUser(verifiedIdentity(clock))
    const fixture = createZulipBindingFixture({ userId: actor.userId, requestedAt: clock.now() })
    const begun = await identities.beginZulipBinding(actor, {
      ...fixture.beginRequest,
      idempotencyKey: 'idem_zulip_binding_confirmed_status_begin'
    })
    const bound = await identities.confirmZulipBinding(fixture.serviceActor, {
      ...fixture.confirmRequest,
      bindingCode: begun.bindingCode,
      idempotencyKey: 'idem_zulip_binding_confirmed_status_confirm'
    })

    clock.tick(301_000)
    const status = await identities.getZulipBindingStatus(actor, begun.bindingRequestId)

    expect(status).toEqual({ status: 'bound', identity: bound.identity })
  })
})
