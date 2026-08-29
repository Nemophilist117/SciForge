import { createHash, randomUUID } from 'node:crypto'

import {
  CURRENT_PROTOCOL_VERSION,
  providerDirectoryPrincipalFactListQuerySchema,
  providerDirectoryPrincipalFactPublishCommandSchema,
  providerDirectoryPrincipalFactSchema,
  providerDirectoryPrincipalReferenceSchema,
  providerInstanceReferenceSchema,
  revisionSchema,
  type ProviderDirectoryPrincipalFact
} from '@sciforge/collaboration-contracts'
import { domainPackageJsonValueSchema } from '@sciforge/domain-sdk/contract'
import { canonicalizeReproValue } from '@sciforge/domain-sdk/reproducibility'
import {
  AUTHENTICATED_CLOUD_COMMAND_OPERATION_ID,
  AuthenticatedCloudTransportError,
  type AuthenticatedCloudTransport,
  type AuthenticatedCloudTransportStatus
} from '@sciforge/domain-identity-access/authenticated-cloud-transport'

import {
  ContentSpaceOperationError,
  contentSpaceProviderPrincipalSyncReceiptSchema,
  type ContentSpaceError,
  type ContentSpaceProviderPrincipalSyncReceipt
} from '../contract.js'
import type {
  ContentSpaceProviderPrincipalBindingObservation,
  ContentSpaceService,
  ContentSpaceServiceWriteCallContext
} from './service.js'

type ReadyCloudStatus = Extract<AuthenticatedCloudTransportStatus, { state: 'ready' }>

type SyncObservation = Readonly<{
  status: ReadyCloudStatus
  provider: ContentSpaceProviderPrincipalBindingObservation
  slot: ProviderDirectoryPrincipalFact | null
  observedAt: string
}>

type PublishResult =
  | Readonly<{ status: 'published' }>
  | Readonly<{ status: 'revision-conflict' }>

export class ContentSpaceProviderPrincipalSyncOrchestrator {
  readonly #service: Pick<ContentSpaceService, 'observeProviderPrincipalBinding'>
  readonly #transport: AuthenticatedCloudTransport
  readonly #now: () => Date
  readonly #requestId: () => `req_${string}`

  constructor(options: Readonly<{
    service: Pick<ContentSpaceService, 'observeProviderPrincipalBinding'>
    transport: AuthenticatedCloudTransport
    now?: () => Date
    requestId?: () => `req_${string}`
  }>) {
    this.#service = options.service
    this.#transport = options.transport
    this.#now = options.now ?? (() => new Date())
    this.#requestId = options.requestId ?? (() => `req_${randomUUID().replaceAll('-', '')}`)
  }

  async sync(
    providerInstanceRef: string,
    call: ContentSpaceServiceWriteCallContext
  ): Promise<ContentSpaceProviderPrincipalSyncReceipt> {
    const first = await this.#observe(providerInstanceRef, call)
    const firstPublish = await this.#publish(first, call)
    if (firstPublish.status === 'published') {
      return syncReceipt(providerInstanceRef)
    }

    const second = await this.#observe(providerInstanceRef, call)
    if (!sameReadyCloudStatus(first.status, second.status)) {
      throw syncError(
        'conflict',
        'The SciForge Cloud Device authority changed during synchronization.',
        'after-human-action'
      )
    }
    if (!sameProviderObservation(first.provider, second.provider)) {
      throw syncError(
        'unauthorized',
        'The Content Space Provider connection changed during synchronization.',
        'after-human-action'
      )
    }
    if (sameFactSlot(first.slot, second.slot)) {
      throw syncError(
        'conflict',
        'The Provider Principal Fact could not be reconciled safely.',
        'after-human-action'
      )
    }

    const secondPublish = await this.#publish(second, call)
    if (secondPublish.status === 'revision-conflict') {
      throw syncError(
        'conflict',
        'The Provider Principal Fact changed again during synchronization.',
        'after-human-action'
      )
    }
    return syncReceipt(providerInstanceRef)
  }

  async #observe(
    providerInstanceRef: string,
    call: ContentSpaceServiceWriteCallContext
  ): Promise<SyncObservation> {
    await assertPrincipalCurrent(call)
    const initialStatus = requireReadyCloudStatus(this.#transport.status(), call)
    const initialProvider = await this.#service.observeProviderPrincipalBinding(
      providerInstanceRef,
      call
    )
    const slot = await this.#listCurrentSlot(initialStatus, providerInstanceRef, call)
    const finalProvider = await this.#service.observeProviderPrincipalBinding(
      providerInstanceRef,
      call
    )
    const finalStatus = requireReadyCloudStatus(this.#transport.status(), call)
    if (!sameReadyCloudStatus(initialStatus, finalStatus)) {
      throw syncError(
        'conflict',
        'The SciForge Cloud Device authority changed during synchronization.',
        'after-human-action'
      )
    }
    if (!sameProviderObservation(initialProvider, finalProvider)) {
      throw syncError(
        'unauthorized',
        'The Content Space Provider connection changed during synchronization.',
        'after-human-action'
      )
    }
    await assertPrincipalCurrent(call)
    return Object.freeze({
      status: finalStatus,
      provider: finalProvider,
      slot,
      observedAt: this.#now().toISOString()
    })
  }

  async #listCurrentSlot(
    status: ReadyCloudStatus,
    providerInstanceRef: string,
    call: ContentSpaceServiceWriteCallContext
  ): Promise<ProviderDirectoryPrincipalFact | null> {
    const request = providerDirectoryPrincipalFactListQuerySchema.parse({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: this.#requestId(),
      type: 'provider_directory_principal.list',
      userIds: [status.userId],
      providerInstance: providerInstanceReferenceSchema.parse({
        schemaVersion: 1,
        type: 'provider_instance_reference',
        providerInstanceRef
      }),
      includeDegraded: true,
      limit: 2
    })
    let response
    try {
      response = await this.#transport.execute({
        contractVersion: 1,
        operationId: AUTHENTICATED_CLOUD_COMMAND_OPERATION_ID,
        payload: request
      }, { signal: call.signal })
    } catch (error) {
      throw cloudReadError(error)
    }
    if (response.body.type === 'rest.error') {
      if (response.body.requestId !== request.requestId) {
        throw syncError(
          'provider_unavailable',
          'SciForge Cloud returned an unbound Provider Principal Fact error.',
          'never'
        )
      }
      throw cloudResponseError(response.body, false)
    }
    if (response.status >= 400) {
      throw syncError(
        'provider_unavailable',
        'SciForge Cloud could not read the Provider Principal Fact slot.',
        'safe-with-same-invocation'
      )
    }
    if (response.body.type !== 'rest.provider_directory_principal_page' ||
      response.body.requestId !== request.requestId) {
      throw syncError(
        'provider_unavailable',
        'SciForge Cloud returned an invalid Provider Principal Fact page.',
        'safe-with-same-invocation'
      )
    }
    if (response.body.items.length > 1 || response.body.nextFactId !== undefined) {
      throw syncError(
        'conflict',
        'SciForge Cloud returned multiple facts for one Provider Principal slot.',
        'after-human-action'
      )
    }
    const slot = response.body.items[0] ?? null
    if (slot && (
      slot.userId !== status.userId ||
      slot.providerPrincipal.providerInstance.providerInstanceRef !== providerInstanceRef
    )) {
      throw syncError(
        'provider_unavailable',
        'SciForge Cloud returned a Provider Principal Fact outside the requested slot.',
        'never'
      )
    }
    await assertPrincipalCurrent(call)
    return slot
  }

  async #publish(
    observation: SyncObservation,
    call: ContentSpaceServiceWriteCallContext
  ): Promise<PublishResult> {
    await assertPrincipalCurrent(call)
    const providerPrincipal = providerDirectoryPrincipalReferenceSchema.parse({
      schemaVersion: 1,
      type: 'provider_directory_principal_reference',
      providerInstance: {
        schemaVersion: 1,
        type: 'provider_instance_reference',
        providerInstanceRef: observation.provider.providerInstanceRef
      },
      principalKind: 'user',
      principalId: observation.provider.directoryUser.principalId
    })
    const principalIdentityRevision = revisionSchema.safeParse(
      call.reauthorizedPrincipal.identityVersion
    )
    if (!principalIdentityRevision.success) {
      throw syncError(
        'unauthorized',
        'The current SciForge Cloud Principal revision is invalid.',
        'after-human-action'
      )
    }
    const commandBody = Object.freeze({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      type: 'provider_directory_principal.publish' as const,
      providerPrincipalFactId: observation.slot?.providerPrincipalFactId ?? null,
      expectedFactRevision: observation.slot?.revision ?? null,
      deviceId: observation.status.deviceId,
      expectedDeviceRevision: observation.status.deviceEntityRevision,
      providerPrincipal,
      principalIdentityRevision: principalIdentityRevision.data,
      providerBindingAttestationDigest: digestCanonical(observation.provider.binding),
      readiness: 'ready' as const,
      readinessReason: null,
      observedAt: observation.observedAt
    })
    const command = providerDirectoryPrincipalFactPublishCommandSchema.parse({
      ...commandBody,
      requestId: this.#requestId(),
      idempotencyKey: `idem_content_space_${digestCanonical({
        invocationId: call.invocationId,
        command: commandBody
      })}`
    })
    let response
    try {
      response = await this.#transport.execute({
        contractVersion: 1,
        operationId: AUTHENTICATED_CLOUD_COMMAND_OPERATION_ID,
        payload: command
      }, { signal: call.signal })
    } catch (error) {
      throw cloudPublishError(error)
    }
    if (response.body.type === 'rest.error') {
      if (response.body.requestId !== command.requestId) {
        throw syncError(
          'outcome_unknown',
          'SciForge Cloud returned an unbound Provider Principal Fact publish error.',
          'never'
        )
      }
      if (response.body.error.code === 'revision_conflict') {
        return Object.freeze({ status: 'revision-conflict' })
      }
      throw cloudResponseError(response.body, true)
    }
    if (response.status >= 400 || response.body.type !== 'rest.entity' ||
      response.body.requestId !== command.requestId) {
      throw syncError(
        'outcome_unknown',
        'SciForge Cloud did not confirm the Provider Principal Fact publish.',
        'never'
      )
    }
    const published = providerDirectoryPrincipalFactSchema.safeParse(response.body.entity)
    const expectedRevision = observation.slot ? observation.slot.revision + 1 : 1
    if (!published.success ||
      published.data.userId !== observation.status.userId ||
      published.data.providerPrincipalFactId !==
        (observation.slot?.providerPrincipalFactId ?? published.data.providerPrincipalFactId) ||
      published.data.revision !== expectedRevision ||
      published.data.publishedByDeviceId !== command.deviceId ||
      published.data.principalIdentityRevision !== command.principalIdentityRevision ||
      published.data.providerBindingAttestationDigest !==
        command.providerBindingAttestationDigest ||
      published.data.readiness !== command.readiness ||
      published.data.readinessReason !== command.readinessReason ||
      published.data.observedAt !== command.observedAt ||
      !sameProviderPrincipal(published.data.providerPrincipal, command.providerPrincipal)) {
      throw syncError(
        'outcome_unknown',
        'SciForge Cloud returned an unbound Provider Principal Fact receipt.',
        'never'
      )
    }
    await assertPrincipalCurrent(call, true)
    return Object.freeze({ status: 'published' })
  }
}

function requireReadyCloudStatus(
  status: AuthenticatedCloudTransportStatus,
  call: ContentSpaceServiceWriteCallContext
): ReadyCloudStatus {
  const principal = call.reauthorizedPrincipal
  if (principal.authority !== 'sciforge-cloud' ||
    principal.assurance !== 'cloud-authenticated' ||
    status.state !== 'ready' ||
    principal.subject !== status.userId ||
    principal.deviceId !== status.deviceId) {
    throw syncError(
      'unauthorized',
      'A current SciForge Cloud Principal and ACTIVE Device are required.',
      'after-human-action'
    )
  }
  return status
}

async function assertPrincipalCurrent(
  call: ContentSpaceServiceWriteCallContext,
  afterPublish = false
): Promise<void> {
  try {
    await call.assertPrincipalCurrent()
  } catch {
    throw syncError(
      afterPublish ? 'outcome_unknown' : 'unauthorized',
      afterPublish
        ? 'The Principal changed before the publish result could be accepted.'
        : 'The Host Principal is no longer current.',
      afterPublish ? 'never' : 'after-human-action'
    )
  }
}

function cloudReadError(error: unknown): ContentSpaceOperationError {
  if (error instanceof AuthenticatedCloudTransportError &&
    (error.code === 'identity_required' || error.code === 'device_required')) {
    return syncError(
      'unauthorized',
      'A current SciForge Cloud Principal and ACTIVE Device are required.',
      'after-human-action'
    )
  }
  return syncError(
    'provider_unavailable',
    'SciForge Cloud is unavailable before Provider Principal synchronization.',
    'safe-with-same-invocation'
  )
}

function cloudPublishError(error: unknown): ContentSpaceOperationError {
  if (error instanceof AuthenticatedCloudTransportError) {
    if (error.code === 'identity_required' || error.code === 'device_required') {
      return syncError(
        'unauthorized',
        'A current SciForge Cloud Principal and ACTIVE Device are required.',
        'after-human-action'
      )
    }
    if (error.code === 'transport_unavailable' || error.code === 'operation_not_allowed') {
      return syncError(
        'provider_unavailable',
        'SciForge Cloud rejected the publish before dispatch.',
        'safe-with-same-invocation'
      )
    }
  }
  return syncError(
    'outcome_unknown',
    'The Provider Principal Fact publish outcome cannot be proven.',
    'never'
  )
}

function cloudResponseError(
  body: Extract<Awaited<ReturnType<AuthenticatedCloudTransport['execute']>>['body'], {
    type: 'rest.error'
  }>,
  publish: boolean
): ContentSpaceOperationError {
  const code = body.error.code
  if (code === 'authentication_required' || code === 'credential_revoked' ||
    code === 'permission_denied' || code === 'assurance_insufficient') {
    return syncError('unauthorized', 'SciForge Cloud authority is unavailable.', 'after-human-action')
  }
  if (code === 'revision_conflict' || code === 'idempotency_conflict' ||
    code === 'identity_conflict' || code === 'ownership_conflict' ||
    code === 'invalid_state_transition') {
    return syncError('conflict', 'SciForge Cloud authority changed.', 'after-human-action')
  }
  if (code === 'rate_limited') {
    return syncError('rate_limited', 'SciForge Cloud rate limited the request.', 'safe-with-same-invocation')
  }
  return syncError(
    'provider_unavailable',
    publish
      ? 'SciForge Cloud rejected the Provider Principal Fact publish.'
      : 'SciForge Cloud could not read the Provider Principal Fact slot.',
    body.error.retryable ? 'safe-with-same-invocation' : 'never'
  )
}

function digestCanonical(value: unknown): string {
  const canonical = canonicalizeReproValue(domainPackageJsonValueSchema.parse(value))
  return createHash('sha256').update(canonical).digest('hex')
}

function sameReadyCloudStatus(left: ReadyCloudStatus, right: ReadyCloudStatus): boolean {
  return left.baseUrl === right.baseUrl &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.deviceEntityRevision === right.deviceEntityRevision
}

function sameProviderObservation(
  left: ContentSpaceProviderPrincipalBindingObservation,
  right: ContentSpaceProviderPrincipalBindingObservation
): boolean {
  return left.providerInstanceRef === right.providerInstanceRef &&
    left.directoryUser.providerInstanceRef === right.directoryUser.providerInstanceRef &&
    left.directoryUser.principalId === right.directoryUser.principalId &&
    left.binding.providerInstanceRef === right.binding.providerInstanceRef &&
    left.binding.externalSubject === right.binding.externalSubject &&
    left.binding.bindingRevision === right.binding.bindingRevision &&
    left.binding.principal.authority === right.binding.principal.authority &&
    left.binding.principal.subject === right.binding.principal.subject &&
    left.binding.principal.assurance === right.binding.principal.assurance &&
    left.binding.principal.deviceId === right.binding.principal.deviceId &&
    left.binding.principal.identityVersion === right.binding.principal.identityVersion
}

function sameFactSlot(
  left: ProviderDirectoryPrincipalFact | null,
  right: ProviderDirectoryPrincipalFact | null
): boolean {
  if (left === null || right === null) return left === right
  return left.providerPrincipalFactId === right.providerPrincipalFactId &&
    left.revision === right.revision
}

function sameProviderPrincipal(
  left: ProviderDirectoryPrincipalFact['providerPrincipal'],
  right: ProviderDirectoryPrincipalFact['providerPrincipal']
): boolean {
  return left.providerInstance.providerInstanceRef ===
    right.providerInstance.providerInstanceRef &&
    left.principalKind === right.principalKind &&
    left.principalId === right.principalId
}

function syncReceipt(providerInstanceRef: string): ContentSpaceProviderPrincipalSyncReceipt {
  return contentSpaceProviderPrincipalSyncReceiptSchema.parse({
    providerInstanceRef,
    status: 'synchronized'
  })
}

function syncError(
  code: ContentSpaceError['code'],
  message: string,
  retry: ContentSpaceError['retry']
): ContentSpaceOperationError {
  return new ContentSpaceOperationError({ code, message, retry })
}
