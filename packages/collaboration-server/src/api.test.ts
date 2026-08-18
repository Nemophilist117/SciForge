import type { AddressInfo } from 'node:net'

import type { HumanEndpointProviderContract } from '@sciforge/collaboration-contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeCollaborationRepository } from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import { createDeviceFixture } from '../../../test-fixtures/collaboration/unified-identity/device-fixture.mjs'
import { createCollaborationHttpServer } from './api.js'
import {
  AuthenticationService,
  type AgentActor,
  type OidcUserResolver,
  type UserActor
} from './auth.js'
import { stableDigest } from './crypto.js'
import { IdentityService } from './identity-service.js'
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

describe('production HTTP authentication boundary', () => {
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

  it('exposes only catalog without a bearer and keeps legacy pairing fail-closed', async () => {
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

    const anonymousBegin = await postCommand(baseUrl, pairingBegin(1))
    expect(anonymousBegin.status).toBe(401)
    await expect(anonymousBegin.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' }
    })

    const redeemBody = {
      protocolVersion: '1.0', requestId: 'req_BootstrapRedeem01', type: 'pairing.redeem',
      idempotencyKey: 'idem_bootstrap_redeem_01', bindingRequestId: 'zbr_bootstrap_missing_0001'
    }
    const redeem = await postCommand(baseUrl, redeemBody)
    expect(redeem.status).toBe(401)
    await expect(redeem.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' }
    })
    expect(repository.state.users.size).toBe(0)
    expect(repository.state.challenges.size).toBe(0)
    expect(repository.state.zulipBindingRequests.size).toBe(0)

    const catalogAfterPairingAttempt = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_BootstrapCatalog02', type: 'endpoint.catalog.get'
    })
    expect(catalogAfterPairingAttempt.status).toBe(200)

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

  it('routes authenticated pairing compatibility commands through the authoritative binding state', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const identityHarness = createTestIdentityHarness(repository)
    const identity = await identityHarness.issueUser('pairing-compatibility')
    const server = createCollaborationHttpServer({
      service,
      identities: identityHarness.identities,
      authentication: identityHarness.authentication,
      readiness: async () => true,
      now
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const response = await postCommand(baseUrl, {
      ...pairingBegin(99),
      requestId: 'req_BindingCompatibility1',
      idempotencyKey: 'idem_binding_compatibility_begin_01'
    }, identity.userToken)
    expect(response.status).toBe(200)
    const begun = await response.json() as { bindingRequestId: string; bindingCode: string }
    expect(begun).toMatchObject({
      type: 'pairing.begun',
      bindingRequestId: expect.stringMatching(/^zbr_/u),
      bindingCode: expect.stringMatching(/^SF-/u)
    })

    const redeem = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_BindingCompatRedeem1', type: 'pairing.redeem',
      idempotencyKey: 'idem_binding_compatibility_redeem_01', bindingRequestId: begun.bindingRequestId
    }, identity.userToken)
    expect(redeem.status).toBe(200)
    await expect(redeem.json()).resolves.toMatchObject({
      type: 'pairing.pending', bindingRequestId: begun.bindingRequestId
    })
    expect(repository.state.challenges.size).toBe(0)
    expect(repository.state.zulipBindingRequests.size).toBe(1)
    expect(repository.state.users.size).toBe(1)
    expect(repository.state.credentials.size).toBe(0)
  })

  it('serves capability, progress, result, and ResourceRef entities through canonical authenticated commands', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const identityHarness = createTestIdentityHarness(repository)
    const { authentication, identities } = identityHarness
    const owner = await identityHarness.onboard('resource-owner', 'provider-resource-owner')
    const worker = await identityHarness.onboard('resource-worker', 'provider-resource-worker')
    const ownerAgent = await registerTestAgent(service, identities, owner.actor,
      'api-resource-owner', 'Resource coordinator', ['research.coordinate'])
    const workerAgent = await registerTestAgent(service, identities, worker.actor,
      'api-resource-worker', 'Resource worker', ['research.execute'])
    if (!ownerAgent.deviceCredential || !workerAgent.deviceCredential) throw new Error('Expected one-time device credentials')
    const coordinator = await authentication.resolveBearer(ownerAgent.deviceCredential)
    const workerDevice = await authentication.resolveBearer(workerAgent.deviceCredential)
    if (coordinator.kind !== 'agent_device' || workerDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')
    await reportTestCapability(service, coordinator, 'research.coordinate', 'api_resource_owner')
    await reportTestCapability(service, workerDevice, 'research.execute', 'api_resource_worker')
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
    const ownerEndpoint = [...repository.state.endpoints.values()]
      .find((endpoint: { userId: string }) => endpoint.userId === owner.userId)
    if (!ownerEndpoint) throw new Error('Expected verified Owner Human Endpoint')
    const server = createCollaborationHttpServer({ service, identities, authentication, readiness: async () => true, now,
      resolveProviderActor: async (_request, command) => command.type === 'human.answer'
        ? { kind: 'human_endpoint', actorKey: `endpoint:${ownerEndpoint.humanEndpointId}`,
          userId: owner.userId, humanEndpointId: ownerEndpoint.humanEndpointId, assurance: 'verified' }
        : null })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const coordinatorSourceMessage = (repository.state.inboxes.get(`agent:${ownerAgent.agent.agentId}`) ?? [])
      .find((message: { messageType: string }) => message.messageType === 'project.started')
    if (!coordinatorSourceMessage) throw new Error('Expected a Project-started Coordinator inbox message')
    const humanNeededResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiCoordinatorHuman1', type: 'human.needed.create',
      idempotencyKey: 'idem_api_coordinator_human_01', projectId: project.projectId,
      sourceKind: 'coordinator', sourceInboxMessageId: coordinatorSourceMessage.messageId,
      targetUserId: owner.userId, requiredAssurance: 'verified',
      prompt: 'Approve the immutable follow-up proposal?',
      confirmableAction: { kind: 'tasks.create', projectId: project.projectId, proposalDigest: 'a'.repeat(64) },
      expiresAt: '2026-08-15T03:00:00.000Z'
    }, ownerAgent.deviceCredential)
    expect(humanNeededResponse.status).toBe(200)
    const humanNeeded = await humanNeededResponse.json() as { entity: { humanRequestId: string; revision: number } }
    expect(humanNeeded).toMatchObject({ entity: { sourceKind: 'coordinator', taskId: null,
      sourceInboxMessageId: coordinatorSourceMessage.messageId } })
    const humanAnswerResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiHumanApproval001', type: 'human.answer',
      idempotencyKey: 'idem_api_human_approval_01', humanRequestId: humanNeeded.entity.humanRequestId,
      requestRevision: humanNeeded.entity.revision, answer: 'Approved for this exact proposal.', decision: 'approve'
    })
    expect(humanAnswerResponse.status).toBe(200)
    const humanAnswer = await humanAnswerResponse.json() as { entity: { confirmationId: string } }
    expect(humanAnswer.entity.confirmationId).toMatch(/^cnf_[A-Za-z0-9]{12,64}$/u)
    const confirmationResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiConfirmationGet1', type: 'confirmation.get',
      confirmationId: humanAnswer.entity.confirmationId
    }, owner.userToken)
    expect(confirmationResponse.status).toBe(200)
    await expect(confirmationResponse.json()).resolves.toMatchObject({ entity: {
      type: 'action_confirmation', confirmationId: humanAnswer.entity.confirmationId,
      status: 'approved', action: { kind: 'tasks.create', proposalDigest: 'a'.repeat(64) }
    } })

    const inboxPageResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerInboxPage1', type: 'inbox.pull',
      recipientType: 'agent', afterSequence: 0, limit: 20
    }, workerAgent.deviceCredential)
    expect(inboxPageResponse.status).toBe(200)
    const inboxPage = await inboxPageResponse.json() as { ackedSequence: number; nextSequence: number;
      messages: Array<{ inboxMessageId: string; sequence: number; disposition: string; payload: { executionId: string } }> }
    expect(inboxPage).toMatchObject({ type: 'rest.inbox_page', ackedSequence: 0, nextSequence: 2,
      messages: [{ sequence: 1, disposition: 'active', payload: { executionId: task.executionId } }] })
    const mismatchedInbox = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiInboxMismatch1', type: 'inbox.pull',
      recipientType: 'user', afterSequence: 0, limit: 20
    }, workerAgent.deviceCredential)
    expect(mismatchedInbox.status).toBe(409)
    await expect(mismatchedInbox.json()).resolves.toMatchObject({ error: { code: 'recipient_mismatch' } })
    const laterInboxMessage = await repository.transaction((tx) => tx.appendInbox({
      recipient: { kind: 'agent', id: workerAgent.agent.agentId },
      messageId: 'ibx_ApiWorkerGap0002',
      messageType: 'task.updated',
      payload: { protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId,
        taskId: task.taskId, executionId: task.executionId, revision: task.revision, status: 'offered' },
      createdAt: now().toISOString(),
      expiresAt: '2026-08-16T02:00:00.000Z'
    }))
    const gapAckResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerInboxGap01', type: 'inbox.ack',
      idempotencyKey: 'idem_api_worker_inbox_gap_01', inboxMessageId: laterInboxMessage.messageId,
      sequence: laterInboxMessage.sequence
    }, workerAgent.deviceCredential)
    const gapAckBody = await gapAckResponse.json()
    expect({ status: gapAckResponse.status, body: gapAckBody }).toMatchObject({ status: 409, body: { error: {
      code: 'inbox_ack_gap', ackedSequence: 0, nextSequence: 3
    } } })
    const ackResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerInboxAck01', type: 'inbox.ack',
      idempotencyKey: 'idem_api_worker_inbox_ack_01', inboxMessageId: inboxPage.messages[0]?.inboxMessageId,
      sequence: inboxPage.messages[0]?.sequence
    }, workerAgent.deviceCredential)
    expect(ackResponse.status).toBe(200)
    await expect(ackResponse.json()).resolves.toMatchObject({ type: 'inbox.acked', ackedSequence: 1, nextSequence: 3 })
    const cursorAckResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerCursorAck1', type: 'inbox.ack',
      idempotencyKey: 'idem_api_worker_cursor_ack_01', throughSequence: 1
    }, workerAgent.deviceCredential)
    expect(cursorAckResponse.status).toBe(200)
    await expect(cursorAckResponse.json()).resolves.toMatchObject({ type: 'inbox.acked', ackedSequence: 1, nextSequence: 3 })
    const acknowledgedPageResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerInboxAfterAck1', type: 'inbox.pull',
      recipientType: 'agent', afterSequence: 0, limit: 20
    }, workerAgent.deviceCredential)
    const acknowledgedPageBody = await acknowledgedPageResponse.json()
    expect({ status: acknowledgedPageResponse.status, body: acknowledgedPageBody }).toMatchObject({
      status: 200,
      body: {
        type: 'rest.inbox_page',
        ackedSequence: 1,
        messages: [
          { sequence: 1, status: 'acknowledged', disposition: 'active' },
          { sequence: 2, status: 'pending', disposition: 'active' }
        ]
      }
    })

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
    await expect(agentTaskCreate.json()).resolves.toMatchObject({ error: { code: 'confirmation_required' } })
    const ownerTaskCreate = await postCommand(baseUrl, governedTaskBody, owner.userToken)
    expect(ownerTaskCreate.status).toBe(200)
    const governedTask = await ownerTaskCreate.json() as { entity: { taskId: string; executionId: string; revision: number } }
    const agentTaskCancel = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiAgentTaskCancel1', type: 'task.transition',
      idempotencyKey: 'idem_api_agent_task_cancel_01', taskId: governedTask.entity.taskId,
      executionId: governedTask.entity.executionId, expectedRevision: governedTask.entity.revision, status: 'cancelled'
    }, ownerAgent.deviceCredential)
    expect(agentTaskCancel.status).toBe(403)
    await expect(agentTaskCancel.json()).resolves.toMatchObject({ error: { code: 'confirmation_required' } })
    const ownerTaskCancel = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOwnerTaskCancel1', type: 'task.transition',
      idempotencyKey: 'idem_api_owner_task_cancel_01', taskId: governedTask.entity.taskId,
      executionId: governedTask.entity.executionId, expectedRevision: governedTask.entity.revision, status: 'cancelled'
    }, owner.userToken)
    expect(ownerTaskCancel.status).toBe(200)
    await expect(ownerTaskCancel.json()).resolves.toMatchObject({ entity: { status: 'cancelled' } })

    const acceptedResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskAccepted1', type: 'task.transition',
      idempotencyKey: 'idem_api_task_accept_01', taskId: task.taskId,
      executionId: task.executionId, expectedRevision: task.revision, status: 'accepted'
    }, workerAgent.deviceCredential)
    const accepted = await acceptedResponse.json() as { entity: { revision: number } }
    expect(acceptedResponse.status).toBe(200)

    const staleRequestId = 'req_ApiRevisionConflict1'
    const staleResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: staleRequestId, type: 'task.transition',
      idempotencyKey: 'idem_api_task_stale_01', taskId: task.taskId,
      executionId: task.executionId, expectedRevision: task.revision, status: 'accepted'
    }, workerAgent.deviceCredential)
    expect(staleResponse.status).toBe(409)
    await expect(staleResponse.json()).resolves.toMatchObject({
      requestId: staleRequestId,
      error: {
        code: 'revision_conflict',
        expectedRevision: task.revision,
        currentRevision: accepted.entity.revision,
        traceId: expect.stringMatching(/^trc_[A-Za-z0-9]{12,64}$/u)
      }
    })

    for (const [credential, profile, requestSuffix] of [
      [ownerAgent.deviceCredential, { agentId: ownerAgent.agent.agentId, ownerUserId: owner.userId,
        capabilities: [{ capabilityId: 'research.coordinate', evidence: { level: 'verified', checkedAt: now().toISOString() } }] }, 'Owner'],
      [workerAgent.deviceCredential, { agentId: workerAgent.agent.agentId, ownerUserId: worker.userId,
        capabilities: [{ capabilityId: 'research.execute', evidence: { level: 'verified', checkedAt: now().toISOString() } }] }, 'Worker']
    ] as const) {
      const reported = await postCommand(baseUrl, {
        protocolVersion: '1.0', requestId: `req_ApiCapability${requestSuffix}1`,
        type: 'agent.capability_profile.report', idempotencyKey: `idem_api_capability_${requestSuffix.toLowerCase()}_01`,
        expectedProfileRevision: 1,
        profile: { ...profile, nodeType: 'personal_computer',
          os: { family: 'linux', architecture: 'x64' }, runtimeIds: ['sciforge-runtime'],
          vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
          resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
            fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
          reportedAt: now().toISOString(), expiresAt: '2026-08-15T03:00:00.000Z' }
      }, credential)
      expect(reported.status).toBe(200)
      await expect(reported.json()).resolves.toMatchObject({ entity: {
        type: 'agent_capability_profile', agentId: profile.agentId, revision: 2, gpu: []
      } })
    }

    const capabilityResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiCapability001',
      type: 'project.capability_directory.get', projectId: project.projectId
    }, owner.userToken)
    expect(capabilityResponse.status).toBe(200)
    const capabilityText = await capabilityResponse.text()
    expect(capabilityText).not.toContain('installationId')
    expect(capabilityText).not.toContain('credentialVersion')
    const capability = JSON.parse(capabilityText) as { entity: { type: string; projectId: string;
      projectRevision: number; agents: Array<{ agentId: string; ownerUserId: string; lastSeenAt: string }> } }
    expect(capability.entity).toMatchObject({ type: 'project_capability_directory', projectId: project.projectId,
      projectRevision: project.revision + 2 })
    expect(capability.entity.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: ownerAgent.agent.agentId, ownerUserId: owner.userId,
        lastSeenAt: now().toISOString() }),
      expect.objectContaining({ agentId: workerAgent.agent.agentId, ownerUserId: worker.userId,
        lastSeenAt: now().toISOString() })
    ]))

    const createBody = {
      protocolVersion: '1.0', requestId: 'req_ApiResourceCreate01', type: 'resource.create',
      idempotencyKey: 'idem_api_resource_create_01', projectId: project.projectId, taskId: task.taskId,
      executionId: task.executionId, expectedTaskRevision: accepted.entity.revision,
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
    }, worker.userToken)
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

    const unavailable = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceOffline1', type: 'resource.transition',
      idempotencyKey: 'idem_api_resource_offline_01', resourceRefId: created.entity.resourceRefId,
      expectedRevision: created.entity.revision, status: 'unavailable', safeReasonCode: 'provider_temporarily_unavailable'
    }, workerAgent.deviceCredential)
    expect(unavailable.status).toBe(200)
    await expect(unavailable.json()).resolves.toMatchObject({ entity: { status: 'unavailable',
      statusReasonCode: 'provider_temporarily_unavailable', unavailableAt: now().toISOString(), revision: 2 } })
    const unavailableRead = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceOffline2', type: 'resource.get',
      resourceRefId: created.entity.resourceRefId
    }, workerAgent.deviceCredential)
    expect(unavailableRead.status).toBe(409)
    await expect(unavailableRead.json()).resolves.toMatchObject({ error: {
      code: 'resource_unavailable', traceId: expect.stringMatching(/^trc_[A-Za-z0-9]{12,64}$/u)
    } })
    const available = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceOnline01', type: 'resource.transition',
      idempotencyKey: 'idem_api_resource_online_01', resourceRefId: created.entity.resourceRefId,
      expectedRevision: 2, status: 'available'
    }, workerAgent.deviceCredential)
    expect(available.status).toBe(200)
    await expect(available.json()).resolves.toMatchObject({ entity: { status: 'available',
      statusReasonCode: null, unavailableAt: null, revision: 3 } })

    const repeatedAvailable = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceOnline02', type: 'resource.transition',
      idempotencyKey: 'idem_api_resource_online_noop_01', resourceRefId: created.entity.resourceRefId,
      expectedRevision: 3, status: 'available'
    }, workerAgent.deviceCredential)
    expect(repeatedAvailable.status).toBe(409)
    await expect(repeatedAvailable.json()).resolves.toMatchObject({ error: {
      code: 'invalid_state_transition', traceId: expect.stringMatching(/^trc_[A-Za-z0-9]{12,64}$/u)
    } })

    const invalidated = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiResourceInvalid1', type: 'resource.invalidate',
      idempotencyKey: 'idem_api_resource_invalidate_01', resourceRefId: created.entity.resourceRefId,
      expectedRevision: 3
    }, workerAgent.deviceCredential)
    expect(invalidated.status).toBe(200)
    await expect(invalidated.json()).resolves.toMatchObject({ entity: { resourceRefId: created.entity.resourceRefId,
      status: 'invalidated', revision: 4, invalidatedAt: now().toISOString() } })

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
      executionId: task.executionId, expectedRevision: accepted.entity.revision, status: 'running'
    }, workerAgent.deviceCredential)
    const running = await runningResponse.json() as { entity: { revision: number } }
    expect(runningResponse.status).toBe(200)
    const workerHumanNeededResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiWorkerHumanNeed1', type: 'human.needed.create',
      idempotencyKey: 'idem_api_worker_human_needed_01', projectId: project.projectId,
      sourceKind: 'worker', taskId: task.taskId, executionId: task.executionId,
      expectedTaskRevision: running.entity.revision, targetUserId: owner.userId,
      requiredAssurance: 'verified', prompt: 'Provide a bounded clarification.',
      expiresAt: '2026-08-15T03:00:00.000Z'
    }, workerAgent.deviceCredential)
    expect(workerHumanNeededResponse.status).toBe(200)
    await expect(workerHumanNeededResponse.json()).resolves.toMatchObject({ entity: {
      type: 'human_needed', sourceKind: 'worker', taskId: task.taskId, executionId: task.executionId,
      sourceInboxMessageId: null
    } })
    const needsHumanTaskResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiNeedsHumanTask1', type: 'task.get', taskId: task.taskId
    }, workerAgent.deviceCredential)
    const needsHumanTask = await needsHumanTaskResponse.json() as { entity: { revision: number } }
    expect(needsHumanTask).toMatchObject({ entity: { status: 'needs_human' } })
    const resumedResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskResumed001', type: 'task.transition',
      idempotencyKey: 'idem_api_task_resume_01', taskId: task.taskId, executionId: task.executionId,
      expectedRevision: needsHumanTask.entity.revision, status: 'running'
    }, workerAgent.deviceCredential)
    expect(resumedResponse.status).toBe(200)
    const resumed = await resumedResponse.json() as { entity: { revision: number } }
    const progressResponse = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskProgress01', type: 'task.progress.report',
      idempotencyKey: 'idem_api_task_progress_01', taskId: task.taskId,
      executionId: task.executionId, expectedRevision: resumed.entity.revision,
      percent: 60, summary: 'Resource metadata verified.'
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
      executionId: task.executionId, expectedRevision: resumed.entity.revision,
      percent: 60, summary: 'Resource metadata verified.'
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
      executionId: task.executionId, expectedRevision: progress.entity.revision, status: 'succeeded',
      result: { summary: 'HTTPS ResourceRef verified.', criterionEvidence: [], resourceRefIds: [],
        logSummary: 'Bounded worker log summary.' }
    }, workerAgent.deviceCredential)
    expect(completedResponse.status).toBe(200)
    await expect(completedResponse.json()).resolves.toMatchObject({ entity: {
      status: 'succeeded', resultSummary: 'HTTPS ResourceRef verified.',
      resultProjectRecordId: expect.stringMatching(/^rec_[A-Za-z0-9]{12,64}$/u)
    } })
    const queriedTask = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiTaskGet00001', type: 'task.get', taskId: task.taskId
    }, owner.userToken)
    expect(queriedTask.status).toBe(200)
    await expect(queriedTask.json()).resolves.toMatchObject({ entity: {
      status: 'succeeded', resultSummary: 'HTTPS ResourceRef verified.'
    } })
    const coordinationView = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiCoordinationView1',
      type: 'project.coordination_view.get', projectId: project.projectId
    }, ownerAgent.deviceCredential)
    expect(coordinationView.status).toBe(200)
    await expect(coordinationView.json()).resolves.toMatchObject({ entity: {
      type: 'project_coordination_view', projectId: project.projectId,
      project: { coordinatorAgentId: ownerAgent.agent.agentId },
      members: expect.arrayContaining([
        expect.objectContaining({ userId: owner.userId, role: 'owner' }),
        expect.objectContaining({ userId: worker.userId, role: 'member' })
      ]),
      tasks: expect.arrayContaining([expect.objectContaining({ taskId: task.taskId,
        executionId: task.executionId, status: 'succeeded' })]),
      records: expect.arrayContaining([expect.objectContaining({ kind: 'task_result',
        sourceExecutionId: task.executionId })])
    } })
  })

  it('publishes owner-confirmed reassignment and Agent current-bearer revocation without accepting caller identity', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const identityHarness = createTestIdentityHarness(repository)
    const { authentication, identities } = identityHarness
    const owner = await identityHarness.onboard('command-owner', 'provider-command-owner')
    const worker = await identityHarness.onboard('command-worker', 'provider-command-worker')
    const ownerAgent = await registerTestAgent(service, identities, owner.actor,
      'api-command-owner', 'Command coordinator', ['research.coordinate'])
    const workerAgent = await registerTestAgent(service, identities, worker.actor,
      'api-command-worker', 'Command worker', ['research.execute'])
    if (!ownerAgent.deviceCredential || !workerAgent.deviceCredential) throw new Error('Expected one-time device credentials')
    const coordinator = await authentication.resolveBearer(ownerAgent.deviceCredential)
    const workerDevice = await authentication.resolveBearer(workerAgent.deviceCredential)
    if (coordinator.kind !== 'agent_device' || workerDevice.kind !== 'agent_device') throw new Error('Expected Agent actors')
    await reportTestCapability(service, coordinator, 'research.coordinate', 'api_command_owner')
    await reportTestCapability(service, workerDevice, 'research.execute', 'api_command_worker')
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
    const accepted = await service.transitionTask(workerDevice, { taskId: task.taskId, executionId: task.executionId,
      status: 'accepted',
      expectedRevision: task.revision, idempotencyKey: 'idem_api_command_task_accept_01' })
    const running = await service.transitionTask(workerDevice, { taskId: task.taskId, executionId: task.executionId,
      status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_api_command_task_run_01' })
    const failed = await service.transitionTask(workerDevice, { taskId: task.taskId, executionId: task.executionId,
      status: 'failed',
      expectedRevision: running.revision, safeFailureCode: 'retry_required',
      idempotencyKey: 'idem_api_command_task_fail_01' })

    const server = createCollaborationHttpServer({
      service,
      identities,
      authentication,
      readiness: async () => true,
      now
    })
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
      executionId: task.executionId, assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: failed.revision
    }

    const workerRetry = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryWrong1', idempotencyKey: 'idem_api_task_retry_wrong_01'
    }, workerAgent.deviceCredential)
    expect(workerRetry.status).toBe(403)
    await expect(workerRetry.json()).resolves.toMatchObject({ error: { code: 'coordinator_mismatch' } })

    const coordinatorReassignment = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryAgent1', idempotencyKey: 'idem_api_task_retry_agent_01'
    }, ownerAgent.deviceCredential)
    expect(coordinatorReassignment.status).toBe(403)
    await expect(coordinatorReassignment.json()).resolves.toMatchObject({ error: { code: 'confirmation_required' } })

    const retriedResponse = await postCommand(baseUrl, retryBody, owner.userToken)
    const retried = await retriedResponse.json() as { entity: { executionId: string; revision: number } }
    expect(retriedResponse.status, JSON.stringify(retried)).toBe(200)
    expect(retried).toMatchObject({ entity: {
      taskId: task.taskId, assigneeAgentId: ownerAgent.agent.agentId,
      status: 'offered', attempt: 2, revision: failed.revision + 1
    } })
    const staleExecutionResource = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOldResourceExec1', type: 'resource.create',
      idempotencyKey: 'idem_api_old_resource_execution_01', projectId: project.projectId,
      taskId: task.taskId, executionId: task.executionId, expectedTaskRevision: failed.revision,
      provider: 'example-content', externalId: 'old-execution-resource', kind: 'shared_document',
      name: 'Old execution resource', openUrl: 'https://content.example.invalid/old-execution-resource'
    }, workerAgent.deviceCredential)
    expect(staleExecutionResource.status).toBe(409)
    await expect(staleExecutionResource.json()).resolves.toMatchObject({ error: {
      code: 'execution_conflict', currentRevision: retried.entity.revision,
      currentExecutionId: retried.entity.executionId
    } })
    const oldAssigneeResource = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOldResourceUser1', type: 'resource.create',
      idempotencyKey: 'idem_api_old_resource_assignee_01', projectId: project.projectId,
      taskId: task.taskId, executionId: retried.entity.executionId, expectedTaskRevision: failed.revision,
      provider: 'example-content', externalId: 'old-assignee-resource', kind: 'shared_document',
      name: 'Old assignee resource', openUrl: 'https://content.example.invalid/old-assignee-resource'
    }, workerAgent.deviceCredential)
    expect(oldAssigneeResource.status).toBe(403)
    await expect(oldAssigneeResource.json()).resolves.toMatchObject({ error: { code: 'assignee_mismatch' } })
    const replayedResponse = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryReplay1'
    }, owner.userToken)
    expect(replayedResponse.status).toBe(200)
    await expect(replayedResponse.json()).resolves.toMatchObject({ entity: {
      taskId: task.taskId, revision: retried.entity.revision, attempt: 2
    } })
    const retryOffers = (repository.state.inboxes.get(`agent:${ownerAgent.agent.agentId}`) ?? [])
      .filter((message: { messageType: string; payload: { taskId?: string } }) => (
        message.messageType === 'task.offered' && message.payload.taskId === task.taskId
      ))
    expect(retryOffers).toHaveLength(1)

    const staleExecutionRetry = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiRetryOldExecution1', idempotencyKey: 'idem_api_retry_old_execution_01',
      expectedRevision: retried.entity.revision
    }, owner.userToken)
    expect(staleExecutionRetry.status).toBe(409)
    await expect(staleExecutionRetry.json()).resolves.toMatchObject({ error: {
      code: 'execution_conflict', currentRevision: retried.entity.revision,
      currentExecutionId: retried.entity.executionId,
      traceId: expect.stringMatching(/^trc_[A-Za-z0-9]{12,64}$/u)
    } })

    const staleRetry = await postCommand(baseUrl, {
      ...retryBody, requestId: 'req_ApiTaskRetryStale01', idempotencyKey: 'idem_api_task_retry_stale_01',
      executionId: retried.entity.executionId, assigneeAgentId: workerAgent.agent.agentId
    }, owner.userToken)
    expect(staleRetry.status).toBe(409)
    await expect(staleRetry.json()).resolves.toMatchObject({ error: {
      code: 'revision_conflict', expectedRevision: failed.revision, currentRevision: retried.entity.revision
    } })
    const oldWorkerWrite = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOldWorkerWrite1', type: 'task.transition',
      idempotencyKey: 'idem_api_old_worker_write_01', taskId: task.taskId,
      executionId: task.executionId, expectedRevision: retried.entity.revision, status: 'accepted'
    }, workerAgent.deviceCredential)
    expect(oldWorkerWrite.status).toBe(403)
    await expect(oldWorkerWrite.json()).resolves.toMatchObject({ error: {
      code: 'assignee_mismatch'
    } })

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
      executionId: activeTask.executionId, assigneeAgentId: ownerAgent.agent.agentId,
      expectedRevision: activeTask.revision
    }
    const coordinatorActiveReassignment = await postCommand(baseUrl, {
      ...activeReassignmentBody, requestId: 'req_ApiActiveAgent001',
      idempotencyKey: 'idem_api_active_reassign_agent_01'
    }, ownerAgent.deviceCredential)
    expect(coordinatorActiveReassignment.status).toBe(403)
    await expect(coordinatorActiveReassignment.json()).resolves.toMatchObject({
      error: { code: 'confirmation_required' }
    })
    const ownerActiveReassignment = await postCommand(baseUrl, activeReassignmentBody, owner.userToken)
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
      idempotencyKey: 'idem_api_revoke_forged_01', credentialId: 'crd_forged_caller_identity'
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
    }, worker.userToken)).status).toBe(200)

    const userRevocation = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiRevokeUser0001', type: 'credential.revoke_current',
      idempotencyKey: 'idem_api_revoke_user_current_01'
    }, owner.userToken)
    expect(userRevocation.status).toBe(403)
    const userRevocationText = await userRevocation.text()
    expect(userRevocationText).not.toContain(owner.userToken)
    expect(JSON.parse(userRevocationText)).toMatchObject({ error: { code: 'permission_denied' } })
    const oidcUserStillActive = await postCommand(baseUrl, {
      protocolVersion: '1.0', requestId: 'req_ApiOidcUserActive1', type: 'user.get', userId: owner.userId
    }, owner.userToken)
    expect(oidcUserStillActive.status).toBe(200)
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
    realmUrl: `https://chat-${String(index).padStart(2, '0')}.example.invalid`
  }
}

function createTestIdentityHarness(repository: FakeCollaborationRepository) {
  const identities = new IdentityService({ repository, now })
  const subjects = new Map<string, { label: string; subject: string }>()
  const resolver: OidcUserResolver = {
    isCandidate: (token) => subjects.has(token),
    resolve: async (token) => {
      const selected = subjects.get(token)
      if (!selected) throw new Error('Unknown injected test OIDC token')
      const epoch = Math.floor(now().getTime() / 1_000)
      return identities.resolveOidcUser({
        issuer: 'https://login-test.sciforge.cn/realms/SciForge',
        subject: selected.subject,
        audience: ['sciforge-cloud-api'],
        authorizedParty: 'sciforge-desktop',
        issuedAt: epoch,
        notBefore: epoch - 1,
        expiresAt: epoch + 300,
        authTime: epoch,
        displayName: selected.label
      })
    }
  }
  const authentication = new AuthenticationService(repository, now, resolver)

  const issueUser = async (label: string) => {
    const digest = stableDigest(label)
    const userToken = `test.${digest}.oidc-signature`
    subjects.set(userToken, { label, subject: `api-test-${digest.slice(0, 32)}` })
    const actor = await authentication.resolveBearer(userToken)
    if (actor.kind !== 'user') throw new Error('Expected injected OIDC User actor')
    return { actor, userId: actor.userId, userToken }
  }

  const onboard = async (label: string, providerUserId: string) => {
    const user = await issueUser(label)
    const begun = await identities.beginZulipBinding(user.actor, {
      realmUrl: 'https://realm-hk.example.invalid',
      idempotencyKey: `idem_api_binding_begin_${label}`
    })
    const confirmed = await identities.confirmZulipBinding(
      { kind: 'service', clientId: 'test-zulip-provider' },
      {
        bindingCode: begun.bindingCode,
        realmUrl: 'https://realm-hk.example.invalid',
        realmId: 'realm-hk',
        zulipUserId: providerUserId,
        providerEventId: `event-api-binding-${label}`,
        idempotencyKey: `idem_api_binding_confirm_${label}`
      }
    )
    return { ...user, endpointId: confirmed.identity.humanEndpointId }
  }

  return { authentication, identities, issueUser, onboard }
}

async function registerTestAgent(
  service: CollaborationService,
  identities: IdentityService,
  user: UserActor,
  label: string,
  displayName: string,
  capabilities: string[]
) {
  const installationId = `ins_${stableDigest(label).slice(0, 24)}`
  const enrollment = await identities.createDeviceEnrollment(user, {
    installationId,
    idempotencyKey: `idem_api_device_enroll_${label}`
  })
  const fixture = createDeviceFixture({
    enrollmentId: enrollment.enrollmentId,
    nonce: enrollment.nonce,
    userId: user.userId,
    installationId,
    expiresAt: enrollment.expiresAt,
    capabilitySummary: ['device-local-files']
  })
  const created = await identities.createDevice(user, {
    ...fixture.deviceRequest,
    nonce: enrollment.nonce,
    idempotencyKey: `idem_api_device_create_${label}`
  })
  return service.registerAgent(user, {
    deviceId: created.device.deviceId,
    displayName,
    nodeType: 'desktop',
    capabilities,
    idempotencyKey: `idem_api_agent_register_${label}`
  })
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

async function reportTestCapability(
  service: CollaborationService,
  actor: AgentActor,
  capabilityId: string,
  keySuffix: string
): Promise<void> {
  const agent = await service.heartbeatAgent(actor, {
    expectedRevision: 1,
    connectionStatus: 'online',
    idempotencyKey: `idem_test_heartbeat_${keySuffix}`
  })
  expect(agent.lastSeenAt).toBe(now().toISOString())
  await service.reportAgentCapabilityProfile(actor, {
    agentId: actor.agentId, ownerUserId: actor.userId, nodeType: 'personal_computer',
    os: { family: 'linux', architecture: 'x64' }, runtimeIds: ['runtime.test'],
    capabilities: [{ capabilityId, evidence: { level: 'verified', checkedAt: now().toISOString() } }],
    vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
    resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
      fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
    reportedAt: now().toISOString(), expiresAt: '2026-08-15T03:00:00.000Z',
    idempotencyKey: `idem_test_capability_${keySuffix}`
  })
}
