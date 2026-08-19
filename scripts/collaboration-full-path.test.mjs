import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CollaborationService,
  toAgent,
  toInboxMessage,
  toProjection
} from '../packages/collaboration-server/src/index.ts'
import {
  CollaborationLocalStore,
  ProjectionCoordinator,
  localProjectionFromRemote
} from '../packages/domains/collaboration/src/main.ts'
import {
  FakeAgentExecutionHost,
  FakeAgentThreadsHost,
  FakeClock,
  FakeCollaborationRepository,
  FakeCollaborationStateBackend,
  FakeHumanEndpointDeliveryWorker,
  FakeHumanProvider,
  FakeServiceProjectionOutbox
} from '../test-fixtures/collaboration/fake-adapters.mjs'
import { createUnifiedIdentityServerFixture } from '../test-fixtures/collaboration/unified-identity/server-fixture.mjs'

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(`timed out waiting for ${label}`)
}

async function bindParticipant(identity) {
  const user = await identity.createUser('全链路用户')
  const binding = await identity.bindZulip(user, 'full-path', {
    zulipUserId: 'full-path-provider-user'
  })
  return {
    ...user,
    ...binding,
    userActor: user.actor,
    humanEndpointId: binding.endpointId
  }
}

test('10.2 canonical trusted Zulip binding → server → fixed desktop Session → server → provider survives retry and offline delivery', async (t) => {
  const clock = new FakeClock()
  const repository = new FakeCollaborationRepository()
  const service = new CollaborationService({ repository, now: clock.now })
  const identity = await createUnifiedIdentityServerFixture({ repository, now: clock.now })
  t.after(() => identity.close())
  const participant = await bindParticipant(identity)
  const device = await identity.createDevice(participant, 'full-path-agent', {
    displayName: '全链路 Device',
    capabilitySummary: ['agent-runtime']
  })
  const provider = new FakeHumanProvider({ provider: 'zulip', realmId: participant.realmId })
  const registered = await service.registerAgent(participant.userActor, {
    deviceId: device.device.deviceId,
    displayName: '全链路 Agent',
    nodeType: 'desktop',
    capabilities: ['agent-runtime'],
    idempotencyKey: 'full-path-register-agent'
  })
  const agentActor = await identity.authentication.resolveBearer(registered.deviceCredential)
  const locator = {
    type: 'provider_locator',
    provider: 'zulip',
    realmId: participant.realmId,
    containerId: 'full-path-container',
    topicId: 'full-path-stable-topic',
    topicDisplayName: '固定个人 Session'
  }
  const projection = await service.createProjection(participant.userActor, {
    agentId: registered.agent.agentId,
    humanEndpointId: participant.humanEndpointId,
    locator,
    displayName: '手机与桌面固定 Session',
    allowedSenderUserIds: [],
    idempotencyKey: 'full-path-create-projection'
  })

  const backend = new FakeCollaborationStateBackend()
  const store = new CollaborationLocalStore(backend)
  await store.open()
  const threadId = `thread-${projection.projectionId}`
  await store.transact((draft) => {
    draft.agents.push(toAgent(registered.agent))
    draft.projections.push(localProjectionFromRemote(toProjection(projection), {
      runtimeId: 'codex',
      threadId,
      bindingMode: 'existing'
    }))
  })
  const agentExecution = new FakeAgentExecutionHost()
  const agentThreads = new FakeAgentThreadsHost()
  const cloudOutbox = new FakeServiceProjectionOutbox({ service, actor: agentActor })
  const coordinator = new ProjectionCoordinator({
    store,
    agentExecution,
    agentThreads,
    cloudOutbox,
    localAgentId: () => registered.agent.agentId,
    now: clock.now
  })
  provider.onEvent((event) => service.acceptPersonalProviderMessage(participant.endpointActor, event))

  const mobileEvent = {
    locator,
    providerMessageId: 'full-path-mobile-message-1',
    text: '手机进入同一个桌面 Session',
    occurredAt: clock.now().toISOString(),
    providerEventId: 'full-path-provider-event-1'
  }
  await provider.emit(mobileEvent)
  await provider.emit(mobileEvent)
  const serverInbox = await service.pullInbox(agentActor, { afterSequence: 0, limit: 20 })
  assert.equal(serverInbox.messages.length, 1)
  const accepted = await coordinator.acceptPersonalInbox(toInboxMessage(serverInbox.messages[0]))
  assert.equal(accepted.duplicate, false)
  await waitUntil(() => agentExecution.requests.length === 1, 'fixed Session Agent execution')
  assert.equal(agentExecution.requests[0].threadId, threadId)
  assert.equal(agentExecution.requests[0].prompt, mobileEvent.text)

  agentThreads.setTurn({
    runtimeId: 'codex',
    threadId,
    turnId: 'fake-turn-1',
    messages: [{
      itemId: 'full-path-assistant-item-1',
      turnId: 'fake-turn-1',
      kind: 'assistant-message',
      text: 'Agent 回复返回手机',
      occurredAt: clock.now().toISOString()
    }]
  })
  provider.setOnline(false)
  agentExecution.completeNext({ text: 'Agent 回复返回手机', runtimeId: 'codex', threadId })
  await coordinator.waitForIdle(projection.projectionId)
  assert.equal(cloudOutbox.deliveries.length, 1)

  const interruptedDelivery = new FakeHumanEndpointDeliveryWorker({
    service,
    actor: participant.endpointActor,
    provider
  })
  await assert.rejects(() => interruptedDelivery.drain(), { code: 'resource_offline' })
  assert.equal(interruptedDelivery.afterSequence, 0)
  assert.equal(provider.outbound.length, 0)

  provider.setOnline(true)
  const recoveredDelivery = new FakeHumanEndpointDeliveryWorker({
    service,
    actor: participant.endpointActor,
    provider
  })
  await recoveredDelivery.drain()
  assert.equal(provider.outbound.length, 1)
  assert.equal(provider.outbound[0].type, 'projection.message.outbound')
  assert.equal(provider.outbound[0].projectionId, projection.projectionId)
  assert.equal(provider.outbound[0].text, 'Agent 回复返回手机')

  await coordinator.mirrorDesktopEvent({
    runtimeId: 'codex',
    threadId,
    itemId: 'full-path-desktop-item-1',
    kind: 'user-message',
    text: '桌面消息也同步到手机',
    occurredAt: clock.now().toISOString()
  })
  const desktopDelivery = new FakeHumanEndpointDeliveryWorker({
    service,
    actor: participant.endpointActor,
    provider,
    afterSequence: recoveredDelivery.afterSequence
  })
  await desktopDelivery.drain()
  assert.equal(provider.outbound.length, 2)
  assert.equal(provider.outbound[1].kind, 'user_message')
  assert.equal(provider.outbound[1].text, '桌面消息也同步到手机')
  assert.equal(agentExecution.requests.length, 1)
})
