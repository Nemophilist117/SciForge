import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createCollaborationHttpServer } from './api.js'
import { AuthenticationService, StrictOidcUserResolver } from './auth.js'
import { IdentityService } from './identity-service.js'
import { createOidcAccessTokenVerifier } from './oidc.js'
import { CollaborationService } from './service.js'

import {
  FakeClock,
  FakeCollaborationRepository
} from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import { createDeviceFixture } from '../../../test-fixtures/collaboration/unified-identity/device-fixture.mjs'
import { startOidcFixtureServer } from '../../../test-fixtures/collaboration/unified-identity/oidc-fixture.mjs'

const closeCallbacks: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closeCallbacks.length > 0) await closeCallbacks.pop()?.()
})

async function startApi(options: {
  repository: FakeCollaborationRepository
  clock: FakeClock
  authentication: AuthenticationService
  identities: IdentityService
  trustedConfirm?: (body: Record<string, unknown>) => Record<string, unknown> | null
}) {
  const service = new CollaborationService({ repository: options.repository, now: options.clock.now })
  const server = createCollaborationHttpServer({
    service,
    identities: options.identities,
    authentication: options.authentication,
    readiness: async () => true,
    now: options.clock.now,
    ...(options.trustedConfirm ? {
      authenticateZulipBindingConfirm: async (_request, body) => options.trustedConfirm?.(body) as never
    } : {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  closeCallbacks.push(async () => {
    server.close()
    await once(server, 'close')
  })
  return `http://127.0.0.1:${address.port}`
}

async function jsonRequest(baseUrl: string, path: string, options: {
  method?: string
  token?: string
  body?: Record<string, unknown>
  idempotencyKey?: string
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

describe('A unified identity HTTP boundary', () => {
  it('runs OIDC User -> Device -> Agent and trusted User <-> Zulip binding with direct strict routes', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const oidc = await startOidcFixtureServer()
    closeCallbacks.push(() => oidc.close())
    const verifier = createOidcAccessTokenVerifier({
      issuer: oidc.issuer,
      allowInsecureLoopback: true,
      now: clock.now
    })
    const authentication = new AuthenticationService(repository, clock.now,
      new StrictOidcUserResolver(verifier, identities))
    let confirmTrusted = false
    const expectedContext = {
      realmUrl: 'https://chat-test.example.invalid',
      realmId: 'zulip-realm-test-0001',
      zulipUserId: 'zulip-user-test-0001',
      providerEventId: 'zulip-event-test-0001'
    }
    const baseUrl = await startApi({
      repository,
      clock,
      authentication,
      identities,
      trustedConfirm: (body) => confirmTrusted && Object.entries(expectedContext)
        .every(([key, value]) => body[key] === value)
        ? { actor: { kind: 'service', clientId: 'sciforge-zulip-bot' }, ...expectedContext }
        : null
    })
    const now = Math.floor(clock.now().getTime() / 1_000)
    const token = oidc.mintToken({ now, claims: { sub: 'http-identity-owner', name: 'HTTP Identity Owner' } })

    const me = await jsonRequest(baseUrl, '/v1/me', { token })
    expect(me.status).toBe(200)
    expect(me.body.userId).toMatch(/^usr_/u)
    expect(repository.state.users.size).toBe(1)

    const enrollmentKey = 'idem_http_device_enrollment_0001'
    const enrollment = await jsonRequest(baseUrl, '/v1/device-enrollments', {
      method: 'POST', token, idempotencyKey: enrollmentKey,
      body: { installationId: 'ins_identity_http_0001', idempotencyKey: enrollmentKey }
    })
    expect(enrollment.status).toBe(200)
    const fixture = createDeviceFixture({
      enrollmentId: enrollment.body.enrollmentId,
      nonce: enrollment.body.nonce,
      userId: me.body.userId,
      installationId: 'ins_identity_http_0001',
      expiresAt: enrollment.body.expiresAt,
      capabilitySummary: ['device-local-files']
    })
    const createKey = 'idem_http_device_create_0001'
    const created = await jsonRequest(baseUrl, '/v1/devices', {
      method: 'POST', token, idempotencyKey: createKey,
      body: { ...fixture.deviceRequest, nonce: enrollment.body.nonce, idempotencyKey: createKey }
    })
    expect(created.status).toBe(200)
    expect(created.body.device.capabilitySummary).toEqual(['device-local-files'])

    const registerKey = 'idem_http_agent_register_0001'
    const registered = await jsonRequest(baseUrl, '/v1/commands', {
      method: 'POST', token, idempotencyKey: registerKey,
      body: {
        protocolVersion: '1.0', requestId: 'req_identity_http_agent_0001', type: 'agent.register',
        idempotencyKey: registerKey, deviceId: created.body.device.deviceId,
        displayName: 'HTTP Runtime Agent', nodeType: 'desktop', capabilities: ['agent-runtime-live']
      }
    })
    expect(registered.status).toBe(200)
    expect(registered.body.agent.deviceId).toBe(created.body.device.deviceId)
    expect(registered.body.agent.capabilities).toEqual(['agent-runtime-live'])
    expect(registered.body.agent).not.toHaveProperty('platform')

    const bindingKey = 'idem_http_binding_begin_0001'
    const begun = await jsonRequest(baseUrl, '/v1/integrations/zulip/bindings', {
      method: 'POST', token, idempotencyKey: bindingKey,
      body: { realmUrl: expectedContext.realmUrl, idempotencyKey: bindingKey }
    })
    expect(begun.status).toBe(200)
    const confirmKey = 'idem_http_binding_confirm_0001'
    const confirmBody = {
      bindingCode: begun.body.bindingCode,
      ...expectedContext,
      idempotencyKey: confirmKey
    }
    const untrusted = await jsonRequest(baseUrl, '/v1/integrations/zulip/bindings/confirm', {
      method: 'POST', idempotencyKey: confirmKey, body: confirmBody
    })
    expect(untrusted.status).toBe(401)
    expect(repository.state.endpoints.size).toBe(0)

    confirmTrusted = true
    const confirmed = await jsonRequest(baseUrl, '/v1/integrations/zulip/bindings/confirm', {
      method: 'POST', idempotencyKey: confirmKey, body: confirmBody
    })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.identity.userId).toBe(me.body.userId)
    expect(repository.state.users.size).toBe(1)

    const listed = await jsonRequest(baseUrl, '/v1/me/external-identities', { token })
    expect(listed.status).toBe(200)
    expect(listed.body.identities).toHaveLength(1)

    const revokeKey = 'idem_http_device_revoke_0001'
    const revoked = await jsonRequest(baseUrl, `/v1/me/devices/${created.body.device.deviceId}`, {
      method: 'DELETE', token, idempotencyKey: revokeKey,
      body: { deviceId: created.body.device.deviceId, idempotencyKey: revokeKey }
    })
    expect(revoked.status).toBe(200)
    const agentDenied = await jsonRequest(baseUrl, '/v1/commands', {
      method: 'POST', token: registered.body.deviceCredential,
      idempotencyKey: 'idem_http_agent_after_revoke',
      body: {
        protocolVersion: '1.0', requestId: 'req_identity_http_after_revoke', type: 'agent.heartbeat',
        idempotencyKey: 'idem_http_agent_after_revoke', agentId: registered.body.agent.agentId,
        expectedRevision: registered.body.agent.revision, connectionStatus: 'online', capabilities: ['agent-runtime-live']
      }
    })
    expect(agentDenied.status).toBe(401)
  })

  it('starts with external identity dependencies absent and fails closed without anonymous pairing or confirm', async () => {
    const clock = new FakeClock('2026-08-18T12:00:00.000Z')
    const repository = new FakeCollaborationRepository()
    const identities = new IdentityService({ repository, now: clock.now })
    const authentication = new AuthenticationService(repository, clock.now)
    const baseUrl = await startApi({ repository, clock, authentication, identities })

    const ready = await jsonRequest(baseUrl, '/readyz')
    expect(ready).toEqual({ status: 200, body: { ok: true } })
    const jwtShaped = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ.eyJzdWIiOiJ4In0.signature'
    const me = await jsonRequest(baseUrl, '/v1/me', { token: jwtShaped })
    expect(me.status).toBe(401)

    const pairingKey = 'idem_http_anonymous_pairing_0001'
    const pairing = await jsonRequest(baseUrl, '/v1/commands', {
      method: 'POST', idempotencyKey: pairingKey,
      body: {
        protocolVersion: '1.0', requestId: 'req_http_anonymous_pairing_0001', type: 'pairing.begin',
        realmUrl: 'https://chat-test.example.invalid', idempotencyKey: pairingKey
      }
    })
    expect(pairing.status).toBe(401)
    expect(repository.state.users.size).toBe(0)
    expect(repository.state.challenges.size).toBe(0)
    expect(JSON.stringify(pairing.body)).not.toContain('userCredential')

    const confirmKey = 'idem_http_unconfigured_confirm'
    const confirm = await jsonRequest(baseUrl, '/v1/integrations/zulip/bindings/confirm', {
      method: 'POST', idempotencyKey: confirmKey,
      body: {
        bindingCode: 'SF-ABCDEFGH-JKLMNPQR', realmUrl: 'https://chat-test.example.invalid',
        realmId: 'zulip-realm-test-0001', zulipUserId: 'zulip-user-test-0001',
        providerEventId: 'zulip-event-test-untrusted', idempotencyKey: confirmKey
      }
    })
    expect(confirm.status).toBe(401)
    expect(repository.state.zulipBindingRequests.size).toBe(0)
    expect(repository.state.endpoints.size).toBe(0)
  })
})
