import { createHash } from 'node:crypto'

import {
  AuthenticationService,
  StrictOidcUserResolver
} from '../../../packages/collaboration-server/src/auth.ts'
import { IdentityService } from '../../../packages/collaboration-server/src/identity-service.ts'
import { createOidcAccessTokenVerifier } from '../../../packages/collaboration-server/src/oidc.ts'
import { createZulipBindingFixture } from './binding-fixture.mjs'
import { createDeviceFixture } from './device-fixture.mjs'
import { startOidcFixtureServer } from './oidc-fixture.mjs'

const DEFAULT_REALM_URL = 'https://chat-test.example.invalid'
const DEFAULT_REALM_ID = 'zulip-realm-test-0001'
const DEFAULT_SERVICE_CLIENT_ID = 'sciforge-zulip-bot-test'

function suffix(label) {
  return createHash('sha256').update(String(label)).digest('hex').slice(0, 24)
}

export async function createUnifiedIdentityServerFixture(options) {
  const oidc = await startOidcFixtureServer()
  const identities = new IdentityService({ repository: options.repository, now: options.now })
  const verifier = createOidcAccessTokenVerifier({
    issuer: oidc.issuer,
    allowInsecureLoopback: true,
    now: options.now
  })
  const authentication = new AuthenticationService(
    options.repository,
    options.now,
    new StrictOidcUserResolver(verifier, identities)
  )
  let closed = false

  return {
    oidc,
    identities,
    authentication,
    serviceActor: Object.freeze({ kind: 'service', clientId: DEFAULT_SERVICE_CLIENT_ID }),

    async createUser(label, overrides = {}) {
      const marker = suffix(label)
      const nowSeconds = Math.floor(options.now().getTime() / 1_000)
      const accessToken = oidc.mintToken({
        now: nowSeconds,
        claims: {
          sub: overrides.subject ?? `oidc-sub-${marker}`,
          email: overrides.email ?? `${marker}@example.invalid`,
          email_verified: true,
          preferred_username: overrides.preferredUsername ?? `user-${marker.slice(0, 12)}`,
          name: overrides.displayName ?? String(label)
        }
      })
      const actor = await authentication.resolveBearer(accessToken)
      if (actor.kind !== 'user') throw new Error('Dynamic OIDC fixture did not resolve a User actor.')
      return { actor, userId: actor.userId, accessToken, subject: actor.subject }
    },

    async bindZulip(user, label, overrides = {}) {
      const marker = suffix(label)
      const fixture = createZulipBindingFixture({
        requestedAt: options.now(),
        userId: user.userId,
        issuer: oidc.issuer,
        subject: user.subject,
        realmUrl: overrides.realmUrl ?? DEFAULT_REALM_URL,
        realmId: overrides.realmId ?? DEFAULT_REALM_ID,
        zulipUserId: overrides.zulipUserId ?? `zulip-user-${marker}`,
        providerEventId: overrides.providerEventId ?? `zulip-event-${marker}`,
        serviceClientId: DEFAULT_SERVICE_CLIENT_ID
      })
      const begun = await identities.beginZulipBinding(user.actor, {
        ...fixture.beginRequest,
        idempotencyKey: `idem_binding_begin_${marker}`
      })
      const confirmed = await identities.confirmZulipBinding(fixture.serviceActor, {
        ...fixture.confirmRequest,
        bindingCode: begun.bindingCode,
        idempotencyKey: `idem_binding_confirm_${marker}`
      })
      const endpointActor = await authentication.resolveProviderIdentity(
        'zulip',
        confirmed.identity.realmId,
        confirmed.identity.zulipUserId
      )
      return {
        bindingRequestId: begun.bindingRequestId,
        bindingCode: begun.bindingCode,
        identity: confirmed.identity,
        endpointActor,
        endpointId: confirmed.identity.humanEndpointId,
        externalIdentityId: confirmed.identity.externalIdentityId,
        provider: 'zulip',
        realmUrl: confirmed.identity.realmUrl,
        realmId: confirmed.identity.realmId,
        providerUserId: confirmed.identity.zulipUserId
      }
    },

    async createDevice(user, label, overrides = {}) {
      const marker = suffix(label)
      const installationId = overrides.installationId ?? `ins_${marker}`
      const enrollment = await identities.createDeviceEnrollment(user.actor, {
        installationId,
        idempotencyKey: `idem_device_enroll_${marker}`
      })
      const fixture = createDeviceFixture({
        enrollmentId: enrollment.enrollmentId,
        nonce: enrollment.nonce,
        userId: user.userId,
        installationId,
        expiresAt: enrollment.expiresAt,
        displayName: overrides.displayName ?? `Device ${label}`,
        kid: `device-key-${marker.slice(0, 16)}`,
        capabilitySummary: overrides.capabilitySummary ?? ['agent-runtime'],
        ...(overrides.platform ? { platform: overrides.platform } : {})
      })
      const created = await identities.createDevice(user.actor, {
        ...fixture.deviceRequest,
        nonce: enrollment.nonce,
        idempotencyKey: `idem_device_create_${marker}`
      })
      return {
        device: created.device,
        enrollment,
        fixture
      }
    },

    async close() {
      if (closed) return
      closed = true
      await oidc.close()
    }
  }
}
