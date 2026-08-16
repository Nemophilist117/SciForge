import type { AddressInfo } from 'node:net'

import type { HumanEndpointProviderContract } from '@sciforge/collaboration-contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeCollaborationRepository } from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import { createCollaborationHttpServer } from './api.js'
import { AuthenticationService } from './auth.js'
import { CollaborationService } from './service.js'

const now = () => new Date('2026-08-15T02:00:00.000Z')
const servers: ReturnType<typeof createCollaborationHttpServer>[] = []

const providerContract: HumanEndpointProviderContract = {
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
  onboarding: { realmLabel: 'Realm', accountLabel: 'Account', containerLabel: 'Stream', topicLabel: 'Topic' },
  limits: { maxTextLength: 10_000, maxLocatorDisplayLength: 200 }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('production HTTP anonymous bootstrap boundary', () => {
  it('exposes only catalog and pairing begin/redeem without a bearer while keeping bounds and route limits', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const server = createCollaborationHttpServer({
      service,
      authentication,
      readiness: async () => true,
      maxBodyBytes: 1_024,
      now,
      providers: {
        contracts: () => [providerContract],
        listLocators: async () => ({ locators: [] })
      }
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const catalog = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_BootstrapCatalog01', type: 'endpoint.catalog.get'
    })
    expect(catalog.status).toBe(200)
    await expect(catalog.json()).resolves.toMatchObject({
      type: 'endpoint.catalog', providers: [{ provider: 'fake-im' }]
    })

    const firstBeginBody = pairingBegin(1)
    const firstBegin = await postCommand(baseUrl, firstBeginBody)
    expect(firstBegin.status).toBe(200)
    const begun = await firstBegin.json() as { pollSecret: string }
    expect(typeof begun.pollSecret).toBe('string')

    for (let index = 2; index <= 10; index += 1) {
      expect((await postCommand(baseUrl, pairingBegin(index))).status).toBe(200)
    }
    const limited = await postCommand(baseUrl, pairingBegin(11))
    expect(limited.status).toBe(429)
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } })

    const redeemBody = {
      protocolVersion: '1.0', requestId: 'req_BootstrapRedeem01', type: 'pairing.redeem',
      idempotencyKey: 'idem_bootstrap_redeem_01', pollSecret: begun.pollSecret
    }
    const redeem = await postCommand(baseUrl, redeemBody)
    expect(redeem.status).toBe(200)
    await expect(redeem.json()).resolves.toMatchObject({ type: 'pairing.pending' })

    const catalogAfterPairingLimit = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_BootstrapCatalog02', type: 'endpoint.catalog.get'
    })
    expect(catalogAfterPairingLimit.status).toBe(200)

    const protectedResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_BootstrapProtected1', type: 'user.get',
      userId: 'usr_123456789012'
    })
    expect(protectedResponse.status).toBe(401)

    const invalidRequestId = 'ATTACKER_PRIVATE_VALUE'
    const invalidRequest = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: invalidRequestId, type: 'endpoint.catalog.get'
    })
    expect(invalidRequest.status).toBe(400)
    const invalidRequestText = await invalidRequest.text()
    expect(invalidRequestText).not.toContain(invalidRequestId)
    expect(JSON.parse(invalidRequestText)).toMatchObject({
      type: 'rest.error',
      requestId: expect.stringMatching(/^req_[A-Za-z0-9]{12,64}$/u),
      error: { code: 'validation_error' }
    })

    const oversized = await fetch(`${baseUrl}/v1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: '1.0', requestId: 'req_BootstrapOversize1',
        type: 'endpoint.catalog.get', padding: 'x'.repeat(2_000) })
    })
    expect(oversized.status).toBe(413)
    const oversizedText = await oversized.text()
    expect(oversizedText).not.toContain('x'.repeat(64))
  })

  it('rejects pairing for an unavailable provider without persisting a challenge', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const server = createCollaborationHttpServer({ service, authentication, readiness: async () => true, now })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const response = await postCommand(`http://127.0.0.1:${address.port}`, {
      ...pairingBegin(99),
      requestId: 'req_BootstrapUnavailable01',
      idempotencyKey: 'idem_bootstrap_unavailable_01',
      provider: 'not-installed'
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'provider_unavailable' } })
    expect(repository.state.challenges.size).toBe(0)
  })

  it('serves capability, progress, result, and ResourceRef entities through canonical authenticated commands', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'resource-owner', 'provider-resource-owner')
    const worker = await onboard(service, authentication, 'resource-worker', 'provider-resource-worker')
    const ownerAgent = await service.registerAgent(owner.actor, {
      installationId: 'ins_ApiResource01', displayName: 'Resource coordinator', nodeType: 'desktop',
      capabilities: ['research.coordinate'], idempotencyKey: 'idem_api_resource_owner_agent_01'
    })
    const workerAgent = await service.registerAgent(worker.actor, {
      installationId: 'ins_ApiResource02', displayName: 'Resource worker', nodeType: 'desktop',
      capabilities: ['research.execute'], idempotencyKey: 'idem_api_resource_worker_agent_01'
    })
    if (!ownerAgent.deviceCredential || !workerAgent.deviceCredential) throw new Error('Expected one-time device credentials')
    const coordinator = await authentication.resolveBearer(ownerAgent.deviceCredential)
    if (coordinator.kind !== 'agent_device') throw new Error('Expected coordinator Agent actor')
    const project = await service.createProject(owner.actor, {
      displayName: 'Resource API test', goal: 'Verify canonical metadata-only references.',
      memberUserIds: [owner.userId, worker.userId], coordinatorAgentId: ownerAgent.agent.agentId,
      idempotencyKey: 'idem_api_resource_project_01'
    })
    const task = await service.createTask(coordinator, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Publish ResourceRef', objective: 'Publish one HTTPS metadata reference.',
      completionCriteria: ['Reference resolves through HTTPS'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_api_resource_task_01'
    })
    const server = createCollaborationHttpServer({ service, authentication, readiness: async () => true, now })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const acceptedResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskAccepted1', type: 'task.transition',
      idempotencyKey: 'idem_api_task_accept_01', taskId: task.taskId,
      expectedRevision: task.revision, status: 'accepted'
    }, workerAgent.deviceCredential)
    const accepted = await acceptedResponse.json() as { entity: { revision: number } }
    expect(acceptedResponse.status).toBe(200)

    const staleRequestId = 'req_ApiRevisionConflict1'
    const staleResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: staleRequestId, type: 'task.transition',
      idempotencyKey: 'idem_api_task_stale_01', taskId: task.taskId,
      expectedRevision: task.revision, status: 'accepted'
    }, workerAgent.deviceCredential)
    expect(staleResponse.status).toBe(409)
    await expect(staleResponse.json()).resolves.toMatchObject({
      requestId: staleRequestId,
      error: {
        code: 'revision_conflict',
        expectedRevision: task.revision,
        currentRevision: accepted.entity.revision
      }
    })

    const capabilityResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiCapability001',
      type: 'project.capability_directory.get', projectId: project.projectId
    }, owner.userCredential)
    expect(capabilityResponse.status).toBe(200)
    const capabilityText = await capabilityResponse.text()
    expect(capabilityText).not.toContain('installationId')
    expect(capabilityText).not.toContain('credentialVersion')
    const capability = JSON.parse(capabilityText) as { entity: { type: string; projectId: string;
      projectRevision: number; agents: Array<{ agentId: string; ownerUserId: string }> } }
    expect(capability.entity).toMatchObject({ type: 'project_capability_directory', projectId: project.projectId,
      projectRevision: project.revision + 1 })
    expect(capability.entity.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: ownerAgent.agent.agentId, ownerUserId: owner.userId }),
      expect.objectContaining({ agentId: workerAgent.agent.agentId, ownerUserId: worker.userId })
    ]))

    const createBody = {
      protocolVersion: '1.0', requestId: 'req_ApiResourceCreate01', type: 'resource.create',
      idempotencyKey: 'idem_api_resource_create_01', projectId: project.projectId, taskId: task.taskId,
      expectedTaskRevision: accepted.entity.revision,
      provider: 'example-content', externalId: 'api-document-42', kind: 'shared_document',
      name: 'API resource record', openUrl: 'https://content.example.invalid/api-document-42', version: '1'
    }
    expect(accepted).toMatchObject({ entity: { revision: 2 } })
    const createdResponse = await postCommand(baseUrl, createBody, workerAgent.deviceCredential)
    expect(createdResponse.status).toBe(200)
    expect(repository.state.resourceRefs.size).toBe(1)
    const created = await createdResponse.json() as { entity: { resourceRefId: string; revision: number } }
    expect(created.entity).toMatchObject({ type: 'resource_ref', projectId: project.projectId,
      taskId: task.taskId, taskRevision: accepted.entity.revision,
      createdByUserId: worker.userId, createdByAgentId: workerAgent.agent.agentId,
      status: 'available', revision: 1 })

    const fetched = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceGet001', type: 'resource.get',
      resourceRefId: created.entity.resourceRefId
    }, worker.userCredential)
    expect(fetched.status).toBe(200)
    await expect(fetched.json()).resolves.toMatchObject({ entity: { resourceRefId: created.entity.resourceRefId,
      openUrl: createBody.openUrl, status: 'available' } })

    const invalidated = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceInvalid1', type: 'resource.invalidate',
      idempotencyKey: 'idem_api_resource_invalidate_01', resourceRefId: created.entity.resourceRefId,
      expectedRevision: created.entity.revision
    }, workerAgent.deviceCredential)
    expect(invalidated.status).toBe(200)
    await expect(invalidated.json()).resolves.toMatchObject({ entity: { resourceRefId: created.entity.resourceRefId,
      status: 'invalidated', revision: 2, invalidatedAt: now().toISOString() } })

    const forbiddenBody = await postCommand(baseUrl, {
      ...createBody, requestId: 'req_ApiResourceBody001', idempotencyKey: 'idem_api_resource_body_01',
      externalId: 'api-document-body', body: 'private document content'
    }, workerAgent.deviceCredential)
    expect(forbiddenBody.status).toBe(400)
    await expect(forbiddenBody.json()).resolves.toMatchObject({ error: { code: 'validation_error' } })

    const forbiddenCredential = await postCommand(baseUrl, {
      ...createBody, requestId: 'req_ApiResourceSecret1', idempotencyKey: 'idem_api_resource_secret_01',
      externalId: 'api-document-secret', openUrl: 'https://content.example.invalid/resource?%73%69%67=test-only'
    }, workerAgent.deviceCredential)
    expect(forbiddenCredential.status).toBe(400)
    await expect(forbiddenCredential.json()).resolves.toMatchObject({ error: { code: 'validation_error' } })

    const runningResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskRunning01', type: 'task.transition',
      idempotencyKey: 'idem_api_task_running_01', taskId: task.taskId,
      expectedRevision: accepted.entity.revision, status: 'running'
    }, workerAgent.deviceCredential)
    const running = await runningResponse.json() as { entity: { revision: number } }
    expect(runningResponse.status).toBe(200)
    const progressResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskProgress01', type: 'task.progress.report',
      idempotencyKey: 'idem_api_task_progress_01', taskId: task.taskId,
      expectedRevision: running.entity.revision, percent: 60, summary: 'Resource metadata verified.'
    }, workerAgent.deviceCredential)
    expect(progressResponse.status).toBe(200)
    const progress = await progressResponse.json() as { entity: { revision: number } }
    expect(progress).toMatchObject({ entity: { status: 'running',
      progress: { percent: 60, summary: 'Resource metadata verified.', reportedAt: now().toISOString() } } })
    const completedResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskComplete01', type: 'task.transition',
      idempotencyKey: 'idem_api_task_complete_01', taskId: task.taskId,
      expectedRevision: progress.entity.revision, status: 'succeeded', resultSummary: 'HTTPS ResourceRef verified.'
    }, workerAgent.deviceCredential)
    expect(completedResponse.status).toBe(200)
    await expect(completedResponse.json()).resolves.toMatchObject({ entity: {
      status: 'succeeded', resultSummary: 'HTTPS ResourceRef verified.'
    } })
    const queriedTask = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskGet00001', type: 'task.get', taskId: task.taskId
    }, owner.userCredential)
    expect(queriedTask.status).toBe(200)
    await expect(queriedTask.json()).resolves.toMatchObject({ entity: {
      status: 'succeeded', resultSummary: 'HTTPS ResourceRef verified.'
    } })
  })
})

function pairingBegin(index: number) {
  return {
    protocolVersion: '1.0',
    requestId: `req_BootstrapBegin${String(index).padStart(2, '0')}`,
    type: 'pairing.begin',
    idempotencyKey: `idem_bootstrap_begin_${String(index).padStart(2, '0')}`,
    provider: 'fake-im',
    realmId: 'fake-realm',
    requestedDisplayName: `Bootstrap User ${index}`
  }
}

async function onboard(
  service: CollaborationService,
  authentication: AuthenticationService,
  label: string,
  providerUserId: string
) {
  const begun = await service.beginPairing({ provider: 'fake-im', realmId: 'fake-realm',
    requestedDisplayName: label, idempotencyKey: `idem_api_pairing_begin_${label}` })
  await service.verifyPairingFromProvider({ provider: 'fake-im', realmId: 'fake-realm', providerUserId,
    providerDisplayName: label, challengeCode: String(begun.challengeCode),
    providerEventId: `event-api-pairing-${label}`, assurance: 'verified' })
  const redeemed = await service.redeemPairing({ pollSecret: String(begun.pollSecret),
    idempotencyKey: `idem_api_pairing_redeem_${label}` })
  if (!redeemed.userCredential || !redeemed.userId) throw new Error('Expected one-time user credential')
  const actor = await authentication.resolveBearer(redeemed.userCredential)
  if (actor.kind !== 'user') throw new Error('Expected User actor')
  return { actor, userId: redeemed.userId, userCredential: redeemed.userCredential }
}

function postCommand(baseUrl: string, body: Record<string, unknown>, bearer?: string): Promise<Response> {
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined
  return fetch(`${baseUrl}/v1/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body)
  })
}
