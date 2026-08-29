import {
  cloudDeviceIdSchema,
  cloudUserIdSchema
} from '../contract.js'
import { IdentityStore, type IdentityStoreState } from './store.js'

type CloudPrincipalRuntime = {
  activeCloudUserId: string | null
  activeCloudDeviceId: string | null
  listeners: Set<(change: CloudPrincipalChange) => void>
}

type CloudPrincipalChange =
  | Readonly<{ kind: 'committed' }>
  | Readonly<{ kind: 'storage-failed'; error: unknown }>

const cloudPrincipalRuntimes = new Map<string, CloudPrincipalRuntime>()

function runtimeFor(databasePath: string): CloudPrincipalRuntime {
  let runtime = cloudPrincipalRuntimes.get(databasePath)
  if (!runtime) {
    runtime = { activeCloudUserId: null, activeCloudDeviceId: null, listeners: new Set() }
    cloudPrincipalRuntimes.set(databasePath, runtime)
  }
  return runtime
}

export function activeCloudUserId(databasePath: string): string | null {
  return runtimeFor(databasePath).activeCloudUserId
}

export function activeCloudDeviceId(databasePath: string): string | null {
  return runtimeFor(databasePath).activeCloudDeviceId
}

export function subscribeCloudPrincipalChanges(
  databasePath: string,
  listener: (change: CloudPrincipalChange) => void
): () => void {
  const runtime = runtimeFor(databasePath)
  runtime.listeners.add(listener)
  return () => runtime.listeners.delete(listener)
}

function notifyCloudPrincipalChanges(
  databasePath: string,
  change: CloudPrincipalChange = { kind: 'committed' }
): void {
  for (const listener of runtimeFor(databasePath).listeners) {
    try {
      listener(change)
    } catch {
      // A committed Principal transition remains authoritative if a listener fails.
    }
  }
}

export class CloudPrincipalStateService {
  readonly #store: IdentityStore
  readonly #databasePath: string
  #closed = false

  constructor(userDataDir: string) {
    this.#store = IdentityStore.open(userDataDir)
    this.#databasePath = this.#store.databasePath
  }

  linkDevice(
    cloudUserId: string,
    deviceId: string,
    status: 'active' | 'revoked'
  ): IdentityStoreState {
    this.#assertOpen()
    const parsedUserId = cloudUserIdSchema.parse(cloudUserId)
    const parsedDeviceId = cloudDeviceIdSchema.parse(deviceId)
    const runtime = runtimeFor(this.#databasePath)
    if (runtime.activeCloudUserId !== parsedUserId) {
      throw new Error('The cloud Device does not belong to the authenticated SciForge User.')
    }
    const nextDeviceId = status === 'active' ? parsedDeviceId : null
    if (runtime.activeCloudDeviceId === nextDeviceId) return this.#store.state()

    if (nextDeviceId === null) runtime.activeCloudDeviceId = null
    try {
      const state = this.#store.advanceIdentityVersion()
      runtime.activeCloudDeviceId = nextDeviceId
      notifyCloudPrincipalChanges(this.#databasePath)
      return state
    } catch (error) {
      notifyCloudPrincipalChanges(this.#databasePath, { kind: 'storage-failed', error })
      throw error
    }
  }

  clearActiveDevice(): IdentityStoreState {
    this.#assertOpen()
    const runtime = runtimeFor(this.#databasePath)
    if (runtime.activeCloudDeviceId === null) return this.#store.state()
    runtime.activeCloudDeviceId = null
    try {
      const state = this.#store.advanceIdentityVersion()
      notifyCloudPrincipalChanges(this.#databasePath)
      return state
    } catch (error) {
      notifyCloudPrincipalChanges(this.#databasePath, { kind: 'storage-failed', error })
      throw error
    }
  }

  setAuthenticatedCloudUser(cloudUserId: string | null): IdentityStoreState {
    this.#assertOpen()
    const parsedUserId = cloudUserId === null
      ? null
      : cloudUserIdSchema.parse(cloudUserId)
    const runtime = runtimeFor(this.#databasePath)
    if (runtime.activeCloudUserId === parsedUserId) return this.#store.state()

    runtime.activeCloudUserId = null
    runtime.activeCloudDeviceId = null
    try {
      const state = this.#store.advanceIdentityVersion()
      runtime.activeCloudUserId = parsedUserId
      notifyCloudPrincipalChanges(this.#databasePath)
      return state
    } catch (error) {
      notifyCloudPrincipalChanges(this.#databasePath, { kind: 'storage-failed', error })
      throw error
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const runtime = runtimeFor(this.#databasePath)
    const authorityWasActive = runtime.activeCloudUserId !== null || runtime.activeCloudDeviceId !== null
    runtime.activeCloudUserId = null
    runtime.activeCloudDeviceId = null
    try {
      if (authorityWasActive) {
        try {
          this.#store.advanceIdentityVersion()
          notifyCloudPrincipalChanges(this.#databasePath)
        } catch (error) {
          notifyCloudPrincipalChanges(this.#databasePath, { kind: 'storage-failed', error })
        }
      }
    } finally {
      this.#store.close()
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Cloud Principal state is closed.')
  }
}
