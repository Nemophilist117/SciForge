import assert from 'node:assert/strict'
import test from 'node:test'

import { CollaborationServiceError } from '../packages/collaboration-server/src/errors.ts'
import { CollaborationService } from '../packages/collaboration-server/src/service.ts'
import {
  FakeCollaborationRepository,
  FakeClock,
  FakeInboxNotifier
} from '../test-fixtures/collaboration/fake-adapters.mjs'
import { createUnifiedIdentityServerFixture } from '../test-fixtures/collaboration/unified-identity/server-fixture.mjs'

function expectCode(code, operation) {
  return assert.rejects(operation, (error) => {
    assert.ok(error instanceof CollaborationServiceError)
    assert.equal(error.code, code)
    return true
  })
}

async function createServiceRig(t) {
  const clock = new FakeClock()
  const repository = new FakeCollaborationRepository()
  const notifier = new FakeInboxNotifier()
  const service = new CollaborationService({ repository, notifier, now: clock.now })
  const identity = await createUnifiedIdentityServerFixture({ repository, now: clock.now })
  t.after(() => identity.close())
  return { clock, repository, notifier, service, identity, identities: identity.identities,
    authentication: identity.authentication }
}

async function bindUser(rig, slot, providerUserId = `provider-user-${slot.toLowerCase()}`) {
  const user = await rig.identity.createUser(`用户 ${slot}`, { displayName: `用户 ${slot}` })
  const binding = await rig.identity.bindZulip(user, `canonical-${slot}`, { zulipUserId: providerUserId })
  return {
    ...user,
    ...binding
  }
}

async function registerAgent(rig, participant, slot) {
  const device = await rig.identity.createDevice(participant, `canonical-agent-${slot}`, {
    displayName: `SciForge ${slot}`,
    capabilitySummary: ['agent-runtime']
  })
  const registered = await rig.service.registerAgent(participant.actor, {
    deviceId: device.device.deviceId,
    displayName: `SciForge ${slot}`,
    nodeType: 'desktop',
    capabilities: ['agent-runtime'],
    idempotencyKey: `register-agent-${slot}`
  })
  const actor = await rig.authentication.resolveBearer(registered.deviceCredential)
  const reportedAt = rig.clock.now().toISOString()
  const expiresAt = new Date(rig.clock.now().getTime() + 60 * 60 * 1_000).toISOString()
  await rig.service.reportAgentCapabilityProfile(actor, {
    agentId: registered.agent.agentId,
    ownerUserId: participant.userId,
    nodeType: 'personal_computer',
    os: { family: 'linux', architecture: 'x64' },
    runtimeIds: ['runtime.test'],
    capabilities: [{
      capabilityId: 'agent-runtime',
      evidence: { level: 'verified', checkedAt: reportedAt }
    }],
    vpnAccessIds: [],
    slurmClusterIds: [],
    accessibleResourceRefIds: [],
    resultReturnPolicy: {
      summary: true,
      evidenceRefs: true,
      resourceRefs: true,
      logSummary: true,
      fullFileRequiresConfirmation: true,
      fullLogRequiresConfirmation: true
    },
    reportedAt,
    expiresAt,
    idempotencyKey: `report-agent-capability-${slot}`
  })
  return {
    agent: registered.agent,
    credential: registered.deviceCredential,
    actor,
    ...device
  }
}

test('2.5 canonical service rejects identity theft/replay, keeps stable OIDC identity, rotates Agent credentials and enforces revocation', async (t) => {
  const rig = await createServiceRig(t)
  const a = await bindUser(rig, 'A')
  const b = await bindUser(rig, 'B')

  const userA = await rig.service.getUser(a.actor, a.userId)
  const renamedA = await rig.service.updateUser(a.actor, {
    userId: a.userId,
    displayName: '用户 A（新显示名）',
    expectedRevision: userA.revision,
    idempotencyKey: 'rename-user-A'
  })
  assert.equal(renamedA.userId, a.userId)
  assert.equal(renamedA.displayName, '用户 A（新显示名）')
  await expectCode('permission_denied', () => rig.service.updateUser(b.actor, {
    userId: a.userId,
    displayName: 'B 不得修改 A',
    expectedRevision: renamedA.revision,
    idempotencyKey: 'cross-user-rename'
  }))

  const replayActor = await rig.authentication.resolveBearer(a.accessToken)
  assert.equal(replayActor.kind, 'user')
  assert.equal(replayActor.userId, a.userId)
  assert.equal(rig.repository.state.users.size, 2)

  const conflictingBinding = await rig.identities.beginZulipBinding(b.actor, {
    realmUrl: a.realmUrl,
    idempotencyKey: 'idem_binding_begin_endpoint_theft'
  })
  await expectCode('IDENTITY_ALREADY_BOUND', () => rig.identities.confirmZulipBinding(
    rig.identity.serviceActor,
    {
      bindingCode: conflictingBinding.bindingCode,
      realmUrl: a.realmUrl,
      realmId: a.realmId,
      zulipUserId: a.providerUserId,
      providerEventId: 'provider-event-endpoint-theft',
      idempotencyKey: 'idem_binding_confirm_endpoint_theft'
    }
  ))

  const agentA = await registerAgent(rig, a, 'A')
  await expectCode('permission_denied', () => rig.service.registerAgent(b.actor, {
    deviceId: agentA.device.deviceId,
    displayName: '不得接管',
    nodeType: 'desktop',
    capabilities: ['agent-runtime'],
    idempotencyKey: 'agent-theft-attempt'
  }))

  const registrationReplay = await rig.service.registerAgent(a.actor, {
    deviceId: agentA.device.deviceId,
    displayName: 'SciForge A',
    nodeType: 'desktop',
    capabilities: ['agent-runtime'],
    idempotencyKey: 'register-agent-A'
  })
  assert.equal(registrationReplay.agent.agentId, agentA.agent.agentId)
  assert.equal(registrationReplay.deviceCredential, undefined)
  assert.equal(registrationReplay.replayed, true)

  const rotated = await rig.service.rotateAgentCredential(a.actor, {
    agentId: agentA.agent.agentId,
    expectedRevision: agentA.agent.revision,
    idempotencyKey: 'rotate-agent-A'
  })
  await expectCode('credential_revoked', () => rig.authentication.resolveBearer(agentA.credential))
  const rotatedActor = await rig.authentication.resolveBearer(rotated.deviceCredential)
  assert.equal(rotatedActor.agentId, agentA.agent.agentId)
  assert.equal(rotatedActor.userId, a.userId)

  await expectCode('assurance_insufficient', () => rig.service.transferAgentOwnership(a.actor, {
    agentId: agentA.agent.agentId,
    targetUserId: b.userId,
    expectedRevision: rotated.agent.revision,
    idempotencyKey: 'transfer-agent-A-to-B'
  }))
  assert.equal((await rig.authentication.resolveBearer(rotated.deviceCredential)).userId, a.userId)

  await expectCode('credential_revoked', () => rig.service.rotateAgentCredential(b.actor, {
    agentId: agentA.agent.agentId,
    expectedRevision: rotated.agent.revision,
    idempotencyKey: 'other-user-rotate-agent'
  }))
  const rejectedAudit = rig.repository.state.auditEvents.find((event) => (
    event.action === 'agent.credential.rotate' && event.outcome === 'rejected'
  ))
  assert.equal(rejectedAudit?.actorUserId, b.userId)
  assert.equal(rejectedAudit?.metadata.errorCode, 'credential_revoked')

  const revoked = await rig.service.revokeAgent(a.actor, {
    agentId: agentA.agent.agentId,
    expectedRevision: rotated.agent.revision,
    idempotencyKey: 'owner-revoke-agent'
  })
  assert.equal(revoked.status, 'revoked')
  await expectCode('credential_revoked', () => rig.authentication.resolveBearer(rotated.deviceCredential))

  const revokedIdentity = await rig.identities.revokeExternalIdentity(
    a.actor,
    a.externalIdentityId,
    'idem_revoke_external_identity_A'
  )
  assert.equal(revokedIdentity.identity.status, 'revoked')
  await expectCode('authentication_required', () => rig.authentication.resolveProviderIdentity(
    'zulip',
    a.realmId,
    a.providerUserId
  ))
})

test('2.6 canonical receipts, repository rows, audit and replay responses never persist or re-emit issued material', async (t) => {
  const rig = await createServiceRig(t)
  const a = await bindUser(rig, 'A')
  const b = await bindUser(rig, 'B')
  const agentA = await registerAgent(rig, a, 'A')
  const rotated = await rig.service.rotateAgentCredential(a.actor, {
    agentId: agentA.agent.agentId,
    expectedRevision: agentA.agent.revision,
    idempotencyKey: 'rotate-agent-A'
  })
  const inMemoryOnly = [
    a.accessToken,
    b.accessToken,
    a.bindingCode,
    b.bindingCode,
    agentA.enrollment.nonce,
    agentA.fixture.deviceRequest.signature,
    agentA.credential,
    rotated.deviceCredential
  ]
  const persisted = JSON.stringify({
    oidcIdentities: [...rig.repository.state.oidcIdentities.values()],
    deviceEnrollments: [...rig.repository.state.deviceEnrollments.values()],
    devices: [...rig.repository.state.devices.values()],
    zulipBindingRequests: [...rig.repository.state.zulipBindingRequests.values()],
    endpoints: [...rig.repository.state.endpoints.values()],
    credentials: [...rig.repository.state.credentials.values()],
    receipts: [...rig.repository.state.receipts.values()],
    auditEvents: rig.repository.state.auditEvents
  })
  for (const material of inMemoryOnly) {
    assert.equal(typeof material, 'string')
    assert.ok(material.length >= 8)
    assert.doesNotMatch(persisted, new RegExp(material.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.ok(rig.repository.state.auditEvents.length > 0)
  assert.ok(rig.repository.state.auditEvents.every((event) => (
    !Object.keys(event.metadata).some((key) => (
      /credential|secret|challenge|password|authorization|token|nonce|signature|binding.?code/i.test(key)
    ))
  )))
})

test('8.3 and 10.2 canonical Project ledger enforces assignee/coordinator, idempotency, inbox recovery and handoff', async (t) => {
  const rig = await createServiceRig(t)
  const a = await bindUser(rig, 'A')
  const b = await bindUser(rig, 'B')
  const c = await bindUser(rig, 'C')
  const agentA = await registerAgent(rig, a, 'A')
  const agentB = await registerAgent(rig, b, 'B')
  const agentC = await registerAgent(rig, c, 'C')

  let project = await rig.service.createProject(a.actor, {
    displayName: 'Fake 三方 Project',
    goal: 'Fake repository 上的 canonical Project',
    memberUserIds: [b.userId, c.userId],
    coordinatorAgentId: agentA.agent.agentId,
    idempotencyKey: 'create-project'
  })
  const taskB = await rig.service.createTask(a.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentB.agent.agentId,
    title: 'Worker B 任务',
    objective: 'Worker B 执行',
    completionCriteria: ['返回 bounded summary'],
    dependencyTaskIds: [],
    expectedProjectRevision: project.revision,
    idempotencyKey: 'create-task-B'
  })
  const taskBReplay = await rig.service.createTask(a.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentB.agent.agentId,
    title: 'Worker B 任务',
    objective: 'Worker B 执行',
    completionCriteria: ['返回 bounded summary'],
    dependencyTaskIds: [],
    expectedProjectRevision: project.revision,
    idempotencyKey: 'create-task-B'
  })
  assert.deepEqual(taskBReplay, taskB)

  let acceptedB = await rig.service.transitionTask(agentB.actor, {
    taskId: taskB.taskId,
    executionId: taskB.executionId,
    status: 'accepted',
    expectedRevision: taskB.revision,
    idempotencyKey: 'accept-task-B'
  })
  acceptedB = await rig.service.transitionTask(agentB.actor, {
    taskId: taskB.taskId,
    executionId: acceptedB.executionId,
    status: 'in_progress',
    expectedRevision: acceptedB.revision,
    idempotencyKey: 'start-task-B'
  })
  await expectCode('assignee_mismatch', () => rig.service.transitionTask(agentA.actor, {
    taskId: taskB.taskId,
    executionId: acceptedB.executionId,
    status: 'completed',
    expectedRevision: acceptedB.revision,
    resultSummary: '非 assignee 不得完成',
    idempotencyKey: 'coordinator-complete-worker-task'
  }))
  await rig.service.createHumanNeeded(agentB.actor, {
    projectId: project.projectId,
    source: { kind: 'worker', taskId: taskB.taskId, executionId: acceptedB.executionId,
      expectedTaskRevision: acceptedB.revision },
    targetUserId: b.userId,
    requiredAssurance: 'verified',
    prompt: 'Worker B 需要 B 的明确输入',
    expiresAt: new Date(rig.clock.now().getTime() + 60_000).toISOString(),
    idempotencyKey: 'task-B-needs-human'
  })
  const waitingB = await rig.repository.getTask(taskB.taskId)
  assert.equal(waitingB.status, 'needs_human')
  const humanInbox = await rig.service.pullInbox(b.actor, { afterSequence: 0, limit: 20 })
  assert.ok(humanInbox.messages.some((message) => (
    message.messageType === 'human.needed' && message.payload.request?.targetUserId === b.userId
  )))
  const aInbox = await rig.service.pullInbox(a.actor, { afterSequence: 0, limit: 20 })
  assert.ok(!aInbox.messages.some((message) => message.messageType === 'human.needed'))

  project = await rig.repository.getProject(project.projectId)
  const taskC = await rig.service.createTask(a.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentC.agent.agentId,
    title: 'Worker C 任务',
    objective: 'Worker C 并行执行',
    completionCriteria: ['返回 bounded summary'],
    dependencyTaskIds: [],
    expectedProjectRevision: project.revision,
    idempotencyKey: 'create-task-C'
  })
  assert.notEqual(taskB.assigneeAgentId, taskC.assigneeAgentId)
  const taskInboxBeforeRestart = await rig.service.pullInbox(agentC.actor, { afterSequence: 0, limit: 20 })
  assert.ok(taskInboxBeforeRestart.messages.some((message) => message.payload.taskId === taskC.taskId))

  const restarted = new CollaborationService({
    repository: rig.repository,
    notifier: rig.notifier,
    now: rig.clock.now
  })
  const taskInboxAfterRestart = await restarted.pullInbox(agentC.actor, { afterSequence: 0, limit: 20 })
  assert.deepEqual(taskInboxAfterRestart.messages, taskInboxBeforeRestart.messages)
  await restarted.ackInbox(agentC.actor, {
    throughSequence: taskInboxAfterRestart.messages.at(-1).sequence,
    idempotencyKey: 'ack-agent-C'
  })
  const cursor = await rig.repository.getInboxCursor({ kind: 'agent', id: agentC.agent.agentId })
  assert.equal(cursor.ackedSequence, taskInboxAfterRestart.messages.at(-1).sequence)

  project = await rig.repository.getProject(project.projectId)
  const handedOff = await restarted.transferCoordinator(a.actor, {
    projectId: project.projectId,
    coordinatorAgentId: agentC.agent.agentId,
    expectedRevision: project.revision,
    idempotencyKey: 'handoff-A-to-C'
  })
  await expectCode('coordinator_mismatch', () => restarted.createTask(agentA.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentB.agent.agentId,
    title: '旧 Coordinator 任务',
    objective: '旧 Coordinator 不得创建',
    completionCriteria: ['Owner 确认'],
    dependencyTaskIds: [],
    expectedProjectRevision: handedOff.revision,
    idempotencyKey: 'old-coordinator-task'
  }))
  await expectCode('confirmation_required', () => restarted.createTask(agentC.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentB.agent.agentId,
    title: '新 Coordinator 直接创建任务',
    objective: '新 Coordinator 也必须等待 Owner 确认',
    completionCriteria: ['Owner 确认'],
    dependencyTaskIds: [],
    expectedProjectRevision: handedOff.revision,
    idempotencyKey: 'new-coordinator-task'
  }))
  const ownerConfirmedTask = await restarted.createTask(a.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentB.agent.agentId,
    title: 'Owner 确认的新 Coordinator 建议',
    objective: 'Owner 创建正式 Task',
    completionCriteria: ['Task 记录当前 Coordinator'],
    dependencyTaskIds: [],
    expectedProjectRevision: handedOff.revision,
    idempotencyKey: 'owner-confirmed-task-after-handoff'
  })
  assert.equal(ownerConfirmedTask.createdByAgentId, agentC.agent.agentId)
})

test('8.4 canonical service bounds payloads and blocks sensitive Project Record material', async (t) => {
  const rig = await createServiceRig(t)
  const a = await bindUser(rig, 'A')
  const agentA = await registerAgent(rig, a, 'A')
  await expectCode('validation_failed', () => rig.service.createProject(a.actor, {
    displayName: '超限 Project',
    goal: 'x'.repeat(20_001),
    memberUserIds: [],
    coordinatorAgentId: agentA.agent.agentId,
    idempotencyKey: 'oversized-project'
  }))

  const project = await rig.service.createProject(a.actor, {
    displayName: '安全记录 Project',
    goal: '安全记录测试',
    memberUserIds: [],
    coordinatorAgentId: agentA.agent.agentId,
    idempotencyKey: 'create-security-project'
  })
  const sensitiveSummary = `${['api', 'key'].join('_')}=${['runtime', 'only', 'material'].join('-')}`
  await expectCode('validation_failed', () => rig.service.submitProjectRecord(agentA.actor, {
    projectId: project.projectId,
    kind: 'summary',
    summary: sensitiveSummary,
    idempotencyKey: 'sensitive-record'
  }))
})

test('8.3 and 10.2 canonical human gateway binds trusted Zulip endpoint to User for personal, ProjectInput and HumanAnswer flows', async (t) => {
  const rig = await createServiceRig(t)
  const a = await bindUser(rig, 'A')
  const b = await bindUser(rig, 'B')
  const c = await bindUser(rig, 'C')
  const agentA = await registerAgent(rig, a, 'A')
  const agentB = await registerAgent(rig, b, 'B')
  const agentC = await registerAgent(rig, c, 'C')
  const endpointA = await rig.authentication.resolveProviderIdentity('zulip', a.realmId, a.providerUserId)
  const endpointB = await rig.authentication.resolveProviderIdentity('zulip', b.realmId, b.providerUserId)
  const endpointC = await rig.authentication.resolveProviderIdentity('zulip', c.realmId, c.providerUserId)
  assert.equal(endpointA.userId, a.userId)
  assert.equal(endpointB.userId, b.userId)
  assert.equal(endpointC.userId, c.userId)

  const personalLocator = {
    type: 'provider_locator',
    provider: 'zulip',
    realmId: a.realmId,
    containerId: 'personal-container',
    topicId: 'stable-personal-topic',
    topicDisplayName: '个人 Session'
  }
  const projection = await rig.service.createProjection(a.actor, {
    agentId: agentA.agent.agentId,
    humanEndpointId: a.endpointId,
    locator: personalLocator,
    displayName: 'A 显式共享给 B 的 Session',
    allowedSenderUserIds: [b.userId],
    idempotencyKey: 'create-shared-projection'
  })
  const remoteA = await rig.service.acceptPersonalProviderMessage(endpointA, {
    locator: personalLocator,
    providerMessageId: 'personal-provider-message-A',
    text: 'A 从手机进入固定 Session',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'personal-provider-event-A'
  })
  assert.equal(remoteA.projectionId, projection.projectionId)
  assert.deepEqual(await rig.service.acceptPersonalProviderMessage(endpointA, {
    locator: personalLocator,
    providerMessageId: 'personal-provider-message-A',
    text: 'A 从手机进入固定 Session',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'personal-provider-event-A'
  }), remoteA)
  await rig.service.acceptPersonalProviderMessage(endpointB, {
    locator: personalLocator,
    providerMessageId: 'personal-provider-message-B',
    text: 'B 通过显式 allowlist 发言',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'personal-provider-event-B'
  })
  await expectCode('permission_denied', () => rig.service.acceptPersonalProviderMessage(endpointC, {
    locator: personalLocator,
    providerMessageId: 'personal-provider-message-C',
    text: 'C 未获共享权限',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'personal-provider-event-C'
  }))
  const personalInbox = await rig.service.pullInbox(agentA.actor, { afterSequence: 0, limit: 20 })
  const personalMessages = personalInbox.messages.filter((message) => message.messageType === 'personal.message.received')
  assert.equal(personalMessages.length, 2)
  assert.deepEqual(personalMessages.map((message) => message.payload.senderUserId), [a.userId, b.userId])
  assert.deepEqual(personalMessages.map((message) => message.payload.humanEndpointId), [a.endpointId, b.endpointId])
  assert.ok(personalMessages.every((message) => message.payload.projectionId === projection.projectionId))

  let project = await rig.service.createProject(a.actor, {
    displayName: 'ProjectInput 与 HumanNeeded',
    goal: '验证人类路由身份、任务和回答',
    memberUserIds: [b.userId],
    coordinatorAgentId: agentA.agent.agentId,
    idempotencyKey: 'create-human-routing-project'
  })
  const projectLocator = {
    type: 'provider_locator',
    provider: 'zulip',
    realmId: a.realmId,
    containerId: 'project-container',
    topicId: 'stable-project-topic',
    topicDisplayName: '多人 Project'
  }
  await rig.service.bindProjectEndpoint(a.actor, {
    projectId: project.projectId,
    locator: projectLocator,
    expectedRevision: null,
    idempotencyKey: 'bind-project-topic'
  })
  const inputB = await rig.service.acceptProjectInput(endpointB, {
    locator: projectLocator,
    providerMessageId: 'project-provider-message-B',
    text: 'B 的 ProjectInput',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'project-provider-event-B'
  })
  assert.equal(inputB.senderUserId, b.userId)
  assert.equal(inputB.sourceHumanEndpointId, b.endpointId)
  const inputBReplay = await rig.service.acceptProjectInput(endpointB, {
    locator: projectLocator,
    providerMessageId: 'project-provider-message-B',
    text: 'B 的 ProjectInput',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'project-provider-event-B-retry'
  })
  assert.equal(inputBReplay.projectInputId, inputB.projectInputId)
  assert.equal([...rig.repository.state.projectInputs.values()].length, 1)
  await expectCode('permission_denied', () => rig.service.acceptProjectInput(endpointC, {
    locator: projectLocator,
    providerMessageId: 'project-provider-message-C',
    text: '非成员 C 不得写 Project',
    occurredAt: rig.clock.now().toISOString(),
    providerEventId: 'project-provider-event-C'
  }))

  project = await rig.repository.getProject(project.projectId)
  let taskB = await rig.service.createTask(a.actor, {
    projectId: project.projectId,
    assigneeAgentId: agentB.agent.agentId,
    title: 'HumanNeeded 任务',
    objective: 'B 需要真人决定',
    completionCriteria: ['收到 B 的定向回答'],
    dependencyTaskIds: [],
    expectedProjectRevision: project.revision,
    idempotencyKey: 'create-human-task-B'
  })
  taskB = await rig.service.transitionTask(agentB.actor, {
    taskId: taskB.taskId,
    executionId: taskB.executionId,
    status: 'accepted',
    expectedRevision: taskB.revision,
    idempotencyKey: 'accept-human-task-B'
  })
  taskB = await rig.service.transitionTask(agentB.actor, {
    taskId: taskB.taskId,
    executionId: taskB.executionId,
    status: 'in_progress',
    expectedRevision: taskB.revision,
    idempotencyKey: 'start-human-task-B'
  })
  const needed = await rig.service.createHumanNeeded(agentB.actor, {
    projectId: project.projectId,
    source: { kind: 'worker', taskId: taskB.taskId, executionId: taskB.executionId,
      expectedTaskRevision: taskB.revision },
    targetUserId: b.userId,
    requiredAssurance: 'verified',
    prompt: '只由 B 回答',
    expiresAt: new Date(rig.clock.now().getTime() + 60_000).toISOString(),
    idempotencyKey: 'human-needed-B'
  })
  const inboxB = await rig.service.pullInbox(b.actor, { afterSequence: 0, limit: 20 })
  assert.ok(inboxB.messages.some((message) => message.payload.request?.targetUserId === b.userId))
  const inboxA = await rig.service.pullInbox(a.actor, { afterSequence: 0, limit: 20 })
  assert.ok(!inboxA.messages.some((message) => message.messageType === 'human.needed'))
  await expectCode('permission_denied', () => rig.service.answerHumanNeeded(endpointA, {
    humanRequestId: needed.humanRequestId,
    requestRevision: needed.revision,
    answer: 'A 不得代答',
    idempotencyKey: 'proxy-human-answer-A'
  }))
  const answerB = await rig.service.answerHumanNeeded(endpointB, {
    humanRequestId: needed.humanRequestId,
    requestRevision: needed.revision,
    answer: 'B 的唯一回答',
    idempotencyKey: 'human-answer-B'
  })
  assert.equal(answerB.answeredByUserId, b.userId)
  assert.equal(answerB.answeredFromHumanEndpointId, b.endpointId)
  assert.equal((await rig.service.answerHumanNeeded(endpointB, {
    humanRequestId: needed.humanRequestId,
    requestRevision: needed.revision,
    answer: 'B 的唯一回答',
    idempotencyKey: 'human-answer-B'
  })).humanAnswerId, answerB.humanAnswerId)

  await expectCode('permission_denied', () => rig.service.publishProjectionMessage(agentB.actor, {
    projectionId: projection.projectionId,
    projectionRevision: projection.revision,
    localItemId: 'local-item-cross-agent',
    kind: 'assistant_final',
    text: 'B Agent 不得替 A Session 发布',
    occurredAt: rig.clock.now().toISOString(),
    idempotencyKey: 'cross-agent-projection-publish'
  }))
  assert.equal(agentC.agent.ownerUserId, c.userId)
})
