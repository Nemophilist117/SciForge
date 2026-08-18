import {
  canTransition,
  resourceRefCreateMetadataSchema,
  type ResourceRefCreateMetadata
} from '@sciforge/collaboration-contracts'

import { actorInboxRecipient, authorize, type AgentActor, type AuthContext, type HumanEndpointActor, type UserActor } from './auth.js'
import { digestSecret, issueSecret, newId, safeAuditMetadata, stableDigest } from './crypto.js'
import { CollaborationServiceError, fail } from './errors.js'
import type {
  InboxRecipient,
  ProviderLocatorValue,
  ProjectBudgets,
  ProjectCapabilityDirectoryView,
  ProjectRecordKind,
  StoredActionConfirmation,
  StoredAgent,
  StoredAgentCapabilityProfile,
  StoredAuditEvent,
  StoredEndpoint,
  StoredInboxMessage,
  StoredParticipant,
  StoredProjection,
  StoredProject,
  StoredProjectEndpointBinding,
  StoredProjectInput,
  StoredProjectMember,
  StoredProjectRecord,
  StoredResourceRef,
  StoredReceipt,
  StoredTask,
  StoredUser,
  StoredHumanRequest,
  StoredHumanAnswer,
  StoredConfirmableAction,
  StoredWorkerRequirement,
  StoredAuthorizationRequirement,
  TaskStatus
} from './model.js'
import type { CollaborationRepository, CollaborationTransaction } from './repository.js'

export type InboxAvailabilityNotifier = {
  notifyInboxAvailable(recipient: InboxRecipient, latestSequence: number): void | Promise<void>
}

export type CollaborationServiceOptions = {
  repository: CollaborationRepository
  notifier?: InboxAvailabilityNotifier
  now?: () => Date
  pairingTtlMs?: number
  inboxRetentionMs?: number
  receiptRetentionMs?: number
}

type CommandResult<T extends Record<string, unknown>> = {
  response: T
  resourceKind?: string
  resourceId?: string
  notifications?: Array<{ recipient: InboxRecipient; sequence: number }>
  receiptResponse?: Record<string, unknown>
  persistReceipt?: boolean
}

type TaskResultInput = {
  summary: string
  criterionEvidence: Array<{
    criterionId: string
    summary: string
    resourceRefIds: string[]
  }>
  resourceRefIds: string[]
  logSummary?: string
}

const DEFAULT_BUDGETS: ProjectBudgets = {
  maxTasks: 100,
  maxTasksPerRound: 20,
  maxTaskRetries: 2,
  maxCoordinationRounds: 20
}

const COORDINATOR_HUMAN_SOURCE_MESSAGE_TYPES = new Set([
  'project.started',
  'project.input.received',
  'task.updated',
  'project_record.submitted',
  'project.endpoint.updated',
  'human.answer.received'
])

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  offered: ['accepted', 'rejected'],
  accepted: ['in_progress', 'rejected'],
  rejected: [],
  in_progress: ['needs_human', 'completed', 'failed'],
  needs_human: ['in_progress', 'failed'],
  completed: [],
  failed: [],
  cancelled: []
}

export class CollaborationService {
  private readonly repository: CollaborationRepository
  private readonly notifier?: InboxAvailabilityNotifier
  private readonly now: () => Date
  private readonly inboxRetentionMs: number
  private readonly receiptRetentionMs: number

  constructor(options: CollaborationServiceOptions) {
    this.repository = options.repository
    this.notifier = options.notifier
    this.now = options.now ?? (() => new Date())
    this.inboxRetentionMs = bounded(options.inboxRetentionMs ?? 30 * 86_400_000, 86_400_000, 90 * 86_400_000)
    this.receiptRetentionMs = bounded(options.receiptRetentionMs ?? 30 * 86_400_000, 86_400_000, 90 * 86_400_000)
  }

  async beginPairing(input: {
    provider: string
    realmId: string
    requestedDisplayName: string
    idempotencyKey: string
    requestedBy?: UserActor
    expectedProviderUserId?: string
  }): Promise<Record<string, unknown>> {
    void input
    fail('invalid_state_transition',
      'Legacy pairing is disabled; an OIDC User must use the authoritative Zulip binding service.')
  }

  async verifyPairingFromProvider(input: {
    provider: string
    realmId: string
    providerUserId: string
    providerDisplayName?: string
    challengeId?: string
    challengeCode: string
    providerEventId: string
    assurance: 'verified' | 'strong'
  }): Promise<Record<string, unknown>> {
    void input
    fail('permission_denied',
      'Legacy provider pairing verification is disabled; only trusted binding confirmation is accepted.')
  }

  async redeemPairing(input: { pollSecret: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
    void input
    fail('permission_denied', 'Legacy pairing redemption is disabled and cannot issue a User credential.')
  }

  async revokeCurrentCredential(
    actor: AgentActor,
    input: { idempotencyKey: string }
  ): Promise<void> {
    await this.commit(actor, 'credential.revoke_current', input.idempotencyKey, input, async (tx, at) => {
      if (!await tx.revokeCredential(actor.credentialId, at)) {
        fail('credential_revoked', 'The current bearer credential was already revoked.')
      }
      return {
        response: { protocolVersion: '1.0', type: 'credential.revoked' },
        resourceKind: 'credential',
        resourceId: actor.credentialId
      }
    })
  }

  async setUserStatus(actor: AuthContext, input: {
    userId: string
    status: 'active' | 'suspended' | 'revoked'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredUser> {
    if (actor.kind !== 'system' && (actor.kind !== 'user' || actor.userId !== input.userId || actor.assurance !== 'strong')) {
      fail('permission_denied', 'Changing user lifecycle requires system authority or the same strong User actor.')
    }
    return this.commit(actor, 'user.status.set', input.idempotencyKey, input, async (tx, at) => {
      const user = required(await tx.getUserForUpdate(input.userId), 'User')
      expectRevision(user.revision, input.expectedRevision)
      if (!canTransition('user', user.status, input.status)) {
        fail('invalid_state_transition', `User cannot transition from ${user.status} to ${input.status}.`)
      }
      if (input.status !== 'active') await assertNoActiveOwnedAgents(tx, user.userId)
      const updated: StoredUser = { ...user, status: input.status, revision: user.revision + 1, updatedAt: at,
        revokedAt: input.status === 'revoked' ? at : user.revokedAt }
      await tx.updateUser(updated, user.revision)
      if (input.status !== 'active') await tx.revokeCredentials('user', user.userId, at)
      return { response: entityResponse('user.updated', updated), resourceKind: 'user', resourceId: user.userId }
    }).then(responseEntity<StoredUser>)
  }

  async getUser(actor: AuthContext, userId: string): Promise<StoredUser> {
    if (actor.kind === 'system' || actor.userId !== userId) fail('permission_denied', 'A UserPrincipal is private to its user.')
    return required(await this.repository.getUser(userId), 'User')
  }

  async updateUser(actor: UserActor, input: {
    userId: string
    displayName?: string
    status?: 'active' | 'suspended' | 'revoked'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredUser> {
    if (actor.userId !== input.userId) fail('permission_denied', 'A user may only update their own principal.')
    if (input.status && input.status !== 'active' && actor.assurance !== 'strong') {
      fail('assurance_insufficient', 'Suspending or revoking a user requires strong assurance.')
    }
    if (input.displayName) assertText(input.displayName, 'displayName', 1, 200)
    return this.commit(actor, 'user.update', input.idempotencyKey, input, async (tx, at) => {
      const user = required(await (input.status === undefined
        ? tx.getUser(input.userId)
        : tx.getUserForUpdate(input.userId)), 'User')
      expectRevision(user.revision, input.expectedRevision)
      if (user.status === 'revoked') fail('invalid_state_transition', 'A revoked user cannot be updated.')
      if (input.status !== undefined && !canTransition('user', user.status, input.status)) {
        fail('invalid_state_transition', `User cannot transition from ${user.status} to ${input.status}.`)
      }
      const status = input.status ?? user.status
      if (input.status !== undefined && status !== 'active') await assertNoActiveOwnedAgents(tx, user.userId)
      const updated: StoredUser = { ...user, displayName: input.displayName ?? user.displayName, status,
        revokedAt: status === 'revoked' ? at : user.revokedAt, revision: user.revision + 1, updatedAt: at }
      await tx.updateUser(updated, user.revision)
      if (status !== 'active') await tx.revokeCredentials('user', user.userId, at)
      return { response: entityResponse('user.updated', updated), resourceKind: 'user', resourceId: user.userId }
    }).then(responseEntity<StoredUser>)
  }

  async setEndpointStatus(actor: UserActor, input: {
    humanEndpointId: string
    status: 'active' | 'suspended' | 'revoked'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredEndpoint> {
    return this.commit(actor, 'endpoint.status.set', input.idempotencyKey, input, async (tx, at) => {
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Human endpoint')
      if (endpoint.userId !== actor.userId) fail('permission_denied', 'The endpoint belongs to another user.')
      expectRevision(endpoint.revision, input.expectedRevision)
      if (!canTransition('endpoint', endpoint.status, input.status)) {
        fail('invalid_state_transition', `Human endpoint cannot transition from ${endpoint.status} to ${input.status}.`)
      }
      const updated: StoredEndpoint = { ...endpoint, status: input.status, revision: endpoint.revision + 1,
        updatedAt: at, revokedAt: input.status === 'revoked' ? at : endpoint.revokedAt }
      await tx.updateEndpoint(updated, endpoint.revision)
      const participant = await tx.getParticipant(actor.userId)
      if (participant?.primaryHumanEndpointId === endpoint.humanEndpointId && input.status !== 'active') {
        const changed = completeParticipant({ ...participant, primaryHumanEndpointId: undefined,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: entityResponse('endpoint.updated', updated), resourceKind: 'human_endpoint',
        resourceId: endpoint.humanEndpointId }
    }).then(responseEntity<StoredEndpoint>)
  }

  async transferEndpoint(actor: UserActor, input: {
    humanEndpointId: string
    targetUserId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredEndpoint> {
    if (actor.assurance !== 'strong') fail('assurance_insufficient', 'Endpoint transfer requires strong assurance.')
    return this.commit(actor, 'endpoint.transfer', input.idempotencyKey, input, async (tx, at) => {
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Human endpoint')
      if (endpoint.userId !== actor.userId) fail('permission_denied', 'Only the current endpoint owner may transfer it.')
      expectRevision(endpoint.revision, input.expectedRevision)
      const target = required(await tx.getUser(input.targetUserId), 'Target user')
      if (target.status !== 'active') fail('credential_revoked', 'The target user is not active.')
      const updated: StoredEndpoint = { ...endpoint, userId: target.userId, revision: endpoint.revision + 1, updatedAt: at }
      await tx.updateEndpoint(updated, endpoint.revision)
      for (const userId of [actor.userId, target.userId]) {
        const participant = await tx.getParticipant(userId)
        if (!participant) continue
        const changed = completeParticipant({ ...participant,
          primaryHumanEndpointId: userId === target.userId
            ? participant.primaryHumanEndpointId ?? endpoint.humanEndpointId
            : participant.primaryHumanEndpointId === endpoint.humanEndpointId ? undefined : participant.primaryHumanEndpointId,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: entityResponse('endpoint.transferred', updated), resourceKind: 'human_endpoint',
        resourceId: endpoint.humanEndpointId }
    }).then(responseEntity<StoredEndpoint>)
  }

  async registerAgent(actor: UserActor, input: {
    deviceId: string
    displayName: string
    nodeType: string
    capabilities: string[]
    idempotencyKey: string
  }): Promise<{ agent: StoredAgent; deviceCredential?: string; replayed?: boolean }> {
    assertText(input.deviceId, 'deviceId', 8, 300)
    assertText(input.displayName, 'displayName', 1, 200)
    assertText(input.nodeType, 'nodeType', 1, 100)
    const capabilities = uniqueTexts(input.capabilities, 100, 200)
    const deviceCredential = issueSecret('agent')
    return this.commit(actor, 'agent.register', input.idempotencyKey, { ...input, capabilities }, async (tx, at) => {
      const owner = required(await tx.getUserForUpdate(actor.userId), 'User')
      if (owner.status !== 'active') fail('credential_revoked', 'The Agent owner is not active.')
      const device = required(await tx.getDeviceForUpdate(input.deviceId), 'Device')
      if (device.status !== 'active' || device.userId !== actor.userId) {
        fail('permission_denied', 'Agent registration requires an ACTIVE Device owned by the authenticated User.')
      }
      const existing = (await tx.listAgentsForDevice(device.deviceId))
        .find((candidate) => candidate.status === 'active')
      if (existing) {
        if (existing.ownerUserId !== actor.userId || existing.deviceId !== device.deviceId) {
          fail('identity_conflict', 'The Device is associated with another Agent owner.')
        }
        return { response: { protocolVersion: '1.0', type: 'agent.registered', agent: existing, replayed: true },
          resourceKind: 'agent', resourceId: existing.agentId }
      }
      const agent: StoredAgent = {
        agentId: newId('agt'), deviceId: device.deviceId, ownerUserId: actor.userId,
        displayName: input.displayName, nodeType: input.nodeType, capabilities, status: 'active',
        connectionStatus: 'offline', credentialGeneration: 1, revision: 1, updatedAt: at
      }
      await tx.insertAgent(agent)
      await tx.insertCredential({ credentialId: newId('credential'), kind: 'agent_device', subjectUserId: actor.userId,
        subjectAgentId: agent.agentId, tokenDigest: digestSecret(deviceCredential), assurance: 'device', generation: 1, createdAt: at })
      const participant = await tx.getParticipant(actor.userId)
      const changed = completeParticipant({ userId: actor.userId,
        primaryHumanEndpointId: participant?.primaryHumanEndpointId,
        primaryAgentId: participant?.primaryAgentId ?? agent.agentId,
        status: 'incomplete', revision: (participant?.revision ?? 0) + 1, updatedAt: at })
      await tx.upsertParticipant(changed, participant?.revision ?? null)
      return {
        response: { protocolVersion: '1.0', type: 'agent.registered', agent, deviceCredential },
        receiptResponse: { protocolVersion: '1.0', type: 'agent.registered', agent, replayed: true },
        resourceKind: 'agent', resourceId: agent.agentId
      }
    }).then((response) => ({
      agent: response.agent as StoredAgent,
      ...(typeof response.deviceCredential === 'string' ? { deviceCredential: response.deviceCredential } : {}),
      ...(response.replayed === true ? { replayed: true } : {})
    }))
  }

  async heartbeatAgent(actor: AgentActor, input: {
    expectedRevision: number
    connectionStatus?: 'online' | 'offline'
    capabilities?: string[]
    idempotencyKey: string
  }): Promise<StoredAgent> {
    return this.commit(actor, 'agent.heartbeat', input.idempotencyKey, input, async (tx, at) => {
      const initialAgent = required(await tx.getAgent(actor.agentId), 'Agent')
      assertCurrentAgentActor(actor, initialAgent)
      expectRevision(initialAgent.revision, input.expectedRevision)
      const requestedConnectionStatus = input.connectionStatus ?? 'online'
      const lockedProjects = requestedConnectionStatus === 'offline'
        ? await lockProjectsForUpdate(tx, await activeCoordinatorProjectIds(tx, initialAgent.agentId))
        : new Map<string, StoredProject>()
      const agent = required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
      assertCurrentAgentActor(actor, agent)
      expectRevision(agent.revision, input.expectedRevision)
      const activeCoordinatorProjects = requestedConnectionStatus === 'offline'
        ? await tx.listActiveProjectsForCoordinator(agent.agentId)
        : []
      assertProjectLocksCover(lockedProjects, activeCoordinatorProjects.map((project) => project.projectId))
      const capabilities = input.capabilities ? uniqueTexts(input.capabilities, 256, 128) : agent.capabilities
      const updated: StoredAgent = { ...agent, connectionStatus: requestedConnectionStatus, capabilities, lastSeenAt: at,
        revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      if (updated.connectionStatus === 'offline') {
        for (const project of activeCoordinatorProjects) {
          const paused = { ...project, status: 'paused' as const, revision: project.revision + 1, updatedAt: at }
          await tx.updateProject(paused, project.revision)
          const message = await this.appendInbox(tx, { kind: 'user', id: project.ownerUserId },
            'collaboration.important_failure', { protocolVersion: '1.0', type: 'collaboration.important_failure',
              projectId: project.projectId, safeMessage: 'The Coordinator Agent is offline; the Project was paused and requires explicit resume or transfer.' }, at)
          notifications.push({ recipient: message.recipient, sequence: message.sequence })
        }
      }
      return { response: entityResponse('agent.heartbeat.accepted', updated), resourceKind: 'agent',
        resourceId: agent.agentId, notifications }
    }).then(responseEntity<StoredAgent>)
  }

  async rotateAgentCredential(actor: UserActor, input: {
    agentId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<{ agent: StoredAgent; deviceCredential?: string; replayed?: boolean }> {
    const deviceCredential = issueSecret('agent')
    return this.commit(actor, 'agent.credential.rotate', input.idempotencyKey, input, async (tx, at) => {
      const initial = required(await tx.getAgent(input.agentId), 'Agent')
      if (!initial.deviceId) fail('credential_revoked', 'The Agent is not linked to an ACTIVE Device.')
      const device = required(await tx.getDeviceForUpdate(initial.deviceId), 'Device')
      if (device.status !== 'active' || device.userId !== actor.userId) {
        fail('credential_revoked', 'The Agent Device is no longer active.')
      }
      const agent = required(await tx.getAgentForUpdate(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId) fail('permission_denied', 'The Agent belongs to another user.')
      if (agent.deviceId !== device.deviceId) fail('credential_revoked', 'The Agent Device link changed concurrently.')
      expectRevision(agent.revision, input.expectedRevision)
      await tx.revokeCredentials('agent_device', agent.agentId, at)
      const updated: StoredAgent = { ...agent, credentialGeneration: agent.credentialGeneration + 1,
        connectionStatus: 'offline', revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      await tx.insertCredential({ credentialId: newId('credential'), kind: 'agent_device', subjectUserId: actor.userId,
        subjectAgentId: agent.agentId, tokenDigest: digestSecret(deviceCredential), assurance: 'device',
        generation: updated.credentialGeneration, createdAt: at })
      return { response: { protocolVersion: '1.0', type: 'agent.credential_rotated', agent: updated, deviceCredential },
        receiptResponse: { protocolVersion: '1.0', type: 'agent.credential_rotated', agent: updated, replayed: true },
        resourceKind: 'agent', resourceId: agent.agentId }
    }).then((response) => ({ agent: response.agent as StoredAgent,
      ...(typeof response.deviceCredential === 'string' ? { deviceCredential: response.deviceCredential } : {}),
      ...(response.replayed === true ? { replayed: true } : {}) }))
  }

  async revokeAgent(actor: UserActor, input: {
    agentId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredAgent> {
    return this.commit(actor, 'agent.revoke', input.idempotencyKey, input, async (tx, at) => {
      const initialAgent = required(await tx.getAgent(input.agentId), 'Agent')
      if (initialAgent.ownerUserId !== actor.userId) fail('permission_denied', 'The Agent belongs to another user.')
      expectRevision(initialAgent.revision, input.expectedRevision)
      const lockedProjects = await lockProjectsForUpdate(tx, await affectedAgentProjectIds(tx, initialAgent.agentId))
      const agent = required(await tx.getAgentForUpdate(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId) fail('permission_denied', 'The Agent belongs to another user.')
      expectRevision(agent.revision, input.expectedRevision)
      if (!canTransition('agent', agent.status, 'revoked')) {
        fail('invalid_state_transition', `Agent cannot transition from ${agent.status} to revoked.`)
      }
      const [openTasks, activeCoordinatorProjects] = await Promise.all([
        tx.listOpenTasksForAgent(agent.agentId),
        tx.listActiveProjectsForCoordinator(agent.agentId)
      ])
      assertProjectLocksCover(lockedProjects, [
        ...activeCoordinatorProjects.map((project) => project.projectId),
        ...openTasks.map((task) => task.projectId)
      ])
      const updated: StoredAgent = { ...agent, status: 'revoked', connectionStatus: 'offline', revokedAt: at,
        revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      await tx.revokeCredentials('agent_device', agent.agentId, at)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      const ownerMessage = await this.appendInbox(tx, { kind: 'user', id: actor.userId }, 'collaboration.important_failure',
        { protocolVersion: '1.0', type: 'collaboration.important_failure', safeMessage: 'A collaboration Agent was revoked and its pending work requires review.' }, at)
      notifications.push({ recipient: ownerMessage.recipient, sequence: ownerMessage.sequence })
      for (const task of openTasks) {
        const project = required(lockedProjects.get(task.projectId) ?? null, 'Task Project')
        const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated',
          { protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
            revision: task.revision, status: contractTaskStatus(task.status), safeFailureCode: 'assignee_revoked' }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      for (const project of activeCoordinatorProjects) {
        const paused = { ...project, status: 'paused' as const, revision: project.revision + 1, updatedAt: at }
        await tx.updateProject(paused, project.revision)
        const message = await this.appendInbox(tx, { kind: 'user', id: project.ownerUserId },
          'collaboration.important_failure', { protocolVersion: '1.0', type: 'collaboration.important_failure',
            projectId: project.projectId, safeMessage: 'The Coordinator Agent was revoked; the Project was paused and requires explicit transfer.' }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      const participant = await tx.getParticipant(actor.userId)
      if (participant?.primaryAgentId === agent.agentId) {
        const changed = completeParticipant({ ...participant, primaryAgentId: undefined,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: entityResponse('agent.revoked', updated), resourceKind: 'agent', resourceId: agent.agentId, notifications }
    }).then(responseEntity<StoredAgent>)
  }

  async transferAgentOwnership(actor: UserActor, input: {
    agentId: string
    targetUserId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<{ agent: StoredAgent; deviceCredential?: string; replayed?: boolean }> {
    if (actor.assurance !== 'strong') fail('assurance_insufficient', 'Agent ownership transfer requires strong assurance.')
    const deviceCredential = issueSecret('agent')
    return this.commit(actor, 'agent.owner.transfer', input.idempotencyKey, input, async (tx, at) => {
      const initialAgent = required(await tx.getAgent(input.agentId), 'Agent')
      if (initialAgent.ownerUserId !== actor.userId) fail('permission_denied', 'Only the current Agent owner may transfer it.')
      if (initialAgent.deviceId) {
        fail('invalid_state_transition', 'A Device-linked Agent cannot transfer ownership independently of its Device.')
      }
      expectRevision(initialAgent.revision, input.expectedRevision)

      // Every write that can bind this Agent to work follows Project -> User -> Agent -> Task.
      // Lock the currently affected Projects first so a concurrent task assignment
      // cannot pass its membership check while ownership is being transferred.
      const lockedProjects = await lockProjectsForUpdate(tx, await affectedAgentProjectIds(tx, initialAgent.agentId))
      const target = required(await tx.getUserForUpdate(input.targetUserId), 'Target user')
      if (target.status !== 'active') fail('credential_revoked', 'The target user is not active.')
      const agent = required(await tx.getAgentForUpdate(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId) fail('permission_denied', 'Only the current Agent owner may transfer it.')
      expectRevision(agent.revision, input.expectedRevision)

      // Re-query after taking the Agent lock. This closes the window where an
      // assignment committed after the initial Project discovery but before the lock.
      const currentAffectedProjectIds = await affectedAgentProjectIds(tx, agent.agentId)
      assertProjectLocksCover(lockedProjects, currentAffectedProjectIds)
      for (const projectId of currentAffectedProjectIds) {
        const membership = await tx.getProjectMember(projectId, target.userId)
        if (!membership?.active || membership.role === 'observer') {
          fail('permission_denied', 'The target owner must already be an executable member of every active Project assigned to this Agent.')
        }
      }
      await tx.revokeCredentials('agent_device', agent.agentId, at)
      // Capability evidence belongs to the reporting owner. It must not survive
      // an ownership transfer or be re-attributed to the new owner by a FK cascade.
      await tx.deleteAgentCapabilityProfile(agent.agentId)
      const updated: StoredAgent = { ...agent, ownerUserId: target.userId,
        credentialGeneration: agent.credentialGeneration + 1, connectionStatus: 'offline',
        revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      await tx.insertCredential({ credentialId: newId('credential'), kind: 'agent_device',
        subjectUserId: target.userId, subjectAgentId: agent.agentId, tokenDigest: digestSecret(deviceCredential),
        assurance: 'device', generation: updated.credentialGeneration, createdAt: at })
      for (const userId of [actor.userId, target.userId]) {
        const participant = await tx.getParticipant(userId)
        if (!participant) continue
        const changed = completeParticipant({ ...participant,
          primaryAgentId: userId === target.userId
            ? participant.primaryAgentId ?? agent.agentId
            : participant.primaryAgentId === agent.agentId ? undefined : participant.primaryAgentId,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: { protocolVersion: '1.0', type: 'agent.owner_transferred', agent: updated, deviceCredential },
        receiptResponse: { protocolVersion: '1.0', type: 'agent.owner_transferred', agent: updated, replayed: true },
        resourceKind: 'agent', resourceId: agent.agentId }
    }).then((response) => ({ agent: response.agent as StoredAgent,
      ...(typeof response.deviceCredential === 'string' ? { deviceCredential: response.deviceCredential } : {}),
      ...(response.replayed === true ? { replayed: true } : {}) }))
  }

  async selectPrimary(actor: UserActor, input: {
    primaryHumanEndpointId?: string | null
    primaryAgentId?: string | null
    expectedRevision: number | null
    idempotencyKey: string
  }): Promise<StoredParticipant> {
    return this.commit(actor, 'participant.primary.select', input.idempotencyKey, input, async (tx, at) => {
      const existing = await tx.getParticipant(actor.userId)
      if ((existing?.revision ?? null) !== input.expectedRevision) {
        fail('revision_conflict', 'The Participant profile revision changed.', { details: { currentRevision: existing?.revision ?? null } })
      }
      const endpointId = input.primaryHumanEndpointId === null ? undefined
        : input.primaryHumanEndpointId ?? existing?.primaryHumanEndpointId
      const agentId = input.primaryAgentId === null ? undefined : input.primaryAgentId ?? existing?.primaryAgentId
      if (endpointId) {
        const endpoint = required(await tx.getEndpoint(endpointId), 'Human endpoint')
        if (endpoint.userId !== actor.userId || endpoint.status !== 'active') fail('permission_denied', 'Primary endpoint must be active and owned by the user.')
      }
      if (agentId) {
        const agent = required(await tx.getAgent(agentId), 'Agent')
        if (agent.ownerUserId !== actor.userId || agent.status !== 'active') fail('permission_denied', 'Primary Agent must be active and owned by the user.')
      }
      const participant = completeParticipant({ userId: actor.userId, primaryHumanEndpointId: endpointId,
        primaryAgentId: agentId, status: 'incomplete', revision: (existing?.revision ?? 0) + 1, updatedAt: at })
      await tx.upsertParticipant(participant, existing?.revision ?? null)
      return { response: entityResponse('participant.updated', participant), resourceKind: 'participant', resourceId: actor.userId }
    }).then(responseEntity<StoredParticipant>)
  }

  async getParticipantSnapshot(actor: AuthContext, userId: string): Promise<{
    user: StoredUser
    participant: StoredParticipant
    humanEndpoints: StoredEndpoint[]
    agents: StoredAgent[]
  }> {
    if (actor.kind === 'system' || actor.userId !== userId) fail('permission_denied', 'A Participant snapshot is private to its user.')
    const [user, participant, humanEndpoints, agents] = await Promise.all([
      this.repository.getUser(userId), this.repository.getParticipant(userId),
      this.repository.listEndpointsForUser(userId), this.repository.listAgentsForUser(userId)
    ])
    return { user: required(user, 'User'), participant: required(participant, 'Participant'), humanEndpoints, agents }
  }

  async createProjection(actor: UserActor, input: {
    agentId: string
    humanEndpointId: string
    locator: ProviderLocatorValue
    displayName: string
    allowedSenderUserIds: string[]
    idempotencyKey: string
  }): Promise<StoredProjection> {
    assertText(input.displayName, 'displayName', 1, 200)
    const allowed = [...new Set([actor.userId, ...input.allowedSenderUserIds])]
    if (allowed.length > 100) fail('validation_failed', 'A shared Session may allow at most 100 users.')
    return this.commit(actor, 'projection.create', input.idempotencyKey, { ...input, allowedSenderUserIds: allowed }, async (tx, at) => {
      await lockProviderLocator(tx, input.locator)
      const agent = required(await tx.getAgent(input.agentId), 'Projection Agent')
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Projection endpoint')
      if (agent.ownerUserId !== actor.userId || agent.status !== 'active') fail('permission_denied', 'Projection Agent must be active and owned by the user.')
      if (endpoint.userId !== actor.userId || endpoint.status !== 'active') fail('permission_denied', 'Projection endpoint must be active and owned by the user.')
      if (endpoint.provider !== input.locator.provider || endpoint.realmId !== input.locator.realmId) {
        fail('validation_failed', 'Projection locator must use the bound endpoint provider and realm.')
      }
      for (const userId of allowed) required(await tx.getUser(userId), 'Allowed sender')
      if (await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId, input.locator.containerId, input.locator.topicId)) {
        fail('identity_conflict', 'This provider locator already resolves to a personal Session projection.')
      }
      if (await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId, input.locator.containerId, input.locator.topicId)) {
        fail('identity_conflict', 'This provider locator already resolves to a Project topic.')
      }
      const projection: StoredProjection = { projectionId: newId('rsp'), ownerUserId: actor.userId,
        agentId: agent.agentId, humanEndpointId: endpoint.humanEndpointId, locator: input.locator, locatorRevision: 1,
        displayName: input.displayName, status: 'active', allowedSenderUserIds: allowed,
        revision: 1, createdAt: at, updatedAt: at }
      await tx.insertProjection(projection)
      return { response: entityResponse('projection.created', projection), resourceKind: 'projection', resourceId: projection.projectionId }
    }).then(responseEntity<StoredProjection>)
  }

  async updateProjection(actor: UserActor, input: {
    projectionId: string
    expectedRevision: number
    displayName?: string
    status?: 'active' | 'paused' | 'closed'
    locator?: ProviderLocatorValue
    locatorRevision?: number
    allowedSenderUserIds?: string[]
    idempotencyKey: string
  }): Promise<StoredProjection> {
    return this.commit(actor, 'projection.update', input.idempotencyKey, input, async (tx, at) => {
      const projection = required(await tx.getProjection(input.projectionId), 'Projection')
      if (projection.ownerUserId !== actor.userId) fail('permission_denied', 'Only the projection owner may update it.')
      expectRevision(projection.revision, input.expectedRevision)
      if (projection.status === 'closed') fail('invalid_state_transition', 'A closed projection cannot be reopened or retargeted.')
      if (input.displayName) assertText(input.displayName, 'displayName', 1, 200)
      let locator = projection.locator
      let locatorRevision = projection.locatorRevision
      if (input.locator) {
        await lockProviderLocator(tx, input.locator)
        if (input.locatorRevision !== projection.locatorRevision) fail('revision_conflict', 'The locator revision is stale.')
        const endpoint = required(await tx.getEndpoint(projection.humanEndpointId), 'Projection endpoint')
        if (endpoint.provider !== input.locator.provider || endpoint.realmId !== input.locator.realmId) {
          fail('validation_failed', 'Updated locator must remain in the verified endpoint provider realm.')
        }
        const otherProjection = await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)
        if (otherProjection && otherProjection.projectionId !== projection.projectionId) {
          fail('identity_conflict', 'The provider locator belongs to another personal Session projection.')
        }
        if (await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)) {
          fail('identity_conflict', 'The provider locator belongs to a Project topic.')
        }
        locator = input.locator
        locatorRevision += 1
      }
      const allowed = input.allowedSenderUserIds
        ? [...new Set([actor.userId, ...input.allowedSenderUserIds])]
        : projection.allowedSenderUserIds
      if (allowed.length > 100) fail('validation_failed', 'A shared Session may allow at most 100 users.')
      const updated: StoredProjection = { ...projection, locator, locatorRevision,
        displayName: input.displayName ?? projection.displayName, status: input.status ?? projection.status,
        allowedSenderUserIds: allowed, revision: projection.revision + 1, updatedAt: at }
      await tx.updateProjection(updated, projection.revision)
      return { response: entityResponse('projection.updated', updated), resourceKind: 'projection', resourceId: projection.projectionId }
    }).then(responseEntity<StoredProjection>)
  }

  async getProjection(actor: AuthContext, projectionId: string): Promise<StoredProjection> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read a private projection.')
    const projection = required(await this.repository.getProjection(projectionId), 'Projection')
    if (!projection.allowedSenderUserIds.includes(actor.userId)) fail('permission_denied', 'The projection is not shared with this user.')
    return projection
  }

  async listProjections(actor: AuthContext, ownerUserId: string): Promise<StoredProjection[]> {
    if (actor.kind === 'system' || actor.userId !== ownerUserId) fail('permission_denied', 'Only the owner may list private projections.')
    return this.repository.listProjectionsForOwner(ownerUserId)
  }

  async publishProjectionMessage(actor: AgentActor, input: {
    projectionId: string
    projectionRevision: number
    localItemId: string
    localTurnId?: string
    kind: 'user_message' | 'assistant_final' | 'system_status'
    text: string
    occurredAt: string
    idempotencyKey: string
  }): Promise<Record<string, unknown>> {
    assertText(input.text, 'text', 1, 32_000)
    return this.commit(actor, 'projection.message.publish', input.idempotencyKey, input, async (tx, at) => {
      const projection = required(await tx.getProjection(input.projectionId), 'Projection')
      if (projection.agentId !== actor.agentId || projection.ownerUserId !== actor.userId) {
        fail('permission_denied', 'Only the fixed projection Agent may publish this Session message.')
      }
      expectRevision(projection.revision, input.projectionRevision)
      if (projection.status !== 'active') fail('invalid_state_transition', 'Projection messages require an active projection.')
      const payload = { protocolVersion: '1.0', type: 'projection.message.outbound', projectionId: projection.projectionId,
        projectionRevision: projection.revision, locator: projection.locator, localItemId: input.localItemId,
        ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}), kind: input.kind, text: input.text,
        occurredAt: input.occurredAt }
      const message = await this.appendInbox(tx, { kind: 'human_endpoint', id: projection.humanEndpointId },
        'projection.message.outbound', payload, at)
      return { response: { protocolVersion: '1.0', type: 'projection.message.accepted',
        projectionId: projection.projectionId, localItemId: input.localItemId, inboxSequence: message.sequence },
        resourceKind: 'projection', resourceId: projection.projectionId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    })
  }

  async acceptPersonalProviderMessage(actor: HumanEndpointActor, input: {
    locator: ProviderLocatorValue
    providerMessageId: string
    text: string
    occurredAt: string
    providerEventId: string
  }): Promise<Record<string, unknown>> {
    assertText(input.text, 'text', 1, 32_000)
    return this.commit(actor, 'personal.message.receive', `idem_${stableDigest(input.providerEventId)}`, input, async (tx, at) => {
      const projection = await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId,
        input.locator.containerId, input.locator.topicId)
      if (!projection) fail('not_found', 'The provider locator does not uniquely resolve to a personal Session.')
      authorize({ actor, operation: 'personal_message', resourceOwnerUserId: projection.ownerUserId,
        senderAllowedByProjection: projection.allowedSenderUserIds.includes(actor.userId) })
      if (projection.status !== 'active') fail('invalid_state_transition', 'The personal Session projection is not active.')
      const message = await this.appendInbox(tx, { kind: 'agent', id: projection.agentId }, 'personal.message.received', {
        protocolVersion: '1.0', type: 'personal.message.received', projectionId: projection.projectionId,
        projectionRevision: projection.revision, senderUserId: actor.userId, humanEndpointId: actor.humanEndpointId,
        providerMessageId: input.providerMessageId, text: input.text, occurredAt: input.occurredAt
      }, at)
      return { response: { protocolVersion: '1.0', type: 'personal.message.accepted', projectionId: projection.projectionId,
        inboxMessageId: message.messageId, sequence: message.sequence }, resourceKind: 'projection',
        resourceId: projection.projectionId, notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    })
  }

  async applyProviderLocatorChange(input: {
    previousLocator: ProviderLocatorValue
    currentLocator: ProviderLocatorValue
    providerEventId: string
  }): Promise<{ kind: 'personal_projection' | 'project'; resourceId: string }> {
    if (input.previousLocator.provider !== input.currentLocator.provider ||
        input.previousLocator.realmId !== input.currentLocator.realmId ||
        input.previousLocator.topicId !== input.currentLocator.topicId) {
      fail('validation_failed', 'A provider locator change must preserve provider, realm, and stable topic ID.')
    }
    const actor: AuthContext = { kind: 'system',
      actorKey: `provider-locator:${input.currentLocator.provider}:${stableDigest(input.providerEventId)}` }
    return this.commit(actor, 'provider.locator.changed', `idem_${stableDigest(input.providerEventId)}`, input, async (tx, at) => {
      await lockProviderLocators(tx, [input.previousLocator, input.currentLocator])
      const [projection, projectBinding] = await Promise.all([
        tx.getProjectionByLocator(input.previousLocator.provider, input.previousLocator.realmId,
          input.previousLocator.containerId, input.previousLocator.topicId),
        tx.getProjectBindingByLocator(input.previousLocator.provider, input.previousLocator.realmId,
          input.previousLocator.containerId, input.previousLocator.topicId)
      ])
      const [currentProjection, currentProject] = await Promise.all([
        tx.getProjectionByLocator(input.currentLocator.provider, input.currentLocator.realmId,
          input.currentLocator.containerId, input.currentLocator.topicId),
        tx.getProjectBindingByLocator(input.currentLocator.provider, input.currentLocator.realmId,
          input.currentLocator.containerId, input.currentLocator.topicId)
      ])
      if (projection && projectBinding) {
        fail('identity_conflict', 'The previous locator ambiguously resolves to multiple collaboration targets.')
      }
      if (!projection && !projectBinding) {
        if (Boolean(currentProjection) === Boolean(currentProject)) {
          fail(currentProjection ? 'identity_conflict' : 'not_found', currentProjection
            ? 'The current locator ambiguously resolves to multiple collaboration targets.'
            : 'Neither locator resolves to an active collaboration target.')
        }
        const kind = currentProjection ? 'personal_projection' as const : 'project' as const
        const resourceId = currentProjection ? currentProjection.projectionId : currentProject!.projectId
        return { response: { protocolVersion: '1.0', type: 'provider.locator.applied', kind, resourceId },
          resourceKind: currentProjection ? 'projection' : 'project_endpoint_binding',
          resourceId: currentProjection ? currentProjection.projectionId : currentProject!.projectEndpointBindingId }
      }
      if (projection) {
        if (stableDigest(projection.locator) === stableDigest(input.currentLocator)) {
          return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
            kind: 'personal_projection', resourceId: projection.projectionId },
          resourceKind: 'projection', resourceId: projection.projectionId }
        }
        if (stableDigest(projection.locator) !== stableDigest(input.previousLocator)) {
          fail('revision_conflict', 'The stored projection locator no longer matches the confirmed previous locator.')
        }
        if ((currentProjection && currentProjection.projectionId !== projection.projectionId) || currentProject) {
          fail('identity_conflict', 'The new locator already belongs to another collaboration target.')
        }
        if (projection.status === 'closed') fail('invalid_state_transition', 'A closed projection cannot move.')
        const updated: StoredProjection = { ...projection, locator: input.currentLocator,
          locatorRevision: projection.locatorRevision + 1, revision: projection.revision + 1,
          lastErrorCode: undefined, updatedAt: at }
        await tx.updateProjection(updated, projection.revision)
        const message = await this.appendInbox(tx, { kind: 'agent', id: projection.agentId }, 'projection.updated', {
          protocolVersion: '1.0', type: 'projection.updated', projectionId: projection.projectionId,
          revision: updated.revision
        }, at)
        return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
          kind: 'personal_projection', resourceId: projection.projectionId },
        resourceKind: 'projection', resourceId: projection.projectionId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
      }
      const binding = projectBinding!
      if (stableDigest(binding.locator) === stableDigest(input.currentLocator)) {
        return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
          kind: 'project', resourceId: binding.projectId },
        resourceKind: 'project_endpoint_binding', resourceId: binding.projectEndpointBindingId }
      }
      if (stableDigest(binding.locator) !== stableDigest(input.previousLocator)) {
        fail('revision_conflict', 'The stored Project locator no longer matches the confirmed previous locator.')
      }
      if (currentProjection || (currentProject && currentProject.projectEndpointBindingId !== binding.projectEndpointBindingId)) {
        fail('identity_conflict', 'The new locator already belongs to another collaboration target.')
      }
      if (binding.status === 'closed') fail('invalid_state_transition', 'A closed Project endpoint binding cannot move.')
      const updated: StoredProjectEndpointBinding = { ...binding, locator: input.currentLocator,
        locatorRevision: binding.locatorRevision + 1, revision: binding.revision + 1,
        lastErrorCode: undefined, updatedAt: at }
      await tx.upsertProjectEndpointBinding(updated, binding.revision)
      const project = required(await tx.getProject(binding.projectId), 'Project')
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId },
        'project.endpoint.updated', {
          protocolVersion: '1.0', type: 'project.endpoint.updated', projectId: binding.projectId,
          projectEndpointBindingId: binding.projectEndpointBindingId, revision: updated.revision,
          locatorRevision: updated.locatorRevision
        }, at)
      return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
        kind: 'project', resourceId: binding.projectId },
      resourceKind: 'project_endpoint_binding', resourceId: binding.projectEndpointBindingId,
      notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then((response) => ({ kind: response.kind as 'personal_projection' | 'project', resourceId: String(response.resourceId) }))
  }

  async bindProjectEndpoint(actor: UserActor, input: {
    projectId: string
    locator: ProviderLocatorValue
    expectedRevision: number | null
    idempotencyKey: string
  }): Promise<StoredProjectEndpointBinding> {
    return this.commit(actor, 'project.endpoint.bind', input.idempotencyKey, input, async (tx, at) => {
      await lockProviderLocator(tx, input.locator)
      const project = required(await tx.getProject(input.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      const existing = await tx.getProjectEndpointBinding(project.projectId)
      if ((existing?.revision ?? null) !== input.expectedRevision) fail('revision_conflict', 'The Project endpoint binding revision is stale.')
      if (await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId, input.locator.containerId, input.locator.topicId)) {
        fail('identity_conflict', 'The provider locator belongs to a personal Session projection.')
      }
      const otherProject = await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
        input.locator.containerId, input.locator.topicId)
      if (otherProject && otherProject.projectId !== project.projectId) fail('identity_conflict', 'The provider locator belongs to another Project.')
      const binding: StoredProjectEndpointBinding = existing
        ? { ...existing, locator: input.locator, locatorRevision: existing.locatorRevision + 1,
            status: 'active', lastErrorCode: undefined, revision: existing.revision + 1, updatedAt: at }
        : { projectEndpointBindingId: newId('peb'), projectId: project.projectId, locator: input.locator,
            locatorRevision: 1, status: 'active', revision: 1, createdAt: at, updatedAt: at }
      await tx.upsertProjectEndpointBinding(binding, existing?.revision ?? null)
      return { response: entityResponse('project_endpoint.updated', binding), resourceKind: 'project_endpoint_binding',
        resourceId: binding.projectEndpointBindingId }
    }).then(responseEntity<StoredProjectEndpointBinding>)
  }

  async getProjectEndpointBinding(actor: AuthContext, projectId: string): Promise<StoredProjectEndpointBinding> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project bindings.')
    const member = await this.repository.getProjectMember(projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return required(await this.repository.getProjectEndpointBinding(projectId), 'Project endpoint binding')
  }

  async updateProjectEndpointBinding(actor: UserActor, input: {
    projectEndpointBindingId: string
    expectedRevision: number
    locator?: ProviderLocatorValue
    locatorRevision?: number
    status?: 'active' | 'closed'
    idempotencyKey: string
  }): Promise<StoredProjectEndpointBinding> {
    return this.commit(actor, 'project.endpoint.update', input.idempotencyKey, input, async (tx, at) => {
      const binding = required(await tx.getProjectEndpointBindingById(input.projectEndpointBindingId),
        'Project endpoint binding')
      const member = await tx.getProjectMember(binding.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      expectRevision(binding.revision, input.expectedRevision)
      if (binding.status === 'closed' && input.status !== 'closed') {
        fail('invalid_state_transition', 'A closed Project endpoint binding cannot be reopened.')
      }
      let locator = binding.locator
      let locatorRevision = binding.locatorRevision
      if (input.locator) {
        await lockProviderLocator(tx, input.locator)
        if (input.locatorRevision !== binding.locatorRevision) {
          fail('revision_conflict', 'The Project endpoint locator revision is stale.')
        }
        const projection = await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)
        if (projection) fail('identity_conflict', 'The provider locator belongs to a personal Session projection.')
        const otherProject = await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)
        if (otherProject && otherProject.projectEndpointBindingId !== binding.projectEndpointBindingId) {
          fail('identity_conflict', 'The provider locator belongs to another Project.')
        }
        locator = input.locator
        locatorRevision += 1
      } else if (input.locatorRevision !== undefined) {
        fail('validation_failed', 'locatorRevision is only valid together with a new locator.')
      }
      if (!input.locator && input.status === undefined) fail('validation_failed', 'Project endpoint update has no changes.')
      const updated: StoredProjectEndpointBinding = { ...binding, locator, locatorRevision,
        status: input.status ?? binding.status, lastErrorCode: undefined,
        revision: binding.revision + 1, updatedAt: at }
      await tx.upsertProjectEndpointBinding(updated, binding.revision)
      return { response: entityResponse('project_endpoint.updated', updated), resourceKind: 'project_endpoint_binding',
        resourceId: updated.projectEndpointBindingId }
    }).then(responseEntity<StoredProjectEndpointBinding>)
  }

  async acceptProjectInput(actor: HumanEndpointActor, input: {
    locator?: ProviderLocatorValue
    projectId?: string
    providerMessageId: string
    text: string
    occurredAt: string
    providerEventId?: string
    idempotencyKey?: string
  }): Promise<StoredProjectInput> {
    assertText(input.text, 'text', 1, 32_000)
    if ((input.locator === undefined) === (input.projectId === undefined)) {
      fail('validation_failed', 'Project input requires exactly one locator or Project ID target.')
    }
    const idempotencyKey = input.idempotencyKey ?? `idem_${stableDigest(required(input.providerEventId ?? null, 'Provider event ID'))}`
    return this.commit(actor, 'project.input.create', idempotencyKey, input, async (tx, at) => {
      const binding = input.locator
        ? await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
            input.locator.containerId, input.locator.topicId)
        : await tx.getProjectEndpointBinding(input.projectId!)
      if (!binding || binding.status !== 'active') fail('not_found', 'The provider locator does not uniquely resolve to an active Project topic.')
      if (input.projectId && binding.projectId !== input.projectId) fail('not_found', 'The active Project endpoint binding does not match this Project.')
      const project = required(await tx.getProject(binding.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_input', projectMember: Boolean(member?.active) })
      const existing = await tx.getProjectInputByProviderMessage(actor.humanEndpointId, input.providerMessageId)
      if (existing) return { response: entityResponse('project_input.created', existing), resourceKind: 'project_input',
        resourceId: existing.projectInputId }
      const projectInput = await tx.insertProjectInput({ projectInputId: newId('pin'), projectId: project.projectId,
        senderUserId: actor.userId, sourceHumanEndpointId: actor.humanEndpointId,
        providerMessageId: input.providerMessageId, text: input.text, status: 'queued', revision: 1,
        occurredAt: input.occurredAt, createdAt: at, updatedAt: at })
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'project.input.received', {
        protocolVersion: '1.0', type: 'project.input.received', projectId: project.projectId,
        projectInputId: projectInput.projectInputId, revision: projectInput.revision
      }, at)
      return { response: entityResponse('project_input.created', projectInput), resourceKind: 'project_input',
        resourceId: projectInput.projectInputId, notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredProjectInput>)
  }

  async createHumanNeeded(actor: AgentActor, input: {
    projectId: string
    source: { kind: 'worker'; taskId: string; executionId: string; expectedTaskRevision: number } |
      { kind: 'coordinator'; sourceInboxMessageId: string }
    targetUserId: string
    requiredAssurance: 'basic' | 'verified' | 'strong'
    prompt: string
    expiresAt: string
    confirmableAction?: StoredConfirmableAction
    idempotencyKey: string
  }): Promise<StoredHumanRequest> {
    assertText(input.prompt, 'prompt', 1, 32_000)
    return this.commit(actor, 'human.needed.create', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
      await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      const member = await tx.getProjectMember(project.projectId, input.targetUserId)
      if (!member?.active) fail('permission_denied', 'HumanNeeded target must be an active Project member.')
      if (project.status !== 'active') fail('invalid_state_transition', 'HumanNeeded requires an active Project.')
      if (new Date(input.expiresAt).getTime() <= new Date(at).getTime()) fail('request_expired', 'HumanNeeded expiry must be in the future.')
      const source = input.source
      let task: StoredTask | undefined
      if (source.kind === 'worker') {
        task = required(await tx.getTaskForUpdate(source.taskId), 'Task')
        if (task.projectId !== project.projectId) fail('validation_failed', 'The Task belongs to another Project.')
        await assertCurrentTaskActorMembership(tx, actor, project, task, source.executionId, actingAgent)
        expectRevision(task.revision, source.expectedTaskRevision)
        if (task.status !== 'in_progress' && task.status !== 'needs_human') fail('invalid_state_transition', 'HumanNeeded requires a running Task.')
      } else {
        if (actor.agentId !== project.coordinatorAgentId) {
          fail('coordinator_mismatch', 'Only the current Coordinator Agent may create a Project-level HumanNeeded request.')
        }
        const sourceMessage = await tx.getInboxMessageById(
          { kind: 'agent', id: actor.agentId }, source.sourceInboxMessageId
        )
        if (!sourceMessage || sourceMessage.disposition !== 'active' ||
            !COORDINATOR_HUMAN_SOURCE_MESSAGE_TYPES.has(sourceMessage.messageType) ||
            inboxMessageProjectId(sourceMessage) !== project.projectId) {
          fail('not_found', 'The Coordinator HumanNeeded source is not an active Project coordination Inbox message.')
        }
      }
      if (input.confirmableAction && input.source.kind !== 'coordinator') {
        fail('validation_failed', 'Only a Coordinator request may carry a confirmable action.')
      }
      if (input.confirmableAction) {
        if (input.targetUserId !== project.ownerUserId) {
          fail('permission_denied', 'A governed action must be confirmed by the Project owner.')
        }
        if (input.confirmableAction.projectId !== project.projectId) {
          fail('validation_failed', 'The governed action belongs to another Project.')
        }
        if (input.confirmableAction.kind === 'task.retry_reassign' || input.confirmableAction.kind === 'task.cancel') {
          const governedTask = await tx.getTask(input.confirmableAction.taskId)
          if (!governedTask || governedTask.projectId !== project.projectId) {
            fail('validation_failed', 'The governed Task must belong to the HumanNeeded Project.')
          }
          const governedExecutionId = input.confirmableAction.kind === 'task.retry_reassign'
            ? input.confirmableAction.fromExecutionId
            : input.confirmableAction.executionId
          if (governedTask.executionId !== governedExecutionId) {
            fail('execution_conflict', 'The governed Task execution is no longer current.', {
              details: { currentRevision: governedTask.revision, currentExecutionId: governedTask.executionId }
            })
          }
        }
      }
      const request: StoredHumanRequest = { humanRequestId: newId('hrq'), projectId: project.projectId,
        sourceKind: source.kind,
        ...(task
          ? { taskId: task.taskId, executionId: task.executionId }
          : source.kind === 'coordinator' ? { sourceInboxMessageId: source.sourceInboxMessageId } : {}),
        targetUserId: input.targetUserId, requestedByAgentId: actor.agentId,
        requiredAssurance: input.requiredAssurance, prompt: input.prompt, status: 'pending', revision: 1,
        ...(input.confirmableAction ? { confirmableAction: input.confirmableAction } : {}),
        expiresAt: input.expiresAt, createdAt: at, updatedAt: at }
      await tx.insertHumanRequest(request)
      let taskRevision = task?.revision
      if (task && task.status !== 'needs_human') {
        const updatedTask: StoredTask = { ...task, status: 'needs_human', revision: task.revision + 1, updatedAt: at }
        await tx.updateTask(updatedTask, task.revision)
        taskRevision = updatedTask.revision
      }
      const message = await this.appendInbox(tx, { kind: 'user', id: input.targetUserId }, 'human.needed', {
        protocolVersion: '1.0', type: 'human.needed', request: toHumanNeededEntity(request)
      }, at)
      const notifications = [{ recipient: message.recipient, sequence: message.sequence }]
      if (task) {
        const coordinatorMessage = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated', {
          protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
          executionId: task.executionId, revision: taskRevision, status: 'needs_human', humanRequestId: request.humanRequestId
        }, at)
        notifications.push({ recipient: coordinatorMessage.recipient, sequence: coordinatorMessage.sequence })
      }
      const [participant, binding] = await Promise.all([
        tx.getParticipant(input.targetUserId),
        tx.getProjectEndpointBinding(project.projectId)
      ])
      if (participant?.primaryHumanEndpointId && binding?.status === 'active') {
        const endpoint = await tx.getEndpoint(participant.primaryHumanEndpointId)
        if (endpoint?.status === 'active' && endpoint.userId === input.targetUserId &&
            endpoint.provider === binding.locator.provider && endpoint.realmId === binding.locator.realmId) {
          const providerMessage = await this.appendInbox(tx,
            { kind: 'human_endpoint', id: endpoint.humanEndpointId }, 'provider.notification.outbound', {
              protocolVersion: '1.0', type: 'provider.notification.outbound', locator: binding.locator,
              notificationKind: 'human_needed', text: humanNeededProviderText(request),
              resourceId: request.humanRequestId
            }, at)
          notifications.push({ recipient: providerMessage.recipient, sequence: providerMessage.sequence })
        }
      }
      return { response: entityResponse('human_needed.created', request), resourceKind: 'human_needed',
        resourceId: request.humanRequestId, notifications }
    }).then(responseEntity<StoredHumanRequest>)
  }

  async answerHumanNeeded(actor: HumanEndpointActor, input: {
    humanRequestId: string
    requestRevision: number
    answer: string
    decision?: 'approve' | 'reject'
    sourceLocator?: ProviderLocatorValue
    idempotencyKey: string
  }): Promise<StoredHumanAnswer> {
    assertText(input.answer, 'answer', 1, 32_000)
    const commandAt = this.timestamp()
    // Expiry is authoritative state, not a rejected-answer side effect. Persist it
    // before the business transaction so request_expired cannot roll it back.
    await this.repository.pruneExpired(commandAt)
    return this.commit(actor, 'human.answer', input.idempotencyKey, input, async (tx, at) => {
      const initialRequest = required(await tx.getHumanRequest(input.humanRequestId), 'HumanNeeded request')
      const project = required(await tx.getProjectForUpdate(initialRequest.projectId), 'Project')
      authorize({ actor, operation: 'human_answer', targetUserId: initialRequest.targetUserId,
        requiredAssurance: initialRequest.requiredAssurance })
      if (input.sourceLocator) {
        const [endpoint, binding] = await Promise.all([
          tx.getEndpoint(actor.humanEndpointId),
          tx.getProjectBindingByLocator(input.sourceLocator.provider, input.sourceLocator.realmId,
            input.sourceLocator.containerId, input.sourceLocator.topicId)
        ])
        if (!endpoint || endpoint.status !== 'active' || endpoint.userId !== actor.userId ||
            endpoint.provider !== input.sourceLocator.provider || endpoint.realmId !== input.sourceLocator.realmId ||
            !binding || binding.status !== 'active' || binding.projectId !== initialRequest.projectId) {
          fail('not_found', 'The provider answer does not originate from the active Project endpoint binding.')
        }
      }
      if (initialRequest.status !== 'pending' || initialRequest.expiresAt <= at) {
        fail('request_expired', 'The HumanNeeded request is no longer current.')
      }
      const request = required(await tx.getHumanRequestForUpdate(input.humanRequestId), 'HumanNeeded request')
      if (request.status !== 'pending' || request.expiresAt <= at) fail('request_expired', 'The HumanNeeded request is no longer current.')
      expectRevision(request.revision, input.requestRevision)
      if (request.confirmableAction && input.decision === undefined) {
        fail('validation_failed', 'A governed action answer requires an explicit approve or reject decision.')
      }
      if (!request.confirmableAction && input.decision !== undefined) {
        fail('validation_failed', 'A free-form HumanNeeded answer cannot create an action confirmation.')
      }
      const existing = await tx.getHumanAnswerForRequest(request.humanRequestId)
      if (existing) return { response: entityResponse('human_answer.created', existing), resourceKind: 'human_answer',
        resourceId: existing.humanAnswerId }
      const answer: StoredHumanAnswer = { humanAnswerId: newId('han'), humanRequestId: request.humanRequestId,
        projectId: request.projectId, ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(request.executionId ? { executionId: request.executionId } : {}), requestRevision: request.revision,
        answeredByUserId: actor.userId, answeredFromHumanEndpointId: actor.humanEndpointId,
        assurance: actor.assurance, answer: input.answer, ...(input.decision ? { decision: input.decision } : {}),
        revision: 1, answeredAt: at, createdAt: at, updatedAt: at }
      if (request.confirmableAction && input.decision === 'approve') {
        if (request.requestedByAgentId !== project.coordinatorAgentId) {
          fail('coordinator_mismatch', 'The governed action was requested by a former Coordinator Agent.')
        }
        const confirmationId = newId('cnf')
        const confirmation: StoredActionConfirmation = {
          confirmationId, humanRequestId: request.humanRequestId, projectId: request.projectId,
          targetUserId: request.targetUserId, coordinatorAgentId: request.requestedByAgentId,
          action: request.confirmableAction, actionDigest: stableDigest(request.confirmableAction), status: 'approved',
          approvedAt: at, expiresAt: request.expiresAt, createdAt: at, updatedAt: at
        }
        await tx.insertActionConfirmation(confirmation)
        answer.confirmationId = confirmationId
      }
      await tx.insertHumanAnswer(answer)
      await tx.updateHumanRequest({ ...request, status: 'answered', revision: request.revision + 1, updatedAt: at }, request.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      for (const agentId of new Set([request.requestedByAgentId, project.coordinatorAgentId])) {
        const message = await this.appendInbox(tx, { kind: 'agent', id: agentId }, 'human.answer.received', {
          protocolVersion: '1.0', type: 'human.answer.received', answer: toHumanAnswerEntity(answer)
        }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      return { response: entityResponse('human_answer.created', answer), resourceKind: 'human_answer',
        resourceId: answer.humanAnswerId, notifications }
    }, commandAt).then(responseEntity<StoredHumanAnswer>)
  }

  async createProject(actor: UserActor, input: {
    displayName: string
    goal: string
    memberUserIds: string[]
    coordinatorAgentId: string
    budgets?: Partial<ProjectBudgets>
    idempotencyKey: string
  }): Promise<StoredProject> {
    assertText(input.displayName, 'displayName', 1, 200)
    assertText(input.goal, 'goal', 1, 20_000)
    const memberUserIds = [...new Set([actor.userId, ...input.memberUserIds])]
    if (memberUserIds.length > 1_000) fail('validation_failed', 'A Project may have at most 1000 members.')
    const budgets = normalizeBudgets(input.budgets)
    return this.commit(actor, 'project.create', input.idempotencyKey, { ...input, memberUserIds, budgets }, async (tx, at) => {
      for (const userId of memberUserIds) {
        const user = required(await tx.getUser(userId), 'Project member')
        if (user.status !== 'active') fail('credential_revoked', 'Every Project member must be active.')
      }
      // A new Project has no row to lock yet, so the Coordinator Agent is the
      // serialization point shared with ownership transfer.
      const coordinator = required(await tx.getAgentForUpdate(input.coordinatorAgentId), 'Coordinator Agent')
      if (coordinator.status !== 'active' || !memberUserIds.includes(coordinator.ownerUserId)) {
        fail('permission_denied', 'Coordinator ownership must resolve to an active Project member.')
      }
      const projectId = newId('prj')
      const project: StoredProject = { projectId, ownerUserId: actor.userId, displayName: input.displayName,
        goal: input.goal, status: 'active',
        coordinatorAgentId: coordinator.agentId, budgets, coordinationRound: 1, revision: 1, createdAt: at, updatedAt: at }
      const members: StoredProjectMember[] = memberUserIds.map((userId) => ({ projectId, userId,
        role: userId === actor.userId ? 'owner' : 'member', active: true, createdAt: at }))
      await tx.insertProject(project, members)
      const message = await this.appendInbox(tx, { kind: 'agent', id: coordinator.agentId }, 'project.started',
        { protocolVersion: '1.0', type: 'project.started', projectId, revision: project.revision }, at)
      return { response: entityResponse('project.created', project), resourceKind: 'project', resourceId: projectId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredProject>)
  }

  async transferCoordinator(actor: UserActor, input: {
    projectId: string
    coordinatorAgentId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.coordinator.transfer', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      expectRevision(project.revision, input.expectedRevision)
      if (['completed', 'failed', 'cancelled'].includes(project.status)) {
        fail('invalid_state_transition', 'A terminal Project cannot transfer its Coordinator.')
      }
      const coordinator = required(await tx.getAgentForUpdate(input.coordinatorAgentId), 'Coordinator Agent')
      const coordinatorMember = await tx.getProjectMember(project.projectId, coordinator.ownerUserId)
      if (coordinator.status !== 'active' || !coordinatorMember?.active) {
        fail('permission_denied', 'The new Coordinator must belong to an active Project member.')
      }
      const oldCoordinatorAgentId = project.coordinatorAgentId
      const updated: StoredProject = { ...project, coordinatorAgentId: coordinator.agentId,
        revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updated, project.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      if (oldCoordinatorAgentId !== coordinator.agentId) {
        for (const request of await tx.listHumanRequestsForProject(project.projectId)) {
          if (request.status === 'pending' && request.sourceKind === 'coordinator' &&
              request.requestedByAgentId === oldCoordinatorAgentId && request.confirmableAction) {
            await tx.updateHumanRequest({ ...request, status: request.expiresAt <= at ? 'expired' : 'cancelled',
              revision: request.revision + 1, updatedAt: at }, request.revision)
          }
        }
        await supersedeApprovedActionConfirmations(tx, project.projectId, at,
          (confirmation) => confirmation.coordinatorAgentId === oldCoordinatorAgentId)
      }
      const superseded = oldCoordinatorAgentId === coordinator.agentId
        ? []
        : await tx.supersedeCoordinatorInbox(project.projectId, oldCoordinatorAgentId, at)
      for (const stale of superseded) {
        const replay = await this.appendInbox(tx, { kind: 'agent', id: coordinator.agentId }, stale.messageType,
          { ...stale.payload, reroutedFromMessageId: stale.messageId }, at)
        notifications.push({ recipient: replay.recipient, sequence: replay.sequence })
      }
      for (const recipient of [
        { kind: 'agent', id: coordinator.agentId } as InboxRecipient,
        { kind: 'agent', id: oldCoordinatorAgentId } as InboxRecipient
      ]) {
        const message = await this.appendInbox(tx, recipient, 'coordinator.transferred',
          { protocolVersion: '1.0', type: 'coordinator.transferred', projectId: project.projectId,
            previousCoordinatorAgentId: oldCoordinatorAgentId, coordinatorAgentId: coordinator.agentId,
            revision: updated.revision }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      return { response: entityResponse('project.updated', updated), resourceKind: 'project', resourceId: project.projectId, notifications }
    }).then(responseEntity<StoredProject>)
  }

  async transitionProject(actor: UserActor | AgentActor, input: {
    projectId: string
    status: 'active' | 'paused' | 'completed' | 'cancelled'
    expectedRevision: number
    finalRecordDigest?: string
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.transition', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      if (actor.kind === 'user') {
        authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      } else {
        if (input.status !== 'completed' || !input.finalRecordDigest || actor.agentId !== project.coordinatorAgentId) {
          fail('confirmation_required', 'An Agent may only execute a confirmed Project completion.')
        }
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'project.complete', projectId: project.projectId, finalRecordDigest: input.finalRecordDigest
        }, project, 'project.complete', at)
      }
      expectRevision(project.revision, input.expectedRevision)
      if (!canTransition('project', project.status, input.status)) {
        fail('invalid_state_transition', `Project cannot transition from ${project.status} to ${input.status}.`)
      }
      if (project.status === 'paused' && input.status === 'active') {
        // Resuming restores the Coordinator's execution authority. Revalidate the
        // current Agent under the Project -> Agent lock order instead of trusting
        // the ownership and membership that existed when the Project was paused.
        const coordinator = required(await tx.getAgentForUpdate(project.coordinatorAgentId), 'Coordinator Agent')
        if (coordinator.status !== 'active') {
          fail('credential_revoked', 'The paused Project Coordinator Agent is no longer active.')
        }
        const coordinatorMember = await tx.getProjectMember(project.projectId, coordinator.ownerUserId)
        if (!coordinatorMember?.active || coordinatorMember.role === 'observer') {
          fail('permission_denied', 'The paused Project Coordinator owner is not an executable Project member.')
        }
      }
      if (input.status === 'completed' || input.status === 'cancelled') {
        const openTasks = await tx.countOpenProjectTasks(project.projectId)
        if (openTasks > 0) {
          fail('invalid_state_transition', 'Complete or cancel every open Task before closing the Project.')
        }
      }
      const updated: StoredProject = { ...project, status: input.status, revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updated, project.revision)
      if (input.status === 'completed' || input.status === 'cancelled') {
        await invalidateApprovedGovernedActions(tx, project.projectId, at, () => true)
      }
      return { response: entityResponse('project.updated', updated), resourceKind: 'project', resourceId: project.projectId }
    }).then(responseEntity<StoredProject>)
  }

  async createTask(actor: UserActor | AgentActor, input: {
    projectId: string
    assigneeAgentId: string
    title: string
    objective: string
    completionCriteria: Array<string | { criterionId: string; text: string }>
    dependencyTaskIds: string[]
    requiredCapabilities?: StoredWorkerRequirement
    resourceRefIds?: string[]
    authorizationRequirements?: StoredAuthorizationRequirement[]
    expectedProjectRevision: number
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    assertText(input.title, 'title', 1, 200)
    assertText(input.objective, 'objective', 1, 20_000)
    const criterionInputs = normalizeTaskCriteria(input.completionCriteria)
    const dependencies = uniqueTexts(input.dependencyTaskIds, 1_000, 100)
    const requiredCapabilities = input.requiredCapabilities ?? emptyWorkerRequirement()
    const resourceRefIds = uniqueTexts(input.resourceRefIds ?? [], 1_000, 128)
    const authorizationRequirements = normalizeAuthorizationRequirements(input.authorizationRequirements ?? [])
    return this.commit(actor, 'task.create', input.idempotencyKey, { ...input, completionCriteria: criterionInputs,
      dependencyTaskIds: dependencies, requiredCapabilities, resourceRefIds, authorizationRequirements }, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      if (project.status !== 'active') fail('invalid_state_transition', 'Tasks may only be created for an active Project.')
      const lockedAgents = await lockAgentsForUpdate(tx, [
        input.assigneeAgentId,
        ...(actor.kind === 'agent_device' ? [actor.agentId] : [])
      ])
      const assignee = required(lockedAgents.get(input.assigneeAgentId) ?? null, 'Assignee Agent')
      const actorMember = await tx.getProjectMember(project.projectId, actor.userId)
      const proposalDigest = stableDigest({ projectId: input.projectId, assigneeAgentId: input.assigneeAgentId,
        title: input.title, objective: input.objective, completionCriteria: criterionInputs,
        dependencyTaskIds: dependencies, requiredCapabilities, resourceRefIds, authorizationRequirements })
      if (actor.kind === 'user') {
        authorize({ actor, operation: 'task_create', projectRole: actorMember?.role })
      } else {
        if (actor.agentId !== project.coordinatorAgentId) fail('coordinator_mismatch', 'Only the current Coordinator may execute a confirmed Task proposal.')
        await assertCurrentAgentProjectMembership(tx, actor, project,
          required(lockedAgents.get(actor.agentId) ?? null, 'Coordinator Agent'))
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'tasks.create', projectId: project.projectId,
          proposalDigest
        }, project, 'task.create', at)
      }
      expectRevision(project.revision, input.expectedProjectRevision)
      const member = await tx.getProjectMember(project.projectId, assignee.ownerUserId)
      if (assignee.status !== 'active' || !member?.active || member.role === 'observer') {
        fail('permission_denied', 'The assignee Agent owner is not an executable Project member.')
      }
      const profile = await tx.getAgentCapabilityProfile(assignee.agentId)
      if (!profile || profile.ownerUserId !== assignee.ownerUserId || profile.expiresAt <= at) {
        fail('capability_profile_expired', 'The assignee Agent capability profile is missing, stale, or owner-mismatched.')
      }
      assertCapabilityRequirements(profile, requiredCapabilities)
      const totalTasks = await tx.countProjectTasks(project.projectId)
      const roundTasks = await tx.countProjectTasks(project.projectId, project.coordinationRound)
      if (totalTasks >= project.budgets.maxTasks || roundTasks >= project.budgets.maxTasksPerRound) {
        fail('budget_exhausted', 'The Project task budget for this Project or coordination round is exhausted.')
      }
      for (const dependencyTaskId of dependencies) {
        const dependency = required(await tx.getTask(dependencyTaskId), 'Dependency Task')
        if (dependency.projectId !== project.projectId) fail('validation_failed', 'Dependencies must belong to the same Project.')
      }
      const referencedResourceIds = new Set([...resourceRefIds, ...requiredCapabilities.requiredResourceRefIds])
      for (const resourceRefId of referencedResourceIds) {
        const resource = required(await tx.getResourceRef(resourceRefId), 'Task ResourceRef')
        if (resource.projectId !== project.projectId || resource.status !== 'available') {
          fail('resource_unavailable', 'Task requirements cite a ResourceRef unavailable to this Project.')
        }
      }
      const taskId = newId('tsk')
      const criteria = criterionInputs.map((criterion, index) => ({
        criterionId: criterion.criterionId ?? taskCriterionId(taskId, index),
        text: criterion.text
      }))
      if (new Set(criteria.map((criterion) => criterion.criterionId)).size !== criteria.length) {
        fail('validation_failed', 'Task acceptance criterion IDs must be unique.')
      }
      const task: StoredTask = { taskId, projectId: project.projectId, executionId: newId('exe'),
        assigneeAgentId: assignee.agentId, assigneeUserId: assignee.ownerUserId,
        createdByAgentId: project.coordinatorAgentId, title: input.title, objective: input.objective, completionCriteria: criteria,
        dependencyTaskIds: dependencies, requiredCapabilities, resourceRefIds, authorizationRequirements,
        status: 'offered', retryCount: 0, maxRetries: project.budgets.maxTaskRetries,
        coordinationRound: project.coordinationRound, revision: 1, createdAt: at, updatedAt: at }
      await tx.insertTask(task)
      const updatedProject: StoredProject = { ...project, revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updatedProject, project.revision)
      await invalidateApprovedGovernedActions(tx, project.projectId, at,
        (action) => action.kind === 'tasks.create' && action.proposalDigest === proposalDigest)
      const message = await this.appendInbox(tx, { kind: 'agent', id: assignee.agentId }, 'task.offered',
        { protocolVersion: '1.0', type: 'task.offered', projectId: project.projectId,
          taskId: task.taskId, executionId: task.executionId, revision: task.revision }, at)
      return { response: entityResponse('task.created', task), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async transitionTask(actor: AgentActor, input: {
    taskId: string
    executionId: string
    status: 'accepted' | 'rejected' | 'in_progress' | 'needs_human' | 'completed' | 'failed'
    expectedRevision: number
    resultSummary?: string
    result?: TaskResultInput
    safeFailureCode?: string
    safeFailureSummary?: string
    targetUserId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    if (input.resultSummary && input.result && input.resultSummary.trim() !== input.result.summary.trim()) {
      fail('validation_failed', 'Legacy resultSummary must match the structured result summary.')
    }
    const result = input.result ?? (input.resultSummary ? {
      summary: input.resultSummary,
      criterionEvidence: [],
      resourceRefIds: []
    } : undefined)
    if (result) {
      assertText(result.summary, 'result.summary', 1, 32_000)
      validateProjectSummary(result.summary)
      if (result.logSummary !== undefined) {
        assertText(result.logSummary, 'result.logSummary', 1, 2_000)
        validateProjectSummary(result.logSummary)
      }
      if (result.criterionEvidence.length > 100 || result.resourceRefIds.length > 1_000) {
        fail('validation_failed', 'Task result evidence exceeds the bounded public contract.')
      }
    }
    if (input.safeFailureCode && !/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.safeFailureCode)) {
      fail('validation_failed', 'safeFailureCode must be a bounded machine-readable code.')
    }
    if (input.safeFailureSummary !== undefined) {
      assertText(input.safeFailureSummary, 'safeFailureSummary', 1, 2_000)
      validateProjectSummary(input.safeFailureSummary)
    }
    if (input.status !== 'completed' && result !== undefined) {
      fail('validation_failed', 'A result is accepted only when completing a Task.')
    }
    if (input.status !== 'failed' && input.safeFailureCode !== undefined) {
      fail('validation_failed', 'safeFailureCode is accepted only when failing a Task.')
    }
    if (input.status !== 'failed' && input.safeFailureSummary !== undefined) {
      fail('validation_failed', 'safeFailureSummary is accepted only when failing a Task.')
    }
    if (input.status === 'needs_human') {
      fail('invalid_state_transition', 'Use human.needed.create to enter needs_human with a bounded request and explicit target.')
    }
    return this.commit(actor, `task.${input.status}`, input.idempotencyKey, input, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const lockedAgents = await lockAgentsForUpdate(tx, [initialTask.assigneeAgentId, actor.agentId])
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      await assertCurrentTaskActorMembership(tx, actor, project, task, input.executionId,
        required(lockedAgents.get(actor.agentId) ?? null, 'Worker Agent'))
      if (project.status !== 'active') fail('invalid_state_transition', 'Task updates require an active Project.')
      expectRevision(task.revision, input.expectedRevision)
      if (!TASK_TRANSITIONS[task.status].includes(input.status)) {
        fail('invalid_state_transition', `Task cannot transition from ${task.status} to ${input.status}.`)
      }
      if (input.status === 'completed' && !result) fail('validation_failed', 'Completed tasks require a bounded result.')
      if (input.status === 'failed' && !input.safeFailureCode) fail('validation_failed', 'Failed tasks require a safe failure code.')
      let resultRecord: StoredProjectRecord | undefined
      if (input.status === 'completed' && result) {
        const validCriterionIds = new Set(task.completionCriteria.map((criterion) => criterion.criterionId))
        const citedResources = new Set(result.resourceRefIds)
        for (const evidence of result.criterionEvidence) {
          if (!validCriterionIds.has(evidence.criterionId)) {
            fail('validation_failed', 'Task result cites an unknown acceptance criterion.')
          }
          assertText(evidence.summary, 'criterionEvidence.summary', 1, 2_000)
          validateProjectSummary(evidence.summary)
          for (const resourceRefId of evidence.resourceRefIds) citedResources.add(resourceRefId)
        }
        for (const resourceRefId of citedResources) {
          const resource = required(await tx.getResourceRef(resourceRefId), 'Result ResourceRef')
          if (resource.projectId !== project.projectId || resource.status !== 'available') {
            fail('resource_unavailable', 'Task result cites a ResourceRef that is not available to this Project.')
          }
          if (resource.taskId && (resource.taskId !== task.taskId || resource.executionId !== task.executionId)) {
            fail('execution_conflict', 'Task result cites a ResourceRef from another execution.', {
              details: { currentExecutionId: task.executionId }
            })
          }
        }
        resultRecord = {
          projectRecordId: newId('rec'), projectId: project.projectId, kind: 'task_result', status: 'candidate',
          summary: result.summary.trim(), authorUserId: actor.userId, authorAgentId: actor.agentId,
          sourceTaskId: task.taskId, sourceExecutionId: task.executionId, sourceRevision: task.revision + 1,
          criterionEvidence: result.criterionEvidence.map((evidence) => ({ ...evidence,
            summary: evidence.summary.trim(), resourceRefIds: [...new Set(evidence.resourceRefIds)] })),
          resourceRefIds: [...citedResources], ...(result.logSummary ? { logSummary: result.logSummary.trim() } : {}),
          revision: 1, createdAt: at, updatedAt: at
        }
        await tx.insertProjectRecord(resultRecord)
      }
      const updated: StoredTask = { ...task, status: input.status, resultSummary: result?.summary.trim() ?? task.resultSummary,
        ...(resultRecord ? { resultRecordId: resultRecord.projectRecordId } : {}),
        safeFailureCode: input.safeFailureCode ?? task.safeFailureCode,
        safeFailureSummary: input.safeFailureSummary?.trim() ?? task.safeFailureSummary,
        revision: task.revision + 1, updatedAt: at,
        completedAt: ['completed', 'failed', 'rejected'].includes(input.status) ? at : undefined }
      await tx.updateTask(updated, task.revision)
      if (['completed', 'failed', 'rejected'].includes(input.status)) {
        await invalidateApprovedGovernedActions(tx, project.projectId, at,
          (action) => action.kind === 'task.cancel' &&
            action.taskId === task.taskId && action.executionId === task.executionId)
      }
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      const coordinatorMessage = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated',
        { protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
          revision: updated.revision, status: contractTaskStatus(updated.status),
          executionId: updated.executionId,
          ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}),
          ...(input.safeFailureSummary ? { safeFailureSummary: input.safeFailureSummary.trim() } : {}),
          ...(resultRecord ? { resultProjectRecordId: resultRecord.projectRecordId } : {}) }, at)
      notifications.push({ recipient: coordinatorMessage.recipient, sequence: coordinatorMessage.sequence })
      if (resultRecord) {
        const recordMessage = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId },
          'project_record.submitted', { protocolVersion: '1.0', type: 'project_record.submitted',
            projectId: project.projectId, projectRecordId: resultRecord.projectRecordId,
            sourceTaskId: task.taskId, sourceExecutionId: task.executionId,
            revision: resultRecord.revision }, at)
        notifications.push({ recipient: recordMessage.recipient, sequence: recordMessage.sequence })
      }
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId, notifications }
    }).then(responseEntity<StoredTask>)
  }

  async reportTaskProgress(actor: AgentActor, input: {
    taskId: string
    executionId: string
    expectedRevision: number
    percent: number
    summary: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    const percent = integer(input.percent, 'percent', 0, 100)
    assertText(input.summary, 'summary', 1, 2_000)
    validateProjectSummary(input.summary)
    return this.commit(actor, 'task.progress.report', input.idempotencyKey, { ...input, percent }, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const lockedAgents = await lockAgentsForUpdate(tx, [initialTask.assigneeAgentId, actor.agentId])
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      await assertCurrentTaskActorMembership(tx, actor, project, task, input.executionId,
        required(lockedAgents.get(actor.agentId) ?? null, 'Worker Agent'))
      if (project.status !== 'active') fail('invalid_state_transition', 'Task progress requires an active Project.')
      expectRevision(task.revision, input.expectedRevision)
      if (task.status !== 'in_progress') {
        fail('invalid_state_transition', 'Task progress may only be reported for a running Task.')
      }
      if (task.progress && percent < task.progress.percent) {
        fail('invalid_state_transition', 'Task progress cannot decrease within the current attempt.')
      }
      const updated: StoredTask = { ...task, progress: { percent, summary: input.summary.trim(), reportedAt: at },
        revision: task.revision + 1, updatedAt: at }
      await tx.updateTask(updated, task.revision)
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated', {
        protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
        executionId: updated.executionId, revision: updated.revision, status: 'running'
      }, at)
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async getTask(actor: AuthContext, taskId: string): Promise<StoredTask> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project Tasks.')
    const task = required(await this.repository.getTask(taskId), 'Task')
    const member = await this.repository.getProjectMember(task.projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return task
  }

  async retryOrReassignTask(actor: UserActor | AgentActor, input: {
    taskId: string
    executionId: string
    assigneeAgentId: string
    expectedRevision: number
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    return this.commit(actor, 'task.retry', input.idempotencyKey, input, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const lockedAgents = await lockAgentsForUpdate(tx, [
        input.assigneeAgentId,
        ...(actor.kind === 'agent_device' ? [actor.agentId] : [])
      ])
      const assignee = required(lockedAgents.get(input.assigneeAgentId) ?? null, 'Assignee Agent')
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      const actorMember = await tx.getProjectMember(project.projectId, actor.userId)
      const isOwner = actor.kind === 'user' && actorMember?.role === 'owner'
      const isCoordinator = actor.kind === 'agent_device' && actor.agentId === project.coordinatorAgentId
      if (!isOwner && !isCoordinator) {
        if (actor.kind === 'agent_device') {
          fail('coordinator_mismatch', 'Only the current Coordinator Agent may retry or reassign a Task.')
        }
        fail('permission_denied', 'Task retry or reassignment requires the Project owner or active Coordinator Agent.')
      }
      if (actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project,
          required(lockedAgents.get(actor.agentId) ?? null, 'Coordinator Agent'))
      }
      if (project.status !== 'active') fail('invalid_state_transition', 'Task retry requires an active Project.')
      if (input.executionId !== task.executionId) fail('execution_conflict', 'The Task execution is no longer current.', {
        details: { currentRevision: task.revision, currentExecutionId: task.executionId }
      })
      expectRevision(task.revision, input.expectedRevision)
      const sameAssignee = input.assigneeAgentId === task.assigneeAgentId
      if (sameAssignee) {
        authorize({ actor, operation: 'task_retry', coordinatorAgentId: project.coordinatorAgentId, projectRole: actorMember?.role })
      } else if (actor.kind === 'user') {
        authorize({ actor, operation: 'task_reassign', projectRole: actorMember?.role })
      } else {
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'task.retry_reassign', projectId: project.projectId,
          taskId: task.taskId, fromExecutionId: task.executionId,
          assigneeAgentId: input.assigneeAgentId
        }, project, 'task.retry', at)
      }
      if (sameAssignee && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'rejected') {
        fail('invalid_state_transition', 'Only succeeded, rejected, or failed tasks may be retried by the current assignee.')
      }
      if (!sameAssignee && !['offered', 'accepted', 'in_progress', 'needs_human', 'completed', 'failed', 'rejected'].includes(task.status)) {
        fail('invalid_state_transition', 'Cancelled tasks cannot be reassigned.')
      }
      if (task.retryCount >= project.budgets.maxTaskRetries) fail('budget_exhausted', 'The task automatic retry budget is exhausted.')
      const member = await tx.getProjectMember(project.projectId, assignee.ownerUserId)
      if (assignee.status !== 'active' || !member?.active || member.role === 'observer') fail('permission_denied', 'The assignee is not authorized for this Project.')
      const profile = await tx.getAgentCapabilityProfile(assignee.agentId)
      if (!profile || profile.ownerUserId !== assignee.ownerUserId || profile.expiresAt <= at) {
        fail('capability_profile_expired', 'The assignee Agent capability profile is missing, stale, or owner-mismatched.')
      }
      assertCapabilityRequirements(profile, task.requiredCapabilities)
      const priorResult = await tx.getTaskResultForExecutionForUpdate(task.taskId, task.executionId)
      if (priorResult?.status === 'accepted') {
        fail('invalid_state_transition', 'An accepted Task result cannot be superseded by an ordinary retry.')
      }
      const pendingRequests = await tx.listPendingHumanRequestsForTaskForUpdate(task.taskId)
      for (const request of pendingRequests) {
        const status = request.expiresAt <= at ? 'expired' as const : 'cancelled' as const
        await tx.updateHumanRequest({ ...request, status, revision: request.revision + 1, updatedAt: at }, request.revision)
      }
      if (priorResult && priorResult.status !== 'superseded') {
        await tx.updateProjectRecord({ ...priorResult, status: 'superseded', revision: priorResult.revision + 1,
          updatedAt: at }, priorResult.revision)
      }
      const updated: StoredTask = { ...clearTaskAttemptOutputs(task), executionId: newId('exe'),
        assigneeAgentId: assignee.agentId, assigneeUserId: assignee.ownerUserId, status: 'offered',
        retryCount: task.retryCount + 1,
        completedAt: undefined, revision: task.revision + 1, updatedAt: at }
      await tx.updateTask(updated, task.revision)
      await invalidateApprovedGovernedActions(tx, project.projectId, at, (action) => (
        action.kind === 'task.cancel' && action.taskId === task.taskId && action.executionId === task.executionId
      ) || (
        action.kind === 'task.retry_reassign' && action.taskId === task.taskId &&
          action.fromExecutionId === task.executionId
      ))
      const message = await this.appendInbox(tx, { kind: 'agent', id: assignee.agentId }, 'task.offered',
        { protocolVersion: '1.0', type: 'task.offered', projectId: project.projectId,
          taskId: task.taskId, executionId: updated.executionId, revision: updated.revision }, at)
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async cancelTask(actor: UserActor | AgentActor, input: {
    taskId: string
    executionId: string
    expectedRevision: number
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    return this.commit(actor, 'task.cancel', input.idempotencyKey, input, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const actorMember = await tx.getProjectMember(project.projectId, actor.userId)
      if (actor.kind === 'user') {
        authorize({ actor, operation: 'task_cancel', projectRole: actorMember?.role })
      } else {
        if (actor.agentId !== project.coordinatorAgentId) fail('coordinator_mismatch', 'Only the current Coordinator may execute a confirmed cancellation.')
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'task.cancel', projectId: project.projectId,
          taskId: task.taskId, executionId: task.executionId
        }, project, 'task.cancel', at)
      }
      if (input.executionId !== task.executionId) fail('execution_conflict', 'The Task execution is no longer current.', {
        details: { currentRevision: task.revision, currentExecutionId: task.executionId }
      })
      expectRevision(task.revision, input.expectedRevision)
      if (['rejected', 'completed', 'failed', 'cancelled'].includes(task.status)) fail('invalid_state_transition', 'The task is already terminal.')
      const updated: StoredTask = { ...task, status: 'cancelled', completedAt: at,
        revision: task.revision + 1, updatedAt: at }
      await tx.updateTask(updated, task.revision)
      await invalidateApprovedGovernedActions(tx, project.projectId, at, (action) => (
        action.kind === 'task.cancel' && action.taskId === task.taskId && action.executionId === task.executionId
      ) || (
        action.kind === 'task.retry_reassign' && action.taskId === task.taskId &&
          action.fromExecutionId === task.executionId
      ))
      const message = await this.appendInbox(tx, { kind: 'agent', id: task.assigneeAgentId }, 'task.cancelled',
        { protocolVersion: '1.0', type: 'task.cancelled', projectId: project.projectId,
          taskId: task.taskId, executionId: task.executionId, revision: updated.revision,
          reason: 'Cancelled through the Project governance boundary.' }, at)
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async advanceCoordinationRound(actor: AgentActor, input: {
    projectId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.round.advance', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = required(await tx.getAgentForUpdate(actor.agentId), 'Coordinator Agent')
      await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      authorize({ actor, operation: 'coordination_write', coordinatorAgentId: project.coordinatorAgentId })
      if (project.status !== 'active') fail('invalid_state_transition', 'Coordination rounds require an active Project.')
      expectRevision(project.revision, input.expectedRevision)
      if (project.coordinationRound >= project.budgets.maxCoordinationRounds) {
        fail('budget_exhausted', 'The Project coordination-round budget is exhausted.')
      }
      const updated: StoredProject = { ...project, coordinationRound: project.coordinationRound + 1,
        revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updated, project.revision)
      return { response: entityResponse('project.updated', updated), resourceKind: 'project', resourceId: project.projectId }
    }).then(responseEntity<StoredProject>)
  }

  async submitProjectRecord(actor: UserActor | AgentActor, input: {
    projectId: string
    kind: ProjectRecordKind
    summary: string
    sourceTaskId?: string
    sourceExecutionId?: string
    sourceRevision?: number
    resourceRefIds?: string[]
    idempotencyKey: string
  }): Promise<StoredProjectRecord> {
    validateProjectSummary(input.summary)
    if ((input.sourceTaskId === undefined) !== (input.sourceExecutionId === undefined)) {
      fail('validation_failed', 'Task provenance requires Task and execution identity together.')
    }
    if (input.kind === 'task_result' && (!input.sourceTaskId || !input.sourceExecutionId)) {
      fail('validation_failed', 'A Task result requires explicit Task execution provenance.')
    }
    return this.commit(actor, 'project_record.submit', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'record_submit', projectMember: Boolean(member?.active) })
      let sourceTask: StoredTask | undefined
      if (input.sourceTaskId) {
        const task = required(await tx.getTaskForUpdate(input.sourceTaskId), 'Source task')
        sourceTask = task
        if (task.projectId !== project.projectId) fail('validation_failed', 'The source task belongs to another Project.')
        if (input.sourceRevision !== task.revision) fail('revision_conflict', 'The source task revision is stale.')
        if (input.sourceExecutionId !== undefined && input.sourceExecutionId !== task.executionId) fail('execution_conflict', 'The source Task execution is stale.', {
          details: { currentRevision: task.revision, currentExecutionId: task.executionId }
        })
        if (actor.kind === 'agent_device' && actor.agentId !== task.assigneeAgentId && actor.agentId !== project.coordinatorAgentId) {
          fail('permission_denied', 'An Agent may only cite its assigned Task or a Task it coordinates.')
        }
        if (actingAgent && actor.kind === 'agent_device' && actor.agentId === task.assigneeAgentId) {
          await assertCurrentTaskActorMembership(tx, actor, project, task, input.sourceExecutionId ?? '', actingAgent)
        }
      } else if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        fail('permission_denied', 'Worker records require explicit Task provenance.')
      }
      if (input.kind === 'task_result') {
        const existing = await tx.getTaskResultForExecution(
          input.sourceTaskId!,
          input.sourceExecutionId!
        )
        if (!existing) {
          fail('invalid_state_transition', 'Task results are created atomically by the successful Task execution.')
        }
        if (existing.summary !== input.summary.trim()) {
          fail('idempotency_conflict', 'This execution already has a different canonical Task result.')
        }
        return { response: entityResponse('project_record.created', existing), resourceKind: 'project_record',
          resourceId: existing.projectRecordId }
      }
      const resourceRefIds = [...new Set(input.resourceRefIds ?? [])]
      if (resourceRefIds.length > 1_000) fail('validation_failed', 'ProjectRecord ResourceRef list is too large.')
      for (const resourceRefId of resourceRefIds) {
        const resource = required(await tx.getResourceRef(resourceRefId), 'ProjectRecord ResourceRef')
        if (resource.projectId !== project.projectId || resource.status !== 'available') {
          fail('resource_unavailable', 'ProjectRecord cites an unavailable ResourceRef.')
        }
        if (sourceTask && resource.taskId &&
            (resource.taskId !== sourceTask.taskId || resource.executionId !== sourceTask.executionId)) {
          fail('execution_conflict', 'ProjectRecord cites a ResourceRef from another Task execution.', {
            details: { currentRevision: sourceTask.revision, currentExecutionId: sourceTask.executionId }
          })
        }
      }
      if ((input.kind === 'decision' || input.kind === 'summary') &&
          !(actor.kind === 'agent_device' && actor.agentId === project.coordinatorAgentId)) {
        fail('permission_denied', 'Formal decisions and summaries must be accepted, not directly authored by a Worker or member.')
      }
      const record: StoredProjectRecord = {
        projectRecordId: newId('rec'), projectId: project.projectId, kind: input.kind,
        status: 'candidate', summary: input.summary,
        ...(actor.kind === 'agent_device' ? { authorAgentId: actor.agentId, authorUserId: actor.userId } : { authorUserId: actor.userId }),
        ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId,
          sourceExecutionId: input.sourceExecutionId ?? required(await tx.getTask(input.sourceTaskId), 'Source task').executionId,
          sourceRevision: input.sourceRevision } : {}),
        criterionEvidence: [], resourceRefIds,
        revision: 1, createdAt: at, updatedAt: at
      }
      await tx.insertProjectRecord(record)
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'project_record.submitted',
        { protocolVersion: '1.0', type: 'project_record.submitted', projectId: project.projectId,
          projectRecordId: record.projectRecordId, sourceTaskId: record.sourceTaskId ?? null,
          sourceExecutionId: record.sourceExecutionId ?? null, revision: record.revision }, at)
      return { response: entityResponse('project_record.created', record), resourceKind: 'project_record',
        resourceId: record.projectRecordId, notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredProjectRecord>)
  }

  async getProjectRecord(actor: AuthContext, projectRecordId: string): Promise<StoredProjectRecord> {
    if (actor.kind !== 'user' && actor.kind !== 'agent_device') {
      fail('permission_denied', 'Only a user or Agent credential may read Project records.')
    }
    const record = required(await this.repository.getProjectRecord(projectRecordId), 'Project record')
    const member = await this.repository.getProjectMember(record.projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return record
  }

  async acceptProjectRecord(actor: UserActor | AgentActor, input: {
    projectRecordId: string
    decision?: 'accepted' | 'rejected'
    acceptedKind?: 'observation' | 'decision' | 'summary' | 'task_result'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredProjectRecord> {
    return this.commit(actor, 'project_record.accept', input.idempotencyKey, input, async (tx, at) => {
      const initialRecord = required(await tx.getProjectRecord(input.projectRecordId), 'Project record')
      const project = required(await tx.getProjectForUpdate(initialRecord.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Coordinator Agent')
        : undefined
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const record = required(await tx.getProjectRecord(input.projectRecordId), 'Project record')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      const decision = input.decision ?? 'accepted'
      const kind = input.acceptedKind ?? (record.kind === 'proposal' && decision === 'accepted' ? 'decision' : record.kind)
      authorize({ actor, operation: 'record_accept', projectRole: member?.role,
        coordinatorAgentId: project.coordinatorAgentId, recordKind: record.kind })
      authorize({ actor, operation: 'record_accept', projectRole: member?.role,
        coordinatorAgentId: project.coordinatorAgentId, recordKind: kind })
      expectRevision(record.revision, input.expectedRevision)
      if (record.status !== 'candidate') fail('invalid_state_transition', 'Only a candidate Project record may be accepted.')
      const updated: StoredProjectRecord = { ...record, kind, status: decision,
        ...(decision === 'accepted'
          ? actor.kind === 'agent_device' ? { acceptedByAgentId: actor.agentId } : { acceptedByUserId: actor.userId }
          : {}),
        ...(decision === 'accepted' ? { acceptedAt: at } : {}), revision: record.revision + 1, updatedAt: at }
      await tx.updateProjectRecord(updated, record.revision)
      if (decision === 'accepted' && kind === 'task_result' && record.sourceTaskId && record.sourceExecutionId) {
        await invalidateApprovedGovernedActions(tx, project.projectId, at,
          (action) => action.kind === 'task.retry_reassign' &&
            action.taskId === record.sourceTaskId && action.fromExecutionId === record.sourceExecutionId)
      }
      return { response: entityResponse('project_record.updated', updated), resourceKind: 'project_record',
        resourceId: record.projectRecordId }
    }).then(responseEntity<StoredProjectRecord>)
  }

  async createResourceRef(actor: UserActor | AgentActor, input: ResourceRefCreateMetadata & {
    projectId: string
    taskId?: string
    executionId?: string
    expectedTaskRevision?: number
    idempotencyKey: string
  }): Promise<StoredResourceRef> {
    const parsed = resourceRefCreateMetadataSchema.safeParse({
      provider: input.provider,
      externalId: input.externalId,
      kind: input.kind,
      name: input.name,
      openUrl: input.openUrl,
      version: input.version
    })
    if (!parsed.success) {
      fail('validation_failed', 'ResourceRef accepts bounded metadata and HTTPS references only.')
    }
    if (new Set([input.taskId, input.executionId, input.expectedTaskRevision].map((value) => value === undefined)).size > 1) {
      fail('validation_failed', 'Task-scoped ResourceRef requires Task, execution, and revision together.')
    }
    const request = { projectId: input.projectId, taskId: input.taskId, executionId: input.executionId,
      expectedTaskRevision: input.expectedTaskRevision, ...parsed.data }
    return this.commit(actor, 'resource.create', input.idempotencyKey, request, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = input.taskId
        ? required(await tx.getTaskForUpdate(input.taskId), 'ResourceRef Task')
        : undefined
      if (actingAgent) await assertCurrentAgentProjectMembership(tx, actor as AgentActor, project, actingAgent)
      await authorizeResourceCreate(tx, actor, project, task, input.executionId)
      if (task) {
        if (actingAgent && actor.kind === 'agent_device' && actor.agentId === task.assigneeAgentId) {
          await assertCurrentTaskActorMembership(tx, actor, project, task, input.executionId ?? '', actingAgent)
        }
        expectRevision(task.revision, input.expectedTaskRevision!)
      }
      const resource: StoredResourceRef = {
        resourceRefId: newId('rrf'),
        projectId: project.projectId,
        ...(task ? { taskId: task.taskId, executionId: task.executionId, taskRevision: task.revision } : {}),
        createdByUserId: actor.userId,
        ...(actor.kind === 'agent_device' ? { createdByAgentId: actor.agentId } : {}),
        ...parsed.data,
        status: 'available',
        revision: 1,
        createdAt: at,
        updatedAt: at
      }
      await tx.insertResourceRef(resource)
      return {
        response: entityResponse('resource.created', resource),
        resourceKind: 'resource_ref',
        resourceId: resource.resourceRefId
      }
    }).then(responseEntity<StoredResourceRef>)
  }

  async getResourceRef(actor: AuthContext, resourceRefId: string): Promise<StoredResourceRef> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project resources.')
    const resource = required(await this.repository.getResourceRef(resourceRefId), 'ResourceRef')
    const member = await this.repository.getProjectMember(resource.projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    if (actor.kind === 'agent_device') {
      const project = required(await this.repository.getProject(resource.projectId), 'Project')
      if (actor.agentId !== project.coordinatorAgentId) {
        if (resource.taskId && resource.executionId) {
          const task = required(await this.repository.getTask(resource.taskId), 'ResourceRef Task')
          assertCurrentTaskExecution(actor, task, resource.executionId)
        } else {
          const referencingTask = (await this.repository.listOpenTasksForAgent(actor.agentId)).find((task) => (
            task.projectId === resource.projectId &&
            (task.resourceRefIds.includes(resource.resourceRefId) ||
              task.requiredCapabilities.requiredResourceRefIds.includes(resource.resourceRefId))
          ))
          if (!referencingTask) {
            fail('permission_denied', 'A Worker may only read ResourceRefs explicitly referenced by its current Task.')
          }
        }
      }
    }
    if (resource.status !== 'available') fail('resource_unavailable', 'The ResourceRef is not currently available.')
    return resource
  }

  async invalidateResourceRef(actor: UserActor | AgentActor, input: {
    resourceRefId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredResourceRef> {
    return this.commit(actor, 'resource.invalidate', input.idempotencyKey, input, async (tx, at) => {
      const initialResource = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      const project = required(await tx.getProjectForUpdate(initialResource.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = initialResource.taskId
        ? required(await tx.getTaskForUpdate(initialResource.taskId), 'ResourceRef Task')
        : undefined
      const resource = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      if (resource.projectId !== project.projectId || resource.taskId !== initialResource.taskId) {
        fail('revision_conflict', 'ResourceRef Task provenance changed before this write.')
      }
      if (task && actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        await assertCurrentTaskActorMembership(tx, actor, project, task, resource.executionId ?? '',
          required(actingAgent ?? null, 'Worker Agent'))
      } else if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      await authorizeResourceInvalidation(tx, actor, project, task)
      expectRevision(resource.revision, input.expectedRevision)
      if (resource.status !== 'available') {
        fail('invalid_state_transition', 'Only an available ResourceRef may be invalidated.')
      }
      const updated: StoredResourceRef = {
        ...resource,
        status: 'invalidated',
        invalidatedAt: at,
        revision: resource.revision + 1,
        updatedAt: at
      }
      await tx.updateResourceRef(updated, resource.revision)
      return {
        response: entityResponse('resource.invalidated', updated),
        resourceKind: 'resource_ref',
        resourceId: resource.resourceRefId
      }
    }).then(responseEntity<StoredResourceRef>)
  }

  async transitionResourceRef(actor: UserActor | AgentActor, input: {
    resourceRefId: string
    status: 'available' | 'unavailable' | 'revoked'
    safeReasonCode?: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredResourceRef> {
    if ((input.status === 'available') === (input.safeReasonCode !== undefined)) {
      fail('validation_failed', 'Unavailable or revoked resources require a safe reason; available resources do not.')
    }
    if (input.safeReasonCode && !/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.safeReasonCode)) {
      fail('validation_failed', 'ResourceRef reason must be a bounded machine-readable code.')
    }
    return this.commit(actor, 'resource.transition', input.idempotencyKey, input, async (tx, at) => {
      const initial = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      const project = required(await tx.getProjectForUpdate(initial.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = initial.taskId ? required(await tx.getTaskForUpdate(initial.taskId), 'ResourceRef Task') : undefined
      const resource = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      await authorizeResourceInvalidation(tx, actor, project, task)
      if (task && actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        await assertCurrentTaskActorMembership(tx, actor, project, task, resource.executionId ?? '',
          required(actingAgent ?? null, 'Worker Agent'))
      } else if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      expectRevision(resource.revision, input.expectedRevision)
      if (!canTransition('resource_ref', resource.status, input.status)) {
        fail('invalid_state_transition', `ResourceRef cannot transition from ${resource.status} to ${input.status}.`)
      }
      const updated: StoredResourceRef = {
        ...resource,
        status: input.status,
        revision: resource.revision + 1,
        updatedAt: at
      }
      delete updated.statusReasonCode
      delete updated.unavailableAt
      delete updated.revokedAt
      if (input.safeReasonCode) updated.statusReasonCode = input.safeReasonCode
      if (input.status === 'unavailable') updated.unavailableAt = at
      if (input.status === 'revoked') updated.revokedAt = at
      await tx.updateResourceRef(updated, resource.revision)
      return { response: entityResponse('resource.updated', updated), resourceKind: 'resource_ref',
        resourceId: resource.resourceRefId }
    }).then(responseEntity<StoredResourceRef>)
  }

  async getProject(actor: AuthContext, projectId: string): Promise<{
    project: StoredProject
    members: StoredProjectMember[]
    records: StoredProjectRecord[]
  }> {
    if (actor.kind === 'system') fail('permission_denied', 'System context is not an interactive Project member.')
    const project = required(await this.repository.getProject(projectId), 'Project')
    const member = await this.repository.getProjectMember(projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    const [members, records] = await Promise.all([
      this.repository.listProjectMembers(projectId),
      this.repository.listProjectRecords(projectId, true)
    ])
    return { project, members, records }
  }

  async getProjectCoordinationView(actor: UserActor | AgentActor, projectId: string): Promise<{
    project: StoredProject
    members: Array<StoredProjectMember & { displayName: string }>
    tasks: StoredTask[]
    records: StoredProjectRecord[]
    humanRequests: StoredHumanRequest[]
    humanAnswers: StoredHumanAnswer[]
    readAt: string
  }> {
    const readAt = this.timestamp()
    await this.repository.pruneExpired(readAt)
    return this.repository.transaction(async (tx) => {
      const actorMember = await tx.getProjectMember(projectId, actor.userId)
      authorize({ actor, operation: 'project_read', projectMember: Boolean(actorMember?.active) })
      const project = required(await tx.getProjectForUpdate(projectId), 'Project')
      if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        fail('coordinator_mismatch', 'Only the current Coordinator Agent may use an Agent credential for the coordination view.')
      }
      if (actor.kind === 'user' && actorMember?.role !== 'owner') {
        fail('permission_denied', 'Only the Project owner User or current Coordinator Agent may read the coordination view.')
      }
      const memberRows = await tx.listProjectMembers(projectId)
      const members = await Promise.all(memberRows.filter((member) => member.active).map(async (member) => ({
        ...member,
        displayName: required(await tx.getUser(member.userId), 'Project member').displayName
      })))
      const [tasks, records, humanRequests, humanAnswers] = await Promise.all([
        tx.listProjectTasks(projectId),
        tx.listProjectRecords(projectId, false),
        tx.listHumanRequestsForProject(projectId),
        tx.listHumanAnswersForProject(projectId)
      ])
      return {
        project,
        members: members.sort((left, right) => compareStable(left.userId, right.userId)),
        tasks: tasks.sort((left, right) => compareStable(left.taskId, right.taskId)),
        records: records.sort((left, right) => compareStable(left.projectRecordId, right.projectRecordId)),
        humanRequests: humanRequests.sort((left, right) => compareStable(left.humanRequestId, right.humanRequestId)),
        humanAnswers: humanAnswers.sort((left, right) => compareStable(left.humanAnswerId, right.humanAnswerId)),
        readAt
      }
    })
  }

  async getActionConfirmation(
    actor: UserActor | AgentActor,
    confirmationId: string
  ): Promise<StoredActionConfirmation> {
    await this.repository.pruneExpired(this.timestamp())
    const confirmation = required(
      await this.repository.getActionConfirmation(confirmationId),
      'Action confirmation'
    )
    const mayRead = actor.kind === 'user'
      ? actor.userId === confirmation.targetUserId
      : actor.agentId === confirmation.coordinatorAgentId
    if (!mayRead) {
      fail('permission_denied', 'The action confirmation belongs to another Project actor.')
    }
    return confirmation
  }

  async reportAgentCapabilityProfile(actor: AgentActor, input: {
    agentId: string
    ownerUserId: string
    nodeType: 'personal_computer' | 'institution_server'
    os: { family: 'windows' | 'macos' | 'linux'; architecture: 'x64' | 'arm64'; version?: string }
    runtimeIds: string[]
    capabilities: StoredAgentCapabilityProfile['capabilities']
    gpu?: StoredAgentCapabilityProfile['gpu']
    vpnAccessIds: string[]
    slurmClusterIds: string[]
    accessibleResourceRefIds: string[]
    resultReturnPolicy: StoredAgentCapabilityProfile['resultReturnPolicy']
    reportedAt: string
    expiresAt: string
    expectedRevision?: number
    idempotencyKey: string
  }): Promise<StoredAgentCapabilityProfile> {
    if (input.agentId !== actor.agentId || input.ownerUserId !== actor.userId) {
      fail('assignee_mismatch', 'Capability profile identity must match the authenticated Agent credential.')
    }
    const reportedTime = new Date(input.reportedAt).getTime()
    const expiresTime = new Date(input.expiresAt).getTime()
    const nowTime = this.now().getTime()
    if (!Number.isFinite(reportedTime) || !Number.isFinite(expiresTime) || reportedTime > nowTime + 60_000 ||
        expiresTime <= nowTime || expiresTime - reportedTime > 7 * 86_400_000) {
      fail('validation_failed', 'Capability profile timestamps are outside the accepted freshness window.')
    }
    return this.commit(actor, 'agent.capability_profile.report', input.idempotencyKey, input, async (tx, at) => {
      const agent = required(await tx.getAgent(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId || agent.status !== 'active') {
        fail('credential_revoked', 'Only an active Agent may report its capability profile.')
      }
      const expectedNodeType = agent.nodeType === 'desktop' ? 'personal_computer' : 'institution_server'
      if (input.nodeType !== expectedNodeType) fail('validation_failed', 'Capability profile nodeType conflicts with Agent registration.')
      const current = await tx.getAgentCapabilityProfile(agent.agentId)
      if (current) {
        if (input.expectedRevision === undefined) fail('revision_conflict', 'Capability profile revision is required.', {
          details: { currentRevision: current.revision }
        })
        expectRevision(current.revision, input.expectedRevision)
      } else if (input.expectedRevision !== undefined) {
        fail('revision_conflict', 'A new capability profile must not claim an existing revision.')
      }
      for (const resourceRefId of input.accessibleResourceRefIds) {
        const resource = required(await tx.getResourceRef(resourceRefId), 'Accessible ResourceRef')
        if (resource.createdByUserId !== actor.userId || resource.status !== 'available') {
          fail('resource_unavailable', 'Capability profile contains a ResourceRef unavailable to this Agent owner.')
        }
      }
      const profile: StoredAgentCapabilityProfile = {
        agentId: agent.agentId, ownerUserId: agent.ownerUserId, nodeType: input.nodeType,
        osFamily: input.os.family, osArchitecture: input.os.architecture,
        ...(input.os.version ? { osVersion: input.os.version } : {}),
        runtimeIds: [...new Set(input.runtimeIds)], capabilities: input.capabilities,
        gpu: input.gpu ?? [], vpnAccessIds: [...new Set(input.vpnAccessIds)],
        slurmClusterIds: [...new Set(input.slurmClusterIds)],
        accessibleResourceRefIds: [...new Set(input.accessibleResourceRefIds)],
        resultReturnPolicy: input.resultReturnPolicy, reportedAt: input.reportedAt, expiresAt: input.expiresAt,
        revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? at, updatedAt: at
      }
      await tx.upsertAgentCapabilityProfile(profile, current?.revision ?? null)
      return { response: entityResponse('agent.capability_profile.updated', profile), resourceKind: 'agent_capability_profile',
        resourceId: agent.agentId }
    }).then(responseEntity<StoredAgentCapabilityProfile>)
  }

  async getProjectCapabilityDirectory(
    actor: UserActor | AgentActor,
    projectId: string
  ): Promise<ProjectCapabilityDirectoryView> {
    const actorMember = await this.repository.getProjectMember(projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(actorMember?.active) })
    const project = required(await this.repository.getProject(projectId), 'Project')
    if (project.status !== 'active') {
      fail('invalid_state_transition', 'Capability directory is available only for an active Project.')
    }
    const members = (await this.repository.listProjectMembers(projectId)).filter((member) => member.active)
    const now = this.timestamp()
    const agents = (await Promise.all(members.map(async (member) => {
      const user = await this.repository.getUser(member.userId)
      if (!user || user.status !== 'active') return []
      return (await Promise.all((await this.repository.listAgentsForUser(member.userId))
        .filter((agent): agent is StoredAgent & { lastSeenAt: string } => (
          agent.status === 'active' && agent.lastSeenAt !== undefined
        ))
        .map(async (agent) => ({ agent, profile: await this.repository.getAgentCapabilityProfile(agent.agentId),
          busy: (await this.repository.listOpenTasksForAgent(agent.agentId))
            .some((task) => ['accepted', 'in_progress', 'needs_human'].includes(task.status)) }))))
        .filter((entry): entry is {
          agent: StoredAgent & { lastSeenAt: string }
          profile: StoredAgentCapabilityProfile
          busy: boolean
        } => (
          entry.profile !== null && entry.profile.expiresAt > now && entry.profile.ownerUserId === entry.agent.ownerUserId
        ))
    }))).flat()
      .sort((left, right) => left.agent.ownerUserId === right.agent.ownerUserId
        ? compareStable(left.agent.agentId, right.agent.agentId)
        : compareStable(left.agent.ownerUserId, right.agent.ownerUserId))
      .map(({ agent, profile, busy }): ProjectCapabilityDirectoryView['agents'][number] => ({
        agentId: agent.agentId,
        ownerUserId: agent.ownerUserId,
        displayName: agent.displayName,
        nodeType: agent.nodeType,
        capabilities: profile.capabilities.map((capability) => capability.capabilityId).sort(compareStable),
        status: agent.connectionStatus === 'offline' ? 'offline' : busy ? 'busy' : 'online',
        lastSeenAt: agent.lastSeenAt,
        profile,
        revision: agent.revision
      }))
    return { projectId: project.projectId, projectRevision: project.revision, agents }
  }

  async pullInbox(actor: AuthContext, input: { afterSequence: number; limit: number }): Promise<{
    messages: StoredInboxMessage[]
    ackedSequence: number
    nextSequence: number
  }> {
    const recipient = actorInboxRecipient(actor)
    const afterSequence = integer(input.afterSequence, 'afterSequence', 0, Number.MAX_SAFE_INTEGER)
    const limit = integer(input.limit, 'limit', 1, 1_000)
    const readAt = this.timestamp()
    // Expired, unacknowledged messages remain sequence-preserving tombstones.
    // Materialize them before the read so a consumer never observes an
    // invisible active gap that it cannot safely acknowledge.
    await this.repository.pruneExpired(readAt)
    const [messages, cursor] = await Promise.all([
      this.repository.pullInbox(recipient, afterSequence, limit, readAt),
      this.repository.getInboxCursor(recipient)
    ])
    return { messages, ackedSequence: cursor?.ackedSequence ?? 0, nextSequence: cursor?.nextSequence ?? 1 }
  }

  async ackInbox(actor: AuthContext, input: { throughSequence: number; idempotencyKey: string }): Promise<{
    ackedSequence: number
    nextSequence: number
  }> {
    const recipient = actorInboxRecipient(actor)
    integer(input.throughSequence, 'throughSequence', 0, Number.MAX_SAFE_INTEGER)
    return this.commit(actor, 'inbox.ack', input.idempotencyKey, input, async (tx, at) => {
      const current = await tx.getInboxCursor(recipient)
      const acked = current?.ackedSequence ?? 0
      if (input.throughSequence > acked + 1) {
        for (let sequence = acked + 1; sequence < input.throughSequence; sequence += 1) {
          const skipped = await tx.getInboxMessage(recipient, sequence)
          if (!skipped || skipped.disposition !== 'superseded') {
            fail('inbox_ack_gap', 'Inbox ACK cannot pass an unfinished active message.', {
              details: { ackedSequence: acked, nextSequence: current?.nextSequence ?? 1 }
            })
          }
        }
      }
      const cursor = await tx.ackInbox(recipient, input.throughSequence, at)
      return { response: { protocolVersion: '1.0', type: 'inbox.acked', ackedSequence: cursor.ackedSequence,
        nextSequence: cursor.nextSequence }, resourceKind: 'inbox', resourceId: recipient.id }
    }).then((response) => ({ ackedSequence: Number(response.ackedSequence), nextSequence: Number(response.nextSequence) }))
  }

  async ackInboxMessage(actor: AuthContext, input: {
    inboxMessageId: string
    sequence: number
    idempotencyKey: string
  }): Promise<{ ackedSequence: number; nextSequence: number }> {
    integer(input.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER)
    const recipient = actorInboxRecipient(actor)
    return this.commit(actor, 'inbox.ack', input.idempotencyKey, input, async (tx, at) => {
      const message = await tx.getInboxMessage(recipient, input.sequence)
      if (!message || message.messageId !== input.inboxMessageId) {
        fail('not_found', 'The inbox message does not match this authenticated recipient and sequence.')
      }
      const current = await tx.getInboxCursor(recipient)
      const acked = current?.ackedSequence ?? 0
      if (input.sequence > acked + 1) {
        for (let sequence = acked + 1; sequence < input.sequence; sequence += 1) {
          const skipped = await tx.getInboxMessage(recipient, sequence)
          if (!skipped || skipped.disposition !== 'superseded') {
            fail('inbox_ack_gap', 'Inbox ACK cannot pass an unfinished active message.', {
              details: { ackedSequence: acked, nextSequence: current?.nextSequence ?? 1 }
            })
          }
        }
      }
      const cursor = await tx.ackInbox(recipient, input.sequence, at)
      return { response: { protocolVersion: '1.0', type: 'inbox.acked', inboxMessageId: input.inboxMessageId,
        sequence: input.sequence, ackedSequence: cursor.ackedSequence, nextSequence: cursor.nextSequence },
      resourceKind: 'inbox', resourceId: recipient.id }
    }).then((response) => ({ ackedSequence: Number(response.ackedSequence), nextSequence: Number(response.nextSequence) }))
  }

  async reconcileReceipt(actor: AuthContext, idempotencyKey: string): Promise<StoredReceipt | null> {
    assertText(idempotencyKey, 'idempotencyKey', 8, 300)
    return this.repository.getReceipt(actor.actorKey, idempotencyKey)
  }

  async getReceipt(actor: AuthContext, receiptId: string): Promise<StoredReceipt | null> {
    assertText(receiptId, 'receiptId', 8, 100)
    const receipt = await this.repository.getReceiptById(receiptId)
    if (!receipt) return null
    if (receipt.actorKey !== actor.actorKey) fail('permission_denied', 'The receipt belongs to another authenticated actor.')
    return receipt
  }

  pruneExpired(): Promise<{ inboxMessages: number; receipts: number; challenges: number; humanRequests: number }> {
    return this.repository.pruneExpired(this.timestamp())
  }

  async recordRejectedBoundary(actor: AuthContext, operation: string, error: CollaborationServiceError): Promise<void> {
    if (error.auditRecorded) return
    await this.repository.transaction((tx) => tx.insertAudit({
      auditEventId: newId('audit'), actorKind: actor.kind, ...actorAuditIdentity(actor), action: operation,
      outcome: 'rejected', metadata: safeAuditMetadata({ errorCode: error.code }), createdAt: this.timestamp()
    }))
    error.auditRecorded = true
  }

  private async appendInbox(
    tx: CollaborationTransaction,
    recipient: InboxRecipient,
    messageType: string,
    payload: Record<string, unknown>,
    at: string
  ): Promise<StoredInboxMessage> {
    return tx.appendInbox({ recipient, messageId: newId('ibx'), messageType, payload,
      createdAt: at, expiresAt: new Date(new Date(at).getTime() + this.inboxRetentionMs).toISOString() })
  }

  private async commit(
    actor: AuthContext,
    operation: string,
    idempotencyKey: string,
    request: unknown,
    work: (tx: CollaborationTransaction, at: string) => Promise<CommandResult<Record<string, unknown>>>,
    atOverride?: string
  ): Promise<Record<string, unknown>> {
    assertText(idempotencyKey, 'idempotencyKey', 8, 300)
    const requestDigest = stableDigest(idempotencyBusinessPayload(request))
    const at = atOverride ?? this.timestamp()
    let notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
    let response: Record<string, unknown>
    try {
      response = await this.repository.transaction(async (tx) => {
      await tx.lockIdempotency(actor.actorKey, idempotencyKey)
      if (actor.kind === 'agent_device') {
        const device = await tx.getDeviceForUpdate(actor.deviceId)
        if (!device || device.status !== 'active' || device.userId !== actor.userId) {
          fail('credential_revoked', 'The Agent Device is no longer active.')
        }
      }
      const existing = await tx.getReceipt(actor.actorKey, idempotencyKey)
      if (existing) {
        if (existing.requestDigest !== requestDigest || existing.operation !== operation) {
          fail('idempotency_conflict', 'The idempotency key was already used for a different request.')
        }
        return existing.response
      }
      const result = await work(tx, at)
      notifications = result.notifications ?? []
      const audit: StoredAuditEvent = {
        auditEventId: newId('audit'), actorKind: actor.kind,
        ...actorAuditIdentity(actor), action: operation, resourceKind: result.resourceKind, resourceId: result.resourceId,
        outcome: 'accepted', metadata: safeAuditMetadata({ idempotencyKeyDigest: stableDigest(idempotencyKey) }), createdAt: at
      }
      await tx.insertAudit(audit)
      if (result.persistReceipt !== false) {
        const receiptResponse = result.receiptResponse ?? result.response
        const receipt: StoredReceipt = {
          receiptId: operationReceiptId(actor.actorKey, idempotencyKey), actorKey: actor.actorKey,
          idempotencyKey, requestDigest, operation, resourceKind: result.resourceKind,
          resourceId: result.resourceId, response: receiptResponse, createdAt: at,
          expiresAt: new Date(new Date(at).getTime() + this.receiptRetentionMs).toISOString()
        }
        await tx.insertReceipt(receipt)
      }
      return result.response
      })
    } catch (error) {
      const serviceError = error instanceof CollaborationServiceError ? error : undefined
      const auditRecorded = await this.repository.transaction((tx) => tx.insertAudit({
        auditEventId: newId('audit'), actorKind: actor.kind, ...actorAuditIdentity(actor), action: operation,
        outcome: 'rejected', metadata: safeAuditMetadata({ idempotencyKeyDigest: stableDigest(idempotencyKey),
          errorCode: serviceError?.code ?? 'internal_error' }), createdAt: this.timestamp()
      })).then(() => true).catch(() => false)
      if (serviceError && auditRecorded) serviceError.auditRecorded = true
      throw error
    }
    for (const notification of notifications) {
      await this.notifier?.notifyInboxAvailable(notification.recipient, notification.sequence)
    }
    return response
  }

  private timestamp(): string { return this.now().toISOString() }
}

function actorAuditIdentity(actor: AuthContext): Pick<StoredAuditEvent, 'actorUserId' | 'actorEndpointId' | 'actorAgentId'> {
  switch (actor.kind) {
    case 'system': return {}
    case 'user': return { actorUserId: actor.userId }
    case 'human_endpoint': return { actorUserId: actor.userId, actorEndpointId: actor.humanEndpointId }
    case 'agent_device': return { actorUserId: actor.userId, actorAgentId: actor.agentId }
  }
}

function idempotencyBusinessPayload(request: unknown): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request
  const record = request as Record<string, unknown>
  if (record.protocolVersion !== '1.0' || typeof record.requestId !== 'string' ||
      typeof record.type !== 'string') {
    return request
  }
  const businessPayload = { ...record }
  delete businessPayload.protocolVersion
  delete businessPayload.requestId
  delete businessPayload.type
  return businessPayload
}

function entityResponse<T>(type: string, entity: T): Record<string, unknown> {
  return { protocolVersion: '1.0', type, entity }
}

function operationReceiptId(actorKey: string, idempotencyKey: string): string {
  return `rcp_${stableDigest({ actorKey, idempotencyKey }).slice(0, 24)}`
}

function responseEntity<T>(response: Record<string, unknown>): T {
  return response.entity as T
}

function required<T>(value: T | null, label: string): T {
  if (value === null) fail('not_found', `${label} was not found.`)
  return value
}

function expectRevision(current: number, expected: number): void {
  if (current !== expected) fail('revision_conflict', 'The resource revision is stale.', { details: { currentRevision: current } })
}

function completeParticipant(participant: StoredParticipant): StoredParticipant {
  return { ...participant, status: participant.primaryHumanEndpointId && participant.primaryAgentId ? 'complete' : 'incomplete' }
}

function contractTaskStatus(status: TaskStatus):
  'offered' | 'accepted' | 'rejected' | 'running' | 'needs_human' | 'succeeded' | 'failed' | 'cancelled' {
  if (status === 'in_progress') return 'running'
  if (status === 'completed') return 'succeeded'
  return status
}

async function lockProviderLocator(tx: CollaborationTransaction, locator: ProviderLocatorValue): Promise<void> {
  await tx.lockIdempotency('provider-locator', stableDigest({
    provider: locator.provider,
    realmId: locator.realmId,
    containerId: locator.containerId,
    topicId: locator.topicId
  }))
}

async function lockProviderLocators(tx: CollaborationTransaction, locators: ProviderLocatorValue[]): Promise<void> {
  const unique = [...new Map(locators.map((locator) => [stableDigest(locator), locator])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
  for (const [, locator] of unique) await lockProviderLocator(tx, locator)
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('validation_failed', `${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function assertText(value: string, label: string, minimum: number, maximum: number): void {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum) {
    fail('validation_failed', `${label} must contain between ${minimum} and ${maximum} characters.`)
  }
}

function uniqueTexts(values: string[], maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) fail('validation_failed', `At most ${maximumItems} values are allowed.`)
  const output = [...new Set(values)]
  for (const value of output) assertText(value, 'list item', 1, maximumLength)
  return output
}

function normalizeTaskCriteria(
  values: Array<string | { criterionId: string; text: string }>
): Array<{ criterionId?: string; text: string }> {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    fail('validation_failed', 'A Task requires between 1 and 100 acceptance criteria.')
  }
  const output = values.map((value) => {
    if (typeof value === 'string') {
      assertText(value, 'completion criterion', 1, 2_000)
      return { text: value.trim() }
    }
    if (!value || typeof value !== 'object' ||
        typeof value.criterionId !== 'string' || !/^cri_[A-Za-z0-9]{12,64}$/u.test(value.criterionId)) {
      fail('validation_failed', 'Structured acceptance criteria require a valid criterionId.')
    }
    assertText(value.text, 'completion criterion', 1, 2_000)
    return { criterionId: value.criterionId, text: value.text.trim() }
  })
  const explicitIds = output.flatMap((criterion) => criterion.criterionId ? [criterion.criterionId] : [])
  if (new Set(explicitIds).size !== explicitIds.length) {
    fail('validation_failed', 'Task acceptance criterion IDs must be unique.')
  }
  return output
}

function emptyWorkerRequirement(): StoredWorkerRequirement {
  return { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] }
}

function normalizeAuthorizationRequirements(
  values: StoredAuthorizationRequirement[]
): StoredAuthorizationRequirement[] {
  if (!Array.isArray(values) || values.length > 100) {
    fail('validation_failed', 'At most 100 authorization requirements are allowed.')
  }
  const output = values.map((requirement) => {
    if (!/^auth_[A-Za-z0-9]{12,64}$/u.test(requirement.id) ||
        !['resource_access', 'data_egress', 'file_upload', 'local_action'].includes(requirement.kind)) {
      fail('validation_failed', 'Authorization requirements require stable IDs and supported kinds.')
    }
    if (requirement.targetRefId !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(requirement.targetRefId)) {
      fail('validation_failed', 'Authorization target references must be bounded opaque IDs.')
    }
    assertText(requirement.description, 'authorization requirement description', 1, 500)
    validateProjectSummary(requirement.description)
    return { ...requirement, description: requirement.description.trim() }
  })
  if (new Set(output.map((requirement) => requirement.id)).size !== output.length) {
    fail('validation_failed', 'Authorization requirement IDs must be unique.')
  }
  return output
}

function assertCapabilityRequirements(
  profile: StoredAgentCapabilityProfile,
  requirements: StoredWorkerRequirement
): void {
  if (requirements.osFamilies && !requirements.osFamilies.includes(profile.osFamily)) {
    fail('permission_denied', 'The assignee capability profile does not satisfy the Task OS requirement.')
  }
  const evidenceRanks = { detected: 0, configured: 1, verified: 2 } as const
  const minimumEvidence = requirements.minimumEvidenceLevel
  const capabilities = new Map(profile.capabilities.map((capability) => [capability.capabilityId, capability]))
  for (const capabilityId of requirements.capabilityIds) {
    const capability = capabilities.get(capabilityId)
    if (!capability || (minimumEvidence !== undefined &&
        evidenceRanks[capability.evidence.level] < evidenceRanks[minimumEvidence])) {
      fail('permission_denied', 'The assignee capability profile does not satisfy the Task capability requirement.')
    }
  }
  if (requirements.minGpuMemoryGB !== undefined &&
      !profile.gpu.some((gpu) => gpu.memoryGB !== undefined && gpu.memoryGB >= requirements.minGpuMemoryGB!)) {
    fail('permission_denied', 'The assignee capability profile does not satisfy the Task GPU requirement.')
  }
  for (const vpnAccessId of requirements.vpnAccessIds) {
    if (!profile.vpnAccessIds.includes(vpnAccessId)) {
      fail('permission_denied', 'The assignee capability profile does not satisfy the Task VPN requirement.')
    }
  }
  for (const slurmClusterId of requirements.slurmClusterIds) {
    if (!profile.slurmClusterIds.includes(slurmClusterId)) {
      fail('permission_denied', 'The assignee capability profile does not satisfy the Task Slurm requirement.')
    }
  }
  for (const resourceRefId of requirements.requiredResourceRefIds) {
    if (!profile.accessibleResourceRefIds.includes(resourceRefId)) {
      fail('permission_denied', 'The assignee capability profile cannot access a required ResourceRef.')
    }
  }
  if (requirements.requireLogSummary === true && !profile.resultReturnPolicy.logSummary) {
    fail('permission_denied', 'The assignee capability profile cannot return the required log summary.')
  }
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function clearTaskAttemptOutputs(task: StoredTask): StoredTask {
  const cleared = { ...task }
  delete cleared.progress
  delete cleared.resultSummary
  delete cleared.resultRecordId
  delete cleared.safeFailureCode
  delete cleared.safeFailureSummary
  return cleared
}

function inboxMessageProjectId(message: StoredInboxMessage): string | undefined {
  if (typeof message.payload.projectId === 'string') return message.payload.projectId
  const answer = message.payload.answer
  if (answer && typeof answer === 'object' && !Array.isArray(answer) &&
      typeof (answer as Record<string, unknown>).projectId === 'string') {
    return (answer as Record<string, unknown>).projectId as string
  }
  return undefined
}

function taskCriterionId(taskId: string, index: number): string {
  return `cri_${stableDigest({ taskId, index }).slice(0, 24)}`
}

async function affectedAgentProjectIds(
  tx: CollaborationTransaction,
  agentId: string
): Promise<string[]> {
  const projectIds = new Set(
    (await tx.listActiveProjectsForCoordinator(agentId)).map((project) => project.projectId)
  )
  for (const task of await tx.listOpenTasksForAgent(agentId)) projectIds.add(task.projectId)
  return [...projectIds].sort(compareStable)
}

async function assertNoActiveOwnedAgents(
  tx: CollaborationTransaction,
  userId: string
): Promise<void> {
  if ((await tx.listAgentsForUser(userId)).some((agent) => agent.status === 'active')) {
    fail('invalid_state_transition', 'Active Agents must be revoked or transferred before the User can become inactive.')
  }
}

async function activeCoordinatorProjectIds(
  tx: CollaborationTransaction,
  agentId: string
): Promise<string[]> {
  return (await tx.listActiveProjectsForCoordinator(agentId))
    .map((project) => project.projectId)
    .sort(compareStable)
}

async function lockProjectsForUpdate(
  tx: CollaborationTransaction,
  projectIds: string[]
): Promise<Map<string, StoredProject>> {
  const locked = new Map<string, StoredProject>()
  for (const projectId of [...new Set(projectIds)].sort(compareStable)) {
    locked.set(projectId, required(await tx.getProjectForUpdate(projectId), 'Project'))
  }
  return locked
}

function assertProjectLocksCover(
  lockedProjects: ReadonlyMap<string, StoredProject>,
  projectIds: string[]
): void {
  if (projectIds.some((projectId) => !lockedProjects.has(projectId))) {
    fail('revision_conflict', 'Agent Project assignments changed while acquiring write locks.', { retryable: true })
  }
}

async function lockAgentsForUpdate(
  tx: CollaborationTransaction,
  agentIds: string[]
): Promise<Map<string, StoredAgent>> {
  const locked = new Map<string, StoredAgent>()
  for (const agentId of [...new Set(agentIds)].sort(compareStable)) {
    locked.set(agentId, required(await tx.getAgentForUpdate(agentId), 'Agent'))
  }
  return locked
}

async function assertCurrentAgentProjectMembership(
  tx: CollaborationTransaction,
  actor: AgentActor,
  project: Pick<StoredProject, 'projectId'>,
  agent: StoredAgent
): Promise<void> {
  assertCurrentAgentActor(actor, agent)
  const membership = await tx.getProjectMember(project.projectId, agent.ownerUserId)
  if (!membership?.active || membership.role === 'observer') {
    fail('permission_denied', 'The authenticated Agent owner is not an executable Project member.')
  }
}

function assertCurrentAgentActor(actor: AgentActor, agent: StoredAgent): void {
  if (agent.agentId !== actor.agentId || agent.status !== 'active' || agent.ownerUserId !== actor.userId) {
    fail('credential_revoked', 'The authenticated Agent ownership is no longer current.')
  }
}

async function assertCurrentTaskActorMembership(
  tx: CollaborationTransaction,
  actor: AgentActor,
  project: Pick<StoredProject, 'projectId'>,
  task: StoredTask,
  executionId: string,
  agent: StoredAgent
): Promise<void> {
  assertCurrentTaskExecution(actor, task, executionId)
  await assertCurrentAgentProjectMembership(tx, actor, project, agent)
  if (task.assigneeUserId !== agent.ownerUserId) {
    fail('assignee_mismatch', 'The authenticated Agent owner is no longer the current Task assignee.')
  }
}

function assertCurrentTaskExecution(actor: AgentActor, task: StoredTask, executionId: string): void {
  if (actor.agentId !== task.assigneeAgentId) {
    fail('assignee_mismatch', 'The authenticated Agent is not the current Task assignee.')
  }
  if (executionId !== task.executionId) {
    fail('execution_conflict', 'The Task execution is no longer current.', {
      details: { currentRevision: task.revision, currentExecutionId: task.executionId }
    })
  }
}

async function consumeActionConfirmation(
  tx: CollaborationTransaction,
  actor: AgentActor,
  confirmationId: string | undefined,
  expectedAction: StoredConfirmableAction,
  project: Pick<StoredProject, 'projectId' | 'ownerUserId'>,
  operation: string,
  at: string
): Promise<void> {
  if (!confirmationId) fail('confirmation_required', 'This delegated action requires a Project owner confirmation.')
  const confirmation = required(await tx.getActionConfirmationForUpdate(confirmationId), 'Action confirmation')
  if (confirmation.status !== 'approved' || confirmation.expiresAt <= at) {
    fail('confirmation_mismatch', 'The action confirmation is expired, consumed, or superseded.')
  }
  if (expectedAction.projectId !== project.projectId ||
      confirmation.projectId !== project.projectId ||
      confirmation.targetUserId !== project.ownerUserId ||
      confirmation.action.projectId !== confirmation.projectId ||
      confirmation.coordinatorAgentId !== actor.agentId ||
      confirmation.actionDigest !== stableDigest(expectedAction)) {
    fail('confirmation_mismatch', 'The action confirmation does not match this actor or immutable action.')
  }
  await tx.updateActionConfirmation({ ...confirmation, status: 'consumed', consumedAt: at,
    consumedByActorKey: actor.actorKey, consumedOperation: operation, updatedAt: at })
}

async function supersedeApprovedActionConfirmations(
  tx: CollaborationTransaction,
  projectId: string,
  at: string,
  conflicts: (confirmation: StoredActionConfirmation) => boolean
): Promise<void> {
  const confirmations = await tx.listApprovedActionConfirmationsForProjectForUpdate(projectId)
  for (const confirmation of confirmations) {
    if (!conflicts(confirmation)) continue
    await tx.updateActionConfirmation({ ...confirmation, status: 'superseded', updatedAt: at })
  }
}

async function invalidateApprovedGovernedActions(
  tx: CollaborationTransaction,
  projectId: string,
  at: string,
  conflicts: (action: StoredConfirmableAction) => boolean
): Promise<void> {
  for (const request of await tx.listHumanRequestsForProject(projectId)) {
    if (request.status !== 'pending' || !request.confirmableAction || !conflicts(request.confirmableAction)) continue
    await tx.updateHumanRequest({ ...request, status: request.expiresAt <= at ? 'expired' : 'cancelled',
      revision: request.revision + 1, updatedAt: at }, request.revision)
  }
  await supersedeApprovedActionConfirmations(tx, projectId, at,
    (confirmation) => conflicts(confirmation.action))
}

function normalizeBudgets(input: Partial<ProjectBudgets> | undefined): ProjectBudgets {
  return {
    maxTasks: integer(input?.maxTasks ?? DEFAULT_BUDGETS.maxTasks, 'maxTasks', 1, 10_000),
    maxTasksPerRound: integer(input?.maxTasksPerRound ?? DEFAULT_BUDGETS.maxTasksPerRound, 'maxTasksPerRound', 1, 1_000),
    maxTaskRetries: integer(input?.maxTaskRetries ?? DEFAULT_BUDGETS.maxTaskRetries, 'maxTaskRetries', 0, 100),
    maxCoordinationRounds: integer(input?.maxCoordinationRounds ?? DEFAULT_BUDGETS.maxCoordinationRounds, 'maxCoordinationRounds', 1, 1_000)
  }
}

function validateProjectSummary(summary: string): void {
  assertText(summary, 'summary', 1, 50_000)
  const forbidden = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:api[_ -]?key|password|bearer token)\s*[:=]/i,
    /(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/,
    /\b(?:full transcript|complete tool log)\b/i
  ]
  if (forbidden.some((pattern) => pattern.test(summary))) {
    fail('validation_failed', 'Project records accept bounded shared summaries only; credentials, local paths, transcripts, and tool logs are forbidden.')
  }
}

const RESOURCE_ACTIVE_TASK_STATUSES = new Set<TaskStatus>(['accepted', 'in_progress', 'needs_human'])

async function authorizeResourceCreate(
  tx: CollaborationTransaction,
  actor: UserActor | AgentActor,
  project: StoredProject,
  task: StoredTask | undefined,
  executionId: string | undefined
): Promise<void> {
  const member = await tx.getProjectMember(project.projectId, actor.userId)
  authorize({ actor, operation: 'record_submit', projectMember: Boolean(member?.active) })
  if (project.status !== 'active') {
    fail('invalid_state_transition', 'ResourceRefs may only be created for an active Project.')
  }
  if (task) {
    if (task.projectId !== project.projectId) {
      fail('validation_failed', 'The ResourceRef Task belongs to another Project.')
    }
    if (executionId !== task.executionId) {
      fail('execution_conflict', 'The ResourceRef Task execution is no longer current.', {
        details: { currentRevision: task.revision, currentExecutionId: task.executionId }
      })
    }
    if (
      actor.kind === 'agent_device' &&
      actor.agentId !== task.assigneeAgentId &&
      actor.agentId !== project.coordinatorAgentId
    ) {
      fail('assignee_mismatch', 'The authenticated Agent is not the current Task assignee or Coordinator.')
    }
    if (!RESOURCE_ACTIVE_TASK_STATUSES.has(task.status)) {
      fail('invalid_state_transition', 'Task-scoped ResourceRefs require an active Task execution.')
    }
  } else if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
    fail('permission_denied', 'Worker ResourceRefs require explicit Task provenance.')
  }
}

async function authorizeResourceInvalidation(
  tx: CollaborationTransaction,
  actor: UserActor | AgentActor,
  project: StoredProject,
  task: StoredTask | undefined
): Promise<void> {
  const member = await tx.getProjectMember(project.projectId, actor.userId)
  authorize({ actor, operation: 'record_submit', projectMember: Boolean(member?.active) })
  if (project.status !== 'active') {
    fail('invalid_state_transition', 'ResourceRefs may only be invalidated for an active Project.')
  }
  if (!task) {
    if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
      fail('permission_denied', 'Only the Coordinator Agent may manage Project-level ResourceRefs.')
    }
    return
  }
  if (task.projectId !== project.projectId) {
    fail('validation_failed', 'The ResourceRef Task belongs to another Project.')
  }
  if (actor.kind !== 'agent_device' || actor.agentId === project.coordinatorAgentId) return
  if (actor.agentId !== task.assigneeAgentId) {
    fail('assignee_mismatch', 'The authenticated Agent is not the current Task assignee or Coordinator.')
  }
  if (!RESOURCE_ACTIVE_TASK_STATUSES.has(task.status)) {
    fail('invalid_state_transition', 'A Worker may only invalidate ResourceRefs for its active Task execution.')
  }
}

function toHumanNeededEntity(request: StoredHumanRequest): Record<string, unknown> {
  return { schemaVersion: 1, type: 'human_needed', humanRequestId: request.humanRequestId,
    projectId: request.projectId, sourceKind: request.sourceKind,
    taskId: request.taskId ?? null,
    executionId: request.executionId ?? null,
    sourceInboxMessageId: request.sourceInboxMessageId ?? null,
    targetUserId: request.targetUserId,
    requestedByAgentId: request.requestedByAgentId, requiredAssurance: request.requiredAssurance,
    prompt: request.prompt, confirmableAction: request.confirmableAction ?? null,
    status: request.status, expiresAt: request.expiresAt,
    revision: request.revision, createdAt: request.createdAt, updatedAt: request.updatedAt }
}

function humanNeededProviderText(request: StoredHumanRequest): string {
  const replyInstruction = `\n\n回复命令：sciforge-answer ${request.humanRequestId} ${request.revision} <answer>`
  return `${request.prompt.slice(0, Math.max(0, 32_000 - replyInstruction.length))}${replyInstruction}`
}

function toHumanAnswerEntity(answer: StoredHumanAnswer): Record<string, unknown> {
  return { schemaVersion: 1, type: 'human_answer', humanAnswerId: answer.humanAnswerId,
    humanRequestId: answer.humanRequestId, projectId: answer.projectId,
    taskId: answer.taskId ?? null,
    executionId: answer.executionId ?? null,
    requestRevision: answer.requestRevision, answeredByUserId: answer.answeredByUserId,
    answeredFromHumanEndpointId: answer.answeredFromHumanEndpointId, assurance: answer.assurance,
    answer: answer.answer, decision: answer.decision ?? null,
    confirmationId: answer.confirmationId ?? null,
    answeredAt: answer.answeredAt, revision: answer.revision,
    createdAt: answer.createdAt, updatedAt: answer.updatedAt }
}
