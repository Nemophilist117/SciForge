import {
  deviceCreateRequestSchema,
  deviceEnrollmentCreateRequestSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  externalIdentityListResponseSchema,
  externalIdentityResponseSchema,
  meResponseSchema,
  zulipBindingBeginRequestSchema,
  zulipBindingConfirmRequestSchema,
  zulipBindingConfirmResponseSchema,
  type Device,
  type DeviceCreateRequest,
  type DeviceEnrollmentCreateRequest,
  type DeviceEnrollmentCreateResponse,
  type DeviceListResponse,
  type DeviceResponse,
  type ExternalIdentity,
  type ExternalIdentityListResponse,
  type ExternalIdentityResponse,
  type MeResponse,
  type ServiceActor,
  type ZulipBindingBeginRequest,
  type ZulipBindingBeginResponse,
  type ZulipBindingConfirmRequest,
  type ZulipBindingConfirmResponse
} from '@sciforge/collaboration-contracts'

import type { UserActor } from './auth.js'
import { newId, safeAuditMetadata, stableDigest } from './crypto.js'
import { CollaborationServiceError, fail } from './errors.js'
import {
  enrollmentNonceDigest,
  issueBindingCode,
  issueEnrollmentNonce,
  verifyDeviceEnrollmentProof
} from './identity-crypto.js'
import type {
  StoredAuditEvent,
  StoredDevice,
  StoredExternalIdentity,
  StoredOidcIdentity,
  StoredParticipant,
  StoredReceipt,
  StoredUser,
  StoredZulipBindingRequest
} from './model.js'
import type { VerifiedOidcIdentity } from './oidc.js'
import type { CollaborationRepository, CollaborationTransaction } from './repository.js'

const IDENTITY_SCHEMA_VERSION = 1 as const
const FIVE_MINUTES_MS = 5 * 60_000
const RECEIPT_TTL_MS = 30 * 86_400_000

type IdentityActor = UserActor | ServiceActor

type IdentityCommandResult<T extends Record<string, unknown>> = Readonly<{
  response: T
  receiptResponse?: Record<string, unknown>
  resourceKind?: string
  resourceId?: string
}>

export type IdentityServiceOptions = Readonly<{
  repository: CollaborationRepository
  now?: () => Date
}>

export class IdentityService {
  private readonly repository: CollaborationRepository
  private readonly now: () => Date

  constructor(options: IdentityServiceOptions) {
    this.repository = options.repository
    this.now = options.now ?? (() => new Date())
  }

  async resolveOidcUser(verified: VerifiedOidcIdentity): Promise<UserActor> {
    const at = this.timestamp()
    const resolved = await this.repository.transaction(async (tx) => {
      await tx.lockOidcIdentity(verified.issuer, verified.subject)
      const existing = await tx.getOidcIdentityByIssuerSubjectForUpdate(verified.issuer, verified.subject)
      if (existing) {
        const user = await tx.getUserForUpdate(existing.userId)
        const active = existing.status === 'active' && user?.status === 'active'
        await tx.insertAudit({
          auditEventId: newId('audit'),
          actorKind: 'oidc',
          ...(user ? { actorUserId: user.userId } : {}),
          action: 'oidc.user.resolve',
          resourceKind: 'oidc_identity',
          resourceId: existing.identityId,
          outcome: active ? 'accepted' : 'rejected',
          metadata: active ? {} : { errorCode: 'credential_revoked' },
          createdAt: at
        })
        return { user, identity: existing }
      }

      const userId = newId('usr')
      const identityId = newId('oid')
      const user: StoredUser = {
        userId,
        displayName: oidcDisplayName(verified),
        status: 'active',
        revision: 1,
        createdAt: at,
        updatedAt: at
      }
      const identity: StoredOidcIdentity = {
        identityId,
        userId,
        issuer: verified.issuer,
        subject: verified.subject,
        ...(verified.email ? { emailAtLinkTime: verified.email } : {}),
        status: 'active',
        revision: 1,
        createdAt: at,
        updatedAt: at
      }
      await tx.insertUser(user)
      await tx.insertOidcIdentity(identity)
      await tx.insertAudit({
        auditEventId: newId('audit'),
        actorKind: 'oidc',
        actorUserId: userId,
        action: 'oidc.user.jit',
        resourceKind: 'oidc_identity',
        resourceId: identityId,
        outcome: 'accepted',
        metadata: {},
        createdAt: at
      })
      return { user, identity }
    })
    if (!resolved.user || resolved.user.status !== 'active' || resolved.identity.status !== 'active') {
      fail('credential_revoked', 'The local OIDC identity is not active.')
    }
    return oidcUserActor(resolved.user, resolved.identity, verified.authTime)
  }

  async me(actor: UserActor): Promise<MeResponse> {
    const [user, identity] = await Promise.all([
      this.repository.getUser(actor.userId),
      this.repository.getOidcIdentity(actor.identityId)
    ])
    if (!user || user.status !== 'active' || !identity || identity.status !== 'active' ||
        identity.userId !== user.userId || identity.issuer !== actor.issuer || identity.subject !== actor.subject) {
      fail('credential_revoked', 'The local OIDC identity is not active.')
    }
    return meResponseSchema.parse({
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      type: 'me',
      userId: user.userId,
      displayName: user.displayName,
      status: 'active',
      oidcIdentityId: identity.identityId,
      issuer: identity.issuer,
      revision: user.revision,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    })
  }

  async createDeviceEnrollment(
    actor: UserActor,
    rawInput: DeviceEnrollmentCreateRequest
  ): Promise<DeviceEnrollmentCreateResponse> {
    const parsed = deviceEnrollmentCreateRequestSchema.safeParse(rawInput)
    if (!parsed.success) fail('validation_failed', 'The Device enrollment request is invalid.')
    const input = parsed.data
    const nonce = issueEnrollmentNonce()
    const result = await this.execute(actor, 'device.enrollment.create', input.idempotencyKey, {
      installationId: input.installationId
    }, async (tx, at) => {
      const enrollmentId = newId('enr')
      const expiresAt = new Date(new Date(at).getTime() + FIVE_MINUTES_MS).toISOString()
      await tx.insertDeviceEnrollment({
        enrollmentId,
        userId: actor.userId,
        installationId: input.installationId,
        nonceDigest: enrollmentNonceDigest(nonce),
        status: 'pending',
        revision: 1,
        expiresAt,
        createdAt: at,
        updatedAt: at
      })
      return {
        response: { enrollmentId, nonce, expiresAt },
        receiptResponse: { enrollmentId, expiresAt, replayed: true },
        resourceKind: 'device_enrollment',
        resourceId: enrollmentId
      }
    })
    if (typeof result.nonce !== 'string') {
      fail('idempotency_conflict', 'Enrollment nonce material is returned only once; create a new enrollment.')
    }
    return { enrollmentId: String(result.enrollmentId), nonce: result.nonce, expiresAt: String(result.expiresAt) }
  }

  async createDevice(actor: UserActor, rawInput: DeviceCreateRequest): Promise<DeviceResponse> {
    const parsed = deviceCreateRequestSchema.safeParse(rawInput)
    if (!parsed.success) fail('validation_failed', 'The Device creation request is invalid.')
    const input = parsed.data
    const response = await this.execute(actor, 'device.create', input.idempotencyKey, input, async (tx, at) => {
      const enrollment = await tx.getDeviceEnrollmentForUpdate(input.enrollmentId)
      if (!enrollment || enrollment.userId !== actor.userId) {
        fail('not_found', 'The Device enrollment was not found for this User.')
      }
      if (enrollment.installationId !== input.installationId) {
        fail('ownership_conflict', 'The Device enrollment belongs to a different installation.')
      }
      if (enrollment.expiresAt <= at || enrollment.status === 'expired') {
        fail('request_expired', 'The Device enrollment has expired.')
      }
      if (enrollment.status !== 'pending' || enrollment.consumedAt) {
        fail('invalid_state_transition', 'The Device enrollment was already used.')
      }
      if (enrollmentNonceDigest(input.nonce) !== enrollment.nonceDigest) {
        fail('validation_failed', 'The Device enrollment proof is invalid.')
      }
      verifyDeviceEnrollmentProof({
        facts: {
          enrollmentId: enrollment.enrollmentId,
          nonce: input.nonce,
          userId: actor.userId,
          installationId: enrollment.installationId,
          expiresAt: enrollment.expiresAt
        },
        publicKeyJwk: input.publicKeyJwk,
        signature: input.signature
      })

      await tx.lockIdempotency('device-installation', input.installationId)
      const currentInstallation = await tx.getDeviceByInstallation(input.installationId)
      if (currentInstallation) {
        fail('ownership_conflict', 'The installation already belongs to a Device.')
      }
      const device: StoredDevice = {
        deviceId: newId('dev'),
        userId: actor.userId,
        installationId: input.installationId,
        displayName: input.displayName,
        platform: input.platform,
        publicKeyJwk: input.publicKeyJwk,
        capabilitySummary: [...input.capabilitySummary],
        status: 'active',
        revision: 1,
        createdAt: at,
        updatedAt: at
      }
      await tx.insertDevice(device)
      if (!await tx.consumeDeviceEnrollment(enrollment.enrollmentId, at, enrollment.revision)) {
        fail('revision_conflict', 'The Device enrollment was consumed concurrently.')
      }
      return {
        response: { device: publicDevice(device) },
        resourceKind: 'device',
        resourceId: device.deviceId
      }
    })
    return deviceResponseSchema.parse(response)
  }

  async listDevices(actor: UserActor): Promise<DeviceListResponse> {
    const devices = await this.repository.listDevicesForUser(actor.userId)
    return deviceListResponseSchema.parse({ devices: devices.map(publicDevice) })
  }

  async revokeDevice(actor: UserActor, deviceId: string, idempotencyKey: string): Promise<DeviceResponse> {
    this.requireRecentAuthentication(actor)
    const response = await this.execute(actor, 'device.revoke', idempotencyKey, { deviceId }, async (tx, at) => {
      const device = await tx.getDeviceForUpdate(deviceId)
      if (!device || device.userId !== actor.userId) fail('not_found', 'The Device was not found for this User.')
      if (device.status === 'revoked') {
        return { response: { device: publicDevice(device) }, resourceKind: 'device', resourceId: device.deviceId }
      }
      const revoked: StoredDevice = {
        ...device,
        status: 'revoked',
        revision: device.revision + 1,
        updatedAt: at,
        revokedAt: at
      }
      await tx.updateDevice(revoked, device.revision)
      await tx.revokeAgentCredentialsForDevice(device.deviceId, at)
      return { response: { device: publicDevice(revoked) }, resourceKind: 'device', resourceId: device.deviceId }
    })
    return deviceResponseSchema.parse(response)
  }

  async beginZulipBinding(actor: UserActor, rawInput: ZulipBindingBeginRequest): Promise<ZulipBindingBeginResponse> {
    const parsed = zulipBindingBeginRequestSchema.safeParse(rawInput)
    if (!parsed.success) fail('validation_failed', 'The Zulip binding request is invalid.')
    const input = parsed.data
    const realmUrl = normalizeRealmUrl(input.realmUrl)
    const bindingCode = issueBindingCode()
    const response = await this.execute(actor, 'zulip.binding.begin', input.idempotencyKey, { realmUrl }, async (tx, at) => {
      await tx.lockIdempotency('zulip-binding-user-realm', `${actor.userId}:${realmUrl}`)
      await tx.expirePendingZulipBindingRequests(actor.userId, realmUrl, at)
      const request: StoredZulipBindingRequest = {
        bindingRequestId: newId('zbr'),
        userId: actor.userId,
        realmUrl,
        codeDigest: stableDigest(bindingCode),
        status: 'pending',
        revision: 1,
        expiresAt: new Date(new Date(at).getTime() + FIVE_MINUTES_MS).toISOString(),
        createdAt: at,
        updatedAt: at
      }
      await tx.insertZulipBindingRequest(request)
      return {
        response: {
          bindingRequestId: request.bindingRequestId,
          bindingCode,
          expiresAt: request.expiresAt
        },
        receiptResponse: {
          bindingRequestId: request.bindingRequestId,
          expiresAt: request.expiresAt,
          replayed: true
        },
        resourceKind: 'zulip_binding_request',
        resourceId: request.bindingRequestId
      }
    })
    if (typeof response.bindingCode !== 'string') {
      fail('idempotency_conflict', 'Binding code material is returned only once; create a new binding request.')
    }
    return {
      bindingRequestId: String(response.bindingRequestId),
      bindingCode: response.bindingCode,
      expiresAt: String(response.expiresAt)
    }
  }

  async confirmZulipBinding(
    actor: ServiceActor,
    rawInput: ZulipBindingConfirmRequest
  ): Promise<ZulipBindingConfirmResponse> {
    const parsed = zulipBindingConfirmRequestSchema.safeParse(rawInput)
    if (!parsed.success) fail('validation_failed', 'The Zulip binding confirmation is invalid.')
    const input = parsed.data
    const realmUrl = normalizeRealmUrl(input.realmUrl)
    const response = await this.execute(actor, 'zulip.binding.confirm', input.idempotencyKey, {
      ...input,
      realmUrl
    }, async (tx, at) => {
      const replay = await tx.getZulipBindingRequestByProviderEvent(input.providerEventId)
      if (replay) {
        const identity = replay.externalIdentityId
          ? await tx.getExternalIdentity(replay.externalIdentityId)
          : null
        if (!identity || replay.codeDigest !== stableDigest(input.bindingCode) ||
            identity.realmUrl !== realmUrl || identity.realmId !== input.realmId ||
            identity.zulipUserId !== input.zulipUserId || replay.serviceActorId !== actor.clientId) {
          fail('idempotency_conflict', 'The provider event was already used for a different binding confirmation.')
        }
        return { response: { identity: publicExternalIdentity(identity) },
          resourceKind: 'external_identity', resourceId: identity.externalIdentityId }
      }

      const request = await tx.getZulipBindingRequestByCodeDigestForUpdate(stableDigest(input.bindingCode))
      if (!request) fail('not_found', 'The binding code is not recognized.')
      if (request.expiresAt <= at || request.status === 'expired') {
        fail('BINDING_CODE_EXPIRED', 'The binding code has expired.')
      }
      if (request.status !== 'pending' || request.confirmedAt) {
        fail('BINDING_CODE_USED', 'The binding code was already used.')
      }
      if (request.realmUrl !== realmUrl) fail('identity_conflict', 'The binding code belongs to a different Zulip Realm.')
      const user = await tx.getUserForUpdate(request.userId)
      if (!user || user.status !== 'active') fail('credential_revoked', 'The binding target User is not active.')

      await tx.lockZulipBindingIdentity(request.userId, input.realmId, input.zulipUserId)
      const providerIdentity = await tx.getExternalIdentityByProviderIdentity(input.realmId, input.zulipUserId)
      if (providerIdentity && providerIdentity.userId !== request.userId) {
        fail('IDENTITY_ALREADY_BOUND', 'The Zulip identity is already bound to another User.')
      }
      const activeForRealm = (await tx.listExternalIdentitiesForUser(request.userId))
        .find((identity) => identity.status === 'active' && identity.realmId === input.realmId)
      if (activeForRealm && activeForRealm.zulipUserId !== input.zulipUserId) {
        fail('identity_conflict', 'The User already has another active Zulip identity in this Realm.')
      }

      const identity = providerIdentity ?? createExternalIdentity({
        userId: request.userId,
        realmUrl,
        realmId: input.realmId,
        zulipUserId: input.zulipUserId,
        at
      })
      if (!providerIdentity) await tx.insertExternalIdentity(identity)
      const participant = await tx.getParticipant(request.userId)
      const currentPrimary = participant?.primaryHumanEndpointId
        ? await tx.getEndpoint(participant.primaryHumanEndpointId)
        : null
      if (!currentPrimary || currentPrimary.status !== 'active') {
        const updatedParticipant: StoredParticipant = {
          userId: request.userId,
          primaryHumanEndpointId: identity.humanEndpointId,
          ...(participant?.primaryAgentId ? { primaryAgentId: participant.primaryAgentId } : {}),
          status: participant?.primaryAgentId ? 'complete' : 'incomplete',
          revision: (participant?.revision ?? 0) + 1,
          updatedAt: at
        }
        await tx.upsertParticipant(updatedParticipant, participant?.revision ?? null)
      }
      const confirmed: StoredZulipBindingRequest = {
        ...request,
        status: 'confirmed',
        revision: request.revision + 1,
        updatedAt: at,
        confirmedAt: at,
        externalIdentityId: identity.externalIdentityId,
        serviceActorId: actor.clientId,
        providerEventId: input.providerEventId
      }
      await tx.updateZulipBindingRequest(confirmed, request.revision)
      return {
        response: { identity: publicExternalIdentity(identity) },
        resourceKind: 'external_identity',
        resourceId: identity.externalIdentityId
      }
    })
    return zulipBindingConfirmResponseSchema.parse(response)
  }

  async getZulipBindingStatus(
    actor: UserActor,
    bindingRequestId: string
  ): Promise<{ status: 'pending'; bindingRequestId: string } | { status: 'bound'; identity: ExternalIdentity }> {
    const request = await this.repository.getZulipBindingRequest(bindingRequestId)
    if (!request || request.userId !== actor.userId) fail('not_found', 'The binding request was not found for this User.')
    if (request.status === 'pending') {
      if (request.expiresAt <= this.timestamp()) {
        fail('BINDING_CODE_EXPIRED', 'The binding code has expired.')
      }
      return { status: 'pending', bindingRequestId }
    }
    if (request.status === 'expired') fail('BINDING_CODE_EXPIRED', 'The binding code has expired.')
    const identity = request.externalIdentityId
      ? await this.repository.getExternalIdentity(request.externalIdentityId)
      : null
    if (!identity) fail('identity_conflict', 'The confirmed binding identity is unavailable.')
    return { status: 'bound', identity: publicExternalIdentity(identity) }
  }

  async listExternalIdentities(actor: UserActor): Promise<ExternalIdentityListResponse> {
    const identities = await this.repository.listExternalIdentitiesForUser(actor.userId)
    return externalIdentityListResponseSchema.parse({ identities: identities.map(publicExternalIdentity) })
  }

  async revokeExternalIdentity(
    actor: UserActor,
    externalIdentityId: string,
    idempotencyKey: string
  ): Promise<ExternalIdentityResponse> {
    this.requireRecentAuthentication(actor)
    const response = await this.execute(actor, 'zulip.binding.revoke', idempotencyKey, {
      externalIdentityId
    }, async (tx, at) => {
      const identity = await tx.getExternalIdentityForUpdate(externalIdentityId)
      if (!identity || identity.userId !== actor.userId) {
        fail('not_found', 'The external identity was not found for this User.')
      }
      if (identity.status === 'revoked') {
        return { response: { identity: publicExternalIdentity(identity) },
          resourceKind: 'external_identity', resourceId: identity.externalIdentityId }
      }
      const revoked: StoredExternalIdentity = {
        ...identity,
        status: 'revoked',
        revision: identity.revision + 1,
        updatedAt: at,
        revokedAt: at
      }
      await tx.updateExternalIdentity(revoked, identity.revision)
      await tx.expirePendingZulipBindingRequests(actor.userId, identity.realmUrl, at)
      return { response: { identity: publicExternalIdentity(revoked) },
        resourceKind: 'external_identity', resourceId: identity.externalIdentityId }
    })
    return externalIdentityResponseSchema.parse(response)
  }

  async recordRejectedBoundary(actor: IdentityActor, operation: string, error: CollaborationServiceError): Promise<void> {
    if (error.auditRecorded) return
    await this.repository.transaction((tx) => tx.insertAudit(rejectedAudit(actor, operation, error.code, this.timestamp())))
    error.auditRecorded = true
  }

  private requireRecentAuthentication(actor: UserActor): void {
    const nowSeconds = Math.floor(this.now().getTime() / 1_000)
    const ageSeconds = nowSeconds - actor.authTime
    if (!Number.isSafeInteger(actor.authTime) || ageSeconds < 0 || ageSeconds > 300) {
      fail('assurance_insufficient', 'Recent OIDC authentication is required for this operation.')
    }
  }

  private async execute<T extends Record<string, unknown>>(
    actor: IdentityActor,
    operation: string,
    idempotencyKey: string,
    request: unknown,
    work: (tx: CollaborationTransaction, at: string) => Promise<IdentityCommandResult<T>>
  ): Promise<Record<string, unknown>> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 300) {
      fail('validation_failed', 'A valid idempotency key is required.')
    }
    const actorKey = identityActorKey(actor)
    const requestDigest = stableDigest(request)
    const at = this.timestamp()
    try {
      return await this.repository.transaction(async (tx) => {
        await tx.lockIdempotency(actorKey, idempotencyKey)
        const existing = await tx.getReceipt(actorKey, idempotencyKey)
        if (existing) {
          if (existing.operation !== operation || existing.requestDigest !== requestDigest) {
            fail('idempotency_conflict', 'The idempotency key was already used for a different request.')
          }
          return existing.response
        }
        const result = await work(tx, at)
        await tx.insertAudit(acceptedAudit(actor, operation, result, idempotencyKey, at))
        const receipt: StoredReceipt = {
          receiptId: `rcp_${stableDigest({ actorKey, idempotencyKey }).slice(0, 24)}`,
          actorKey,
          idempotencyKey,
          requestDigest,
          operation,
          resourceKind: result.resourceKind,
          resourceId: result.resourceId,
          response: result.receiptResponse ?? result.response,
          createdAt: at,
          expiresAt: new Date(new Date(at).getTime() + RECEIPT_TTL_MS).toISOString()
        }
        await tx.insertReceipt(receipt)
        return result.response
      })
    } catch (error) {
      const serviceError = error instanceof CollaborationServiceError ? error : undefined
      const recorded = await this.repository.transaction((tx) => tx.insertAudit(
        rejectedAudit(actor, operation, serviceError?.code ?? 'internal_error', this.timestamp(), idempotencyKey)
      )).then(() => true).catch(() => false)
      if (serviceError && recorded) serviceError.auditRecorded = true
      throw error
    }
  }

  private timestamp(): string {
    const timestamp = this.now().toISOString()
    if (timestamp === 'Invalid Date') throw new Error('Identity clock is invalid.')
    return timestamp
  }
}

function oidcDisplayName(verified: VerifiedOidcIdentity): string {
  const value = verified.displayName ?? verified.preferredUsername ?? 'SciForge User'
  return value.trim().slice(0, 200) || 'SciForge User'
}

function oidcUserActor(user: StoredUser, identity: StoredOidcIdentity, authTime: number): UserActor {
  return {
    kind: 'user',
    actorKey: `oidc:${identity.identityId}`,
    userId: user.userId,
    identityId: identity.identityId,
    issuer: identity.issuer,
    subject: identity.subject,
    authTime,
    assurance: 'verified'
  }
}

function publicDevice(device: StoredDevice): Device {
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    type: 'device',
    deviceId: device.deviceId,
    userId: device.userId,
    installationId: device.installationId,
    displayName: device.displayName,
    platform: device.platform,
    publicKeyJwk: device.publicKeyJwk,
    capabilitySummary: [...device.capabilitySummary],
    status: device.status,
    revision: device.revision,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    ...(device.revokedAt ? { revokedAt: device.revokedAt } : {})
  }
}

function createExternalIdentity(input: Readonly<{
  userId: string
  realmUrl: string
  realmId: string
  zulipUserId: string
  at: string
}>): StoredExternalIdentity {
  return {
    externalIdentityId: newId('xid'),
    humanEndpointId: newId('hep'),
    userId: input.userId,
    provider: 'zulip',
    realmUrl: input.realmUrl,
    realmId: input.realmId,
    zulipUserId: input.zulipUserId,
    status: 'active',
    revision: 1,
    verifiedAt: input.at,
    createdAt: input.at,
    updatedAt: input.at
  }
}

function publicExternalIdentity(identity: StoredExternalIdentity): ExternalIdentity {
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    type: 'external_identity',
    externalIdentityId: identity.externalIdentityId,
    provider: 'zulip',
    userId: identity.userId,
    realmUrl: identity.realmUrl,
    realmId: identity.realmId,
    zulipUserId: identity.zulipUserId,
    humanEndpointId: identity.humanEndpointId,
    status: identity.status,
    verifiedAt: identity.verifiedAt,
    revision: identity.revision,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    ...(identity.revokedAt ? { revokedAt: identity.revokedAt } : {})
  }
}

function normalizeRealmUrl(value: string): string {
  const parsed = new URL(value)
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '')
  return `${parsed.origin}${pathname}`
}

function identityActorKey(actor: IdentityActor): string {
  return actor.kind === 'service' ? `service:${actor.clientId}` : actor.actorKey
}

function identityAuditActor(actor: IdentityActor): Pick<StoredAuditEvent, 'actorKind' | 'actorUserId' | 'metadata'> {
  return actor.kind === 'service'
    ? { actorKind: 'service', metadata: safeAuditMetadata({ serviceClientId: actor.clientId }) }
    : { actorKind: 'user', actorUserId: actor.userId, metadata: {} }
}

function acceptedAudit(
  actor: IdentityActor,
  operation: string,
  result: IdentityCommandResult<Record<string, unknown>>,
  idempotencyKey: string,
  at: string
): StoredAuditEvent {
  const actorFields = identityAuditActor(actor)
  return {
    auditEventId: newId('audit'),
    actorKind: actorFields.actorKind,
    ...(actorFields.actorUserId ? { actorUserId: actorFields.actorUserId } : {}),
    action: operation,
    resourceKind: result.resourceKind,
    resourceId: result.resourceId,
    outcome: 'accepted',
    metadata: safeAuditMetadata({ ...actorFields.metadata, idempotencyKeyDigest: stableDigest(idempotencyKey) }),
    createdAt: at
  }
}

function rejectedAudit(
  actor: IdentityActor,
  operation: string,
  errorCode: string,
  at: string,
  idempotencyKey?: string
): StoredAuditEvent {
  const actorFields = identityAuditActor(actor)
  return {
    auditEventId: newId('audit'),
    actorKind: actorFields.actorKind,
    ...(actorFields.actorUserId ? { actorUserId: actorFields.actorUserId } : {}),
    action: operation,
    outcome: 'rejected',
    metadata: safeAuditMetadata({
      ...actorFields.metadata,
      errorCode,
      ...(idempotencyKey ? { idempotencyKeyDigest: stableDigest(idempotencyKey) } : {})
    }),
    createdAt: at
  }
}
