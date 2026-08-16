import { describe, expect, it } from 'vitest'

import { FakeCollaborationRepository, FakeInboxNotifier } from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import { AuthenticationService, type HumanEndpointActor, type UserActor } from './auth.js'
import { toInboxMessage, toProjectCapabilityDirectory, toTask } from './contracts.js'
import { CollaborationService } from './service.js'

const at = new Date('2026-08-15T02:00:00.000Z')
const now = () => at

async function onboard(
  service: CollaborationService,
  authentication: AuthenticationService,
  label: string,
  providerUserId: string
) {
  const begun = await service.beginPairing({ provider: 'zulip', realmId: 'realm-hk', requestedDisplayName: label,
    idempotencyKey: `idem_pairing_begin_${label}` })
  await service.verifyPairingFromProvider({ provider: 'zulip', realmId: 'realm-hk', providerUserId,
    providerDisplayName: `${label} Remote`, challengeCode: String(begun.challengeCode),
    providerEventId: `provider-event-${label}-verify`, assurance: 'verified' })
  const redeemed = await service.redeemPairing({ pollSecret: String(begun.pollSecret),
    idempotencyKey: `idem_pairing_redeem_${label}` })
  const user = await authentication.resolveBearer(String(redeemed.userCredential))
  if (user.kind !== 'user') throw new Error('Expected user actor')
  const endpoint = await authentication.resolveProviderIdentity('zulip', 'realm-hk', providerUserId)
  return { user, endpoint, userId: String(redeemed.userId), endpointId: String(redeemed.humanEndpointId) }
}

async function registerAgent(service: CollaborationService, user: UserActor, label: string) {
  const result = await service.registerAgent(user, { installationId: `ins_${label.padEnd(12, '0')}`,
    displayName: `${label} desktop`, nodeType: 'desktop', capabilities: ['research.execute'],
    idempotencyKey: `idem_agent_register_${label}` })
  if (!result.deviceCredential) throw new Error('Expected one-time device credential')
  return result
}

describe('CollaborationService canonical transactions', () => {
  it('pairs a provider identity exactly once without persisting plaintext secrets', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const identity = await onboard(service, authentication, 'alice', 'provider-alice')

    expect(identity.userId).toMatch(/^usr_/)
    expect(identity.endpointId).toMatch(/^hep_/)
    const serialized = JSON.stringify(repository.state)
    expect(serialized).not.toContain('pairing_poll.')
    expect(serialized).not.toContain('user.')
    const endpoint = await repository.getEndpoint(identity.endpointId)
    expect(endpoint).toMatchObject({ userId: identity.userId, providerUserId: 'provider-alice', status: 'active' })
    const additional = await service.beginPairing({ provider: 'zulip', realmId: 'realm-hk',
      requestedDisplayName: 'alice', requestedBy: identity.user, expectedProviderUserId: 'provider-alice-secondary',
      idempotencyKey: 'idem_pairing_expected_identity' })
    await expect(service.verifyPairingFromProvider({ provider: 'zulip', realmId: 'realm-hk',
      providerUserId: 'provider-attacker', providerDisplayName: 'Attacker', challengeId: String(additional.challengeId),
      challengeCode: String(additional.challengeCode), providerEventId: 'provider-event-wrong-identity',
      assurance: 'verified' })).rejects.toMatchObject({ code: 'identity_conflict' })
    await expect(service.redeemPairing({ pollSecret: 'pairing_poll.invalid-but-long-enough-to-check',
      idempotencyKey: 'idem_invalid_pairing_poll' })).rejects.toMatchObject({ code: 'authentication_required' })
  })

  it('does not cache a pending pairing redeem and redacts the terminal replay for the same key', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const begun = await service.beginPairing({ provider: 'zulip', realmId: 'realm-hk',
      requestedDisplayName: 'Pending pairing user', idempotencyKey: 'idem_pairing_pending_begin_01' })
    const receiptsAfterBegin = repository.state.receipts.size
    const redeemInput = { pollSecret: String(begun.pollSecret), idempotencyKey: 'idem_pairing_pending_redeem_01' }

    const pending = await service.redeemPairing(redeemInput)
    expect(pending).toMatchObject({ type: 'pairing.pending', challengeId: begun.challengeId })
    expect(repository.state.receipts.size).toBe(receiptsAfterBegin)
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'pairing.redeem', outcome: 'accepted' }))

    await service.verifyPairingFromProvider({ provider: 'zulip', realmId: 'realm-hk',
      providerUserId: 'provider-pending-user', providerDisplayName: 'Pending Remote User',
      challengeId: String(begun.challengeId), challengeCode: String(begun.challengeCode),
      providerEventId: 'provider-event-pending-verify', assurance: 'verified' })
    expect(repository.state.challenges.get(String(begun.challengeId))?.consumedAt).toBeUndefined()

    const redeemed = await service.redeemPairing(redeemInput)
    expect(redeemed).toMatchObject({ type: 'pairing.redeemed' })
    expect(typeof redeemed.userCredential).toBe('string')
    expect(repository.state.challenges.get(String(begun.challengeId))?.consumedAt).toBe(at.toISOString())
    const credentialCount = repository.state.credentials.size
    const terminalReceiptCount = repository.state.receipts.size

    const replayed = await service.redeemPairing(redeemInput)
    expect(replayed).toMatchObject({ type: 'pairing.redeemed', replayed: true })
    expect(replayed).not.toHaveProperty('userCredential')
    expect(repository.state.credentials.size).toBe(credentialCount)
    expect(repository.state.receipts.size).toBe(terminalReceiptCount)
  })

  it('keeps Project task writes star-shaped, idempotent, ordered, and restart-recoverable', async () => {
    const repository = new FakeCollaborationRepository()
    const notifier = new FakeInboxNotifier()
    const service = new CollaborationService({ repository, notifier, now })
    const authentication = new AuthenticationService(repository, now)
    const alice = await onboard(service, authentication, 'alice', 'provider-alice')
    const bob = await onboard(service, authentication, 'bob', 'provider-bob')
    const aliceAgent = await registerAgent(service, alice.user, 'aliceagent01')
    const bobAgent = await registerAgent(service, bob.user, 'bobagent0001')
    const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
    const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
    if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')

    const project = await service.createProject(alice.user, { displayName: '共同研究', goal: '验证协作内核',
      memberUserIds: [alice.userId, bob.userId], coordinatorAgentId: aliceAgent.agent.agentId,
      budgets: { maxTasks: 4, maxTasksPerRound: 2, maxTaskRetries: 1, maxCoordinationRounds: 2 },
      idempotencyKey: 'idem_project_create_shared' })
    const task = await service.createTask(aliceDevice, { projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId, title: '分析数据', objective: '返回有界结果摘要',
      completionCriteria: ['结果可复核'], dependencyTaskIds: [], expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_task_create_bob_01' })
    const repeated = await service.createTask(aliceDevice, { projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId, title: '分析数据', objective: '返回有界结果摘要',
      completionCriteria: ['结果可复核'], dependencyTaskIds: [], expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_task_create_bob_01' })
    expect(repeated.taskId).toBe(task.taskId)
    expect((await repository.pullInbox({ kind: 'agent', id: bobAgent.agent.agentId }, 0, 20, at.toISOString())))
      .toHaveLength(1)
    await expect(service.transitionTask(aliceDevice, { taskId: task.taskId, status: 'accepted',
      expectedRevision: 1, idempotencyKey: 'idem_wrong_agent_accept' })).rejects.toMatchObject({ code: 'permission_denied' })

    const restarted = new CollaborationService({ repository, notifier, now })
    const accepted = await restarted.transitionTask(bobDevice, { taskId: task.taskId, status: 'accepted',
      expectedRevision: 1, idempotencyKey: 'idem_bob_accept_task_01' })
    const running = await restarted.transitionTask(bobDevice, { taskId: task.taskId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_bob_run_task_01' })
    const completed = await restarted.transitionTask(bobDevice, { taskId: task.taskId, status: 'completed',
      expectedRevision: running.revision, resultSummary: '分析完成，结果可复核。',
      idempotencyKey: 'idem_bob_complete_task_01' })
    expect(completed.status).toBe('completed')
    const coordinatorInbox = await restarted.pullInbox(aliceDevice, { afterSequence: 0, limit: 20 })
    expect(() => coordinatorInbox.messages.map(toInboxMessage)).not.toThrow()
    expect(coordinatorInbox.messages.map((message) => message.sequence)).toEqual(
      coordinatorInbox.messages.map((_, index) => index + 1)
    )
  })

  it('stores only governed ResourceRef metadata with idempotent invalidation', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const alice = await onboard(service, authentication, 'resourcealice', 'provider-resource-alice')
    const bob = await onboard(service, authentication, 'resourcebob', 'provider-resource-bob')
    const outsider = await onboard(service, authentication, 'resourceoutsider', 'provider-resource-outsider')
    const aliceAgent = await registerAgent(service, alice.user, 'resourceali1')
    const bobAgent = await registerAgent(service, bob.user, 'resourcebob1')
    const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
    const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
    if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')

    const project = await service.createProject(alice.user, {
      displayName: 'Resource references',
      goal: 'Share references without copying content.',
      memberUserIds: [alice.userId, bob.userId],
      coordinatorAgentId: aliceAgent.agent.agentId,
      idempotencyKey: 'idem_resource_project_create_01'
    })
    const task = await service.createTask(aliceDevice, {
      projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId,
      title: 'Publish reference',
      objective: 'Return one metadata-only reference.',
      completionCriteria: ['HTTPS reference is available'],
      dependencyTaskIds: [],
      expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_resource_task_create_01'
    })
    await expect(service.createResourceRef(bobDevice, {
      projectId: project.projectId,
      taskId: task.taskId,
      expectedTaskRevision: task.revision,
      provider: 'example-content',
      externalId: 'offered-document',
      kind: 'shared_document',
      name: 'Offered Task reference',
      openUrl: 'https://content.example.invalid/resources/offered-document',
      idempotencyKey: 'idem_resource_offered_task_rejected_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    const accepted = await service.transitionTask(bobDevice, {
      taskId: task.taskId,
      status: 'accepted',
      expectedRevision: task.revision,
      idempotencyKey: 'idem_resource_task_accept_01'
    })
    const input = {
      projectId: project.projectId,
      taskId: task.taskId,
      expectedTaskRevision: accepted.revision,
      provider: 'example-content',
      externalId: 'document-42',
      kind: 'shared_document',
      name: 'Model analysis record',
      openUrl: 'https://content.example.invalid/resources/document-42',
      version: '1',
      idempotencyKey: 'idem_resource_create_01'
    }
    const resource = await service.createResourceRef(bobDevice, input)
    const replay = await service.createResourceRef(bobDevice, input)
    expect(replay.resourceRefId).toBe(resource.resourceRefId)
    expect(repository.state.resourceRefs.size).toBe(1)
    expect(resource).toMatchObject({
      taskRevision: accepted.revision,
      createdByUserId: bob.userId,
      createdByAgentId: bobAgent.agent.agentId
    })
    await expect(service.createResourceRef(bobDevice, {
      ...input,
      expectedTaskRevision: task.revision,
      externalId: 'stale-task-revision-document',
      idempotencyKey: 'idem_resource_stale_task_revision_01'
    })).rejects.toMatchObject({ code: 'revision_conflict' })
    const repeatedExternalReference = await service.createResourceRef(bobDevice, {
      ...input,
      idempotencyKey: 'idem_resource_same_external_reference_02'
    })
    expect(repeatedExternalReference.resourceRefId).not.toBe(resource.resourceRefId)
    expect(repository.state.resourceRefs.size).toBe(2)
    await expect(service.getResourceRef(outsider.user, resource.resourceRefId))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.createResourceRef(bobDevice, {
      ...input,
      taskId: undefined,
      expectedTaskRevision: undefined,
      externalId: 'document-without-task',
      idempotencyKey: 'idem_resource_worker_without_task_01'
    })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.createResourceRef(alice.user, {
      ...input,
      externalId: '/Users/alice/private-document',
      openUrl: 'file:///Users/alice/private-document',
      idempotencyKey: 'idem_resource_local_path_rejected_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })

    const invalidation = {
      resourceRefId: resource.resourceRefId,
      expectedRevision: resource.revision,
      idempotencyKey: 'idem_resource_invalidate_01'
    }
    const invalidated = await service.invalidateResourceRef(bobDevice, invalidation)
    expect(invalidated).toMatchObject({ status: 'invalidated', revision: 2, invalidatedAt: at.toISOString() })
    expect((await service.invalidateResourceRef(bobDevice, invalidation)).revision).toBe(2)
    await expect(service.invalidateResourceRef(bobDevice, {
      ...invalidation,
      idempotencyKey: 'idem_resource_invalidate_stale_01'
    })).rejects.toMatchObject({ code: 'revision_conflict' })
    const running = await service.transitionTask(bobDevice, {
      taskId: task.taskId,
      status: 'in_progress',
      expectedRevision: accepted.revision,
      idempotencyKey: 'idem_resource_task_running_01'
    })
    await service.transitionTask(bobDevice, {
      taskId: task.taskId,
      status: 'completed',
      expectedRevision: running.revision,
      resultSummary: 'Resource references published.',
      idempotencyKey: 'idem_resource_task_completed_01'
    })
    await expect(service.invalidateResourceRef(bobDevice, {
      resourceRefId: repeatedExternalReference.resourceRefId,
      expectedRevision: repeatedExternalReference.revision,
      idempotencyKey: 'idem_resource_terminal_worker_rejected_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.invalidateResourceRef(aliceDevice, {
      resourceRefId: repeatedExternalReference.resourceRefId,
      expectedRevision: repeatedExternalReference.revision,
      idempotencyKey: 'idem_resource_terminal_coordinator_01'
    })).resolves.toMatchObject({ status: 'invalidated', revision: 2 })

    const projectBeforeReassignment = repository.state.projects.get(project.projectId)
    if (!projectBeforeReassignment) throw new Error('Expected Project before reassignment')
    const reassignedTask = await service.createTask(aliceDevice, {
      projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId,
      title: 'Reassign a resource-producing Task',
      objective: 'Verify old Worker authorization is revoked atomically.',
      completionCriteria: ['Old Worker writes are rejected'],
      dependencyTaskIds: [],
      expectedProjectRevision: projectBeforeReassignment.revision,
      idempotencyKey: 'idem_resource_reassigned_task_create_01'
    })
    const reassignedAccepted = await service.transitionTask(bobDevice, {
      taskId: reassignedTask.taskId, status: 'accepted', expectedRevision: reassignedTask.revision,
      idempotencyKey: 'idem_resource_reassigned_task_accept_01'
    })
    const reassignedRunning = await service.transitionTask(bobDevice, {
      taskId: reassignedTask.taskId, status: 'in_progress', expectedRevision: reassignedAccepted.revision,
      idempotencyKey: 'idem_resource_reassigned_task_running_01'
    })
    const preReassignmentResource = await service.createResourceRef(bobDevice, {
      projectId: project.projectId,
      taskId: reassignedTask.taskId,
      expectedTaskRevision: reassignedRunning.revision,
      provider: 'example-content',
      externalId: 'pre-reassignment-document',
      kind: 'shared_document',
      name: 'Pre-reassignment reference',
      openUrl: 'https://content.example.invalid/resources/pre-reassignment-document',
      idempotencyKey: 'idem_resource_pre_reassignment_create_01'
    })
    const failedTask = await service.transitionTask(bobDevice, {
      taskId: reassignedTask.taskId, status: 'failed', expectedRevision: reassignedRunning.revision,
      safeFailureCode: 'worker_failed', idempotencyKey: 'idem_resource_reassigned_task_fail_01'
    })
    const replacement = await service.retryOrReassignTask(aliceDevice, {
      taskId: reassignedTask.taskId,
      assigneeAgentId: aliceAgent.agent.agentId,
      expectedRevision: failedTask.revision,
      idempotencyKey: 'idem_resource_task_reassign_01'
    })
    await expect(service.invalidateResourceRef(bobDevice, {
      resourceRefId: preReassignmentResource.resourceRefId,
      expectedRevision: preReassignmentResource.revision,
      idempotencyKey: 'idem_resource_old_worker_invalidate_01'
    })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.createResourceRef(bobDevice, {
      projectId: project.projectId,
      taskId: replacement.taskId,
      expectedTaskRevision: replacement.revision,
      provider: 'example-content',
      externalId: 'old-worker-document',
      kind: 'shared_document',
      name: 'Old Worker reference',
      openUrl: 'https://content.example.invalid/resources/old-worker-document',
      idempotencyKey: 'idem_resource_old_worker_create_01'
    })).rejects.toMatchObject({ code: 'permission_denied' })

    const userResource = await service.createResourceRef(alice.user, {
      projectId: project.projectId,
      provider: 'example-content',
      externalId: 'project-level-user-document',
      kind: 'shared_document',
      name: 'Project-level user reference',
      openUrl: 'https://content.example.invalid/resources/project-level-user-document',
      idempotencyKey: 'idem_resource_user_project_level_01'
    })
    expect(userResource).toMatchObject({ createdByUserId: alice.userId })
    expect(userResource).not.toHaveProperty('taskId')
    expect(userResource).not.toHaveProperty('taskRevision')
    expect(userResource).not.toHaveProperty('createdByAgentId')

    const currentProject = repository.state.projects.get(project.projectId)
    if (!currentProject) throw new Error('Expected Project')
    await service.transitionProject(alice.user, {
      projectId: project.projectId,
      status: 'paused',
      expectedRevision: currentProject.revision,
      idempotencyKey: 'idem_resource_project_pause_01'
    })
    await expect(service.createResourceRef(alice.user, {
      projectId: project.projectId,
      provider: 'example-content',
      externalId: 'paused-project-document',
      kind: 'shared_document',
      name: 'Paused Project reference',
      openUrl: 'https://content.example.invalid/resources/paused-project-document',
      idempotencyKey: 'idem_resource_paused_project_rejected_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'resource.create', resourceKind: 'resource_ref', resourceId: resource.resourceRefId,
      outcome: 'accepted'
    }))
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'resource.invalidate', resourceKind: 'resource_ref', resourceId: resource.resourceRefId,
      outcome: 'accepted'
    }))
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'resource.invalidate', outcome: 'rejected',
      metadata: expect.objectContaining({ errorCode: 'revision_conflict' })
    }))
  })

  it('exposes a minimal member capability directory and governs monotonic Task progress per attempt', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const alice = await onboard(service, authentication, 'capalice', 'provider-cap-alice')
    const bob = await onboard(service, authentication, 'capbob', 'provider-cap-bob')
    const outsider = await onboard(service, authentication, 'capoutsider', 'provider-cap-outsider')
    const aliceAgent = await registerAgent(service, alice.user, 'capaliceagt1')
    const bobAgent = await registerAgent(service, bob.user, 'capbobagent1')
    const revokedBobAgent = await registerAgent(service, bob.user, 'capbobagent2')
    const outsiderAgent = await registerAgent(service, outsider.user, 'capoutside01')
    await service.revokeAgent(bob.user, { agentId: revokedBobAgent.agent.agentId,
      expectedRevision: revokedBobAgent.agent.revision, idempotencyKey: 'idem_capability_revoke_bob_agent_01' })
    const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
    const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
    if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')

    const project = await service.createProject(alice.user, {
      displayName: 'Capabilities and progress', goal: 'Verify minimal discovery and Task progress.',
      memberUserIds: [alice.userId, bob.userId], coordinatorAgentId: aliceAgent.agent.agentId,
      budgets: { maxTasks: 4, maxTasksPerRound: 4, maxTaskRetries: 1, maxCoordinationRounds: 2 },
      idempotencyKey: 'idem_capability_progress_project_01'
    })
    const task = await service.createTask(aliceDevice, {
      projectId: project.projectId, assigneeAgentId: bobAgent.agent.agentId,
      title: 'Report progress', objective: 'Report bounded monotonic progress and a result.',
      completionCriteria: ['Progress and result are queryable'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_capability_progress_task_01'
    })

    const directory = toProjectCapabilityDirectory(await service.getProjectCapabilityDirectory(alice.user, project.projectId))
    expect(directory.projectRevision).toBe(project.revision + 1)
    expect(directory.agents.map((agent) => agent.agentId)).toEqual(
      [{ agentId: aliceAgent.agent.agentId, ownerUserId: alice.userId },
        { agentId: bobAgent.agent.agentId, ownerUserId: bob.userId }]
        .sort((left, right) => left.ownerUserId === right.ownerUserId
          ? left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0
          : left.ownerUserId < right.ownerUserId ? -1 : 1)
        .map((agent) => agent.agentId)
    )
    expect(directory.agents.map((agent) => agent.ownerUserId)).toEqual(
      [...directory.agents].map((agent) => agent.ownerUserId).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    )
    const serializedDirectory = JSON.stringify(directory)
    expect(serializedDirectory).not.toContain('installationId')
    expect(serializedDirectory).not.toContain('credentialVersion')
    expect(serializedDirectory).not.toContain(outsiderAgent.agent.agentId)
    expect(serializedDirectory).not.toContain(revokedBobAgent.agent.agentId)
    await expect(service.getProjectCapabilityDirectory(outsider.user, project.projectId))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.getProjectCapabilityDirectory(bobDevice, project.projectId))
      .resolves.toMatchObject({ projectId: project.projectId })

    const accepted = await service.transitionTask(bobDevice, { taskId: task.taskId, status: 'accepted',
      expectedRevision: task.revision, idempotencyKey: 'idem_capability_progress_accept_01' })
    const running = await service.transitionTask(bobDevice, { taskId: task.taskId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_capability_progress_running_01' })
    const coordinatorInboxBefore = (await repository.pullInbox(
      { kind: 'agent', id: aliceAgent.agent.agentId }, 0, 100, at.toISOString())).length
    const ownerInboxBefore = (await repository.pullInbox(
      { kind: 'user', id: alice.userId }, 0, 100, at.toISOString())).length
    const reportInput = { taskId: task.taskId, expectedRevision: running.revision, percent: 25,
      summary: 'Input validation completed.', idempotencyKey: 'idem_capability_progress_report_01' }
    const progressed = await service.reportTaskProgress(bobDevice, reportInput)
    expect((await service.reportTaskProgress(bobDevice, reportInput)).revision).toBe(progressed.revision)
    expect(toTask(progressed)).toMatchObject({ status: 'running',
      progress: { percent: 25, summary: reportInput.summary, reportedAt: at.toISOString() } })
    const coordinatorInboxAfter = await repository.pullInbox(
      { kind: 'agent', id: aliceAgent.agent.agentId }, 0, 100, at.toISOString())
    expect(coordinatorInboxAfter).toHaveLength(coordinatorInboxBefore + 1)
    expect(coordinatorInboxAfter.at(-1)).toMatchObject({ messageType: 'task.updated', payload: {
      type: 'task.updated', taskId: task.taskId, revision: progressed.revision, status: 'running'
    } })
    expect((await repository.pullInbox({ kind: 'user', id: alice.userId }, 0, 100, at.toISOString())).length)
      .toBe(ownerInboxBefore)
    await expect(service.reportTaskProgress(aliceDevice, { ...reportInput,
      expectedRevision: progressed.revision, percent: 30, idempotencyKey: 'idem_capability_progress_wrong_agent_01' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.reportTaskProgress(bobDevice, { ...reportInput,
      percent: 30, idempotencyKey: 'idem_capability_progress_old_revision_01' }))
      .rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(service.reportTaskProgress(bobDevice, { ...reportInput,
      expectedRevision: progressed.revision, percent: 20, idempotencyKey: 'idem_capability_progress_regress_01' }))
      .rejects.toMatchObject({ code: 'invalid_state_transition' })

    const failed = await service.transitionTask(bobDevice, { taskId: task.taskId, status: 'failed',
      expectedRevision: progressed.revision, safeFailureCode: 'input_invalid',
      idempotencyKey: 'idem_capability_progress_failed_01' })
    expect(toTask(failed)).toMatchObject({ status: 'failed', safeFailureCode: 'input_invalid' })
    expect(toTask(failed)).not.toHaveProperty('resultSummary')
    const retried = await service.retryOrReassignTask(aliceDevice, { taskId: task.taskId,
      assigneeAgentId: aliceAgent.agent.agentId, expectedRevision: failed.revision,
      idempotencyKey: 'idem_capability_progress_retry_01' })
    expect(retried).not.toHaveProperty('progress')
    expect(retried).not.toHaveProperty('resultSummary')
    expect(retried).not.toHaveProperty('safeFailureCode')
    await expect(service.reportTaskProgress(bobDevice, { taskId: task.taskId, expectedRevision: retried.revision,
      percent: 30, summary: 'Stale assignee report.', idempotencyKey: 'idem_capability_progress_old_assignee_01' }))
      .rejects.toMatchObject({ code: 'permission_denied' })

    const acceptedRetry = await service.transitionTask(aliceDevice, { taskId: task.taskId, status: 'accepted',
      expectedRevision: retried.revision, idempotencyKey: 'idem_capability_progress_retry_accept_01' })
    const runningRetry = await service.transitionTask(aliceDevice, { taskId: task.taskId, status: 'in_progress',
      expectedRevision: acceptedRetry.revision, idempotencyKey: 'idem_capability_progress_retry_running_01' })
    const completed = await service.transitionTask(aliceDevice, { taskId: task.taskId, status: 'completed',
      expectedRevision: runningRetry.revision, resultSummary: 'The bounded result is reproducible.',
      idempotencyKey: 'idem_capability_progress_complete_01' })
    const queried = toTask(await service.getTask(alice.user, task.taskId))
    expect(queried).toMatchObject({ status: 'succeeded', resultSummary: 'The bounded result is reproducible.' })
    expect(queried).not.toHaveProperty('safeFailureCode')
    expect(completed.revision).toBe(queried.revision)
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'task.progress.report', outcome: 'accepted', resourceKind: 'task', resourceId: task.taskId
    }))
    expect(repository.state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'task.progress.report', outcome: 'rejected',
      metadata: expect.objectContaining({ errorCode: 'revision_conflict' })
    }))
    await service.transitionProject(alice.user, { projectId: project.projectId, status: 'completed',
      expectedRevision: project.revision + 1, idempotencyKey: 'idem_capability_project_complete_01' })
    await expect(service.getProjectCapabilityDirectory(alice.user, project.projectId))
      .rejects.toMatchObject({ code: 'invalid_state_transition' })
  })

  it('does not let a non-member distinguish active, paused, or unknown capability directories', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const alice = await onboard(service, authentication, 'directoryalice', 'provider-directory-alice')
    const outsider = await onboard(service, authentication, 'directoryoutsider', 'provider-directory-outsider')
    const aliceAgent = await registerAgent(service, alice.user, 'directoryali')
    const project = await service.createProject(alice.user, {
      displayName: 'Capability directory authorization',
      goal: 'Do not disclose Project existence or lifecycle to non-members.',
      memberUserIds: [alice.userId],
      coordinatorAgentId: aliceAgent.agent.agentId,
      idempotencyKey: 'idem_directory_authorization_project_01'
    })

    const errorView = async (projectId: string) => {
      try {
        await service.getProjectCapabilityDirectory(outsider.user, projectId)
        throw new Error('Expected capability-directory authorization to fail')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error)) throw error
        return { code: error.code, message: error.message }
      }
    }

    const activeError = await errorView(project.projectId)
    const paused = await service.transitionProject(alice.user, {
      projectId: project.projectId,
      status: 'paused',
      expectedRevision: project.revision,
      idempotencyKey: 'idem_directory_authorization_pause_01'
    })
    expect(paused.status).toBe('paused')
    const pausedError = await errorView(project.projectId)
    const unknownError = await errorView('prj_unknown_capability_directory_01')

    expect(activeError).toEqual({
      code: 'permission_denied',
      message: 'Only active Project members may read this Project.'
    })
    expect(pausedError).toEqual(activeError)
    expect(unknownError).toEqual(activeError)
  })

  it.each(['paused', 'completed', 'cancelled'] as const)(
    'blocks Task accept, progress, result, HumanNeeded, and retry while its Project is %s',
    async (projectStatus) => {
      const repository = new FakeCollaborationRepository()
      const service = new CollaborationService({ repository, now })
      const authentication = new AuthenticationService(repository, now)
      const alice = await onboard(service, authentication, `inactivealice${projectStatus}`, `provider-inactive-alice-${projectStatus}`)
      const bob = await onboard(service, authentication, `inactivebob${projectStatus}`, `provider-inactive-bob-${projectStatus}`)
      const aliceAgent = await registerAgent(service, alice.user, `inactali${projectStatus}`)
      const bobAgent = await registerAgent(service, bob.user, `inactbob${projectStatus}`)
      const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
      const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
      if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')

      const project = await service.createProject(alice.user, {
        displayName: `Inactive Project ${projectStatus}`,
        goal: 'Reject Task writes whenever the containing Project is not active.',
        memberUserIds: [alice.userId, bob.userId],
        coordinatorAgentId: aliceAgent.agent.agentId,
        budgets: { maxTasks: 4, maxTasksPerRound: 4, maxTaskRetries: 2, maxCoordinationRounds: 2 },
        idempotencyKey: `idem_inactive_project_create_${projectStatus}`
      })
      const offeredTask = await service.createTask(aliceDevice, {
        projectId: project.projectId,
        assigneeAgentId: bobAgent.agent.agentId,
        title: 'Offered Task',
        objective: 'Remain offered for the accept boundary check.',
        completionCriteria: ['Inactive Project rejects acceptance'],
        dependencyTaskIds: [],
        expectedProjectRevision: project.revision,
        idempotencyKey: `idem_inactive_offered_task_${projectStatus}`
      })
      const projectAfterOffered = repository.state.projects.get(project.projectId)
      if (!projectAfterOffered) throw new Error('Expected Project after offered Task')
      const runningTask = await service.createTask(aliceDevice, {
        projectId: project.projectId,
        assigneeAgentId: bobAgent.agent.agentId,
        title: 'Running Task',
        objective: 'Remain running for progress, result, and HumanNeeded boundary checks.',
        completionCriteria: ['Inactive Project rejects running Task writes'],
        dependencyTaskIds: [],
        expectedProjectRevision: projectAfterOffered.revision,
        idempotencyKey: `idem_inactive_running_task_${projectStatus}`
      })
      const runningAccepted = await service.transitionTask(bobDevice, {
        taskId: runningTask.taskId,
        status: 'accepted',
        expectedRevision: runningTask.revision,
        idempotencyKey: `idem_inactive_running_accept_${projectStatus}`
      })
      const running = await service.transitionTask(bobDevice, {
        taskId: runningTask.taskId,
        status: 'in_progress',
        expectedRevision: runningAccepted.revision,
        idempotencyKey: `idem_inactive_running_start_${projectStatus}`
      })
      const projectAfterRunning = repository.state.projects.get(project.projectId)
      if (!projectAfterRunning) throw new Error('Expected Project after running Task')
      const failedTask = await service.createTask(aliceDevice, {
        projectId: project.projectId,
        assigneeAgentId: bobAgent.agent.agentId,
        title: 'Failed Task',
        objective: 'Remain failed for the retry boundary check.',
        completionCriteria: ['Inactive Project rejects retry'],
        dependencyTaskIds: [],
        expectedProjectRevision: projectAfterRunning.revision,
        idempotencyKey: `idem_inactive_failed_task_${projectStatus}`
      })
      const failedAccepted = await service.transitionTask(bobDevice, {
        taskId: failedTask.taskId,
        status: 'accepted',
        expectedRevision: failedTask.revision,
        idempotencyKey: `idem_inactive_failed_accept_${projectStatus}`
      })
      const failedRunning = await service.transitionTask(bobDevice, {
        taskId: failedTask.taskId,
        status: 'in_progress',
        expectedRevision: failedAccepted.revision,
        idempotencyKey: `idem_inactive_failed_start_${projectStatus}`
      })
      const failed = await service.transitionTask(bobDevice, {
        taskId: failedTask.taskId,
        status: 'failed',
        expectedRevision: failedRunning.revision,
        safeFailureCode: 'fixture_failed',
        idempotencyKey: `idem_inactive_failed_finish_${projectStatus}`
      })

      const storedProject = repository.state.projects.get(project.projectId)
      if (!storedProject) throw new Error('Expected Project before simulating inactive persisted state')
      repository.state.projects.set(project.projectId, { ...storedProject, status: projectStatus })

      await expect(service.transitionTask(bobDevice, {
        taskId: offeredTask.taskId,
        status: 'accepted',
        expectedRevision: offeredTask.revision,
        idempotencyKey: `idem_inactive_accept_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.reportTaskProgress(bobDevice, {
        taskId: running.taskId,
        expectedRevision: running.revision,
        percent: 50,
        summary: 'This progress must not be persisted.',
        idempotencyKey: `idem_inactive_progress_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.transitionTask(bobDevice, {
        taskId: running.taskId,
        status: 'completed',
        expectedRevision: running.revision,
        resultSummary: 'This result must not be persisted.',
        idempotencyKey: `idem_inactive_result_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.createHumanNeeded(bobDevice, {
        projectId: project.projectId,
        taskId: running.taskId,
        expectedTaskRevision: running.revision,
        targetUserId: bob.userId,
        requiredAssurance: 'verified',
        prompt: 'This request must not be persisted.',
        expiresAt: '2026-08-15T03:00:00.000Z',
        idempotencyKey: `idem_inactive_human_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.retryOrReassignTask(aliceDevice, {
        taskId: failed.taskId,
        assigneeAgentId: aliceAgent.agent.agentId,
        expectedRevision: failed.revision,
        idempotencyKey: `idem_inactive_retry_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })

      expect(repository.state.tasks.get(offeredTask.taskId)).toMatchObject({ status: 'offered', revision: offeredTask.revision })
      expect(repository.state.tasks.get(running.taskId)).toMatchObject({ status: 'in_progress', revision: running.revision })
      expect(repository.state.tasks.get(failed.taskId)).toMatchObject({ status: 'failed', revision: failed.revision })
      expect(repository.state.humanRequests.size).toBe(0)
    }
  )

  it('gates Project closure, rejects oversized direct results, and keeps one active Task route', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const alice = await onboard(service, authentication, 'boundaryalice', 'provider-boundary-alice')
    const bob = await onboard(service, authentication, 'boundarybob', 'provider-boundary-bob')
    const aliceAgent = await registerAgent(service, alice.user, 'boundaryali1')
    const bobAgent = await registerAgent(service, bob.user, 'boundarybob1')
    const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
    const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
    if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')

    const completionProject = await service.createProject(alice.user, {
      displayName: 'Completion boundary',
      goal: 'Complete the Task before completing the Project.',
      memberUserIds: [alice.userId, bob.userId],
      coordinatorAgentId: aliceAgent.agent.agentId,
      idempotencyKey: 'idem_completion_boundary_project_01'
    })
    const completionTask = await service.createTask(aliceDevice, {
      projectId: completionProject.projectId,
      assigneeAgentId: bobAgent.agent.agentId,
      title: 'Complete first',
      objective: 'Close this Task before the Project.',
      completionCriteria: ['Task reaches a terminal state'],
      dependencyTaskIds: [],
      expectedProjectRevision: completionProject.revision,
      idempotencyKey: 'idem_completion_boundary_task_01'
    })
    const completionProjectCurrent = repository.state.projects.get(completionProject.projectId)
    if (!completionProjectCurrent) throw new Error('Expected completion Project')
    await expect(service.transitionProject(alice.user, {
      projectId: completionProject.projectId,
      status: 'completed',
      expectedRevision: completionProjectCurrent.revision,
      idempotencyKey: 'idem_completion_boundary_early_close_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    const completionAccepted = await service.transitionTask(bobDevice, {
      taskId: completionTask.taskId,
      status: 'accepted',
      expectedRevision: completionTask.revision,
      idempotencyKey: 'idem_completion_boundary_accept_01'
    })
    const completionRunning = await service.transitionTask(bobDevice, {
      taskId: completionTask.taskId,
      status: 'in_progress',
      expectedRevision: completionAccepted.revision,
      idempotencyKey: 'idem_completion_boundary_run_01'
    })
    await expect(service.transitionTask(bobDevice, {
      taskId: completionTask.taskId,
      status: 'completed',
      expectedRevision: completionRunning.revision,
      resultSummary: 'x'.repeat(32_001),
      idempotencyKey: 'idem_completion_boundary_oversized_result_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
    expect(repository.state.tasks.get(completionTask.taskId)).toMatchObject({
      status: 'in_progress',
      revision: completionRunning.revision
    })
    const completionFinished = await service.transitionTask(bobDevice, {
      taskId: completionTask.taskId,
      status: 'completed',
      expectedRevision: completionRunning.revision,
      resultSummary: 'The result is within the public contract bound.',
      idempotencyKey: 'idem_completion_boundary_finish_01'
    })
    expect(completionFinished.status).toBe('completed')
    await expect(service.transitionProject(alice.user, {
      projectId: completionProject.projectId,
      status: 'completed',
      expectedRevision: completionProjectCurrent.revision,
      idempotencyKey: 'idem_completion_boundary_close_01'
    })).resolves.toMatchObject({ status: 'completed' })

    const cancellationProject = await service.createProject(alice.user, {
      displayName: 'Cancellation boundary',
      goal: 'Cancel the Task before cancelling the Project.',
      memberUserIds: [alice.userId, bob.userId],
      coordinatorAgentId: aliceAgent.agent.agentId,
      idempotencyKey: 'idem_cancellation_boundary_project_01'
    })
    const cancellationTask = await service.createTask(aliceDevice, {
      projectId: cancellationProject.projectId,
      assigneeAgentId: bobAgent.agent.agentId,
      title: 'Cancel first',
      objective: 'Cancel this Task before the Project.',
      completionCriteria: ['Task reaches cancelled'],
      dependencyTaskIds: [],
      expectedProjectRevision: cancellationProject.revision,
      idempotencyKey: 'idem_cancellation_boundary_task_01'
    })
    const cancellationProjectCurrent = repository.state.projects.get(cancellationProject.projectId)
    if (!cancellationProjectCurrent) throw new Error('Expected cancellation Project')
    await expect(service.transitionProject(alice.user, {
      projectId: cancellationProject.projectId,
      status: 'cancelled',
      expectedRevision: cancellationProjectCurrent.revision,
      idempotencyKey: 'idem_cancellation_boundary_early_close_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    const cancelledTask = await service.cancelTask(aliceDevice, {
      taskId: cancellationTask.taskId,
      expectedRevision: cancellationTask.revision,
      idempotencyKey: 'idem_cancellation_boundary_task_cancel_01'
    })
    expect(cancelledTask.status).toBe('cancelled')
    await expect(service.transitionProject(alice.user, {
      projectId: cancellationProject.projectId,
      status: 'cancelled',
      expectedRevision: cancellationProjectCurrent.revision,
      idempotencyKey: 'idem_cancellation_boundary_close_01'
    })).resolves.toMatchObject({ status: 'cancelled' })

    const routingProject = await service.createProject(alice.user, {
      displayName: 'Single active route',
      goal: 'Keep exactly one current Task assignee after competing retries.',
      memberUserIds: [alice.userId, bob.userId],
      coordinatorAgentId: aliceAgent.agent.agentId,
      budgets: { maxTasks: 2, maxTasksPerRound: 2, maxTaskRetries: 2, maxCoordinationRounds: 2 },
      idempotencyKey: 'idem_single_route_project_01'
    })
    const routedTask = await service.createTask(aliceDevice, {
      projectId: routingProject.projectId,
      assigneeAgentId: bobAgent.agent.agentId,
      title: 'Competing retry routes',
      objective: 'Allow only one reassignment at the current revision.',
      completionCriteria: ['Exactly one retry request succeeds'],
      dependencyTaskIds: [],
      expectedProjectRevision: routingProject.revision,
      idempotencyKey: 'idem_single_route_task_01'
    })
    const routedAccepted = await service.transitionTask(bobDevice, {
      taskId: routedTask.taskId,
      status: 'accepted',
      expectedRevision: routedTask.revision,
      idempotencyKey: 'idem_single_route_accept_01'
    })
    const routedRunning = await service.transitionTask(bobDevice, {
      taskId: routedTask.taskId,
      status: 'in_progress',
      expectedRevision: routedAccepted.revision,
      idempotencyKey: 'idem_single_route_run_01'
    })
    const routedFailed = await service.transitionTask(bobDevice, {
      taskId: routedTask.taskId,
      status: 'failed',
      expectedRevision: routedRunning.revision,
      safeFailureCode: 'retry_required',
      idempotencyKey: 'idem_single_route_fail_01'
    })
    const competingRetries = await Promise.allSettled([
      service.retryOrReassignTask(aliceDevice, {
        taskId: routedTask.taskId,
        assigneeAgentId: aliceAgent.agent.agentId,
        expectedRevision: routedFailed.revision,
        idempotencyKey: 'idem_single_route_retry_alice_01'
      }),
      service.retryOrReassignTask(aliceDevice, {
        taskId: routedTask.taskId,
        assigneeAgentId: bobAgent.agent.agentId,
        expectedRevision: routedFailed.revision,
        idempotencyKey: 'idem_single_route_retry_bob_01'
      })
    ])
    const successfulRetry = competingRetries.find((result) => result.status === 'fulfilled')
    const rejectedRetry = competingRetries.find((result) => result.status === 'rejected')
    if (!successfulRetry || successfulRetry.status !== 'fulfilled') throw new Error('Expected one successful retry')
    if (!rejectedRetry || rejectedRetry.status !== 'rejected') throw new Error('Expected one rejected retry')
    expect(competingRetries.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(competingRetries.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(rejectedRetry.reason).toMatchObject({ code: 'revision_conflict' })

    const currentRoutedTask = await service.getTask(alice.user, routedTask.taskId)
    expect(currentRoutedTask).toMatchObject({
      status: 'offered',
      revision: routedFailed.revision + 1,
      assigneeAgentId: successfulRetry.value.assigneeAgentId
    })
    expect([...repository.state.tasks.values()].filter((task) => task.taskId === routedTask.taskId)).toHaveLength(1)
    const routedOffers = [
      ...(await repository.pullInbox({ kind: 'agent', id: aliceAgent.agent.agentId }, 0, 100, at.toISOString())),
      ...(await repository.pullInbox({ kind: 'agent', id: bobAgent.agent.agentId }, 0, 100, at.toISOString()))
    ].filter((message) => message.messageType === 'task.offered' && message.payload.taskId === routedTask.taskId)
    expect(routedOffers).toHaveLength(2)
    expect(routedOffers.map((message) => message.payload.revision).sort((left, right) => Number(left) - Number(right)))
      .toEqual([routedTask.revision, currentRoutedTask.revision])

    const routedAssignee = currentRoutedTask.assigneeAgentId === aliceAgent.agent.agentId ? aliceDevice : bobDevice
    const nonAssignee = currentRoutedTask.assigneeAgentId === aliceAgent.agent.agentId ? bobDevice : aliceDevice
    await expect(service.transitionTask(nonAssignee, {
      taskId: routedTask.taskId,
      status: 'accepted',
      expectedRevision: currentRoutedTask.revision,
      idempotencyKey: 'idem_single_route_non_assignee_rejected_01'
    })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.transitionTask(routedAssignee, {
      taskId: routedTask.taskId,
      status: 'accepted',
      expectedRevision: currentRoutedTask.revision,
      idempotencyKey: 'idem_single_route_assignee_accept_01'
    })).resolves.toMatchObject({ status: 'accepted' })
  })

  it('routes a shared personal topic to its fixed Agent once and targets HumanNeeded answers', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const alice = await onboard(service, authentication, 'alice', 'provider-alice')
    const bob = await onboard(service, authentication, 'bob', 'provider-bob')
    const aliceAgent = await registerAgent(service, alice.user, 'aliceagent02')
    const bobAgent = await registerAgent(service, bob.user, 'bobagent0002')
    const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
    const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
    if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')
    const locator = { type: 'provider_locator' as const, provider: 'zulip', realmId: 'realm-hk',
      containerId: 'stream-research', topicId: 'topic-fixed', topicDisplayName: '固定会话' }
    const projection = await service.createProjection(alice.user, { agentId: aliceAgent.agent.agentId,
      humanEndpointId: alice.endpointId, locator, displayName: '固定会话', allowedSenderUserIds: [alice.userId, bob.userId],
      idempotencyKey: 'idem_projection_create_alice' })
    const first = await service.acceptPersonalProviderMessage(bob.endpoint, { locator,
      providerMessageId: 'zulip-message-100', providerEventId: 'zulip-event-100', text: '请继续分析',
      occurredAt: at.toISOString() })
    const duplicate = await service.acceptPersonalProviderMessage(bob.endpoint, { locator,
      providerMessageId: 'zulip-message-100', providerEventId: 'zulip-event-100', text: '请继续分析',
      occurredAt: at.toISOString() })
    expect(duplicate).toEqual(first)
    expect(await repository.pullInbox({ kind: 'agent', id: aliceAgent.agent.agentId }, 0, 20, at.toISOString())).toHaveLength(1)
    expect(await repository.pullInbox({ kind: 'agent', id: bobAgent.agent.agentId }, 0, 20, at.toISOString())).toHaveLength(0)
    expect(projection.agentId).toBe(aliceAgent.agent.agentId)
    const movedLocator = { ...locator, containerId: 'stream-research-renamed',
      containerDisplayName: '研究（新）', topicDisplayName: '固定会话（新）' }
    const moved = await service.applyProviderLocatorChange({ previousLocator: locator, currentLocator: movedLocator,
      providerEventId: 'zulip-event-locator-moved-100' })
    expect(moved).toEqual({ kind: 'personal_projection', resourceId: projection.projectionId })
    const updatedProjection = await service.getProjection(alice.user, projection.projectionId)
    expect(updatedProjection).toMatchObject({ projectionId: projection.projectionId,
      agentId: aliceAgent.agent.agentId, displayName: '固定会话', locator: movedLocator,
      locatorRevision: 2, revision: 2 })
    const replayedMove = await service.applyProviderLocatorChange({ previousLocator: locator,
      currentLocator: movedLocator, providerEventId: 'zulip-event-locator-moved-replay-100' })
    expect(replayedMove).toEqual({ kind: 'personal_projection', resourceId: projection.projectionId })
    expect(await service.getProjection(alice.user, projection.projectionId)).toMatchObject({
      projectionId: projection.projectionId, locatorRevision: 2, revision: 2 })
    await service.acceptPersonalProviderMessage(bob.endpoint, { locator: movedLocator,
      providerMessageId: 'zulip-message-101', providerEventId: 'zulip-event-101', text: '在新 Topic 继续',
      occurredAt: at.toISOString() })
    const movedSessionInbox = await repository.pullInbox(
      { kind: 'agent', id: aliceAgent.agent.agentId }, 0, 20, at.toISOString())
    expect(movedSessionInbox.map((message) => message.messageType)).toEqual([
      'personal.message.received', 'projection.updated', 'personal.message.received'
    ])
    expect(movedSessionInbox[1]?.payload).toMatchObject({
      type: 'projection.updated', projectionId: projection.projectionId, revision: 2 })
    expect(movedSessionInbox[2]?.payload).toMatchObject({
      type: 'personal.message.received', projectionId: projection.projectionId, projectionRevision: 2 })
    await expect(service.acceptPersonalProviderMessage(bob.endpoint, { locator,
      providerMessageId: 'zulip-message-102', providerEventId: 'zulip-event-102', text: '旧 Topic 不应路由',
      occurredAt: at.toISOString() })).rejects.toMatchObject({ code: 'not_found' })

    const project = await service.createProject(alice.user, { displayName: 'Human loop', goal: '定向提问',
      memberUserIds: [alice.userId, bob.userId], coordinatorAgentId: aliceAgent.agent.agentId,
      idempotencyKey: 'idem_project_human_loop' })
    const projectLocator = { ...locator, topicId: 'topic-project', topicDisplayName: '项目协作' }
    const projectBinding = await service.bindProjectEndpoint(alice.user, { projectId: project.projectId,
      locator: projectLocator, expectedRevision: null, idempotencyKey: 'idem_project_endpoint_bind' })
    const movedProjectLocator = { ...projectLocator, containerId: 'stream-project-renamed',
      containerDisplayName: '项目（新）', topicDisplayName: '项目协作（新）' }
    const movedProject = await service.applyProviderLocatorChange({ previousLocator: projectLocator,
      currentLocator: movedProjectLocator, providerEventId: 'zulip-event-project-locator-moved-100' })
    expect(movedProject).toEqual({ kind: 'project', resourceId: project.projectId })
    expect(await service.getProjectEndpointBinding(alice.user, project.projectId)).toMatchObject({
      projectEndpointBindingId: projectBinding.projectEndpointBindingId, projectId: project.projectId,
      locator: movedProjectLocator, locatorRevision: 2, revision: 2 })
    const replayedProjectMove = await service.applyProviderLocatorChange({ previousLocator: projectLocator,
      currentLocator: movedProjectLocator, providerEventId: 'zulip-event-project-locator-moved-replay-100' })
    expect(replayedProjectMove).toEqual({ kind: 'project', resourceId: project.projectId })
    expect(await service.getProjectEndpointBinding(alice.user, project.projectId)).toMatchObject({
      projectEndpointBindingId: projectBinding.projectEndpointBindingId, locatorRevision: 2, revision: 2 })
    const projectInput = await service.acceptProjectInput(bob.endpoint, { locator: movedProjectLocator,
      providerMessageId: 'zulip-project-message-101', providerEventId: 'zulip-project-event-101',
      text: '在新项目 Topic 继续', occurredAt: at.toISOString() })
    expect(projectInput).toMatchObject({ projectId: project.projectId, senderUserId: bob.userId })
    const movedProjectInbox = await repository.pullInbox(
      { kind: 'agent', id: aliceAgent.agent.agentId }, 0, 50, at.toISOString())
    const endpointUpdateIndex = movedProjectInbox.findIndex((message) =>
      message.messageType === 'project.endpoint.updated' && message.payload.projectId === project.projectId)
    const projectInputIndex = movedProjectInbox.findIndex((message) =>
      message.messageType === 'project.input.received' && message.payload.projectInputId === projectInput.projectInputId)
    expect(endpointUpdateIndex).toBeGreaterThanOrEqual(0)
    expect(projectInputIndex).toBeGreaterThan(endpointUpdateIndex)
    await expect(service.acceptProjectInput(bob.endpoint, { locator: projectLocator,
      providerMessageId: 'zulip-project-message-102', providerEventId: 'zulip-project-event-102',
      text: '旧项目 Topic 不应路由', occurredAt: at.toISOString() }))
      .rejects.toMatchObject({ code: 'not_found' })
    const task = await service.createTask(aliceDevice, { projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId, title: '需确认', objective: '等待 Bob 决策',
      completionCriteria: ['收到回答'], dependencyTaskIds: [], expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_task_human_loop' })
    const accepted = await service.transitionTask(bobDevice, { taskId: task.taskId, status: 'accepted', expectedRevision: 1,
      idempotencyKey: 'idem_task_human_accept' })
    const running = await service.transitionTask(bobDevice, { taskId: task.taskId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_task_human_running' })
    const request = await service.createHumanNeeded(bobDevice, { projectId: project.projectId, taskId: task.taskId,
      expectedTaskRevision: running.revision, targetUserId: bob.userId, requiredAssurance: 'verified',
      prompt: '是否继续？', expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: 'idem_human_needed_bob' })
    const providerNotifications = await repository.pullInbox(
      { kind: 'human_endpoint', id: bob.endpointId }, 0, 20, at.toISOString())
    expect(providerNotifications).toContainEqual(expect.objectContaining({
      messageType: 'provider.notification.outbound',
      payload: expect.objectContaining({
        resourceId: request.humanRequestId,
        text: `是否继续？\n\n回复命令：sciforge-answer ${request.humanRequestId} ${request.revision} <answer>`
      })
    }))
    await expect(service.answerHumanNeeded(alice.endpoint as HumanEndpointActor, { humanRequestId: request.humanRequestId,
      requestRevision: request.revision, answer: '代答', idempotencyKey: 'idem_human_wrong_user' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
    const otherProject = await service.createProject(alice.user, { displayName: 'Other project', goal: '错误 Topic 验证',
      memberUserIds: [alice.userId, bob.userId], coordinatorAgentId: aliceAgent.agent.agentId,
      idempotencyKey: 'idem_project_other_human_loop' })
    const otherProjectLocator = { ...locator, topicId: 'topic-other-project', topicDisplayName: '其他项目' }
    await service.bindProjectEndpoint(alice.user, { projectId: otherProject.projectId,
      locator: otherProjectLocator, expectedRevision: null, idempotencyKey: 'idem_project_other_endpoint_bind' })
    await expect(service.answerHumanNeeded(bob.endpoint, { humanRequestId: request.humanRequestId,
      requestRevision: request.revision, answer: '从错误项目回答', sourceLocator: otherProjectLocator,
      idempotencyKey: 'idem_human_wrong_project_locator' })).rejects.toMatchObject({ code: 'not_found' })
    const answer = await service.answerHumanNeeded(bob.endpoint, { humanRequestId: request.humanRequestId,
      requestRevision: request.revision, answer: '继续', sourceLocator: movedProjectLocator,
      idempotencyKey: 'idem_human_answer_bob' })
    expect(answer).toMatchObject({ answeredByUserId: bob.userId, answeredFromHumanEndpointId: bob.endpointId })
    const repeatedAnswer = await service.answerHumanNeeded(bob.endpoint, { humanRequestId: request.humanRequestId,
      requestRevision: request.revision, answer: '继续', sourceLocator: movedProjectLocator,
      idempotencyKey: 'idem_human_answer_bob' })
    expect(repeatedAnswer.humanAnswerId).toBe(answer.humanAnswerId)
    const expiringRequest = await service.createHumanNeeded(bobDevice, { projectId: project.projectId, taskId: task.taskId,
      expectedTaskRevision: running.revision + 1, targetUserId: bob.userId, requiredAssurance: 'verified',
      prompt: '过期后不可回答', expiresAt: '2026-08-15T03:30:00.000Z',
      idempotencyKey: 'idem_human_needed_expiring_bob' })
    const laterService = new CollaborationService({ repository, now: () => new Date('2026-08-15T04:00:00.000Z') })
    await expect(laterService.answerHumanNeeded(bob.endpoint, { humanRequestId: expiringRequest.humanRequestId,
      requestRevision: expiringRequest.revision, answer: '迟到回答', sourceLocator: movedProjectLocator,
      idempotencyKey: 'idem_human_expired_answer_bob' })).rejects.toMatchObject({ code: 'request_expired' })
    const bobInbox = await service.pullInbox(bob.user, { afterSequence: 0, limit: 20 })
    expect(() => bobInbox.messages.map(toInboxMessage)).not.toThrow()
    const aliceAgentInbox = await service.pullInbox(aliceDevice, { afterSequence: 0, limit: 50 })
    expect(() => aliceAgentInbox.messages.map(toInboxMessage)).not.toThrow()
  })
})
