import type {
  DomainCapabilityResourceHandle,
  DomainRendererCapabilityInvoker,
  DomainRendererCapabilityObservation
} from '@sciforge/domain-sdk/host'
import {
  IDENTITY_CAPABILITY_IDS,
  cloudDeviceRevokeInputSchema,
  cloudIdentityInspectOutputSchema,
  cloudIdentityObservationContract,
  cloudIdentitySnapshotSchema,
  emptyIdentityInputSchema,
  type CloudIdentityInspectOutput,
  type CloudIdentitySnapshot
} from '../contract.js'

export type IdentityRendererClient = Readonly<{
  inspectCloud(): Promise<CloudIdentityInspectOutput>
  observeCloud(
    resource: DomainCapabilityResourceHandle
  ): Promise<DomainRendererCapabilityObservation<CloudIdentitySnapshot>>
  subscribeCloud?(
    resourceRef: string,
    listener: () => void
  ): Promise<() => void>
  loginCloud(): Promise<CloudIdentitySnapshot>
  reauthenticateCloud(): Promise<CloudIdentitySnapshot>
  logoutCloud(): Promise<CloudIdentitySnapshot>
  enrollCloudDevice(): Promise<CloudIdentitySnapshot>
  refreshCloudDevices(): Promise<CloudIdentitySnapshot>
  revokeCloudDevice(deviceId: string): Promise<CloudIdentitySnapshot>
}>

export function createIdentityRendererClient(
  invoker: DomainRendererCapabilityInvoker
): IdentityRendererClient {
  const cloudMutation = (
    actionId: string,
    inputSchema: typeof emptyIdentityInputSchema | typeof cloudDeviceRevokeInputSchema,
    input: Record<string, unknown>
  ): Promise<CloudIdentitySnapshot> => invoker.invoke({
    actionId,
    effect: 'external-write',
    inputSchema,
    outputSchema: cloudIdentitySnapshotSchema
  }, input)
  const subscribeCloud = invoker.subscribe
    ? (resourceRef: string, listener: () => void): Promise<() => void> =>
        invoker.subscribe!(resourceRef, listener)
    : undefined
  return Object.freeze({
    inspectCloud: () => invoker.invoke({
      actionId: IDENTITY_CAPABILITY_IDS.cloudInspect,
      effect: 'read',
      inputSchema: emptyIdentityInputSchema,
      outputSchema: cloudIdentityInspectOutputSchema
    }, {}),
    observeCloud: (resource) => invoker.observe(
      cloudIdentityObservationContract,
      resource
    ),
    ...(subscribeCloud ? { subscribeCloud } : {}),
    loginCloud: () => cloudMutation(
      IDENTITY_CAPABILITY_IDS.cloudLogin,
      emptyIdentityInputSchema,
      {}
    ),
    reauthenticateCloud: () => cloudMutation(
      IDENTITY_CAPABILITY_IDS.cloudReauthenticate,
      emptyIdentityInputSchema,
      {}
    ),
    logoutCloud: () => cloudMutation(
      IDENTITY_CAPABILITY_IDS.cloudLogout,
      emptyIdentityInputSchema,
      {}
    ),
    enrollCloudDevice: () => cloudMutation(
      IDENTITY_CAPABILITY_IDS.cloudEnrollDevice,
      emptyIdentityInputSchema,
      {}
    ),
    refreshCloudDevices: () => cloudMutation(
      IDENTITY_CAPABILITY_IDS.cloudRefreshDevices,
      emptyIdentityInputSchema,
      {}
    ),
    revokeCloudDevice: (deviceId) => cloudMutation(
      IDENTITY_CAPABILITY_IDS.cloudRevokeDevice,
      cloudDeviceRevokeInputSchema,
      { deviceId }
    )
  })
}
