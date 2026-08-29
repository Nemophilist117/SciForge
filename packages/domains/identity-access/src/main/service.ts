import { join } from 'node:path'
import type {
  DomainMainPrincipalProvider,
  PrincipalContextSnapshot,
  PrincipalSnapshot
} from '@sciforge/domain-sdk/principal'
import { definePrincipalContextSnapshot } from '@sciforge/domain-sdk/principal'
import {
  activeCloudDeviceId,
  activeCloudUserId,
  subscribeCloudPrincipalChanges
} from './cloud-principal-state.js'
import { IdentityStore, type IdentityStoreState } from './store.js'

type StoreFactory = Readonly<{
  open(userDataDir: string): IdentityStore
}>

export class IdentityService implements DomainMainPrincipalProvider {
  private store: IdentityStore | null = null
  private unavailable = false
  private readonly listeners = new Set<(snapshot: PrincipalContextSnapshot) => void>()
  private readonly databasePath: string
  private readonly disposeCloudPrincipalSubscription: () => void
  private lastPublishedVersion = 0

  constructor(
    private readonly userDataDir: string,
    private readonly stores: StoreFactory = IdentityStore
  ) {
    this.databasePath = join(this.userDataDir, 'identity-access', 'identity.sqlite')
    this.initialize()
    this.disposeCloudPrincipalSubscription = subscribeCloudPrincipalChanges(
      this.databasePath,
      (change) => {
        if (change.kind === 'storage-failed') {
          this.failClosed()
          return
        }
        this.refreshCloudPrincipalState()
      }
    )
  }

  current(): PrincipalSnapshot | undefined {
    return this.snapshot().principal ?? undefined
  }

  snapshot(): PrincipalContextSnapshot {
    if (this.unavailable) {
      return definePrincipalContextSnapshot({
        identityVersion: this.lastPublishedVersion,
        principal: null
      })
    }
    try {
      return principalContextFromState(
        this.requireStore().state(),
        activeCloudUserId(this.databasePath),
        activeCloudDeviceId(this.databasePath)
      )
    } catch {
      this.failClosed()
      return definePrincipalContextSnapshot({
        identityVersion: this.lastPublishedVersion,
        principal: null
      })
    }
  }

  subscribe(listener: (snapshot: PrincipalContextSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.disposeCloudPrincipalSubscription()
    this.store?.close()
    this.store = null
    this.listeners.clear()
  }

  private initialize(): void {
    try {
      this.store = this.stores.open(this.userDataDir)
      this.lastPublishedVersion = this.store.state().identityVersion
    } catch {
      this.store = null
      this.unavailable = true
    }
  }

  private requireStore(): IdentityStore {
    if (!this.store || this.unavailable) throw new Error('Identity is unavailable.')
    return this.store
  }

  private refreshCloudPrincipalState(): void {
    try {
      this.publish(this.requireStore().state())
    } catch {
      this.failClosed()
    }
  }

  private failClosed(): void {
    if (this.unavailable) return
    this.store?.close()
    this.store = null
    this.unavailable = true
    const unavailableVersion = this.lastPublishedVersion < Number.MAX_SAFE_INTEGER
      ? this.lastPublishedVersion + 1
      : this.lastPublishedVersion
    const snapshot = definePrincipalContextSnapshot({
      identityVersion: unavailableVersion,
      principal: null
    })
    this.lastPublishedVersion = snapshot.identityVersion
    this.notify(snapshot)
  }

  private publish(state: IdentityStoreState): void {
    const snapshot = principalContextFromState(
      state,
      activeCloudUserId(this.databasePath),
      activeCloudDeviceId(this.databasePath)
    )
    if (snapshot.identityVersion <= this.lastPublishedVersion) return
    this.lastPublishedVersion = snapshot.identityVersion
    this.notify(snapshot)
  }

  private notify(snapshot: PrincipalContextSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Principal publication is committed independently of projection listeners.
      }
    }
  }
}

function principalContextFromState(
  state: IdentityStoreState,
  cloudUserId: string | null,
  cloudDeviceId: string | null
): PrincipalContextSnapshot {
  return definePrincipalContextSnapshot({
    identityVersion: state.identityVersion,
    principal: cloudUserId && cloudDeviceId
      ? {
          authority: 'sciforge-cloud',
          subject: cloudUserId,
          assurance: 'cloud-authenticated',
          deviceId: cloudDeviceId,
          identityVersion: state.identityVersion
        }
      : null
  })
}
