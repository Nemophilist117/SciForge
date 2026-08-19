import assert from 'node:assert/strict'
import test from 'node:test'

import { WebSocket } from 'ws'

import {
  AuthenticationService,
  CollaborationService,
  CollaborationWebSocketHub,
  createCollaborationHttpServer
} from '../packages/collaboration-server/src/index.ts'
import {
  FakeClock,
  FakeCollaborationRepository
} from '../test-fixtures/collaboration/fake-adapters.mjs'
import { createUnifiedIdentityServerFixture } from '../test-fixtures/collaboration/unified-identity/server-fixture.mjs'

const BASE_PATH = '/collaboration'
const FAKE_PROVIDER_DIRECTORY = Object.freeze({
  contracts: () => [{
    protocolVersion: '1.0',
    type: 'human_endpoint_provider_contract',
    provider: 'fake-im',
    displayName: 'Fake IM',
    capabilities: {
      textMessages: true,
      stableLocators: true,
      eventCursor: true,
      locatorRename: true,
      locatorMove: true,
      locatorDiscovery: true,
      identityChallenge: true
    },
    onboarding: { realmLabel: 'Realm', accountLabel: 'Account', containerLabel: 'Container', topicLabel: 'Topic' },
    limits: { maxTextLength: 10_000, maxLocatorDisplayLength: 200 }
  }],
  listLocators: async () => ({ locators: [] })
})

function invalidTestOnlyValue(label) {
  return ['INVALID', 'TEST', 'ONLY', label].join('_')
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}${BASE_PATH}`
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function commandBody(index) {
  return {
    protocolVersion: '1.0',
    requestId: `req_Transport${String(index).padStart(5, '0')}`,
    type: 'endpoint.catalog.get',
    provider: 'fake-im'
  }
}

async function postCommand(baseUrl, body, headers = {}) {
  const idempotencyHeader = body.idempotencyKey
    ? { 'idempotency-key': body.idempotencyKey }
    : {}
  return fetch(`${baseUrl}/v1/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...idempotencyHeader, ...headers },
    body: JSON.stringify(body)
  })
}

async function bindUser(identity, slot = 'websocket') {
  const user = await identity.createUser(`${slot} 测试用户`)
  const binding = await identity.bindZulip(user, `transport-${slot}`, {
    zulipUserId: `provider-${slot}-user`
  })
  return { ...user, ...binding }
}

function nextMessage(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) }
    })
    webSocket.once('error', reject)
  })
}

function opened(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once('open', resolve)
    webSocket.once('error', reject)
  })
}

function closed(webSocket) {
  return new Promise((resolve) => webSocket.once('close', (code) => resolve(code)))
}

test('8.4 production HTTP boundary bounds command bodies, rate limits the anonymous catalog and never echoes authorization material', async (t) => {
  const clock = new FakeClock()
  const repository = new FakeCollaborationRepository()
  const authentication = new AuthenticationService(repository, clock.now)
  const service = new CollaborationService({ repository, now: clock.now })
  const server = createCollaborationHttpServer({
    service,
    authentication,
    readiness: async () => true,
    maxBodyBytes: 1_024,
    now: clock.now,
    basePath: BASE_PATH,
    providers: FAKE_PROVIDER_DIRECTORY
  })
  t.after(() => closeServer(server))
  const baseUrl = await listen(server)

  const oversized = commandBody(90)
  oversized.padding = 'x'.repeat(1_200)
  const oversizedResponse = await postCommand(baseUrl, oversized)
  assert.equal(oversizedResponse.status, 413)
  const oversizedText = await oversizedResponse.text()
  assert.equal(oversizedText.includes('x'.repeat(64)), false)
  assert.equal(JSON.parse(oversizedText).error.code, 'payload_too_large')

  for (let index = 1; index <= 120; index += 1) {
    const response = await postCommand(baseUrl, commandBody(index))
    assert.equal(response.status, 200)
  }
  const limited = await postCommand(baseUrl, commandBody(121))
  assert.equal(limited.status, 429)
  const limitedBody = await limited.json()
  assert.equal(limitedBody.type, 'rest.error')
  assert.equal(limitedBody.error.code, 'rate_limited')

  const authorizationMaterial = invalidTestOnlyValue('AUTHORIZATION')
  const protectedResponse = await postCommand(baseUrl, {
    protocolVersion: '1.0',
    requestId: 'req_TransportAuth1',
    type: 'user.get',
    userId: 'usr_TransportUsr1'
  }, { authorization: `${['Bear', 'er'].join('')} ${authorizationMaterial}` })
  assert.equal(protectedResponse.status, 401)
  assert.equal((await protectedResponse.text()).includes(authorizationMaterial), false)
})

test('8.4 production WebSocket boundary enforces origin, authenticated routing, bounded frames and minimal notifications', async (t) => {
  const clock = new FakeClock()
  const repository = new FakeCollaborationRepository()
  const identity = await createUnifiedIdentityServerFixture({ repository, now: clock.now })
  const authentication = identity.authentication
  const hub = new CollaborationWebSocketHub()
  const service = new CollaborationService({ repository, notifier: hub, now: clock.now })
  const participant = await bindUser(identity)
  const server = createCollaborationHttpServer({
    service,
    authentication,
    readiness: async () => true,
    now: clock.now,
    basePath: BASE_PATH
  })
  hub.attach(server, {
    authentication,
    basePath: BASE_PATH,
    allowedOrigins: ['https://desktop.invalid'],
    now: clock.now
  })
  t.after(async () => {
    await hub.close()
    await closeServer(server)
    await identity.close()
  })
  const baseUrl = await listen(server)
  const webSocketUrl = baseUrl.replace(/^http:/u, 'ws:')

  const webSocket = new WebSocket(`${webSocketUrl}/v1/events`, {
    origin: 'https://desktop.invalid',
    headers: { authorization: `${['Bear', 'er'].join('')} ${participant.accessToken}` }
  })
  const readyMessage = nextMessage(webSocket)
  await opened(webSocket)
  assert.equal((await readyMessage).type, 'connection.ready')

  const pongMessage = nextMessage(webSocket)
  webSocket.send(JSON.stringify({
    protocolVersion: '1.0',
    type: 'connection.ping',
    nonce: 'bounded-ping',
    sentAt: clock.now().toISOString()
  }))
  const pong = await pongMessage
  assert.equal(pong.type, 'connection.pong')
  assert.equal(pong.nonce, 'bounded-ping')

  const availabilityMessage = nextMessage(webSocket)
  hub.notifyInboxAvailable({ kind: 'user', id: participant.userId }, 7)
  assert.deepEqual(await availabilityMessage, {
    protocolVersion: '1.0',
    type: 'inbox.available',
    recipientType: 'user',
    highestSequence: 7
  })

  const closeCode = closed(webSocket)
  webSocket.send('x'.repeat(8 * 1_024 + 1))
  assert.equal(await closeCode, 1009)

  const blocked = new WebSocket(`${webSocketUrl}/v1/events`, {
    origin: 'https://untrusted.invalid',
    headers: { authorization: `${['Bear', 'er'].join('')} ${participant.accessToken}` }
  })
  const blockedStatus = await new Promise((resolve) => {
    blocked.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    blocked.once('error', () => resolve(0))
  })
  assert.equal(blockedStatus, 403)
})

test('2.5 production HTTP keeps a Device-linked Agent with its OIDC owner, redacts denial, and cascades Device revocation', async (t) => {
  const clock = new FakeClock()
  const repository = new FakeCollaborationRepository()
  const identity = await createUnifiedIdentityServerFixture({ repository, now: clock.now })
  const authentication = identity.authentication
  const service = new CollaborationService({ repository, now: clock.now })
  const a = await identity.createUser('transfer-a 测试用户')
  const b = await identity.createUser('transfer-b 测试用户')
  const device = await identity.createDevice(a, 'transport-transfer-agent', {
    displayName: '待保护 Device',
    capabilitySummary: ['agent-runtime']
  })
  const registered = await service.registerAgent(a.actor, {
    deviceId: device.device.deviceId,
    displayName: '待转移 Agent',
    nodeType: 'desktop',
    capabilities: ['agent-runtime'],
    idempotencyKey: 'idem_transport_register_agent'
  })
  const server = createCollaborationHttpServer({
    service,
    authentication,
    identities: identity.identities,
    readiness: async () => true,
    now: clock.now,
    basePath: BASE_PATH
  })
  t.after(async () => {
    await closeServer(server)
    await identity.close()
  })
  const baseUrl = await listen(server)
  const transfer = {
    protocolVersion: '1.0',
    requestId: 'req_TransferAgent1',
    type: 'agent.owner.transfer',
    idempotencyKey: 'idem_transport_agent_transfer',
    agentId: registered.agent.agentId,
    targetUserId: b.userId,
    expectedRevision: registered.agent.revision
  }
  const authorization = `${['Bear', 'er'].join('')} ${a.accessToken}`
  const response = await postCommand(baseUrl, transfer, { authorization })
  assert.equal(response.status, 403)
  const body = await response.json()
  assert.equal(body.type, 'rest.error')
  assert.equal(body.error.code, 'assurance_insufficient')
  assert.equal(JSON.stringify(body).includes(registered.deviceCredential), false)
  const originalAgentActor = await authentication.resolveBearer(registered.deviceCredential)
  assert.equal(originalAgentActor.userId, a.userId)
  assert.equal(originalAgentActor.deviceId, device.device.deviceId)
  assert.ok(repository.state.auditEvents.some((event) => (
    event.action === 'agent.owner.transfer' &&
    event.actorUserId === a.userId &&
    event.outcome === 'rejected' &&
    event.metadata.errorCode === 'assurance_insufficient'
  )))

  const revoked = await identity.identities.revokeDevice(
    a.actor,
    device.device.deviceId,
    'idem_transport_revoke_device'
  )
  assert.equal(revoked.device.status, 'revoked')
  await assert.rejects(() => authentication.resolveBearer(registered.deviceCredential), {
    code: 'credential_revoked'
  })
})
