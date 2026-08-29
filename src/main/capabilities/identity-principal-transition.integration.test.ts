import {
  mkdtempSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDENTITY_CAPABILITY_IDS,
  type CloudIdentitySnapshot
} from '@sciforge/domain-identity-access/contract'
import {
  createIdentityCapabilityFactory,
  createDomainMainEntry,
  type IdentityCapabilityFactory
} from '@sciforge/domain-identity-access/main'
import {
  definePrincipalContextSnapshot,
  type DomainMainPrincipalProvider,
  type PrincipalContextSnapshot
} from '@sciforge/domain-sdk/principal'
import type {
  CapabilityInvocationResult,
  CapabilityJsonValue
} from '../../shared/capability-broker'
import { unwrapCapabilityTransportEnvelope } from '../../shared/capability-transport-error'
import { CapabilityBroker } from './broker'
import { CAPABILITY_IPC_CHANNELS, registerCapabilityIpc } from './ipc'
import type { AppCapabilityDependencies } from './app-registry'
import {
  CapabilityRegistry,
  defineCapability,
  type CapabilityDefinition,
  type DefineCapabilityOptions
} from './registry'
import {
  createApplicationCapabilityRegistry,
  createApplicationDomainCatalog
} from '../modules/application-composition'
import { createNonSecretPackageStorageForTest } from '../modules/domain-package-storage.test-helper'
import {
  createIsolatedInternalServicesForTest,
  createUnavailablePortableResourcesForTest
} from '../modules/domain-main-host.test-helper'
import { HostPrincipalContext } from '../principal-context'
import type { z } from 'zod'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Identity Principal transition Host integration', () => {
  it('starts application composition signed out without a local Principal bootstrap', () => {
    const fixture = identityApplicationIpcFixture(temporaryRoot('sciforge-identity-app-ipc-'))

    expect(fixture.principalContext.snapshot()).toEqual({
      identityVersion: 0,
      principal: null
    })
    fixture.dispose()
  })

  it('registers every Cloud mutation through the real Host schema as a global authority action', async () => {
    const fixture = identityBrokerFixture(temporaryRoot('sciforge-identity-schema-'))
    const descriptors = CLOUD_MUTATION_IDS.map((id) => fixture.definition(id).descriptor)

    expect(descriptors).toHaveLength(6)
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({
        audiences: ['ui'],
        scope: 'global',
        resourceKinds: [],
        effect: 'external-write',
        principalTransition: 'host-authority',
        concurrency: { revision: 'none', idempotency: 'required' }
      })
    }
    await expect(fixture.invoke(
      IDENTITY_CAPABILITY_IDS.cloudLogin,
      'inactive-cloud-login',
      {}
    )).rejects.toMatchObject({ code: 'handler_failed' })
    fixture.dispose()
  })

  it('re-issues Cloud resources across Principal transitions and emits only provider changes', async () => {
    const fixture = cloudIdentityBrokerFixture()
    const signedOutInspection = await fixture.inspect('inspect-signed-out-initial')
    const initialSignedOutHandle = cloudHandle(signedOutInspection.output)
    await expect(fixture.observe(initialSignedOutHandle)).resolves.toMatchObject({
      state: { identity: { state: 'signed-out' } }
    })

    const loginRequest = {
      actionId: IDENTITY_CAPABILITY_IDS.cloudLogin,
      invocationId: 'cloud-login',
      input: {}
    }
    expect(loginRequest).not.toHaveProperty('resource')
    expect(loginRequest).not.toHaveProperty('expectedRevision')
    await expect(fixture.invoke(loginRequest)).resolves.toMatchObject({
      changed: false,
      replayed: false,
      output: { identity: { state: 'signed-in' }, revision: 'cloud-2' }
    })
    expect(fixture.handlerResource(IDENTITY_CAPABILITY_IDS.cloudLogin)).toBeUndefined()
    expect(fixture.events()).toEqual([])
    await expect(fixture.observe(initialSignedOutHandle)).rejects.toMatchObject({
      code: 'resource_scope_mismatch'
    })

    const cloudInspection = await fixture.inspect('inspect-cloud')
    const cloudHandleValue = cloudHandle(cloudInspection.output)
    expect(cloudHandleValue.token).not.toBe(initialSignedOutHandle.token)
    await expect(fixture.observe(cloudHandleValue)).resolves.toMatchObject({
      state: { identity: { state: 'signed-in' } }
    })
    const deliveredEvents: unknown[] = []
    const unsubscribe = fixture.subscribe((event) => deliveredEvents.push(event))

    const refreshRequest = {
      actionId: IDENTITY_CAPABILITY_IDS.cloudRefreshDevices,
      invocationId: 'cloud-refresh',
      input: {}
    }
    await expect(fixture.invoke(refreshRequest)).resolves.toMatchObject({
      changed: false,
      output: { revision: 'cloud-3' }
    })
    expect(fixture.handlerResource(IDENTITY_CAPABILITY_IDS.cloudRefreshDevices)).toBeUndefined()
    expect(fixture.events()).toEqual([
      expect.objectContaining({
        type: 'resource.changed',
        origin: 'provider',
        beforeRevision: 'cloud-2',
        afterRevision: 'cloud-3'
      })
    ])
    expect(fixture.events()[0]).not.toHaveProperty('actionId')
    expect(fixture.events()[0]).not.toHaveProperty('invocationId')
    expect(deliveredEvents).toHaveLength(1)

    await expect(fixture.invoke({
      actionId: IDENTITY_CAPABILITY_IDS.cloudLogout,
      invocationId: 'cloud-logout',
      input: {}
    })).resolves.toMatchObject({
      changed: false,
      output: { identity: { state: 'signed-out' }, revision: 'cloud-4' }
    })
    expect(deliveredEvents).toHaveLength(1)
    expect(deliveredEvents).toEqual([
      expect.objectContaining({ origin: 'provider' })
    ])
    unsubscribe()
    await expect(fixture.observe(cloudHandleValue)).rejects.toMatchObject({
      code: 'resource_scope_mismatch'
    })

    const finalSignedOutInspection = await fixture.inspect('inspect-signed-out')
    const signedOutHandle = cloudHandle(finalSignedOutInspection.output)
    expect(signedOutHandle.token).not.toBe(cloudHandleValue.token)
    await expect(fixture.observe(signedOutHandle)).resolves.toMatchObject({
      state: { identity: { state: 'signed-out' }, revision: 'cloud-4' }
    })
    fixture.dispose()
  })
})

function identityApplicationIpcFixture(root: string) {
  const catalog = createApplicationDomainCatalog({
    getUserDataDir: () => root,
    getDeviceId: () => 'device-integration-1',
    portableResourcesFor: createUnavailablePortableResourcesForTest(),
    packageStorageFor: createNonSecretPackageStorageForTest(),
    capabilityInvokerFor: () => Object.freeze({
      invoke: async () => {
        throw new Error('Nested domain capabilities are unavailable in this test.')
      },
      createApprovedBatch: () => {
        throw new Error('Nested domain capabilities are unavailable in this test.')
      }
    })
  })
  const principalContext = new HostPrincipalContext(catalog)
  const broker = new CapabilityBroker(
    createApplicationCapabilityRegistry(catalog, unavailableDependencies()),
    { resolveCurrentPrincipalContext: () => principalContext.snapshot() }
  )
  const registration = registerCapabilityIpc({
    broker,
    ipc: {
      removeHandler: vi.fn(),
      handle: vi.fn()
    } as never,
    isTrustedIpcSender: () => true
  })
  const sender = {
    id: 41,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn()
  }
  let transportRequest = 0
  return {
    principalContext,
    invoke: async (
      actionId: string,
      input: CapabilityJsonValue,
      invocationId?: string
    ): Promise<CapabilityInvocationResult> => unwrapCapabilityTransportEnvelope(
      await registration.invoke(CAPABILITY_IPC_CHANNELS.invoke, {
        transportRequestId: `123e4567-e89b-42d3-a456-${String(++transportRequest).padStart(12, '0')}`,
        request: {
          actionId,
          ...(invocationId ? { invocationId } : {}),
          input
        }
      }, sender)
    ),
    dispose: () => {
      registration.dispose()
      catalog.dispose()
    }
  }
}

function unavailableDependencies(): AppCapabilityDependencies {
  return new Proxy({}, {
    get: () => () => undefined
  }) as AppCapabilityDependencies
}

const CLOUD_MUTATION_IDS = [
  IDENTITY_CAPABILITY_IDS.cloudLogin,
  IDENTITY_CAPABILITY_IDS.cloudReauthenticate,
  IDENTITY_CAPABILITY_IDS.cloudLogout,
  IDENTITY_CAPABILITY_IDS.cloudEnrollDevice,
  IDENTITY_CAPABILITY_IDS.cloudRefreshDevices,
  IDENTITY_CAPABILITY_IDS.cloudRevokeDevice
] as const

function identityBrokerFixture(root: string) {
  const entry = createDomainMainEntry({
    getUserDataDir: () => root,
    getDeviceId: () => 'device-integration-1',
    internalServices: createIsolatedInternalServicesForTest(),
    packageSecrets: memorySecrets(),
    defineCapability: (options) => defineCapability(
      options as DefineCapabilityOptions<z.ZodType, z.ZodType>
    )
  })
  const factory = entry.contributions.find(
    (contribution) => contribution.kind === 'main.capability-factory'
  )?.value as IdentityCapabilityFactory<CapabilityDefinition> | undefined
  const provider = entry.contributions.find(
    (contribution) => contribution.kind === 'main.principal-provider'
  )?.value as DomainMainPrincipalProvider | undefined
  if (!factory || !provider) throw new Error('Identity main contributions are incomplete.')
  const callCounts = new Map<string, number>()
  const definitions = factory.createDefinitions().map((definition) => ({
    ...definition,
    handler: vi.fn(async (...args: Parameters<CapabilityDefinition['handler']>) => {
      callCounts.set(definition.descriptor.id, (callCounts.get(definition.descriptor.id) ?? 0) + 1)
      return await definition.handler(...args)
    })
  }))
  const broker = new CapabilityBroker(new CapabilityRegistry(definitions), {
    resolveCurrentPrincipalContext: () => provider.snapshot()
  })
  const callerId = 'window:identity-integration'
  return {
    provider,
    definition: (actionId: string) => definitions.find(
      (definition) => definition.descriptor.id === actionId
    )!,
    calls: (actionId: string) => callCounts.get(actionId) ?? 0,
    invoke: (
      actionId: string,
      invocationId: string,
      input: CapabilityJsonValue,
      approval?: 'confirmation'
    ) => broker.invoke({
      audience: 'ui',
      callerId,
      approvals: approval ? [{ actionId, invocationId, mode: approval }] : []
    }, {
      actionId,
      invocationId,
      input
    }),
    dispose: () => {
      for (const contribution of entry.contributions) contribution.onDispose?.()
    }
  }
}

function cloudIdentityBrokerFixture() {
  const initialSignedOutPrincipal = definePrincipalContextSnapshot({
    identityVersion: 1,
    principal: null
  })
  const cloudPrincipal = principalContext(2, 'usr_CloudUser000001')
  const signedOutPrincipal = definePrincipalContextSnapshot({
    identityVersion: 3,
    principal: null
  })
  let currentPrincipal = initialSignedOutPrincipal
  let revision = 1
  let signedIn = false
  const listeners = new Set<() => void>()
  const snapshot = (): CloudIdentitySnapshot => signedIn
    ? signedInCloudSnapshot(revision)
    : {
        identity: { state: 'signed-out' },
        device: { state: 'signed-out' },
        devices: [],
        revision: `cloud-${revision}`
      }
  const publish = (): CloudIdentitySnapshot => {
    for (const listener of listeners) listener()
    return snapshot()
  }
  const runtime = {
    snapshot,
    semanticRevision: () => `cloud-${revision}`,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    login: async () => {
      signedIn = true
      revision = 2
      currentPrincipal = cloudPrincipal
      return publish()
    },
    reauthenticate: async () => {
      revision += 1
      return publish()
    },
    logout: async () => {
      signedIn = false
      revision += 1
      currentPrincipal = signedOutPrincipal
      return publish()
    },
    enrollDevice: async () => {
      revision += 1
      return publish()
    },
    refreshDevices: async () => {
      revision += 1
      return publish()
    },
    revokeDevice: async () => {
      revision += 1
      return publish()
    }
  }
  const handlerResources = new Map<string, unknown>()
  const factory = createIdentityCapabilityFactory({
    defineCapability: (options) => defineCapability(
      options as unknown as DefineCapabilityOptions<z.ZodType, z.ZodType>
    ),
    getCloudRuntime: () => runtime as never
  })
  const definitions = factory.createDefinitions().map((definition) => ({
    ...definition,
    handler: async (...args: Parameters<CapabilityDefinition['handler']>) => {
      handlerResources.set(definition.descriptor.id, args[1].resource)
      return await definition.handler(...args)
    }
  }))
  const broker = new CapabilityBroker(new CapabilityRegistry(definitions), {
    resolveCurrentPrincipalContext: () => currentPrincipal
  })
  const caller = {
    audience: 'ui' as const,
    callerId: 'window:cloud-identity-integration'
  }
  return {
    inspect: (invocationId: string) => broker.invoke(caller, {
      actionId: IDENTITY_CAPABILITY_IDS.cloudInspect,
      invocationId,
      input: {}
    }),
    invoke: (request: Parameters<CapabilityBroker['invoke']>[1]) => broker.invoke(caller, request),
    observe: (resource: ReturnType<typeof cloudHandle>) => broker.observe(caller, { resource }),
    subscribe: (listener: Parameters<CapabilityBroker['subscribe']>[1]) =>
      broker.subscribe(caller, listener),
    events: () => broker.listEvents(caller),
    handlerResource: (actionId: string) => handlerResources.get(actionId),
    dispose: () => listeners.clear()
  }
}

function principalContext(
  identityVersion: number,
  subject: string
): PrincipalContextSnapshot {
  return definePrincipalContextSnapshot({
    identityVersion,
    principal: {
      authority: 'sciforge-cloud',
      subject,
      assurance: 'cloud-authenticated',
      deviceId: 'dev_CloudDevice0001',
      identityVersion
    }
  })
}

function signedInCloudSnapshot(revision: number): CloudIdentitySnapshot {
  const device = {
    deviceId: 'dev_CloudDevice0001',
    displayName: 'Integration Desktop',
    status: 'active' as const,
    platform: {
      os: 'windows' as const,
      arch: 'x64' as const,
      appVersion: '1.0.0'
    },
    activatedAt: '2026-08-21T00:00:00.000Z'
  }
  return {
    identity: {
      state: 'signed-in',
      user: {
        userId: 'usr_CloudUser000001',
        oidcIdentityId: 'oid_CloudIdent0001',
        issuer: 'https://login-test.sciforge.cn/realms/SciForge',
        subject: 'integration-subject',
        displayName: 'Integration User'
      },
      accessTokenExpiresAt: '2026-08-21T01:00:00.000Z'
    },
    device: { state: 'active', device },
    devices: [device],
    revision: `cloud-${revision}`
  }
}

function cloudHandle(output: unknown) {
  const candidate = output as {
    resource?: { token?: unknown; semanticRevision?: unknown; expiresAt?: unknown }
  }
  if (
    typeof candidate.resource?.token !== 'string' ||
    typeof candidate.resource.semanticRevision !== 'string' ||
    typeof candidate.resource.expiresAt !== 'string'
  ) {
    throw new Error('Cloud inspection did not return a resource handle.')
  }
  return {
    token: candidate.resource.token,
    semanticRevision: candidate.resource.semanticRevision,
    expiresAt: candidate.resource.expiresAt
  }
}

function memorySecrets() {
  const values = new Map<string, string>()
  return {
    has: async (key: string) => values.has(key),
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value)
    },
    remove: async (key: string) => {
      values.delete(key)
    }
  }
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
