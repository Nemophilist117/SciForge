import { z } from 'zod'

export const IDENTITY_CAPABILITY_IDS = Object.freeze({
  cloudInspect: 'identity.cloud.inspect',
  cloudLogin: 'identity.cloud.login',
  cloudReauthenticate: 'identity.cloud.reauthenticate',
  cloudLogout: 'identity.cloud.logout',
  cloudEnrollDevice: 'identity.cloud.enroll-device',
  cloudRefreshDevices: 'identity.cloud.refresh-devices',
  cloudRevokeDevice: 'identity.cloud.revoke-device'
} as const)

export const IDENTITY_ACCOUNT_COMMAND_ID = 'identity-access.open-account' as const
export const IDENTITY_ACCOUNT_OVERLAY_ID = 'identity-access.account-overlay' as const

const cloudOpaqueSuffix = '[A-Za-z0-9](?:[A-Za-z0-9_]{10,62}[A-Za-z0-9])'
const cloudOpaqueId = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_${cloudOpaqueSuffix}$`, 'u'))

export const cloudUserIdSchema = cloudOpaqueId('usr')
export const cloudDeviceIdSchema = cloudOpaqueId('dev')

export const desktopIdentityUserSchema = z.object({
  userId: cloudUserIdSchema,
  oidcIdentityId: cloudOpaqueId('oid'),
  issuer: z.string().url().max(2_048),
  subject: z.string().min(1).max(512),
  displayName: z.string().min(1).max(512),
  username: z.string().min(1).max(512).optional(),
  email: z.string().email().max(512).optional(),
  emailVerified: z.boolean().optional()
}).strict().readonly()

export const desktopIdentityStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('signed-out') }).strict().readonly(),
  z.object({
    state: z.literal('signed-in'),
    user: desktopIdentityUserSchema,
    accessTokenExpiresAt: z.string().datetime({ offset: true })
  }).strict().readonly()
])

export const desktopIdentityErrorCodeSchema = z.enum([
  'OIDC_CONFIGURATION_ERROR',
  'OIDC_PROVIDER_UNAVAILABLE',
  'OIDC_LOGIN_CANCELLED',
  'OIDC_LOGIN_TIMEOUT',
  'OIDC_CALLBACK_INVALID',
  'OIDC_TOKEN_INVALID',
  'OIDC_LOGIN_FAILED',
  'OIDC_SESSION_STORAGE_UNAVAILABLE',
  'OIDC_SESSION_EXPIRED',
  'OIDC_LOGOUT_FAILED',
  'OIDC_REAUTH_USER_MISMATCH',
  'SCIFORGE_CLOUD_UNAVAILABLE',
  'SCIFORGE_CLOUD_AUTH_FAILED',
  'SCIFORGE_CLOUD_RESPONSE_INVALID'
])

export const desktopIdentityActionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    status: desktopIdentityStatusSchema
  }).strict().readonly(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: desktopIdentityErrorCodeSchema,
      message: z.string().min(1).max(2_048)
    }).strict().readonly(),
    status: desktopIdentityStatusSchema
  }).strict().readonly()
])

export const desktopDeviceSummarySchema = z.object({
  deviceId: cloudDeviceIdSchema,
  displayName: z.string().min(1).max(512),
  status: z.enum(['pending', 'active', 'revoked']),
  platform: z.object({
    os: z.enum(['windows', 'macos', 'linux']),
    arch: z.enum(['x64', 'arm64']),
    osVersion: z.string().min(1).max(256).optional(),
    appVersion: z.string().min(1).max(256)
  }).strict().readonly(),
  activatedAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional()
}).strict().readonly()

export const desktopDeviceStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('signed-out') }).strict().readonly(),
  z.object({ state: z.literal('not-enrolled') }).strict().readonly(),
  z.object({ state: z.literal('enrolling') }).strict().readonly(),
  z.object({
    state: z.literal('active'),
    device: desktopDeviceSummarySchema
  }).strict().readonly(),
  z.object({
    state: z.literal('revoked'),
    device: desktopDeviceSummarySchema
  }).strict().readonly(),
  z.object({
    state: z.literal('error'),
    message: z.string().min(1).max(2_048)
  }).strict().readonly()
])

export const desktopDeviceActionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    status: desktopDeviceStatusSchema,
    devices: z.array(desktopDeviceSummarySchema).max(1_024)
  }).strict().readonly(),
  z.object({
    ok: z.literal(false),
    status: desktopDeviceStatusSchema,
    devices: z.array(desktopDeviceSummarySchema).max(1_024),
    message: z.string().min(1).max(2_048)
  }).strict().readonly()
])

export const cloudIdentitySnapshotSchema = z.object({
  identity: desktopIdentityStatusSchema,
  device: desktopDeviceStatusSchema,
  devices: z.array(desktopDeviceSummarySchema).max(1_024),
  revision: z.string().regex(/^cloud-[1-9][0-9]*$/u),
  error: z.object({
    source: z.enum(['identity', 'device', 'runtime']),
    code: z.string().min(1).max(128).optional(),
    message: z.string().min(1).max(2_048)
  }).strict().readonly().optional()
}).strict().readonly()

export const identityCapabilityResourceHandleSchema = z.object({
  token: z.string().regex(/^cap_[A-Za-z0-9_-]{20,}$/u),
  semanticRevision: z.string().regex(/^cloud-[1-9][0-9]*$/u),
  expiresAt: z.string().datetime({ offset: true })
}).strict().readonly()

export const cloudIdentityInspectOutputSchema = z.object({
  snapshot: cloudIdentitySnapshotSchema,
  resource: identityCapabilityResourceHandleSchema
}).strict().readonly()

export const emptyIdentityInputSchema = z.object({}).strict()

export const cloudDeviceRevokeInputSchema = z.object({
  deviceId: cloudDeviceIdSchema
}).strict().readonly()

export const cloudIdentityObservationContract = Object.freeze({
  resourceKind: 'identity.cloud-session',
  stateSchema: cloudIdentitySnapshotSchema
})

export type DesktopIdentityUser = z.infer<typeof desktopIdentityUserSchema>
export type DesktopIdentityStatus = z.infer<typeof desktopIdentityStatusSchema>
export type DesktopIdentityErrorCode = z.infer<typeof desktopIdentityErrorCodeSchema>
export type DesktopIdentityActionResult = z.infer<typeof desktopIdentityActionResultSchema>
export type DesktopDeviceSummary = z.infer<typeof desktopDeviceSummarySchema>
export type DesktopDeviceStatus = z.infer<typeof desktopDeviceStatusSchema>
export type DesktopDeviceActionResult = z.infer<typeof desktopDeviceActionResultSchema>
export type CloudIdentitySnapshot = z.infer<typeof cloudIdentitySnapshotSchema>
export type CloudIdentityInspectOutput = z.infer<typeof cloudIdentityInspectOutputSchema>
