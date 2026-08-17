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
  it('serves the memory-only A console under the configured base path with strict browser headers', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const server = createCollaborationHttpServer({
      service,
      authentication,
      readiness: async () => true,
      basePath: '/collaboration'
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const redirect = await fetch(`${baseUrl}/collaboration/console`, { redirect: 'manual' })
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('/collaboration/console/')

    const page = await fetch(`${baseUrl}/collaboration/console/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    const html = await page.text()
    expect(html).toContain('SciForge · 协同控制塔')
    expect(html).toContain('href="app.css"')
    expect(html).not.toContain('localStorage')

    const script = await fetch(`${baseUrl}/collaboration/console/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toContain("consolePath.replace(/\\/console\\/$/u, '/v1/commands')")

    const missing = await fetch(`${baseUrl}/collaboration/console/missing`)
    expect(missing.status).toBe(404)
  })

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
    const task = await service.createTask(owner.actor, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Publish ResourceRef', objective: 'Publish one HTTPS metadata reference.',
      completionCriteria: ['Reference resolves through HTTPS'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_api_resource_task_01'
    })
    const projectRecord = await service.submitProjectRecord(worker.actor, {
      projectId: project.projectId, kind: 'observation', summary: 'A bounded API-visible observation.',
      idempotencyKey: 'idem_api_project_record_submit_01'
    })
    const server = createCollaborationHttpServer({ service, authentication, readiness: async () => true, now })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const currentProject = repository.state.projects.get(project.projectId)
    if (!currentProject) throw new Error('Expected current Project')
    const governedTaskBody = {
      protocolVersion: '1.0', requestId: 'req_ApiGovernedTask01', type: 'task.create',
      idempotencyKey: 'idem_api_governed_task_01', projectId: project.projectId,
      expectedRevision: currentProject.revision, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Owner-confirmed API task', objective: 'Verify the authenticated human assignment boundary.',
      completionCriteria: ['Agent cannot create or cancel the assignment'], dependencyTaskIds: []
    }
    const agentTaskCreate = await postCommand(baseUrl, {
      ...governedTaskBody, requestId: 'req_ApiAgentTaskCreate1', idempotencyKey: 'idem_api_agent_task_create_01'
    }, ownerAgent.deviceCredential)
    expect(agentTaskCreate.status).toBe(403)
    await expect(agentTaskCreate.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } })
    const ownerTaskCreate = await postCommand(baseUrl, governedTaskBody, owner.userCredential)
    expect(ownerTaskCreate.status).toBe(200)
    const governedTask = await ownerTaskCreate.json() as { entity: { taskId: string; revision: number } }
    const agentTaskCancel = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiAgentTaskCancel1', type: 'task.transition',
      idempotencyKey: 'idem_api_agent_task_cancel_01', taskId: governedTask.entity.taskId,
      expectedRevision: governedTask.entity.revision, status: 'cancelled'
    }, ownerAgent.deviceCredential)
    expect(agentTaskCancel.status).toBe(403)
    await expect(agentTaskCancel.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } })
    const ownerTaskCancel = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOwnerTaskCancel1', type: 'task.transition',
      idempotencyKey: 'idem_api_owner_task_cancel_01', taskId: governedTask.entity.taskId,
      expectedRevision: governedTask.entity.revision, status: 'cancelled'
    }, owner.userCredential)
    expect(ownerTaskCancel.status).toBe(200)
    await expect(ownerTaskCancel.json()).resolves.toMatchObject({ entity: { status: 'cancelled' } })

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
      projectRevision: project.revision + 2 })
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

    const fetchedProjectRecord = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiProjectRecord01', type: 'project_record.get',
      projectRecordId: projectRecord.projectRecordId
    }, workerAgent.deviceCredential)
    expect(fetchedProjectRecord.status).toBe(200)
    await expect(fetchedProjectRecord.json()).resolves.toMatchObject({
      type: 'rest.entity',
      entity: {
        type: 'project_record', projectRecordId: projectRecord.projectRecordId,
        projectId: project.projectId, authorUserId: worker.userId,
        body: 'A bounded API-visible observation.', status: 'proposed'
      }
    })

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
    const inboxCountBeforeReplay = [...repository.state.inboxes.values()]
      .reduce((count, messages) => count + messages.length, 0)
    const progressReplayResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskProgress02', type: 'task.progress.report',
      idempotencyKey: 'idem_api_task_progress_01', taskId: task.taskId,
      expectedRevision: running.entity.revision, percent: 60, summary: 'Resource metadata verified.'
    }, workerAgent.deviceCredential)
    expect(progressReplayResponse.status).toBe(200)
    const progressReplay = await progressReplayResponse.json() as { requestId: string; entity: { revision: number } }
    expect(progressReplay.requestId).toBe('req_ApiTaskProgress02')
    expect(progressReplay.entity).toEqual(progress.entity)
    expect([...repository.state.inboxes.values()].reduce((count, messages) => count + messages.length, 0))
      .toBe(inboxCountBeforeReplay)
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

  it('publishes owner-confirmed reassignment and current-bearer revocation without accepting caller identity', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'command-owner', 'provider-command-owner')
    const worker = await onboard(service, authentication, 'command-worker', 'provider-command-worker')
    const ownerAgent = await service.registerAgent(owner.actor, {
      installationId: 'ins_ApiCommand001', displayName: 'Command coordinator', nodeType: 'desktop',
      capabilities: ['research.coordinate'], idempotencyKey: 'idem_api_command_owner_agent_01'
    })
    const workerAgent = await service.registerAgent(worker.actor, {
      installationId: 'ins_ApiCommand002', displayName: 'Command worker', nodeType: 'desktop',
      capabilities: ['research.execute'], idempotencyKey: 'idem_api_command_worker_agent_01'
    })
    if (!ownerAgent.deviceCredential || !workerAgent.deviceCredential) throw new Error('Expected one-time device credentials')
    const coordinator = await authentication.resolveBearer(ownerAgent.deviceCredential)
    const workerDevice = await authentication.resolveBearer(workerAgent.deviceCredential)
    if (coordinator.kind !== 'agent_device' || workerDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')
    const project = await service.createProject(owner.actor, {
      displayName: 'Public command test', goal: 'Verify retry and credential revocation boundaries.',
      memberUserIds: [owner.userId, worker.userId], coordinatorAgentId: ownerAgent.agent.agentId,
      budgets: { maxTasks: 4, maxTasksPerRound: 4, maxTaskRetries: 2, maxCoordinationRounds: 2 },
      idempotencyKey: 'idem_api_command_project_01'
    })
    const task = await service.createTask(owner.actor, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Fail safely', objective: 'Produce a bounded failure for reassignment.',
      completionCriteria: ['Failure is machine readable'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_api_command_task_01'
    })
    const accepted = await service.transitionTask(workerDevice, { taskId: task.taskId, status: 'accepted',
      expectedRevision: task.revision, idempotencyKey: 'idem_api_command_task_accept_01' })
    const running = await service.transitionTask(workerDevice, { taskId: task.taskId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_api_command_task_run_01' })
    const failed = await service.transitionTask(workerDevice, { taskId: task.taskId, status: 'failed',
      expectedRevision: running.revision, safeFailureCode: 'retry_required',
      idempotencyKey: 'idem_api_command_task_fail_01' })

    const server = createCollaborationHttpServer({ service, authentication, readiness: async () => true, now })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const retryBody = {
      protocolVersion: '1.0', requestId: 'req_ApiTaskRetry0001', type: 'task.retry',
      idempotencyKey: 'idem_api_task_retry_public_01', taskId: task.taskId,
      assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: failed.revision
    }

    const workerRetry = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryWrong1', idempotencyKey: 'idem_api_task_retry_wrong_01'
    }, workerAgent.deviceCredential)
    expect(workerRetry.status).toBe(403)
    await expect(workerRetry.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } })

    const coordinatorReassignment = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryAgent1', idempotencyKey: 'idem_api_task_retry_agent_01'
    }, ownerAgent.deviceCredential)
    expect(coordinatorReassignment.status).toBe(403)
    await expect(coordinatorReassignment.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } })

    const retriedResponse = await postCommand(baseUrl, retryBody, owner.userCredential)
    expect(retriedResponse.status).toBe(200)
    const retried = await retriedResponse.json() as { entity: { revision: number } }
    expect(retried).toMatchObject({ entity: {
      taskId: task.taskId, assigneeAgentId: ownerAgent.agent.agentId,
      status: 'offered', attempt: 2, revision: failed.revision + 1
    } })
    const replayedResponse = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryReplay1'
    }, owner.userCredential)
    expect(replayedResponse.status).toBe(200)
    await expect(replayedResponse.json()).resolves.toMatchObject({ entity: {
      taskId: task.taskId, revision: retried.entity.revision, attempt: 2
    } })
    const retryOffers = (repository.state.inboxes.get(`agent:${ownerAgent.agent.agentId}`) ?? [])
      .filter((message: { messageType: string; payload: { taskId?: string } }) => (
        message.messageType === 'task.offered' && message.payload.taskId === task.taskId
      ))
    expect(retryOffers).toHaveLength(1)

    const staleRetry = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryStale01', idempotencyKey: 'idem_api_task_retry_stale_01',
      assigneeAgentId: workerAgent.agent.agentId
    }, owner.userCredential)
    expect(staleRetry.status).toBe(409)
    await expect(staleRetry.json()).resolves.toMatchObject({ error: {
      code: 'revision_conflict', expectedRevision: failed.revision, currentRevision: retried.entity.revision
    } })
    const oldWorkerWrite = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOldWorkerWrite1', type: 'task.transition',
      idempotencyKey: 'idem_api_old_worker_write_01', taskId: task.taskId,
      expectedRevision: retried.entity.revision, status: 'accepted'
    }, workerAgent.deviceCredential)
    expect(oldWorkerWrite.status).toBe(403)
    await expect(oldWorkerWrite.json()).resolves.toMatchObject({ error: { code: 'permission_denied' } })

    const currentProject = (await service.getProject(owner.actor, project.projectId)).project
    const activeTask = await service.createTask(owner.actor, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Reassign while active', objective: 'Exercise owner-confirmed proactive reassignment over HTTP.',
      completionCriteria: ['Only the owner can change the current assignee'], dependencyTaskIds: [],
      expectedProjectRevision: currentProject.revision, idempotencyKey: 'idem_api_active_reassign_task_01'
    })
    const activeReassignmentBody = {
      protocolVersion: '1.0', requestId: 'req_ApiActiveReassign1', type: 'task.retry',
      idempotencyKey: 'idem_api_active_reassign_owner_01', taskId: activeTask.taskId,
      assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: activeTask.revision
    }
    const coordinatorActiveReassignment = await postCommand(baseUrl, {
      ...activeReassignmentBody, requestId: 'req_ApiActiveAgent001',
      idempotencyKey: 'idem_api_active_reassign_agent_01'
    }, ownerAgent.deviceCredential)
    expect(coordinatorActiveReassignment.status).toBe(403)
    await expect(coordinatorActiveReassignment.json()).resolves.toMatchObject({
      error: { code: 'permission_denied' }
    })
    const ownerActiveReassignment = await postCommand(baseUrl, activeReassignmentBody, owner.userCredential)
    expect(ownerActiveReassignment.status).toBe(200)
    await expect(ownerActiveReassignment.json()).resolves.toMatchObject({ entity: {
      taskId: activeTask.taskId, assigneeAgentId: ownerAgent.agent.agentId,
      status: 'offered', attempt: 2, revision: activeTask.revision + 1
    } })
    const activeOffers = (repository.state.inboxes.get(`agent:${ownerAgent.agent.agentId}`) ?? [])
      .filter((message: { messageType: string; payload: { taskId?: string } }) => (
        message.messageType === 'task.offered' && message.payload.taskId === activeTask.taskId
      ))
    expect(activeOffers).toHaveLength(1)

    const forgedRevoke = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokeForged01', type: 'credential.revoke_current',
      idempotencyKey: 'idem_api_revoke_forged_01', credentialId: owner.actor.credentialId
    }, workerAgent.deviceCredential)
    expect(forgedRevoke.status).toBe(400)
    await expect(forgedRevoke.json()).resolves.toMatchObject({ error: { code: 'validation_error' } })

    const agentRevocation = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokeAgent001', type: 'credential.revoke_current',
      idempotencyKey: 'idem_api_revoke_agent_current_01'
    }, workerAgent.deviceCredential)
    expect(agentRevocation.status).toBe(200)
    const agentRevocationText = await agentRevocation.text()
    expect(agentRevocationText).not.toContain(workerAgent.deviceCredential)
    expect(JSON.parse(agentRevocationText)).toMatchObject({ type: 'rest.receipt', receipt: {
      type: 'operation.receipt', status: 'succeeded', actor: { actorType: 'agent', agentId: workerAgent.agent.agentId }
    } })
    const revokedAgentRequest = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokedAgent01', type: 'inbox.pull',
      recipientType: 'agent', afterSequence: 0, limit: 10
    }, workerAgent.deviceCredential)
    expect(revokedAgentRequest.status).toBe(401)
    await expect(revokedAgentRequest.json()).resolves.toMatchObject({ error: { code: 'credential_revoked' } })
    expect((await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerUserOkay1', type: 'user.get', userId: worker.userId
    }, worker.userCredential)).status).toBe(200)

    const userRevocation = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokeUser0001', type: 'credential.revoke_current',
      idempotencyKey: 'idem_api_revoke_user_current_01'
    }, owner.userCredential)
    expect(userRevocation.status).toBe(200)
    const userRevocationText = await userRevocation.text()
    expect(userRevocationText).not.toContain(owner.userCredential)
    expect(JSON.parse(userRevocationText)).toMatchObject({ type: 'rest.receipt', receipt: {
      type: 'operation.receipt', status: 'succeeded', actor: { actorType: 'user', userId: owner.userId }
    } })
    const revokedUserRequest = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokedUser001', type: 'user.get', userId: owner.userId
    }, owner.userCredential)
    expect(revokedUserRequest.status).toBe(401)
    await expect(revokedUserRequest.json()).resolves.toMatchObject({ error: { code: 'credential_revoked' } })
    expect((await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOwnerAgentOkay1', type: 'task.get', taskId: task.taskId
    }, ownerAgent.deviceCredential)).status).toBe(200)

    const anonymousRevoke = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokeAnonymous1', type: 'credential.revoke_current',
      idempotencyKey: 'idem_api_revoke_anonymous_01'
    })
    expect(anonymousRevoke.status).toBe(401)
    await expect(anonymousRevoke.json()).resolves.toMatchObject({ error: { code: 'authentication_required' } })
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
