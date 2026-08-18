export type Assurance = 'basic' | 'verified' | 'strong' | 'device'
export type ResourceStatus = 'active' | 'suspended' | 'revoked'

export type StoredUser = {
  userId: string
  displayName: string
  status: ResourceStatus
  revision: number
  createdAt: string
  updatedAt: string
  revokedAt?: string
}

export type StoredOidcIdentity = {
  identityId: string
  userId: string
  issuer: string
  subject: string
  emailAtLinkTime?: string
  status: 'active' | 'revoked'
  revision: number
  createdAt: string
  updatedAt: string
  revokedAt?: string
}

export type StoredDeviceEnrollment = {
  enrollmentId: string
  userId: string
  installationId: string
  nonceDigest: string
  status: 'pending' | 'consumed' | 'expired'
  revision: number
  expiresAt: string
  createdAt: string
  updatedAt: string
  consumedAt?: string
}

export type StoredDevicePlatform = {
  os: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  osVersion?: string
  appVersion: string
}

export type StoredEd25519PublicJwk = {
  kty: 'OKP'
  crv: 'Ed25519'
  alg: 'EdDSA'
  use: 'sig'
  kid: string
  x: string
}

export type StoredDevice = {
  deviceId: string
  userId: string
  installationId: string
  displayName: string
  platform: StoredDevicePlatform
  publicKeyJwk: StoredEd25519PublicJwk
  capabilitySummary: string[]
  status: 'active' | 'revoked'
  revision: number
  createdAt: string
  updatedAt: string
  revokedAt?: string
}

export type StoredZulipBindingRequest = {
  bindingRequestId: string
  userId: string
  realmUrl: string
  codeDigest: string
  status: 'pending' | 'confirmed' | 'expired'
  revision: number
  expiresAt: string
  createdAt: string
  updatedAt: string
  confirmedAt?: string
  externalIdentityId?: string
  serviceActorId?: string
  providerEventId?: string
}

export type StoredExternalIdentity = {
  externalIdentityId: string
  humanEndpointId: string
  userId: string
  provider: 'zulip'
  realmUrl: string
  realmId: string
  zulipUserId: string
  status: 'active' | 'revoked'
  revision: number
  verifiedAt: string
  createdAt: string
  updatedAt: string
  revokedAt?: string
}

export type StoredChallenge = {
  challengeId: string
  requestedUserId?: string
  provider: string
  realmId: string
  expectedProviderUserId?: string
  challengeDigest: string
  pollSecretDigest: string
  requestedDisplayName: string
  expiresAt: string
  createdAt: string
  verifiedUserId?: string
  verifiedEndpointId?: string
  verifiedAt?: string
  consumedAt?: string
}

export type StoredEndpoint = {
  humanEndpointId: string
  userId: string
  provider: string
  realmId: string
  providerUserId: string
  displayName?: string
  assurance: Exclude<Assurance, 'device'>
  status: ResourceStatus
  revision: number
  verifiedAt: string
  updatedAt: string
  revokedAt?: string
}

export type StoredAgent = {
  agentId: string
  /** Legacy installation authority. New Agents derive installation from Device. */
  installationId?: string
  /** Null only for historical non-ACTIVE Agents migrated before Device enrollment existed. */
  deviceId?: string
  ownerUserId: string
  displayName: string
  nodeType: string
  capabilities: string[]
  status: ResourceStatus
  connectionStatus: 'online' | 'offline'
  credentialGeneration: number
  revision: number
  lastSeenAt?: string
  updatedAt: string
  revokedAt?: string
}

export type CapabilityEvidenceLevel = 'detected' | 'configured' | 'verified'

export type StoredCapabilityEvidence = {
  level: CapabilityEvidenceLevel
  checkedAt: string
  summary?: string
}

export type StoredAgentCapabilityProfile = {
  agentId: string
  ownerUserId: string
  nodeType: 'personal_computer' | 'institution_server'
  osFamily: 'windows' | 'macos' | 'linux'
  osArchitecture: 'x64' | 'arm64'
  osVersion?: string
  runtimeIds: string[]
  capabilities: Array<{
    capabilityId: string
    version?: string
    evidence: StoredCapabilityEvidence
  }>
  gpu: Array<{
    vendor?: string
    model?: string
    memoryGB?: number
    evidence: StoredCapabilityEvidence
  }>
  vpnAccessIds: string[]
  slurmClusterIds: string[]
  accessibleResourceRefIds: string[]
  resultReturnPolicy: {
    summary: true
    evidenceRefs: boolean
    resourceRefs: boolean
    logSummary: boolean
    fullFileRequiresConfirmation: true
    fullLogRequiresConfirmation: true
  }
  reportedAt: string
  expiresAt: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type StoredCredential = {
  credentialId: string
  kind: 'user' | 'agent_device'
  subjectUserId: string
  subjectAgentId?: string
  tokenDigest: string
  assurance: Exclude<Assurance, 'unverified'>
  generation: number
  createdAt: string
  expiresAt?: string
  revokedAt?: string
}

export type StoredParticipant = {
  userId: string
  primaryHumanEndpointId?: string
  primaryAgentId?: string
  status: 'incomplete' | 'complete'
  revision: number
  updatedAt: string
}

export type ProjectBudgets = {
  maxTasks: number
  maxTasksPerRound: number
  maxTaskRetries: number
  maxCoordinationRounds: number
}

export type StoredProject = {
  projectId: string
  ownerUserId: string
  displayName: string
  goal: string
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled'
  coordinatorAgentId: string
  budgets: ProjectBudgets
  coordinationRound: number
  revision: number
  createdAt: string
  updatedAt: string
}

export type StoredProjectMember = {
  projectId: string
  userId: string
  role: 'owner' | 'member' | 'observer'
  active: boolean
  createdAt: string
}

export type ProjectCapabilityAgentView = {
  agentId: string
  ownerUserId: string
  displayName: string
  nodeType: string
  capabilities: string[]
  status: 'online' | 'offline' | 'busy' | 'revoked'
  lastSeenAt: string
  profile: StoredAgentCapabilityProfile
  revision: number
}

export type ProjectCapabilityDirectoryView = {
  projectId: string
  projectRevision: number
  agents: ProjectCapabilityAgentView[]
}

export type TaskStatus =
  | 'offered'
  | 'accepted'
  | 'rejected'
  | 'in_progress'
  | 'needs_human'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type StoredWorkerRequirement = {
  osFamilies?: Array<'windows' | 'macos' | 'linux'>
  capabilityIds: string[]
  minimumEvidenceLevel?: 'detected' | 'configured' | 'verified'
  minGpuMemoryGB?: number
  vpnAccessIds: string[]
  slurmClusterIds: string[]
  requiredResourceRefIds: string[]
  requireLogSummary?: boolean
}

export type StoredAuthorizationRequirement = {
  id: string
  kind: 'resource_access' | 'data_egress' | 'file_upload' | 'local_action'
  targetRefId?: string
  description: string
}

export type StoredTask = {
  taskId: string
  projectId: string
  executionId: string
  assigneeAgentId: string
  assigneeUserId: string
  createdByAgentId: string
  title: string
  objective: string
  completionCriteria: Array<{
    criterionId: string
    text: string
  }>
  dependencyTaskIds: string[]
  requiredCapabilities: StoredWorkerRequirement
  resourceRefIds: string[]
  authorizationRequirements: StoredAuthorizationRequirement[]
  status: TaskStatus
  retryCount: number
  maxRetries: number
  coordinationRound: number
  activeTurnId?: string
  progress?: {
    percent: number
    summary: string
    reportedAt: string
  }
  resultSummary?: string
  resultRecordId?: string
  safeFailureCode?: string
  safeFailureSummary?: string
  revision: number
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type ProjectRecordKind = 'observation' | 'proposal' | 'decision' | 'summary' | 'task_result'

export type StoredProjectRecord = {
  projectRecordId: string
  projectId: string
  kind: ProjectRecordKind
  status: 'candidate' | 'accepted' | 'rejected' | 'superseded'
  summary: string
  authorUserId?: string
  authorAgentId?: string
  sourceTaskId?: string
  sourceExecutionId?: string
  sourceRevision?: number
  criterionEvidence: Array<{
    criterionId: string
    summary: string
    resourceRefIds: string[]
  }>
  resourceRefIds: string[]
  logSummary?: string
  acceptedByUserId?: string
  acceptedByAgentId?: string
  acceptedAt?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type StoredResourceRef = {
  resourceRefId: string
  projectId: string
  taskId?: string
  executionId?: string
  taskRevision?: number
  createdByUserId: string
  createdByAgentId?: string
  provider: string
  externalId: string
  kind: string
  name: string
  openUrl: string
  version?: string
  status: 'available' | 'unavailable' | 'revoked' | 'invalidated'
  statusReasonCode?: string
  unavailableAt?: string
  revokedAt?: string
  invalidatedAt?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type ProviderLocatorValue = {
  type: 'provider_locator'
  provider: string
  realmId: string
  containerId: string
  topicId: string
  containerDisplayName?: string
  topicDisplayName?: string
}

export type StoredProjection = {
  projectionId: string
  ownerUserId: string
  agentId: string
  humanEndpointId: string
  locator: ProviderLocatorValue
  locatorRevision: number
  displayName: string
  status: 'active' | 'paused' | 'error' | 'closed'
  allowedSenderUserIds: string[]
  lastErrorCode?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type StoredProjectEndpointBinding = {
  projectEndpointBindingId: string
  projectId: string
  locator: ProviderLocatorValue
  locatorRevision: number
  status: 'active' | 'error' | 'closed'
  lastErrorCode?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type StoredProjectInput = {
  projectInputId: string
  projectId: string
  senderUserId: string
  sourceHumanEndpointId: string
  providerMessageId: string
  sequence: number
  text: string
  status: 'queued' | 'processed' | 'rejected' | 'expired'
  revision: number
  occurredAt: string
  createdAt: string
  updatedAt: string
}

export type StoredHumanRequest = {
  humanRequestId: string
  projectId: string
  sourceKind: 'worker' | 'coordinator'
  taskId?: string
  executionId?: string
  sourceInboxMessageId?: string
  targetUserId: string
  requestedByAgentId: string
  requiredAssurance: 'basic' | 'verified' | 'strong'
  prompt: string
  confirmableAction?: StoredConfirmableAction
  status: 'pending' | 'answered' | 'expired' | 'cancelled'
  revision: number
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export type StoredHumanAnswer = {
  humanAnswerId: string
  humanRequestId: string
  projectId: string
  taskId?: string
  executionId?: string
  requestRevision: number
  answeredByUserId: string
  answeredFromHumanEndpointId: string
  assurance: 'basic' | 'verified' | 'strong'
  answer: string
  decision?: 'approve' | 'reject'
  confirmationId?: string
  revision: number
  answeredAt: string
  createdAt: string
  updatedAt: string
}

export type StoredConfirmableAction =
  | { kind: 'tasks.create'; projectId: string; proposalDigest: string }
  | { kind: 'task.retry_reassign'; projectId: string; taskId: string; fromExecutionId: string; assigneeAgentId: string }
  | { kind: 'task.cancel'; projectId: string; taskId: string; executionId: string }
  | { kind: 'project.complete'; projectId: string; finalRecordDigest: string }

export type StoredActionConfirmation = {
  confirmationId: string
  humanRequestId: string
  projectId: string
  targetUserId: string
  coordinatorAgentId: string
  action: StoredConfirmableAction
  actionDigest: string
  status: 'approved' | 'consumed' | 'superseded'
  approvedAt: string
  expiresAt: string
  consumedAt?: string
  consumedByActorKey?: string
  consumedOperation?: string
  createdAt: string
  updatedAt: string
}

export type InboxRecipient = {
  kind: 'user' | 'human_endpoint' | 'agent'
  id: string
}

export type StoredInboxMessage = {
  recipient: InboxRecipient
  sequence: number
  messageId: string
  messageType: string
  payload: Record<string, unknown>
  disposition: 'active' | 'superseded'
  supersededAt?: string
  supersededByMessageId?: string
  createdAt: string
  expiresAt: string
}

export type StoredInboxCursor = {
  recipient: InboxRecipient
  nextSequence: number
  ackedSequence: number
  updatedAt: string
}

export type StoredReceipt = {
  receiptId: string
  actorKey: string
  idempotencyKey: string
  requestDigest: string
  operation: string
  resourceKind?: string
  resourceId?: string
  response: Record<string, unknown>
  createdAt: string
  expiresAt: string
}

export type StoredAuditEvent = {
  auditEventId: string
  actorKind: string
  actorUserId?: string
  actorEndpointId?: string
  actorAgentId?: string
  action: string
  resourceKind?: string
  resourceId?: string
  outcome: 'accepted' | 'rejected'
  metadata: Record<string, unknown>
  createdAt: string
}
