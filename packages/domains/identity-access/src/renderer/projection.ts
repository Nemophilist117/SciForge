import type { DomainCapabilityResourceHandle } from '@sciforge/domain-sdk/host'
import type {
  CloudIdentityInspectOutput,
  CloudIdentitySnapshot
} from '../contract.js'
import type { IdentityRendererClient } from './client.js'

export type IdentityProjectionSnapshot = Readonly<{
  cloud: CloudIdentitySnapshot | null
  cloudResource: DomainCapabilityResourceHandle | null
  cloudLoading: boolean
  error: string | null
}>

const INITIAL_SNAPSHOT: IdentityProjectionSnapshot = Object.freeze({
  cloud: null,
  cloudResource: null,
  cloudLoading: false,
  error: null
})

export class IdentityRendererProjection {
  private snapshotValue = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private loading: Promise<IdentityProjectionSnapshot> | null = null
  private cloudSubscription: (() => void) | null = null
  private cloudSubscriptionEpoch = 0
  private cloudObservationSequence = 0
  private cloudInspectionSequence = 0
  private cloudMutationSequence = 0
  private disposed = false

  constructor(readonly client: IdentityRendererClient) {}

  getSnapshot = (): IdentityProjectionSnapshot => this.snapshotValue

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(): Promise<IdentityProjectionSnapshot> {
    if (this.loading) return this.loading
    this.set({ ...this.snapshotValue, cloudLoading: true, error: null })
    this.loading = this.refreshCloudInspection()
      .then(() => this.snapshotValue)
      .catch((error: unknown) => {
        if (!this.disposed) this.setError(error)
        return this.snapshotValue
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  async loginCloud(): Promise<void> {
    await this.mutateCloud(() => this.client.loginCloud())
  }

  async reauthenticateCloud(): Promise<void> {
    await this.mutateCloud(() => this.client.reauthenticateCloud())
  }

  async logoutCloud(): Promise<void> {
    await this.mutateCloud(() => this.client.logoutCloud())
  }

  async enrollCloudDevice(): Promise<void> {
    await this.mutateCloud(() => this.client.enrollCloudDevice())
  }

  async refreshCloudDevices(): Promise<void> {
    await this.mutateCloud(() => this.client.refreshCloudDevices())
  }

  async revokeCloudDevice(deviceId: string): Promise<void> {
    await this.mutateCloud(() => this.client.revokeCloudDevice(deviceId))
  }

  dispose(): void {
    this.disposed = true
    this.cloudSubscriptionEpoch += 1
    this.cloudObservationSequence += 1
    this.cloudInspectionSequence += 1
    this.cloudMutationSequence += 1
    this.cloudSubscription?.()
    this.cloudSubscription = null
    this.listeners.clear()
  }

  private async mutateCloud(
    operation: () => Promise<CloudIdentitySnapshot>
  ): Promise<void> {
    const sequence = ++this.cloudMutationSequence
    this.set({ ...this.snapshotValue, cloudLoading: true, error: null })
    try {
      await operation()
      if (this.disposed || sequence !== this.cloudMutationSequence) return
      await this.refreshCloudInspection()
    } catch (error) {
      if (!this.disposed && sequence === this.cloudMutationSequence) this.setError(error)
      throw error
    }
  }

  private async refreshCloudInspection(): Promise<void> {
    const sequence = ++this.cloudInspectionSequence
    const epoch = ++this.cloudSubscriptionEpoch
    this.cloudSubscription?.()
    this.cloudSubscription = null
    const inspection = await this.client.inspectCloud()
    if (
      this.disposed ||
      epoch !== this.cloudSubscriptionEpoch ||
      sequence !== this.cloudInspectionSequence
    ) return
    this.acceptCloudInspection(inspection)
  }

  private acceptCloudInspection(output: CloudIdentityInspectOutput): void {
    this.set({
      ...this.snapshotValue,
      cloudLoading: false,
      cloud: output.snapshot,
      cloudResource: output.resource,
      error: null
    })
    this.initializeCloudObservation(output.resource)
  }

  private initializeCloudObservation(resource: DomainCapabilityResourceHandle): void {
    const epoch = ++this.cloudSubscriptionEpoch
    void this.client.observeCloud(resource).then((observed) => {
      if (this.disposed || epoch !== this.cloudSubscriptionEpoch) return
      this.set({
        ...this.snapshotValue,
        cloud: observed.state,
        cloudResource: observed.resource,
        error: null
      })
      this.attachCloudSubscription(observed.resourceRef, epoch)
    }).catch((error) => {
      if (epoch === this.cloudSubscriptionEpoch) this.setError(error)
    })
  }

  private attachCloudSubscription(resourceRef: string, epoch: number): void {
    const subscribe = this.client.subscribeCloud
    if (!subscribe || this.disposed) return
    void subscribe(resourceRef, () => {
      const resource = this.snapshotValue.cloudResource
      if (resource) void this.refreshCloudObservation(resource, epoch)
    }).then((dispose) => {
      if (this.disposed || epoch !== this.cloudSubscriptionEpoch) {
        dispose()
        return
      }
      this.cloudSubscription?.()
      this.cloudSubscription = dispose
      const resource = this.snapshotValue.cloudResource
      if (resource) void this.refreshCloudObservation(resource, epoch)
    }).catch((error) => {
      if (epoch === this.cloudSubscriptionEpoch) this.setError(error)
    })
  }

  private async refreshCloudObservation(
    resource: DomainCapabilityResourceHandle,
    epoch: number
  ): Promise<void> {
    const sequence = ++this.cloudObservationSequence
    try {
      const observed = await this.client.observeCloud(resource)
      if (
        this.disposed ||
        epoch !== this.cloudSubscriptionEpoch ||
        sequence !== this.cloudObservationSequence
      ) return
      this.set({
        ...this.snapshotValue,
        cloud: observed.state,
        cloudResource: observed.resource,
        cloudLoading: false,
        error: null
      })
    } catch (error) {
      if (
        !this.disposed &&
        epoch === this.cloudSubscriptionEpoch &&
        sequence === this.cloudObservationSequence
      ) this.setError(error)
    }
  }

  private setError(error: unknown): void {
    this.set({
      ...this.snapshotValue,
      cloudLoading: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  private set(snapshot: IdentityProjectionSnapshot): void {
    this.snapshotValue = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }
}
