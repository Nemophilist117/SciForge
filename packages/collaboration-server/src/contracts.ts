import {
  actionConfirmationSchema,
  agentCapabilityProfileSchema,
  agentNodeSchema,
  humanAnswerSchema,
  humanEndpointBindingSchema,
  humanNeededSchema,
  inboxMessageSchema,
  participantProfileSchema,
  projectInputSchema,
  projectCoordinationViewSchema,
  projectCapabilityDirectorySchema,
  projectEndpointBindingSchema,
  projectRecordSchema,
  resourceRefSchema,
  projectSchema,
  remoteSessionProjectionSchema,
  taskSchema,
  userPrincipalSchema,
  type ActionConfirmation,
  type AgentCapabilityProfile,
  type AgentNode,
  type HumanAnswer,
  type HumanEndpointBinding,
  type HumanNeeded,
  type InboxMessage,
  type ParticipantProfile,
  type Project,
  type ProjectInput,
  type ProjectCoordinationView,
  type ProjectCapabilityDirectory,
  type ProjectEndpointBinding,
  type ProjectRecord,
  type ResourceRef,
  type RemoteSessionProjection,
  type Task,
  type UserPrincipal
} from '@sciforge/collaboration-contracts'

import { stableDigest } from './crypto.js'
import type {
  StoredActionConfirmation,
  StoredAgent,
  StoredAgentCapabilityProfile,
  StoredEndpoint,
  StoredHumanAnswer,
  StoredHumanRequest,
  StoredInboxMessage,
  StoredParticipant,
  StoredProject,
  StoredProjectEndpointBinding,
  StoredProjectInput,
  ProjectCapabilityDirectoryView,
  StoredProjectMember,
  StoredProjectRecord,
  StoredResourceRef,
  StoredProjection,
  StoredTask,
  StoredUser
} from './model.js'

export function toUserPrincipal(user: StoredUser): UserPrincipal {
  return userPrincipalSchema.parse({ schemaVersion: 1, type: 'user_principal', userId: user.userId,
    displayName: user.displayName, status: user.status, revision: user.revision,
    createdAt: user.createdAt, updatedAt: user.updatedAt })
}

export function toEndpoint(endpoint: StoredEndpoint): HumanEndpointBinding {
  return humanEndpointBindingSchema.parse({ schemaVersion: 1, type: 'human_endpoint_binding',
    humanEndpointId: endpoint.humanEndpointId, userId: endpoint.userId,
    identity: { type: 'provider_identity', provider: endpoint.provider, realmId: endpoint.realmId,
      providerUserId: endpoint.providerUserId, ...(endpoint.displayName ? { displayName: endpoint.displayName } : {}) },
    displayName: endpoint.displayName ?? endpoint.providerUserId, assurance: endpoint.assurance,
    status: endpoint.status, verifiedAt: endpoint.verifiedAt, ...(endpoint.revokedAt ? { revokedAt: endpoint.revokedAt } : {}),
    revision: endpoint.revision, createdAt: endpoint.verifiedAt, updatedAt: endpoint.updatedAt })
}

export function toAgent(agent: StoredAgent): AgentNode {
  return agentNodeSchema.parse({ schemaVersion: 1, type: 'agent_node', agentId: agent.agentId,
    ...(agent.deviceId ? { deviceId: agent.deviceId } : {}),
    ownerUserId: agent.ownerUserId, displayName: agent.displayName,
    nodeType: agent.nodeType, capabilities: agent.capabilities,
    lifecycleStatus: agent.status === 'revoked' ? 'revoked' : 'active', connectionStatus: agent.connectionStatus,
    credentialVersion: agent.credentialGeneration, ...(agent.lastSeenAt ? { lastSeenAt: agent.lastSeenAt } : {}),
    ...(agent.revokedAt ? { revokedAt: agent.revokedAt } : {}), revision: agent.revision,
    createdAt: agent.updatedAt, updatedAt: agent.updatedAt })
}

export function toParticipant(participant: StoredParticipant): ParticipantProfile {
  return participantProfileSchema.parse({ schemaVersion: 1, type: 'participant_profile',
    participantId: `par_${stableDigest(participant.userId).slice(0, 24)}`, userId: participant.userId,
    primaryHumanEndpointId: participant.primaryHumanEndpointId ?? null, primaryAgentId: participant.primaryAgentId ?? null,
    status: participant.status === 'complete' ? 'active' : 'incomplete', revision: participant.revision,
    createdAt: participant.updatedAt, updatedAt: participant.updatedAt })
}

export function toProjection(projection: StoredProjection): RemoteSessionProjection {
  return remoteSessionProjectionSchema.parse({ schemaVersion: 1, type: 'remote_session_projection',
    ...projection })
}

export function toProject(project: StoredProject, members: StoredProjectMember[]): Project {
  return projectSchema.parse({ schemaVersion: 1, type: 'project', projectId: project.projectId,
    ownerUserId: project.ownerUserId, displayName: project.displayName, goal: project.goal,
    memberUserIds: members.filter((member) => member.active).map((member) => member.userId),
    coordinatorAgentId: project.coordinatorAgentId,
    status: project.status === 'failed' ? 'cancelled' : project.status,
    budget: project.budgets, revision: project.revision, createdAt: project.createdAt, updatedAt: project.updatedAt })
}

export function toProjectCapabilityDirectory(directory: ProjectCapabilityDirectoryView): ProjectCapabilityDirectory {
  return projectCapabilityDirectorySchema.parse({
    schemaVersion: 1,
    type: 'project_capability_directory',
    projectId: directory.projectId,
    projectRevision: directory.projectRevision,
    agents: directory.agents.map((agent) => ({ ...agent, capabilities: [...agent.capabilities].sort(),
      profile: toAgentCapabilityProfile(agent.profile) }))
  })
}

export function toAgentCapabilityProfile(profile: StoredAgentCapabilityProfile): AgentCapabilityProfile {
  return agentCapabilityProfileSchema.parse({
    schemaVersion: 1,
    type: 'agent_capability_profile',
    agentId: profile.agentId,
    ownerUserId: profile.ownerUserId,
    nodeType: profile.nodeType,
    os: { family: profile.osFamily, architecture: profile.osArchitecture,
      ...(profile.osVersion ? { version: profile.osVersion } : {}) },
    runtimeIds: profile.runtimeIds,
    capabilities: profile.capabilities,
    gpu: profile.gpu,
    vpnAccessIds: profile.vpnAccessIds,
    slurmClusterIds: profile.slurmClusterIds,
    accessibleResourceRefIds: profile.accessibleResourceRefIds,
    resultReturnPolicy: profile.resultReturnPolicy,
    reportedAt: profile.reportedAt,
    expiresAt: profile.expiresAt,
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  })
}

export function toTask(task: StoredTask): Task {
  const status = task.status === 'in_progress' ? 'running' : task.status === 'completed' ? 'succeeded' : task.status
  return taskSchema.parse({ schemaVersion: 1, type: 'task', taskId: task.taskId, projectId: task.projectId,
    executionId: task.executionId, createdByCoordinatorAgentId: task.createdByAgentId,
    assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId,
    title: task.title, objective: task.objective, completionCriteria: task.completionCriteria,
    dependencyTaskIds: task.dependencyTaskIds, requiredCapabilities: task.requiredCapabilities,
    resourceRefIds: task.resourceRefIds, authorizationRequirements: task.authorizationRequirements,
    status, attempt: task.retryCount + 1, maxRetries: task.maxRetries,
    ...(task.activeTurnId ? { activeTurnId: task.activeTurnId } : {}),
    ...(task.progress ? { progress: task.progress } : {}),
    ...(task.status === 'completed' && task.resultSummary && task.resultRecordId
      ? { resultSummary: task.resultSummary, resultProjectRecordId: task.resultRecordId }
      : {}),
    ...(task.status === 'failed' && task.safeFailureCode ? { safeFailureCode: task.safeFailureCode } : {}),
    ...(task.status === 'failed' && task.safeFailureSummary ? { safeFailureSummary: task.safeFailureSummary } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}), revision: task.revision,
    createdAt: task.createdAt, updatedAt: task.updatedAt })
}

export function toProjectRecord(record: StoredProjectRecord): ProjectRecord {
  return projectRecordSchema.parse({ schemaVersion: 1, type: 'project_record',
    projectRecordId: record.projectRecordId, projectId: record.projectId, kind: record.kind,
    status: record.status === 'candidate' ? 'proposed' : record.status, body: record.summary,
    authorUserId: record.authorUserId, authorAgentId: record.authorAgentId ?? null,
    sourceTaskId: record.sourceTaskId ?? null, sourceExecutionId: record.sourceExecutionId ?? null,
    sourceRevision: record.sourceRevision ?? 1,
    criterionEvidence: record.criterionEvidence, resourceRefIds: record.resourceRefIds,
    logSummary: record.logSummary ?? null,
    acceptedByUserId: record.acceptedByUserId ?? null, acceptedByAgentId: record.acceptedByAgentId ?? null,
    acceptedAt: record.acceptedAt ?? null, revision: record.revision,
    createdAt: record.createdAt, updatedAt: record.updatedAt })
}

export function toResourceRef(resource: StoredResourceRef): ResourceRef {
  return resourceRefSchema.parse({
    schemaVersion: 1,
    type: 'resource_ref',
    resourceRefId: resource.resourceRefId,
    projectId: resource.projectId,
    taskId: resource.taskId ?? null,
    executionId: resource.executionId ?? null,
    taskRevision: resource.taskRevision ?? null,
    createdByUserId: resource.createdByUserId,
    createdByAgentId: resource.createdByAgentId ?? null,
    provider: resource.provider,
    externalId: resource.externalId,
    kind: resource.kind,
    name: resource.name,
    openUrl: resource.openUrl ?? null,
    portableReference: resource.portableReference ?? null,
    version: resource.version ?? null,
    status: resource.status,
    statusReasonCode: resource.statusReasonCode ?? null,
    unavailableAt: resource.unavailableAt ?? null,
    revokedAt: resource.revokedAt ?? null,
    invalidatedAt: resource.invalidatedAt ?? null,
    revision: resource.revision,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt
  })
}

export function toProjectInput(input: StoredProjectInput): ProjectInput {
  return projectInputSchema.parse({ schemaVersion: 1, type: 'project_input', ...input })
}

export function toProjectEndpointBinding(binding: StoredProjectEndpointBinding): ProjectEndpointBinding {
  return projectEndpointBindingSchema.parse({ schemaVersion: 1, type: 'project_endpoint_binding', ...binding })
}

export function toHumanNeeded(request: StoredHumanRequest): HumanNeeded {
  return humanNeededSchema.parse({ schemaVersion: 1, type: 'human_needed', ...request,
    taskId: request.taskId ?? null, executionId: request.executionId ?? null,
    sourceInboxMessageId: request.sourceInboxMessageId ?? null,
    confirmableAction: request.confirmableAction ?? null })
}

export function toHumanAnswer(answer: StoredHumanAnswer): HumanAnswer {
  return humanAnswerSchema.parse({ schemaVersion: 1, type: 'human_answer', ...answer,
    taskId: answer.taskId ?? null, executionId: answer.executionId ?? null,
    decision: answer.decision ?? null, confirmationId: answer.confirmationId ?? null })
}

export function toActionConfirmation(confirmation: StoredActionConfirmation): ActionConfirmation {
  return actionConfirmationSchema.parse({ schemaVersion: 1, type: 'action_confirmation',
    confirmationId: confirmation.confirmationId, humanRequestId: confirmation.humanRequestId,
    projectId: confirmation.projectId, targetUserId: confirmation.targetUserId,
    coordinatorAgentId: confirmation.coordinatorAgentId, action: confirmation.action,
    actionDigest: confirmation.actionDigest, status: confirmation.status,
    approvedAt: confirmation.approvedAt, expiresAt: confirmation.expiresAt,
    consumedAt: confirmation.consumedAt ?? null, createdAt: confirmation.createdAt,
    updatedAt: confirmation.updatedAt })
}

export function toProjectCoordinationView(view: {
  project: StoredProject
  members: Array<StoredProjectMember & { displayName: string }>
  tasks: StoredTask[]
  records: StoredProjectRecord[]
  humanRequests: StoredHumanRequest[]
  humanAnswers: StoredHumanAnswer[]
  readAt: string
}): ProjectCoordinationView {
  return projectCoordinationViewSchema.parse({ schemaVersion: 1, type: 'project_coordination_view',
    projectId: view.project.projectId, projectRevision: view.project.revision,
    project: toProject(view.project, view.members),
    members: view.members.map((member) => ({ userId: member.userId, displayName: member.displayName,
      role: member.role, active: member.active })),
    tasks: view.tasks.map(toTask), records: view.records.map(toProjectRecord),
    humanRequests: view.humanRequests.map(toHumanNeeded), humanAnswers: view.humanAnswers.map(toHumanAnswer),
    readAt: view.readAt })
}

export function toInboxMessage(message: StoredInboxMessage, ackedSequence = 0): InboxMessage {
  const payload = { ...message.payload, type: message.messageType }
  return inboxMessageSchema.parse({ schemaVersion: 1, type: 'inbox_message', inboxMessageId: message.messageId,
    sequence: message.sequence, status: message.disposition === 'superseded'
      ? 'superseded'
      : message.sequence <= ackedSequence ? 'acknowledged' : 'pending',
    disposition: message.disposition, createdAt: message.createdAt, expiresAt: message.expiresAt,
    ...(message.supersededAt ? { supersededAt: message.supersededAt } : {}),
    ...(message.supersededByMessageId ? { supersededByMessageId: message.supersededByMessageId } : {}),
    ...(message.recipient.kind === 'agent'
      ? { recipientType: 'agent', recipientAgentId: message.recipient.id }
      : { recipientType: 'user', recipientUserId: message.recipient.id }),
    payload })
}
