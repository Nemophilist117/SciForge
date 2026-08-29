import { describe, expect, it, vi } from 'vitest'

import {
  createCollaborationError,
  providerDirectoryPrincipalFactSchema,
  type ProviderDirectoryPrincipalFact,
  type RestRequest
} from '@sciforge/collaboration-contracts'
import type { PrincipalSnapshot } from '@sciforge/domain-sdk/principal'
import {
  AuthenticatedCloudTransportError,
  type AuthenticatedCloudResponse,
  type AuthenticatedCloudTransport,
  type AuthenticatedCloudTransportStatus
} from '@sciforge/domain-identity-access/authenticated-cloud-transport'

import type { ContentSpaceProviderPrincipalBindingObservation } from './service.js'
import { ContentSpaceProviderPrincipalSyncOrchestrator } from './provider-principal-sync.js'

const PROVIDER_INSTANCE_REF = 'opencontent.run0'
const USER_ID = 'usr_ContentUser001'
const DEVICE_ID = 'dev_ContentDevice01'
const FACT_ID = 'ppf_ContentFact0001'
const OBSERVED_AT = '2026-08-28T08:00:00.000Z'
const CREATED_AT = '2026-08-28T07:00:00.000Z'

const principal: PrincipalSnapshot = Object.freeze({
  authority: 'sciforge-cloud',
  subject: USER_ID,
  assurance: 'cloud-authenticated',
  deviceId: DEVICE_ID,
  identityVersion: 7
})

const providerObservation: ContentSpaceProviderPrincipalBindingObservation = Object.freeze({
  providerInstanceRef: PROVIDER_INSTANCE_REF,
  binding: Object.freeze({
    providerInstanceRef: PROVIDER_INSTANCE_REF,
    principal,
    externalSubject: 'a'.repeat(64),
    bindingRevision: 'b'.repeat(64)
  }),
  directoryUser: Object.freeze({
    providerInstanceRef: PROVIDER_INSTANCE_REF,
    kind: 'user',
    principalId: 'opencontent-user-001'
  })
})

const readyStatus: Extract<AuthenticatedCloudTransportStatus, { state: 'ready' }> =
  Object.freeze({
    state: 'ready',
    baseUrl: 'https://cloud.sciforge.invalid',
    userId: USER_ID,
    deviceId: DEVICE_ID,
    deviceEntityRevision: 11
  })

describe('ContentSpaceProviderPrincipalSyncOrchestrator', () => {
  it('publishes the exact provider-neutral slot through the existing Cloud protocol', async () => {
    const service = serviceFixture()
    const publishCommands: PublishCommand[] = []
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        expect(payload).toMatchObject({
          userIds: [USER_ID],
          providerInstance: {
            schemaVersion: 1,
            type: 'provider_instance_reference',
            providerInstanceRef: PROVIDER_INSTANCE_REF
          },
          includeDegraded: true,
          limit: 2
        })
        return principalPage(payload.requestId, [])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        publishCommands.push(payload)
        return publishedResponse(payload)
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    const orchestrator = orchestratorFor(service, transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall())).resolves.toEqual({
      providerInstanceRef: PROVIDER_INSTANCE_REF,
      status: 'synchronized'
    })
    expect(service.observeProviderPrincipalBinding).toHaveBeenCalledTimes(2)
    expect(publishCommands).toHaveLength(1)
    expect(publishCommands[0]).toMatchObject({
      type: 'provider_directory_principal.publish',
      providerPrincipalFactId: null,
      expectedFactRevision: null,
      deviceId: DEVICE_ID,
      expectedDeviceRevision: 11,
      providerPrincipal: {
        providerInstance: { providerInstanceRef: PROVIDER_INSTANCE_REF },
        principalKind: 'user',
        principalId: 'opencontent-user-001'
      },
      principalIdentityRevision: 7,
      readiness: 'ready',
      readinessReason: null,
      observedAt: OBSERVED_AT
    })
    expect(publishCommands[0]?.providerBindingAttestationDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(publishCommands[0]?.idempotencyKey).toMatch(/^idem_content_space_[a-f0-9]{64}$/u)
  })

  it('uses the same idempotency key for the same observed payload and invocation', async () => {
    const publishKeys: string[] = []
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        return principalPage(payload.requestId, [])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        publishKeys.push(payload.idempotencyKey)
        return publishedResponse(payload)
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    const orchestrator = orchestratorFor(serviceFixture(), transportFixture(execute))
    const call = writeCall()

    await orchestrator.sync(PROVIDER_INSTANCE_REF, call)
    await orchestrator.sync(PROVIDER_INSTANCE_REF, call)

    expect(publishKeys).toHaveLength(2)
    expect(publishKeys[1]).toBe(publishKeys[0])
  })

  it('fails closed when the Principal identity revision is not a Cloud revision', async () => {
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        return principalPage(payload.requestId, [])
      }
      throw new Error('Publish must not be dispatched with an invalid Principal revision.')
    })
    const orchestrator = orchestratorFor(serviceFixture(), transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall({
      ...principal,
      identityVersion: 0
    }))).rejects.toMatchObject({
      detail: { code: 'unauthorized', retry: 'after-human-action' }
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects an unbound list error before publishing', async () => {
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type !== 'provider_directory_principal.list') {
        throw new Error('Publish must not follow an unbound list response.')
      }
      return errorResponse('req_MismatchedList01', 'revision_conflict')
    })
    const orchestrator = orchestratorFor(serviceFixture(), transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall())).rejects.toMatchObject({
      detail: { code: 'provider_unavailable', retry: 'never' }
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('treats an unbound publish error as outcome unknown and never retries', async () => {
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        return principalPage(payload.requestId, [])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        return errorResponse('req_MismatchedWrite1', 'revision_conflict')
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    const orchestrator = orchestratorFor(serviceFixture(), transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall())).rejects.toMatchObject({
      detail: { code: 'outcome_unknown', retry: 'never' }
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('reobserves one complete slot after a Fact conflict and changes the payload key', async () => {
    const firstSlot = factFixture(1)
    const secondSlot = factFixture(2)
    let listCount = 0
    const publishCommands: PublishCommand[] = []
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        listCount += 1
        return principalPage(payload.requestId, [listCount === 1 ? firstSlot : secondSlot])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        publishCommands.push(payload)
        if (publishCommands.length === 1) {
          return errorResponse(payload.requestId, 'revision_conflict')
        }
        return publishedResponse(payload)
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    const service = serviceFixture()
    const orchestrator = orchestratorFor(service, transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall())).resolves.toEqual({
      providerInstanceRef: PROVIDER_INSTANCE_REF,
      status: 'synchronized'
    })
    expect(service.observeProviderPrincipalBinding).toHaveBeenCalledTimes(4)
    expect(publishCommands).toHaveLength(2)
    expect(publishCommands.map(({ expectedFactRevision }) => expectedFactRevision)).toEqual([1, 2])
    expect(publishCommands[1]?.idempotencyKey).not.toBe(publishCommands[0]?.idempotencyKey)
  })

  it('stops before a second publish when Device authority drifts during conflict recovery', async () => {
    const statuses = [
      readyStatus,
      readyStatus,
      { ...readyStatus, deviceEntityRevision: 12 },
      { ...readyStatus, deviceEntityRevision: 12 }
    ] satisfies AuthenticatedCloudTransportStatus[]
    let statusIndex = 0
    let listCount = 0
    let publishCount = 0
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        listCount += 1
        return principalPage(payload.requestId, [factFixture(listCount)])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        publishCount += 1
        return errorResponse(payload.requestId, 'revision_conflict')
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    const transport = transportFixture(execute, () => statuses[statusIndex++] ?? statuses.at(-1)!)
    const orchestrator = orchestratorFor(serviceFixture(), transport)

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall())).rejects.toMatchObject({
      detail: { code: 'conflict', retry: 'after-human-action' }
    })
    expect(publishCount).toBe(1)
  })

  it('does not retry when a dispatched publish outcome cannot be proven', async () => {
    let publishCount = 0
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        return principalPage(payload.requestId, [])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        publishCount += 1
        throw new AuthenticatedCloudTransportError(
          'cloud_unavailable',
          'The connection closed after dispatch.'
        )
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    const orchestrator = orchestratorFor(serviceFixture(), transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, writeCall())).rejects.toMatchObject({
      detail: { code: 'outcome_unknown', retry: 'never' }
    })
    expect(publishCount).toBe(1)
  })

  it('reports outcome unknown when the Principal lease expires after a confirmed publish', async () => {
    const execute = vi.fn<AuthenticatedCloudTransport['execute']>(async ({ payload }) => {
      if (payload.type === 'provider_directory_principal.list') {
        return principalPage(payload.requestId, [])
      }
      if (payload.type === 'provider_directory_principal.publish') {
        return publishedResponse(payload)
      }
      throw new Error(`Unexpected Cloud command ${payload.type}`)
    })
    let principalChecks = 0
    const call = Object.freeze({
      ...writeCall(),
      assertPrincipalCurrent: vi.fn(async () => {
        principalChecks += 1
        if (principalChecks === 5) throw new Error('Principal lease expired after publish.')
      })
    })
    const orchestrator = orchestratorFor(serviceFixture(), transportFixture(execute))

    await expect(orchestrator.sync(PROVIDER_INSTANCE_REF, call)).rejects.toMatchObject({
      detail: { code: 'outcome_unknown', retry: 'never' }
    })
    expect(principalChecks).toBe(5)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

type PublishCommand = Extract<RestRequest, { type: 'provider_directory_principal.publish' }>

function orchestratorFor(
  service: ReturnType<typeof serviceFixture>,
  transport: AuthenticatedCloudTransport
): ContentSpaceProviderPrincipalSyncOrchestrator {
  let requestSequence = 0
  return new ContentSpaceProviderPrincipalSyncOrchestrator({
    service,
    transport,
    now: () => new Date(OBSERVED_AT),
    requestId: () => {
      requestSequence += 1
      return `req_ContentSync${String(requestSequence).padStart(3, '0')}` as `req_${string}`
    }
  })
}

function serviceFixture(
  observations: readonly ContentSpaceProviderPrincipalBindingObservation[] = [providerObservation]
) {
  let index = 0
  return Object.freeze({
    observeProviderPrincipalBinding: vi.fn(async () =>
      observations[Math.min(index++, observations.length - 1)]!
    )
  })
}

function transportFixture(
  execute: AuthenticatedCloudTransport['execute'],
  status: AuthenticatedCloudTransport['status'] = () => readyStatus
): AuthenticatedCloudTransport {
  return Object.freeze({ status, execute })
}

function writeCall(
  reauthorizedPrincipal: PrincipalSnapshot = principal
) {
  return Object.freeze({
    reauthorizedPrincipal,
    assertPrincipalCurrent: vi.fn(async () => undefined),
    audience: 'ui' as const,
    invocationId: 'invocation_content_space_sync_0001',
    signal: new AbortController().signal
  })
}

function principalPage(
  requestId: string,
  items: readonly ProviderDirectoryPrincipalFact[]
): AuthenticatedCloudResponse {
  return Object.freeze({
    contractVersion: 1 as const,
    status: 200,
    body: Object.freeze({
      protocolVersion: '1.0' as const,
      type: 'rest.provider_directory_principal_page' as const,
      requestId,
      items: [...items]
    })
  })
}

function errorResponse(
  requestId: string,
  code: 'revision_conflict'
): AuthenticatedCloudResponse {
  return Object.freeze({
    contractVersion: 1 as const,
    status: 409,
    body: Object.freeze({
      protocolVersion: '1.0' as const,
      type: 'rest.error' as const,
      requestId,
      error: createCollaborationError(code, 'The Provider Principal Fact changed.', {
        requestId
      })
    })
  })
}

function publishedResponse(command: PublishCommand): AuthenticatedCloudResponse {
  return Object.freeze({
    contractVersion: 1 as const,
    status: 200,
    body: Object.freeze({
      protocolVersion: '1.0' as const,
      type: 'rest.entity' as const,
      requestId: command.requestId,
      entity: factFixture(
        command.expectedFactRevision === null ? 1 : command.expectedFactRevision + 1,
        command
      )
    })
  })
}

function factFixture(
  revision: number,
  command?: PublishCommand
): ProviderDirectoryPrincipalFact {
  return providerDirectoryPrincipalFactSchema.parse({
    schemaVersion: 1,
    type: 'provider_directory_principal_fact',
    providerPrincipalFactId: command?.providerPrincipalFactId ?? FACT_ID,
    userId: USER_ID,
    providerPrincipal: command?.providerPrincipal ?? {
      schemaVersion: 1,
      type: 'provider_directory_principal_reference',
      providerInstance: {
        schemaVersion: 1,
        type: 'provider_instance_reference',
        providerInstanceRef: PROVIDER_INSTANCE_REF
      },
      principalKind: 'user',
      principalId: 'opencontent-user-001'
    },
    principalIdentityRevision: command?.principalIdentityRevision ?? 7,
    providerBindingAttestationDigest: command?.providerBindingAttestationDigest ?? 'c'.repeat(64),
    publishedByDeviceId: command?.deviceId ?? DEVICE_ID,
    readiness: command?.readiness ?? 'ready',
    readinessReason: command?.readinessReason ?? null,
    observedAt: command?.observedAt ?? OBSERVED_AT,
    revision,
    createdAt: CREATED_AT,
    updatedAt: OBSERVED_AT
  })
}
