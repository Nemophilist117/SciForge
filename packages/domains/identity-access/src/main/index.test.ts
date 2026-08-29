import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTHENTICATED_CLOUD_TRANSPORT_CONTRACT_VERSION,
  AUTHENTICATED_CLOUD_TRANSPORT_SERVICE_ID,
  type AuthenticatedCloudTransport
} from '../authenticated-cloud-transport.js'
import {
  DEVICE_FACT_ATTESTATION_SIGNING_CONTRACT_VERSION,
  DEVICE_FACT_ATTESTATION_SIGNING_SERVICE_ID,
  type DeviceFactAttestationSigningService
} from '../device-fact-attestation-signing.js'
import {
  AGENT_CLOUD_RUNTIME_CONTRACT_VERSION,
  AGENT_CLOUD_RUNTIME_SERVICE_ID,
  type AgentCloudRuntime
} from '../agent-cloud-runtime.js'
import { IDENTITY_CAPABILITY_IDS } from '../contract.js'
import {
  createDomainMainEntry,
  createIdentityCapabilityFactory,
  type IdentityCapabilityOptions
} from './index.js'
import { CloudIdentityRuntime } from './cloud-runtime.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Identity main contributions', () => {
  it('publishes token-free User, Agent, and Device-signing services through Host mediation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-transport-'))
    roots.push(root)
    const registered = new Map<string, object>()
    const register = vi.fn((registration: Readonly<{
      serviceId: string
      contractVersion: string
      service: object
    }>) => {
      registered.set(`${registration.serviceId}@${registration.contractVersion}`, registration.service)
    })
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      internalServices: {
        register: register as never,
        acquire: vi.fn() as never
      },
      defineCapability: (definition) => definition
    })

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: AUTHENTICATED_CLOUD_TRANSPORT_SERVICE_ID,
      contractVersion: AUTHENTICATED_CLOUD_TRANSPORT_CONTRACT_VERSION,
      allowedConsumerModuleIds: [
        'sciforge.collaboration',
        'sciforge.project-coordinator',
        'sciforge.content-space'
      ]
    }))
    expect(entry.contributions[3]).toMatchObject({
      id: 'identity-access.authenticated-cloud-transport',
      kind: 'main.extension',
      contract: {
        location: 'main.internal-service-descriptor',
        serviceId: AUTHENTICATED_CLOUD_TRANSPORT_SERVICE_ID,
        contractVersion: AUTHENTICATED_CLOUD_TRANSPORT_CONTRACT_VERSION,
        allowedConsumerModuleIds: [
          'sciforge.collaboration',
          'sciforge.project-coordinator',
          'sciforge.content-space'
        ]
      }
    })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: DEVICE_FACT_ATTESTATION_SIGNING_SERVICE_ID,
      contractVersion: DEVICE_FACT_ATTESTATION_SIGNING_CONTRACT_VERSION,
      allowedConsumerModuleIds: ['sciforge.project-coordinator']
    }))
    expect(entry.contributions[4]).toMatchObject({
      id: 'identity-access.device-fact-attestation-signing',
      kind: 'main.extension',
      contract: {
        location: 'main.internal-service-descriptor',
        serviceId: DEVICE_FACT_ATTESTATION_SIGNING_SERVICE_ID,
        contractVersion: DEVICE_FACT_ATTESTATION_SIGNING_CONTRACT_VERSION,
        allowedConsumerModuleIds: ['sciforge.project-coordinator']
      }
    })
    expect(entry.contributions[4]).not.toMatchObject({
      contract: { allowedConsumerModuleIds: expect.arrayContaining(['sciforge.collaboration']) }
    })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: AGENT_CLOUD_RUNTIME_SERVICE_ID,
      contractVersion: AGENT_CLOUD_RUNTIME_CONTRACT_VERSION,
      allowedConsumerModuleIds: ['sciforge.collaboration']
    }))
    expect(entry.contributions[5]).toMatchObject({
      id: 'identity-access.agent-cloud-runtime',
      kind: 'main.extension',
      contract: {
        location: 'main.internal-service-descriptor',
        serviceId: AGENT_CLOUD_RUNTIME_SERVICE_ID,
        contractVersion: AGENT_CLOUD_RUNTIME_CONTRACT_VERSION,
        allowedConsumerModuleIds: ['sciforge.collaboration']
      }
    })
    const transport = registered.get(
      `${AUTHENTICATED_CLOUD_TRANSPORT_SERVICE_ID}@${AUTHENTICATED_CLOUD_TRANSPORT_CONTRACT_VERSION}`
    ) as AuthenticatedCloudTransport
    expect(transport.status()).toEqual({
      state: 'unavailable',
      reason: 'Cloud identity runtime is not active.'
    })
    await expect(transport.execute({
      contractVersion: 1,
      operationId: 'sciforge.cloud.command',
      payload: {
        protocolVersion: '1.0',
        requestId: 'req_IdentityIndexTest0001',
        type: 'project.list',
        limit: 50
      }
    })).rejects.toMatchObject({ code: 'transport_unavailable' })
    const signer = registered.get(
      `${DEVICE_FACT_ATTESTATION_SIGNING_SERVICE_ID}@${DEVICE_FACT_ATTESTATION_SIGNING_CONTRACT_VERSION}`
    ) as DeviceFactAttestationSigningService
    await expect(signer.signDeviceFact({
      purpose: 'project-content-provisioning-attestation',
      factDigest: 'a'.repeat(64),
      factRevision: 1,
      observedAt: '2026-08-18T01:59:00.000Z'
    })).rejects.toMatchObject({ code: 'signer_unavailable' })
    const agentRuntime = registered.get(
      `${AGENT_CLOUD_RUNTIME_SERVICE_ID}@${AGENT_CLOUD_RUNTIME_CONTRACT_VERSION}`
    ) as AgentCloudRuntime
    await expect(agentRuntime.authorityStatus('agt_000000000000000000000000')).resolves.toEqual({
      state: 'unavailable',
      reason: 'Cloud identity runtime is not active.'
    })
  })

  it('declares only the existing Cloud identity capability set', () => {
    const definitions = createIdentityCapabilityFactory({
      defineCapability: (definition) => definition,
      getCloudRuntime: () => ({}) as never
    }).createDefinitions() as IdentityCapabilityOptions[]

    expect(definitions.map((definition) => definition.id)).toEqual(
      Object.values(IDENTITY_CAPABILITY_IDS)
    )
    for (const definition of definitions) {
      expect(definition.audiences).toEqual(['ui'])
      expect(definition.scope).toBe('global')
      expect(definition.concurrency.idempotency).toBe(
        definition.effect === 'read' ? 'none' : 'required'
      )
    }
    expect(definitions.filter((definition) => (
      definition.principalTransition === 'host-authority'
    )).map(({ id }) => id)).toEqual([
      IDENTITY_CAPABILITY_IDS.cloudLogin,
      IDENTITY_CAPABILITY_IDS.cloudReauthenticate,
      IDENTITY_CAPABILITY_IDS.cloudLogout,
      IDENTITY_CAPABILITY_IDS.cloudEnrollDevice,
      IDENTITY_CAPABILITY_IDS.cloudRefreshDevices,
      IDENTITY_CAPABILITY_IDS.cloudRevokeDevice
    ])
  })

  it('keeps signed-out Principal null and rejects Cloud mutations from Agent callers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-main-'))
    roots.push(root)
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const provider = entry.contributions[1]!.value as { current(): unknown }
    expect(provider.current()).toBeUndefined()

    const runtimeSnapshot = {
      identity: { state: 'signed-out' as const },
      device: { state: 'signed-out' as const },
      devices: [],
      revision: 'cloud-1'
    }
    const definitions = createIdentityCapabilityFactory({
      defineCapability: (definition) => definition,
      getCloudRuntime: () => ({
        snapshot: () => runtimeSnapshot,
        semanticRevision: () => 'cloud-1',
        subscribe: () => () => undefined,
        login: async () => runtimeSnapshot,
        reauthenticate: async () => runtimeSnapshot,
        logout: async () => runtimeSnapshot,
        enrollDevice: async () => runtimeSnapshot,
        refreshDevices: async () => runtimeSnapshot,
        revokeDevice: async () => runtimeSnapshot
      })
    }).createDefinitions() as IdentityCapabilityOptions[]
    const login = definitions.find(({ id }) => id === IDENTITY_CAPABILITY_IDS.cloudLogin)!

    await expect(Promise.resolve(login.handler({}, {
      caller: { audience: 'agent' },
      assertPrincipalCurrent: vi.fn()
    }))).rejects.toThrow('trusted Human UI')
    await expect(Promise.resolve(login.handler({}, {
      caller: { audience: 'ui' },
      assertPrincipalCurrent: vi.fn(() => { throw codedError('principal_changed') })
    }))).resolves.toMatchObject({ output: runtimeSnapshot })

    entry.contributions[0]!.onDispose?.()
    entry.contributions[1]!.onDispose?.()
  })

  it('publishes runtime changes while keeping Principal mutations global and resource-neutral', async () => {
    let revision = 1
    const listeners = new Set<() => void>()
    const snapshot = () => ({
      identity: { state: 'signed-out' as const },
      device: { state: 'signed-out' as const },
      devices: [],
      revision: `cloud-${revision}`
    })
    const runtime = {
      snapshot,
      semanticRevision: () => `cloud-${revision}`,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      login: async () => {
        revision += 1
        for (const listener of listeners) listener()
        return snapshot()
      }
    }
    let registration: {
      subscribeChanges: (
        listener: (change: { semanticRevision: string; layoutRevision?: string }) => void
      ) => () => void
    } | undefined
    const resource = {
      token: `cap_${'a'.repeat(24)}`,
      semanticRevision: 'cloud-1',
      expiresAt: '2027-08-21T00:00:00.000Z'
    }
    const definitions = createIdentityCapabilityFactory({
      defineCapability: (definition) => definition,
      getCloudRuntime: () => runtime as never
    }).createDefinitions() as IdentityCapabilityOptions[]
    const inspect = definitions.find(({ id }) => id === IDENTITY_CAPABILITY_IDS.cloudInspect)!
    const login = definitions.find(({ id }) => id === IDENTITY_CAPABILITY_IDS.cloudLogin)!
    const context = {
      caller: { audience: 'ui' as const },
      assertPrincipalCurrent: vi.fn(),
      issueResource: (value: {
        subscribeChanges: (
          listener: (change: { semanticRevision: string; layoutRevision?: string }) => void
        ) => () => void
      }) => {
        registration = value
        return resource
      }
    }

    await inspect.handler({}, context)
    const providerChanges: unknown[] = []
    const unsubscribe = registration!.subscribeChanges((change) => providerChanges.push(change))
    const result = await login.handler({}, {
      caller: { audience: 'ui' },
      assertPrincipalCurrent: vi.fn()
    })

    expect(providerChanges).toEqual([{ semanticRevision: 'cloud-2' }])
    expect(login).toMatchObject({
      scope: 'global',
      principalTransition: 'host-authority',
      concurrency: { revision: 'none', idempotency: 'required' }
    })
    expect(login).not.toHaveProperty('resourceKinds')
    expect(result).toEqual({ output: expect.objectContaining({ revision: 'cloud-2' }) })
    unsubscribe()
  })

  it('fails an inactive Cloud mutation without constructing a fallback runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-inactive-'))
    roots.push(root)
    const createRuntime = vi.spyOn(CloudIdentityRuntime, 'create')
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const factory = entry.contributions[0]!.value as ReturnType<typeof createIdentityCapabilityFactory>
    const login = (factory.createDefinitions() as IdentityCapabilityOptions[]).find(
      ({ id }) => id === IDENTITY_CAPABILITY_IDS.cloudLogin
    )!

    await expect(Promise.resolve(login.handler({}, {
      caller: { audience: 'ui' },
      assertPrincipalCurrent: vi.fn()
    }))).rejects.toThrow('Cloud identity runtime is not active.')
    expect(createRuntime).not.toHaveBeenCalled()
    entry.contributions[0]!.onDispose?.()
    entry.contributions[1]!.onDispose?.()
    await entry.contributions[2]!.onDispose?.()
  })

  it('fails closed when the Host does not provide a canonical installation identity', () => {
    for (const getDeviceId of [undefined, () => ' device-1']) {
      expect(() => createDomainMainEntry({
        getUserDataDir: () => '/private/tmp/sciforge-identity-missing-device',
        ...(getDeviceId ? { getDeviceId } : {}),
        internalServices: memoryInternalServices(),
        defineCapability: (definition) => definition
      })).toThrow()
    }
  })

  it.each(['win32', 'linux'] as const)(
    'fails closed on %s when the Host encrypted package store is unavailable',
    (platform) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      try {
        expect(() => createDomainMainEntry({
          getUserDataDir: () => '/private/tmp/sciforge-identity-missing-secrets',
          getDeviceId: () => 'device-1',
          internalServices: memoryInternalServices(),
          defineCapability: (definition) => definition
        })).toThrow('Identity requires the Host package-scoped secret store')
      } finally {
        Object.defineProperty(process, 'platform', descriptor)
      }
    }
  )

  it('fails Cloud activation before construction when the Host application version is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-version-'))
    roots.push(root)
    const createRuntime = vi.spyOn(CloudIdentityRuntime, 'create')
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const lifecycle = entry.contributions[2]!.value as {
      activate(context: unknown): Promise<unknown>
    }

    await expect(lifecycle.activate(lifecycleContext(root))).rejects.toThrow(
      'Identity requires the canonical Host application version.'
    )
    expect(createRuntime).not.toHaveBeenCalled()
    await expect(Promise.resolve(entry.contributions[2]!.onDispose?.())).resolves.toBeUndefined()
  })

  it('passes the canonical Host application version unchanged into Cloud activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-version-'))
    roots.push(root)
    const runtime = runtimeDouble(Promise.resolve())
    const createRuntime = vi.spyOn(CloudIdentityRuntime, 'create').mockResolvedValueOnce(runtime.value)
    const getAppVersion = vi.fn(() => '9.8.7-host')
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      getAppVersion,
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const lifecycle = entry.contributions[2]!.value as {
      activate(context: unknown): Promise<unknown>
    }

    const dispose = await lifecycle.activate(lifecycleContext(root)) as () => void
    expect(getAppVersion).toHaveBeenCalledOnce()
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      appRoot: root,
      appVersion: '9.8.7-host'
    }))
    dispose()
    expect(runtime.close).toHaveBeenCalledOnce()
  })

  it('waits for initialization before disposing an in-flight activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-lifecycle-'))
    roots.push(root)
    const initialization = deferred<void>()
    const runtime = runtimeDouble(initialization.promise)
    vi.spyOn(CloudIdentityRuntime, 'create').mockResolvedValueOnce(runtime.value)
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      getAppVersion: () => '1.0.0',
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const lifecycle = entry.contributions[2]!.value as {
      activate(context: unknown): Promise<unknown>
    }

    const activation = lifecycle.activate(lifecycleContext(root))
    await vi.waitFor(() => expect(runtime.initialize).toHaveBeenCalledOnce())
    const cleanup = Promise.resolve(entry.contributions[2]!.onDispose?.())

    expect(runtime.close).not.toHaveBeenCalled()
    initialization.resolve()
    const returnedDisposer = await activation as () => void
    await expect(cleanup).resolves.toBeUndefined()

    expect(runtime.close).toHaveBeenCalledOnce()
    await expectCloudRuntimeInactive(entry)
    returnedDisposer()
    expect(runtime.close).toHaveBeenCalledOnce()
  })

  it('keeps initialization rejection with the activation owner during concurrent cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-lifecycle-'))
    roots.push(root)
    const initialization = deferred<void>()
    const runtime = runtimeDouble(initialization.promise)
    vi.spyOn(CloudIdentityRuntime, 'create').mockResolvedValueOnce(runtime.value)
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      getAppVersion: () => '1.0.0',
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const lifecycle = entry.contributions[2]!.value as {
      activate(context: unknown): Promise<unknown>
    }

    const activation = lifecycle.activate(lifecycleContext(root))
    await vi.waitFor(() => expect(runtime.initialize).toHaveBeenCalledOnce())
    const cleanup = Promise.resolve(entry.contributions[2]!.onDispose?.())
    const failure = new Error('structural initialization failed')
    const activationFailure = expect(activation).rejects.toBe(failure)

    expect(runtime.close).not.toHaveBeenCalled()
    initialization.reject(failure)

    await activationFailure
    await expect(cleanup).resolves.toBeUndefined()
    expect(runtime.close).toHaveBeenCalledOnce()
    await expectCloudRuntimeInactive(entry)
  })

  it('publishes a recoverable signed-out initialization result as an active runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-lifecycle-'))
    roots.push(root)
    const snapshot = {
      identity: { state: 'signed-out' as const },
      device: { state: 'signed-out' as const },
      devices: [],
      revision: 'cloud-1',
      error: {
        source: 'identity' as const,
        code: 'OIDC_CONFIGURATION_ERROR',
        message: 'Cloud identity configuration is unavailable.'
      }
    }
    const runtime = runtimeDouble(Promise.resolve(snapshot), snapshot)
    vi.spyOn(CloudIdentityRuntime, 'create').mockResolvedValueOnce(runtime.value)
    const entry = createDomainMainEntry({
      getUserDataDir: () => root,
      getDeviceId: () => 'device-1',
      packageSecrets: memoryPackageSecrets(),
      getAppVersion: () => '1.0.0',
      internalServices: memoryInternalServices(),
      defineCapability: (definition) => definition
    })
    const lifecycle = entry.contributions[2]!.value as {
      activate(context: unknown): Promise<unknown>
    }

    const returnedDisposer = await lifecycle.activate(lifecycleContext(root)) as () => void
    const factory = entry.contributions[0]!.value as ReturnType<typeof createIdentityCapabilityFactory>
    const inspect = (factory.createDefinitions() as IdentityCapabilityOptions[]).find(
      ({ id }) => id === IDENTITY_CAPABILITY_IDS.cloudInspect
    )!
    const result = await inspect.handler({}, {
      caller: { audience: 'ui' },
      assertPrincipalCurrent: vi.fn(),
      issueResource: () => ({
        token: `cap_${'a'.repeat(24)}`,
        semanticRevision: 'cloud-1',
        expiresAt: '2027-08-21T00:00:00.000Z'
      })
    })

    expect(result.output).toMatchObject({
      snapshot: {
        identity: { state: 'signed-out' },
        error: { source: 'identity', code: 'OIDC_CONFIGURATION_ERROR' }
      }
    })
    expect(runtime.close).not.toHaveBeenCalled()
    returnedDisposer()
    expect(runtime.close).toHaveBeenCalledOnce()
  })

  it.each(['returned-first', 'catalog-first'] as const)(
    'closes a normally activated runtime once when disposal is %s',
    async (order) => {
      const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-lifecycle-'))
      roots.push(root)
      const runtime = runtimeDouble(Promise.resolve())
      vi.spyOn(CloudIdentityRuntime, 'create').mockResolvedValueOnce(runtime.value)
      const entry = createDomainMainEntry({
        getUserDataDir: () => root,
        getDeviceId: () => 'device-1',
        packageSecrets: memoryPackageSecrets(),
        getAppVersion: () => '1.0.0',
        internalServices: memoryInternalServices(),
        defineCapability: (definition) => definition
      })
      const lifecycle = entry.contributions[2]!.value as {
        activate(context: unknown): Promise<unknown>
      }
      const returnedDisposer = await lifecycle.activate(lifecycleContext(root)) as () => void

      if (order === 'returned-first') {
        returnedDisposer()
        await entry.contributions[2]!.onDispose?.()
      } else {
        await entry.contributions[2]!.onDispose?.()
        returnedDisposer()
      }

      expect(runtime.close).toHaveBeenCalledOnce()
      await expectCloudRuntimeInactive(entry)
    }
  )
})

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function memoryInternalServices() {
  const services = new Map<string, object>()
  return {
    register: <Service extends object>(registration: Readonly<{
      serviceId: string
      contractVersion: string
      allowedConsumerModuleIds: readonly string[]
      service: Service
    }>) => {
      services.set(`${registration.serviceId}@${registration.contractVersion}`, registration.service)
    },
    acquire: <Service extends object>(serviceId: string, contractVersion: string): Service => {
      const service = services.get(`${serviceId}@${contractVersion}`)
      if (!service) throw new Error('Internal service is not registered.')
      return service as Service
    }
  }
}

function memoryPackageSecrets() {
  const values = new Map<string, string>()
  return {
    has: async (key: string) => values.has(key),
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => { values.set(key, value) },
    remove: async (key: string) => { values.delete(key) }
  }
}

function lifecycleContext(root: string) {
  return {
    userDataDir: root,
    appRoot: root,
    environment: {},
    signal: new AbortController().signal
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function runtimeDouble(
  initialization: Promise<unknown>,
  snapshot: unknown = {
    identity: { state: 'signed-out' },
    device: { state: 'signed-out' },
    devices: [],
    revision: 'cloud-1'
  }
) {
  const initialize = vi.fn(() => initialization)
  const close = vi.fn()
  return {
    initialize,
    close,
    value: {
      initialize,
      close,
      snapshot: vi.fn(() => snapshot),
      semanticRevision: vi.fn(() => 'cloud-1'),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as CloudIdentityRuntime
  }
}

async function expectCloudRuntimeInactive(
  entry: ReturnType<typeof createDomainMainEntry>
): Promise<void> {
  const factory = entry.contributions[0]!.value as ReturnType<typeof createIdentityCapabilityFactory>
  const inspect = (factory.createDefinitions() as IdentityCapabilityOptions[]).find(
    ({ id }) => id === IDENTITY_CAPABILITY_IDS.cloudInspect
  )!
  await expect(Promise.resolve(inspect.handler({}, {
    caller: { audience: 'ui' },
    assertPrincipalCurrent: vi.fn(),
    issueResource: vi.fn()
  }))).rejects.toThrow('Cloud identity runtime is not active.')
}
