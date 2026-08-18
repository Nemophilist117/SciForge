import { describe, expect, it } from 'vitest'

import {
  fakeAgentActor,
  FakeCollaborationRepository,
  FakeInboxNotifier
} from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import { AuthenticationService, type HumanEndpointActor, type UserActor } from './auth.js'
import { toInboxMessage, toProjectCapabilityDirectory, toTask } from './contracts.js'
import { stableDigest } from './crypto.js'
import { IdentityService } from './identity-service.js'
import type { StoredActionConfirmation, StoredConfirmableAction } from './model.js'
import { CollaborationService } from './service.js'
import { createDeviceFixture } from '../../../test-fixtures/collaboration/unified-identity/device-fixture.mjs'

const at = new Date('2026-08-15T02:00:00.000Z')
const now = () => at

async function onboard(
  service: CollaborationService,
  _authentication: AuthenticationService,
  label: string,
  providerUserId: string
) {
  const repository = (service as unknown as { repository: FakeCollaborationRepository }).repository
  const identities = new IdentityService({ repository, now })
  const epoch = Math.floor(at.getTime() / 1_000)
  const user = await identities.resolveOidcUser({
    issuer: 'https://login-test.sciforge.cn/realms/SciForge',
    subject: `test-${label}`,
    audience: ['sciforge-cloud-api'],
    authorizedParty: 'sciforge-desktop',
    issuedAt: epoch,
    notBefore: epoch - 1,
    expiresAt: epoch + 300,
    authTime: epoch,
    displayName: label
  })
  const begun = await identities.beginZulipBinding(user, {
    realmUrl: 'https://realm-hk.example.invalid',
    idempotencyKey: `idem_binding_begin_${label}`
  })
  const confirmed = await identities.confirmZulipBinding(
    { kind: 'service', clientId: 'test-zulip-provider' },
    {
      bindingCode: begun.bindingCode,
      realmUrl: 'https://realm-hk.example.invalid',
      realmId: 'realm-hk',
      zulipUserId: providerUserId,
      providerEventId: `provider-event-${label}-confirm`,
      idempotencyKey: `idem_binding_confirm_${label}`
    }
  )
  const endpoint: HumanEndpointActor = {
    kind: 'human_endpoint',
    actorKey: `endpoint:${confirmed.identity.humanEndpointId}:revision:${confirmed.identity.revision}`,
    userId: user.userId,
    humanEndpointId: confirmed.identity.humanEndpointId,
    assurance: 'verified'
  }
  return { user, endpoint, userId: user.userId, endpointId: confirmed.identity.humanEndpointId }
}

async function registerAgent(
  service: CollaborationService,
  user: UserActor,
  label: string,
  options: { provisionCapability?: boolean; heartbeat?: boolean } = {}
) {
  const created = await createDevice(service, user, label)
  const result = await service.registerAgent(user, { deviceId: created.device.deviceId,
    displayName: `${label} desktop`, nodeType: 'desktop', capabilities: ['research.execute'],
    idempotencyKey: `idem_agent_register_${label}` })
  if (!result.deviceCredential) throw new Error('Expected one-time device credential')
  const device = fakeAgentActor(result.agent, user.userId)
  const agent = options.heartbeat === false
    ? result.agent
    : await service.heartbeatAgent(device, {
        expectedRevision: result.agent.revision,
        connectionStatus: 'online',
        idempotencyKey: `idem_agent_heartbeat_${label}`
      })
  if (options.provisionCapability !== false) {
    await service.reportAgentCapabilityProfile(device, {
      agentId: agent.agentId,
      ownerUserId: user.userId,
      nodeType: 'personal_computer',
      os: { family: 'linux', architecture: 'x64' },
      runtimeIds: ['runtime.test'],
      capabilities: [{
        capabilityId: 'research.execute',
        evidence: { level: 'verified', checkedAt: at.toISOString() }
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
      reportedAt: at.toISOString(),
      expiresAt: '2026-08-15T03:00:00.000Z',
      idempotencyKey: `idem_agent_capability_${label}`
    })
  }
  return { ...result, agent }
}

async function createDevice(
  service: CollaborationService,
  user: UserActor,
  label: string
) {
  const repository = (service as unknown as { repository: FakeCollaborationRepository }).repository
  const identities = new IdentityService({ repository, now })
  const installationId = `ins_${stableDigest(label).slice(0, 24)}`
  const enrollment = await identities.createDeviceEnrollment(user, { installationId,
    idempotencyKey: `idem_device_enroll_${label}` })
  const fixture = createDeviceFixture({ enrollmentId: enrollment.enrollmentId, nonce: enrollment.nonce,
    userId: user.userId, installationId, expiresAt: enrollment.expiresAt,
    capabilitySummary: ['device-enrollment-summary'] })
  return identities.createDevice(user, { ...fixture.deviceRequest, nonce: enrollment.nonce,
    idempotencyKey: `idem_device_create_${label}` })
}

function seedApprovedConfirmation(
  repository: FakeCollaborationRepository,
  input: {
    confirmationId: string
    projectId: string
    ownerUserId: string
    coordinatorAgentId: string
    action: StoredConfirmableAction
    expiresAt?: string
  }
): StoredActionConfirmation {
  const confirmation: StoredActionConfirmation = {
    confirmationId: input.confirmationId,
    humanRequestId: `hrq_${input.confirmationId.slice(4)}`,
    projectId: input.projectId,
    targetUserId: input.ownerUserId,
    coordinatorAgentId: input.coordinatorAgentId,
    action: input.action,
    actionDigest: stableDigest(input.action),
    status: 'approved',
    approvedAt: '2026-08-15T01:00:00.000Z',
    expiresAt: input.expiresAt ?? '2026-08-15T03:00:00.000Z',
    createdAt: '2026-08-15T01:00:00.000Z',
    updatedAt: '2026-08-15T01:00:00.000Z'
  }
  repository.state.actionConfirmations.set(confirmation.confirmationId, structuredClone(confirmation))
  return confirmation
}

describe('CollaborationService canonical transactions', () => {
  it('binds a provider identity to an OIDC User without opaque credentials and rejects legacy pairing', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const identity = await onboard(service, authentication, 'alice', 'provider-alice')

    expect(identity.userId).toMatch(/^usr_/)
    expect(identity.endpointId).toMatch(/^hep_/)
    const serialized = JSON.stringify(repository.state)
    expect(serialized).not.toContain('pairing_poll.')
    expect(repository.state.credentials.size).toBe(0)
    const endpoint = await repository.getEndpoint(identity.endpointId)
    expect(endpoint).toMatchObject({ userId: identity.userId, providerUserId: 'provider-alice', status: 'active' })
    await expect(service.beginPairing({ provider: 'zulip', realmId: 'realm-hk',
      requestedDisplayName: 'alice', requestedBy: identity.user,
      idempotencyKey: 'idem_legacy_pairing_disabled' })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.redeemPairing({ pollSecret: 'pairing_poll.invalid-but-long-enough-to-check',
      idempotencyKey: 'idem_invalid_pairing_poll' })).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('returns binding code material once and stores only its digest and a redacted replay receipt', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const identity = await onboard(service, authentication, 'binding-once', 'provider-binding-once')
    const identities = new IdentityService({ repository, now })
    const input = { realmUrl: 'https://second-realm.example.invalid', idempotencyKey: 'idem_binding_once_0001' }
    const begun = await identities.beginZulipBinding(identity.user, input)
    expect(begun.bindingCode).toMatch(/^SF-/u)
    expect(JSON.stringify(repository.state.receipts)).not.toContain(begun.bindingCode)
    expect(JSON.stringify(repository.state.zulipBindingRequests)).not.toContain(begun.bindingCode)
    await expect(identities.beginZulipBinding(identity.user, input))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects Device-linked Agent ownership transfer without deleting owner-bound capability evidence', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'transfer-profile-owner', 'provider-transfer-profile-owner')
    const target = await onboard(service, authentication, 'transfer-profile-target', 'provider-transfer-profile-target')
    const registered = await registerAgent(service, owner.user, 'transferprof1', { provisionCapability: false })
    const device = await authentication.resolveBearer(registered.deviceCredential!)
    if (device.kind !== 'agent_device') throw new Error('Expected Agent actor')
    await service.reportAgentCapabilityProfile(device, {
      agentId: registered.agent.agentId, ownerUserId: owner.userId, nodeType: 'personal_computer',
      os: { family: 'linux', architecture: 'x64' }, runtimeIds: ['runtime.test'],
      capabilities: [{ capabilityId: 'research.execute', evidence: {
        level: 'verified', checkedAt: at.toISOString(), summary: 'Owner-bound evidence.'
      } }],
      vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
      resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
        fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
      reportedAt: at.toISOString(), expiresAt: '2026-08-15T03:00:00.000Z',
      idempotencyKey: 'idem_transfer_profile_report_01'
    })
    expect(await repository.getAgentCapabilityProfile(registered.agent.agentId))
      .toMatchObject({ ownerUserId: owner.userId })
    const project = await service.createProject(owner.user, {
      displayName: 'Transfer owner cascade', goal: 'Keep current Task ownership aligned with its Agent.',
      memberUserIds: [owner.userId, target.userId], coordinatorAgentId: registered.agent.agentId,
      idempotencyKey: 'idem_transfer_profile_project_01'
    })
    const task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: registered.agent.agentId,
      title: 'Transfer an assigned Agent', objective: 'Preserve the Task while its Agent owner changes.',
      completionCriteria: ['Task owner follows the Agent owner'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_transfer_profile_task_01'
    })

    await expect(service.transferAgentOwnership({ ...owner.user, assurance: 'strong' }, {
      agentId: registered.agent.agentId, targetUserId: target.userId,
      expectedRevision: registered.agent.revision, idempotencyKey: 'idem_transfer_profile_owner_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })

    expect(await repository.getAgent(registered.agent.agentId)).toMatchObject({
      ownerUserId: owner.userId,
      deviceId: registered.agent.deviceId,
      revision: registered.agent.revision
    })
    expect(await repository.getAgentCapabilityProfile(registered.agent.agentId))
      .toMatchObject({ ownerUserId: owner.userId })
    expect(await repository.getTask(task.taskId)).toMatchObject({
      assigneeAgentId: registered.agent.agentId,
      assigneeUserId: owner.userId
    })
    await expect(service.transitionTask(device, {
      taskId: task.taskId, executionId: task.executionId, status: 'accepted',
      expectedRevision: task.revision, idempotencyKey: 'idem_transfer_profile_stale_worker_01'
    })).resolves.toMatchObject({ status: 'accepted' })
  })

  it('serializes Agent ownership transfer against Task creation and reassignment', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'race-owner', 'provider-race-owner')
    const member = await onboard(service, authentication, 'race-member', 'provider-race-member')
    const outsider = await onboard(service, authentication, 'race-outsider', 'provider-race-outsider')
    const coordinator = await registerAgent(service, owner.user, 'racecoord001')
    const createCandidate = await registerAgent(service, member.user, 'racecreate01')
    const project = await service.createProject(owner.user, {
      displayName: 'Owner transfer race', goal: 'Never bind a Task to an Agent owner outside the Project.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinator.agent.agentId,
      idempotencyKey: 'idem_owner_transfer_race_project_01'
    })

    // Transfer enters the fake serialized transaction first. Task creation must
    // then observe the new, non-member owner and fail closed.
    const createRace = await Promise.allSettled([
      service.transferAgentOwnership({ ...member.user, assurance: 'strong' }, {
        agentId: createCandidate.agent.agentId, targetUserId: outsider.userId,
        expectedRevision: createCandidate.agent.revision, idempotencyKey: 'idem_owner_transfer_race_create_transfer_01'
      }),
      service.createTask(owner.user, {
        projectId: project.projectId, assigneeAgentId: createCandidate.agent.agentId,
        title: 'Race task creation', objective: 'This assignment must fail after ownership changes.',
        completionCriteria: ['No non-member assignment is stored'], dependencyTaskIds: [],
        expectedProjectRevision: project.revision, idempotencyKey: 'idem_owner_transfer_race_create_task_01'
      })
    ])
    expect(createRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(createRace[0]).toMatchObject({
      status: 'rejected', reason: { code: 'invalid_state_transition' }
    })
    expect(createRace[1]?.status).toBe('fulfilled')

    const initialWorker = await registerAgent(service, member.user, 'raceinitial1')
    const retryCandidate = await registerAgent(service, member.user, 'raceretry001')
    const latestProject = await repository.getProject(project.projectId)
    if (!latestProject) throw new Error('Expected race Project')
    const failedTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: initialWorker.agent.agentId,
      title: 'Race task reassignment', objective: 'Fail once, then race reassignment with ownership transfer.',
      completionCriteria: ['The reassigned owner remains a member'], dependencyTaskIds: [],
      expectedProjectRevision: latestProject.revision, idempotencyKey: 'idem_owner_transfer_race_retry_task_01'
    })
    const workerActor = fakeAgentActor(initialWorker.agent, member.userId)
    const accepted = await service.transitionTask(workerActor, {
      taskId: failedTask.taskId, executionId: failedTask.executionId, status: 'accepted',
      expectedRevision: failedTask.revision, idempotencyKey: 'idem_owner_transfer_race_retry_accept_01'
    })
    const running = await service.transitionTask(workerActor, {
      taskId: accepted.taskId, executionId: accepted.executionId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_owner_transfer_race_retry_run_01'
    })
    const failed = await service.transitionTask(workerActor, {
      taskId: running.taskId, executionId: running.executionId, status: 'failed',
      expectedRevision: running.revision, safeFailureCode: 'safe_test_failure',
      idempotencyKey: 'idem_owner_transfer_race_retry_fail_01'
    })

    // Reassignment enters first this time. The subsequent transfer must re-query
    // open work under the Agent lock and reject the non-member target owner.
    const retryRace = await Promise.allSettled([
      service.retryOrReassignTask(owner.user, {
        taskId: failed.taskId, executionId: failed.executionId, assigneeAgentId: retryCandidate.agent.agentId,
        expectedRevision: failed.revision, idempotencyKey: 'idem_owner_transfer_race_retry_command_01'
      }),
      service.transferAgentOwnership({ ...member.user, assurance: 'strong' }, {
        agentId: retryCandidate.agent.agentId, targetUserId: outsider.userId,
        expectedRevision: retryCandidate.agent.revision, idempotencyKey: 'idem_owner_transfer_race_retry_transfer_01'
      })
    ])
    expect(retryRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(retryRace[0]?.status).toBe('fulfilled')
    expect(retryRace[1]).toMatchObject({
      status: 'rejected', reason: { code: 'invalid_state_transition' }
    })

    for (const task of repository.state.tasks.values()) {
      const agent = repository.state.agents.get(task.assigneeAgentId)
      const membership = agent
        ? repository.state.projectMembers.get(`${task.projectId}:${agent.ownerUserId}`)
        : undefined
      expect(agent, `missing assignee Agent for ${task.taskId}`).toBeDefined()
      expect(task.assigneeUserId).toBe(agent?.ownerUserId)
      expect(membership, `non-member assignee owner for ${task.taskId}`).toMatchObject({ active: true })
      expect(membership?.role).not.toBe('observer')
    }
  })

  it('keeps target User lifecycle independent from forbidden Device-linked Agent transfer', async () => {
    class UserLockGateRepository extends FakeCollaborationRepository {
      readonly lockOrder: string[] = []
      private gate?: {
        userId: string
        entered: () => void
        wait: Promise<void>
      }

      armUserLock(userId: string) {
        let entered!: () => void
        let release!: () => void
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
        const wait = new Promise<void>((resolve) => { release = resolve })
        this.gate = { userId, entered, wait }
        return { entered: enteredPromise, release }
      }

      async getProjectForUpdate(projectId: string) {
        this.lockOrder.push(`project:${projectId}`)
        return super.getProjectForUpdate(projectId)
      }

      async getUserForUpdate(userId: string) {
        this.lockOrder.push(`user:${userId}`)
        const gate = this.gate
        if (gate?.userId === userId) {
          this.gate = undefined
          gate.entered()
          await gate.wait
        }
        return super.getUserForUpdate(userId)
      }

      async getAgentForUpdate(agentId: string) {
        this.lockOrder.push(`agent:${agentId}`)
        return super.getAgentForUpdate(agentId)
      }
    }

    const setup = async (label: string) => {
      const repository = new UserLockGateRepository()
      const service = new CollaborationService({ repository, now })
      const authentication = new AuthenticationService(repository, now)
      const owner = await onboard(service, authentication, `${label}-owner`, `provider-${label}-owner`)
      const target = await onboard(service, authentication, `${label}-target`, `provider-${label}-target`)
      const candidate = await registerAgent(service, owner.user, `${label}agent`)
      const project = await service.createProject(owner.user, {
        displayName: `${label} transfer Project`, goal: 'Serialize the target User lifecycle with ownership transfer.',
        memberUserIds: [owner.userId, target.userId], coordinatorAgentId: candidate.agent.agentId,
        idempotencyKey: `idem_${label}_transfer_project_01`
      })
      repository.lockOrder.length = 0
      return { repository, service, owner, target, candidate, project }
    }

    const lifecycleFirst = await setup('life1')
    const targetBeforeLifecycle = await lifecycleFirst.repository.getUser(lifecycleFirst.target.userId)
    if (!targetBeforeLifecycle) throw new Error('Expected lifecycle-first target User')
    const lifecycleGate = lifecycleFirst.repository.armUserLock(lifecycleFirst.target.userId)
    const suspendFirst = lifecycleFirst.service.updateUser(
      { ...lifecycleFirst.target.user, assurance: 'strong' },
      { userId: lifecycleFirst.target.userId, status: 'suspended', expectedRevision: targetBeforeLifecycle.revision,
        idempotencyKey: 'idem_lifecycle_first_suspend_01' }
    )
    await lifecycleGate.entered
    const transferSecond = lifecycleFirst.service.transferAgentOwnership(
      { ...lifecycleFirst.owner.user, assurance: 'strong' },
      { agentId: lifecycleFirst.candidate.agent.agentId, targetUserId: lifecycleFirst.target.userId,
        expectedRevision: lifecycleFirst.candidate.agent.revision,
        idempotencyKey: 'idem_lifecycle_first_transfer_01' }
    )
    lifecycleGate.release()
    const lifecycleFirstResults = await Promise.allSettled([suspendFirst, transferSecond])
    expect(lifecycleFirstResults[0]).toMatchObject({ status: 'fulfilled', value: { status: 'suspended' } })
    expect(lifecycleFirstResults[1]).toMatchObject({
      status: 'rejected', reason: { code: 'invalid_state_transition' }
    })
    expect(await lifecycleFirst.repository.getAgent(lifecycleFirst.candidate.agent.agentId))
      .toMatchObject({ ownerUserId: lifecycleFirst.owner.userId, status: 'active' })
    expect(lifecycleFirst.repository.lockOrder).toEqual([`user:${lifecycleFirst.target.userId}`])

    const transferFirst = await setup('life2')
    const targetBeforeTransfer = await transferFirst.repository.getUser(transferFirst.target.userId)
    if (!targetBeforeTransfer) throw new Error('Expected transfer-first target User')
    const transfer = transferFirst.service.transferAgentOwnership(
      { ...transferFirst.owner.user, assurance: 'strong' },
      { agentId: transferFirst.candidate.agent.agentId, targetUserId: transferFirst.target.userId,
        expectedRevision: transferFirst.candidate.agent.revision,
        idempotencyKey: 'idem_transfer_first_transfer_01' }
    )
    const suspendSecond = transferFirst.service.setUserStatus(
      { kind: 'system', actorKey: 'system:target-user-race' },
      { userId: transferFirst.target.userId, status: 'suspended', expectedRevision: targetBeforeTransfer.revision,
        idempotencyKey: 'idem_transfer_first_suspend_01' }
    )
    const transferFirstResults = await Promise.allSettled([transfer, suspendSecond])
    expect(transferFirstResults[0]).toMatchObject({
      status: 'rejected', reason: { code: 'invalid_state_transition' }
    })
    expect(transferFirstResults[1]).toMatchObject({ status: 'fulfilled', value: { status: 'suspended' } })
    expect(await transferFirst.repository.getUser(transferFirst.target.userId)).toMatchObject({ status: 'suspended' })
    expect(await transferFirst.repository.getAgent(transferFirst.candidate.agent.agentId))
      .toMatchObject({ ownerUserId: transferFirst.owner.userId, status: 'active' })
    expect(transferFirst.repository.lockOrder).toEqual([`user:${transferFirst.target.userId}`])
  })

  it('serializes Agent registration with User suspension so the owner cannot become inactive', async () => {
    class UserLockGateRepository extends FakeCollaborationRepository {
      private gate?: { userId: string; entered: () => void; wait: Promise<void> }

      armUserLock(userId: string) {
        let entered!: () => void
        let release!: () => void
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
        const wait = new Promise<void>((resolve) => { release = resolve })
        this.gate = { userId, entered, wait }
        return { entered: enteredPromise, release }
      }

      async getUserForUpdate(userId: string) {
        const gate = this.gate
        if (gate?.userId === userId) {
          this.gate = undefined
          gate.entered()
          await gate.wait
        }
        return super.getUserForUpdate(userId)
      }
    }

    const setup = async (label: string) => {
      const repository = new UserLockGateRepository()
      const service = new CollaborationService({ repository, now })
      const authentication = new AuthenticationService(repository, now)
      const owner = await onboard(service, authentication, label, `provider-${label}`)
      const device = await createDevice(service, owner.user, `${label}-registration-device`)
      const stored = await repository.getUser(owner.userId)
      if (!stored) throw new Error('Expected registration-race User')
      return { repository, service, owner, device: device.device, stored }
    }

    const lifecycleFirst = await setup('registration-life-first')
    const lifecycleGate = lifecycleFirst.repository.armUserLock(lifecycleFirst.owner.userId)
    const suspend = lifecycleFirst.service.setUserStatus({ kind: 'system', actorKey: 'system:registration-race-1' }, {
      userId: lifecycleFirst.owner.userId, status: 'suspended', expectedRevision: lifecycleFirst.stored.revision,
      idempotencyKey: 'idem_registration_lifecycle_first_suspend_01'
    })
    await lifecycleGate.entered
    const registerSecond = lifecycleFirst.service.registerAgent(lifecycleFirst.owner.user, {
      deviceId: lifecycleFirst.device.deviceId, displayName: 'Late registration', nodeType: 'desktop',
      capabilities: [], idempotencyKey: 'idem_registration_lifecycle_first_register_01'
    })
    lifecycleGate.release()
    const lifecycleFirstResults = await Promise.allSettled([suspend, registerSecond])
    expect(lifecycleFirstResults[0]).toMatchObject({ status: 'fulfilled' })
    expect(lifecycleFirstResults[1]).toMatchObject({ status: 'rejected', reason: { code: 'credential_revoked' } })
    expect(await lifecycleFirst.repository.listAgentsForUser(lifecycleFirst.owner.userId)).toEqual([])

    const registrationFirst = await setup('registration-agent-first')
    const registrationGate = registrationFirst.repository.armUserLock(registrationFirst.owner.userId)
    const register = registrationFirst.service.registerAgent(registrationFirst.owner.user, {
      deviceId: registrationFirst.device.deviceId, displayName: 'Winning registration', nodeType: 'desktop',
      capabilities: [], idempotencyKey: 'idem_registration_agent_first_register_01'
    })
    await registrationGate.entered
    const suspendSecond = registrationFirst.service.setUserStatus(
      { kind: 'system', actorKey: 'system:registration-race-2' },
      { userId: registrationFirst.owner.userId, status: 'suspended', expectedRevision: registrationFirst.stored.revision,
        idempotencyKey: 'idem_registration_agent_first_suspend_01' }
    )
    registrationGate.release()
    const registrationFirstResults = await Promise.allSettled([register, suspendSecond])
    expect(registrationFirstResults[0]).toMatchObject({ status: 'fulfilled' })
    expect(registrationFirstResults[1]).toMatchObject({ status: 'rejected', reason: { code: 'invalid_state_transition' } })
    expect(await registrationFirst.repository.getUser(registrationFirst.owner.userId)).toMatchObject({ status: 'active' })
    expect(await registrationFirst.repository.listAgentsForUser(registrationFirst.owner.userId))
      .toEqual([expect.objectContaining({ status: 'active' })])
  })

  it('rejects Device-linked ownership transfer before late Project lock discovery', async () => {
    class LateProjectRepository extends FakeCollaborationRepository {
      lateSpec?: {
        agentId: string
        ownerUserId: string
        targetUserId: string
        coordinatorAgentId: string
        projectId: string
        taskId: string
      }
      lateInjected = false
      preserveLateCommit = false

      armLateProject(spec: NonNullable<LateProjectRepository['lateSpec']>) {
        this.lateSpec = spec
        this.lateInjected = false
        this.preserveLateCommit = true
      }

      async transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
        const snapshot = structuredClone(this.state)
        try {
          return await work(this)
        } catch (error) {
          const spec = this.lateSpec
          const lateState = spec && this.lateInjected && this.preserveLateCommit
            ? {
                project: structuredClone(this.state.projects.get(spec.projectId)),
                ownerMember: structuredClone(this.state.projectMembers.get(`${spec.projectId}:${spec.ownerUserId}`)),
                targetMember: structuredClone(this.state.projectMembers.get(`${spec.projectId}:${spec.targetUserId}`)),
                task: structuredClone(this.state.tasks.get(spec.taskId))
              }
            : undefined
          this.state = snapshot
          if (spec && lateState?.project && lateState.ownerMember && lateState.targetMember && lateState.task) {
            this.state.projects.set(spec.projectId, lateState.project)
            this.state.projectMembers.set(`${spec.projectId}:${spec.ownerUserId}`, lateState.ownerMember)
            this.state.projectMembers.set(`${spec.projectId}:${spec.targetUserId}`, lateState.targetMember)
            this.state.tasks.set(spec.taskId, lateState.task)
            this.preserveLateCommit = false
          }
          throw error
        }
      }

      async getAgentForUpdate(agentId: string) {
        const spec = this.lateSpec
        if (spec && !this.lateInjected && agentId === spec.agentId) {
          const timestamp = at.toISOString()
          this.state.projects.set(spec.projectId, {
            projectId: spec.projectId,
            ownerUserId: spec.ownerUserId,
            displayName: 'Late member-safe Project',
            goal: 'Appear after transfer Project-lock discovery.',
            status: 'active',
            coordinatorAgentId: spec.coordinatorAgentId,
            budgets: { maxTasks: 20, maxTasksPerRound: 10, maxTaskRetries: 2, maxCoordinationRounds: 4 },
            coordinationRound: 1,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp
          })
          this.state.projectMembers.set(`${spec.projectId}:${spec.ownerUserId}`, {
            projectId: spec.projectId, userId: spec.ownerUserId, role: 'owner', active: true, createdAt: timestamp
          })
          this.state.projectMembers.set(`${spec.projectId}:${spec.targetUserId}`, {
            projectId: spec.projectId, userId: spec.targetUserId, role: 'member', active: true, createdAt: timestamp
          })
          this.state.tasks.set(spec.taskId, {
            taskId: spec.taskId,
            projectId: spec.projectId,
            executionId: 'exe_LateTransferRace01',
            assigneeAgentId: spec.agentId,
            assigneeUserId: spec.ownerUserId,
            createdByAgentId: spec.coordinatorAgentId,
            title: 'Late ownership-transfer Task',
            objective: 'Remain assigned to the original owner when transfer retries.',
            completionCriteria: [{ criterionId: 'cri_LateTransferRace01', text: 'No partial transfer is committed' }],
            dependencyTaskIds: [],
            requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
            resourceRefIds: [],
            authorizationRequirements: [],
            status: 'offered',
            retryCount: 0,
            maxRetries: 2,
            coordinationRound: 1,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp
          })
          this.lateInjected = true
        }
        return super.getAgentForUpdate(agentId)
      }
    }

    const repository = new LateProjectRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'late-transfer-owner', 'provider-late-transfer-owner')
    const target = await onboard(service, authentication, 'late-transfer-target', 'provider-late-transfer-target')
    const coordinator = await registerAgent(service, owner.user, 'latecoord001')
    const transferredCandidate = await registerAgent(service, owner.user, 'lateagent001')
    const projectId = 'prj_LateTransferRace01'
    const taskId = 'tsk_LateTransferRace01'
    repository.armLateProject({
      agentId: transferredCandidate.agent.agentId,
      ownerUserId: owner.userId,
      targetUserId: target.userId,
      coordinatorAgentId: coordinator.agent.agentId,
      projectId,
      taskId
    })
    const agentBefore = structuredClone(await repository.getAgent(transferredCandidate.agent.agentId))
    const profileBefore = structuredClone(await repository.getAgentCapabilityProfile(transferredCandidate.agent.agentId))
    const credentialsBefore = structuredClone([...repository.state.credentials.values()]
      .filter((credential) => credential.subjectAgentId === transferredCandidate.agent.agentId))

    const error = await service.transferAgentOwnership({ ...owner.user, assurance: 'strong' }, {
      agentId: transferredCandidate.agent.agentId,
      targetUserId: target.userId,
      expectedRevision: transferredCandidate.agent.revision,
      idempotencyKey: 'idem_late_transfer_retry_01'
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'invalid_state_transition', retryable: false })
    expect(repository.lateInjected).toBe(false)
    expect(await repository.getAgent(transferredCandidate.agent.agentId)).toEqual(agentBefore)
    expect(await repository.getAgentCapabilityProfile(transferredCandidate.agent.agentId)).toEqual(profileBefore)
    expect([...repository.state.credentials.values()]
      .filter((credential) => credential.subjectAgentId === transferredCandidate.agent.agentId)).toEqual(credentialsBefore)
    expect(await repository.getProjectMember(projectId, target.userId)).toBeNull()
    expect(await repository.getTask(taskId)).toBeNull()
  })

  it('locks affected Projects before the Agent when heartbeat pauses or revocation fences work', async () => {
    class LockOrderRepository extends FakeCollaborationRepository {
      readonly lockOrder: string[] = []

      async getProjectForUpdate(projectId: string) {
        this.lockOrder.push(`project-lock:${projectId}`)
        return super.getProjectForUpdate(projectId)
      }

      async getAgentForUpdate(agentId: string) {
        this.lockOrder.push(`agent-lock:${agentId}`)
        return super.getAgentForUpdate(agentId)
      }

      async updateAgent(agent: Parameters<FakeCollaborationRepository['updateAgent']>[0], expectedRevision: number) {
        this.lockOrder.push(`agent-update:${agent.agentId}`)
        return super.updateAgent(agent, expectedRevision)
      }

      async updateProject(project: Parameters<FakeCollaborationRepository['updateProject']>[0], expectedRevision: number) {
        this.lockOrder.push(`project-update:${project.projectId}`)
        return super.updateProject(project, expectedRevision)
      }
    }

    const repository = new LockOrderRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'lock-order-owner', 'provider-lock-order-owner')
    const coordinator = await registerAgent(service, owner.user, 'lockorder001')
    const coordinatorActor = fakeAgentActor(coordinator.agent, owner.userId)
    const project = await service.createProject(owner.user, {
      displayName: 'Lock order Project', goal: 'Keep Project locks ahead of the Agent lock.',
      memberUserIds: [owner.userId], coordinatorAgentId: coordinator.agent.agentId,
      idempotencyKey: 'idem_lock_order_project_01'
    })
    const task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: coordinator.agent.agentId,
      title: 'Keep one open assignment', objective: 'Make revocation lock the Task Project.',
      completionCriteria: ['The Project is locked before the Agent'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_lock_order_task_01'
    })
    expect(task.status).toBe('offered')

    repository.lockOrder.length = 0
    const offline = await service.heartbeatAgent(coordinatorActor, {
      expectedRevision: coordinator.agent.revision, connectionStatus: 'offline',
      idempotencyKey: 'idem_lock_order_offline_01'
    })
    expect(repository.lockOrder).toEqual([
      `project-lock:${project.projectId}`,
      `agent-lock:${coordinator.agent.agentId}`,
      `agent-update:${coordinator.agent.agentId}`,
      `project-update:${project.projectId}`
    ])

    repository.lockOrder.length = 0
    await service.revokeAgent(owner.user, {
      agentId: coordinator.agent.agentId, expectedRevision: offline.revision,
      idempotencyKey: 'idem_lock_order_revoke_01'
    })
    expect(repository.lockOrder.slice(0, 3)).toEqual([
      `project-lock:${project.projectId}`,
      `agent-lock:${coordinator.agent.agentId}`,
      `agent-update:${coordinator.agent.agentId}`
    ])
    expect(repository.lockOrder.indexOf(`agent-lock:${coordinator.agent.agentId}`))
      .toBeLessThan(repository.lockOrder.indexOf(`agent-update:${coordinator.agent.agentId}`))
  })

  it('rejects a pre-revocation Coordinator actor at every governance write boundary', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'stale-coordinator-owner', 'provider-stale-coordinator-owner')
    const member = await onboard(service, authentication, 'stale-coordinator-member', 'provider-stale-coordinator-member')
    const coordinator = await registerAgent(service, owner.user, 'stalecoord01')
    const worker = await registerAgent(service, member.user, 'staleworker1')
    const staleCoordinator = fakeAgentActor(coordinator.agent, owner.userId)
    const project = await service.createProject(owner.user, {
      displayName: 'Stale Coordinator fence', goal: 'Reject governance writes authenticated before revocation.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinator.agent.agentId,
      idempotencyKey: 'idem_stale_coordinator_project_01'
    })
    const task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: worker.agent.agentId,
      title: 'Governed open Task', objective: 'Remain unchanged by the stale Coordinator actor.',
      completionCriteria: ['Every stale governance write is rejected'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_stale_coordinator_task_01'
    })
    const record = await service.submitProjectRecord(owner.user, {
      projectId: project.projectId, kind: 'observation', summary: 'Candidate record for stale acceptance fencing.',
      idempotencyKey: 'idem_stale_coordinator_record_01'
    })
    const currentProject = await repository.getProject(project.projectId)
    if (!currentProject) throw new Error('Expected stale Coordinator Project')

    await service.revokeAgent(owner.user, {
      agentId: coordinator.agent.agentId,
      expectedRevision: coordinator.agent.revision, idempotencyKey: 'idem_stale_coordinator_revoke_01'
    })

    const staleWrites = [
      service.transitionProject(staleCoordinator, {
        projectId: project.projectId, status: 'completed', expectedRevision: currentProject.revision,
        finalRecordDigest: 'digest_stale_coordinator_project',
        idempotencyKey: 'idem_stale_coordinator_transition_01'
      }),
      service.cancelTask(staleCoordinator, {
        taskId: task.taskId, executionId: task.executionId, expectedRevision: task.revision,
        idempotencyKey: 'idem_stale_coordinator_cancel_01'
      }),
      service.advanceCoordinationRound(staleCoordinator, {
        projectId: project.projectId, expectedRevision: currentProject.revision,
        idempotencyKey: 'idem_stale_coordinator_round_01'
      }),
      service.acceptProjectRecord(staleCoordinator, {
        projectRecordId: record.projectRecordId, expectedRevision: record.revision,
        idempotencyKey: 'idem_stale_coordinator_record_accept_01'
      })
    ]
    const results = await Promise.allSettled(staleWrites)
    expect(results).toHaveLength(4)
    for (const result of results) {
      expect(result).toMatchObject({ status: 'rejected', reason: { code: 'credential_revoked' } })
    }
    expect(await repository.getProject(project.projectId)).toMatchObject({
      status: 'paused', coordinationRound: currentProject.coordinationRound, revision: currentProject.revision + 1
    })
    expect(await repository.getTask(task.taskId)).toMatchObject({ status: 'offered', revision: task.revision })
    expect(await repository.getProjectRecord(record.projectRecordId)).toMatchObject({ status: 'candidate', revision: record.revision })
  })

  it('enforces the shared lifecycle matrices without treating explicit no-ops as writes', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'lifecycle-owner', 'provider-lifecycle-owner')
    const initialUser = await repository.getUser(owner.userId)
    if (!initialUser) throw new Error('Expected lifecycle User')
    const renamed = await service.updateUser(owner.user, {
      userId: owner.userId, displayName: 'Lifecycle Owner Renamed', expectedRevision: initialUser.revision,
      idempotencyKey: 'idem_lifecycle_display_only_01'
    })
    expect(renamed).toMatchObject({ displayName: 'Lifecycle Owner Renamed', status: 'active' })
    await expect(service.updateUser(owner.user, {
      userId: owner.userId, status: 'active', expectedRevision: renamed.revision,
      idempotencyKey: 'idem_lifecycle_user_update_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.setUserStatus({ kind: 'system', actorKey: 'system:lifecycle-test' }, {
      userId: owner.userId, status: 'active', expectedRevision: renamed.revision,
      idempotencyKey: 'idem_lifecycle_user_set_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })

    const endpoint = await repository.getEndpoint(owner.endpointId)
    if (!endpoint) throw new Error('Expected lifecycle endpoint')
    await expect(service.setEndpointStatus(owner.user, {
      humanEndpointId: endpoint.humanEndpointId, status: 'active', expectedRevision: endpoint.revision,
      idempotencyKey: 'idem_lifecycle_endpoint_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })

    const standalone = await registerAgent(service, owner.user, 'lifecyclea1')
    const revoked = await service.revokeAgent(owner.user, {
      agentId: standalone.agent.agentId, expectedRevision: standalone.agent.revision,
      idempotencyKey: 'idem_lifecycle_agent_revoke_01'
    })
    await expect(service.revokeAgent(owner.user, {
      agentId: standalone.agent.agentId, expectedRevision: revoked.revision,
      idempotencyKey: 'idem_lifecycle_agent_revoke_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })

    const coordinator = await registerAgent(service, owner.user, 'lifecyclec1')
    const project = await service.createProject(owner.user, {
      displayName: 'Lifecycle matrix Project', goal: 'Keep service transitions aligned with the public machine.',
      memberUserIds: [owner.userId], coordinatorAgentId: coordinator.agent.agentId,
      idempotencyKey: 'idem_lifecycle_project_01'
    })
    const resource = await service.createResourceRef(owner.user, {
      projectId: project.projectId, provider: 'lifecycle-provider', externalId: 'lifecycle-resource-1',
      kind: 'shared_document', name: 'Lifecycle resource',
      openUrl: 'https://content.example.invalid/lifecycle-resource-1', version: '1',
      idempotencyKey: 'idem_lifecycle_resource_01'
    })
    await expect(service.transitionResourceRef(owner.user, {
      resourceRefId: resource.resourceRefId, status: 'available', expectedRevision: resource.revision,
      idempotencyKey: 'idem_lifecycle_resource_available_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    const unavailable = await service.transitionResourceRef(owner.user, {
      resourceRefId: resource.resourceRefId, status: 'unavailable', safeReasonCode: 'provider_offline',
      expectedRevision: resource.revision, idempotencyKey: 'idem_lifecycle_resource_unavailable_01'
    })
    await expect(service.transitionResourceRef(owner.user, {
      resourceRefId: resource.resourceRefId, status: 'unavailable', safeReasonCode: 'still_offline',
      expectedRevision: unavailable.revision, idempotencyKey: 'idem_lifecycle_resource_unavailable_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })

    const paused = await service.transitionProject(owner.user, {
      projectId: project.projectId, status: 'paused', expectedRevision: project.revision,
      idempotencyKey: 'idem_lifecycle_project_pause_01'
    })
    await expect(service.transitionProject(owner.user, {
      projectId: project.projectId, status: 'completed', expectedRevision: paused.revision,
      idempotencyKey: 'idem_lifecycle_project_paused_complete_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.transitionProject(owner.user, {
      projectId: project.projectId, status: 'paused', expectedRevision: paused.revision,
      idempotencyKey: 'idem_lifecycle_project_pause_noop_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
  })

  it('keeps Device-linked Coordinator ownership fixed and resumes only with an active Coordinator', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'resume-owner', 'provider-resume-owner')
    const outsider = await onboard(service, authentication, 'resume-outsider', 'provider-resume-outsider')
    const transferredCoordinator = await registerAgent(service, owner.user, 'resumexfer01')
    const revokedCoordinator = await registerAgent(service, owner.user, 'resumerevoke')
    const validCoordinator = await registerAgent(service, owner.user, 'resumevalid1')

    const createPausedProject = async (label: string, coordinatorAgentId: string) => {
      const project = await service.createProject(owner.user, {
        displayName: `Paused resume ${label}`, goal: 'Revalidate Coordinator authority before resuming execution.',
        memberUserIds: [owner.userId], coordinatorAgentId,
        idempotencyKey: `idem_resume_project_${label}`
      })
      return service.transitionProject(owner.user, {
        projectId: project.projectId, status: 'paused', expectedRevision: project.revision,
        idempotencyKey: `idem_resume_pause_${label}`
      })
    }

    const transferredProject = await createPausedProject('transferred', transferredCoordinator.agent.agentId)
    await expect(service.transferAgentOwnership({ ...owner.user, assurance: 'strong' }, {
      agentId: transferredCoordinator.agent.agentId, targetUserId: outsider.userId,
      expectedRevision: transferredCoordinator.agent.revision, idempotencyKey: 'idem_resume_transfer_owner_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.transitionProject(owner.user, {
      projectId: transferredProject.projectId, status: 'active', expectedRevision: transferredProject.revision,
      idempotencyKey: 'idem_resume_transfer_blocked_resume_01'
    })).resolves.toMatchObject({ status: 'active', revision: transferredProject.revision + 1 })
    expect(await repository.getProject(transferredProject.projectId)).toMatchObject({
      status: 'active', revision: transferredProject.revision + 1
    })

    const revokedProject = await createPausedProject('revoked', revokedCoordinator.agent.agentId)
    await service.revokeAgent(owner.user, {
      agentId: revokedCoordinator.agent.agentId, expectedRevision: revokedCoordinator.agent.revision,
      idempotencyKey: 'idem_resume_revoke_agent_01'
    })
    await expect(service.transitionProject(owner.user, {
      projectId: revokedProject.projectId, status: 'active', expectedRevision: revokedProject.revision,
      idempotencyKey: 'idem_resume_revoked_reject_01'
    })).rejects.toMatchObject({ code: 'credential_revoked' })
    expect(await repository.getProject(revokedProject.projectId)).toMatchObject({
      status: 'paused', revision: revokedProject.revision
    })

    const validProject = await createPausedProject('valid', validCoordinator.agent.agentId)
    await expect(service.transitionProject(owner.user, {
      projectId: validProject.projectId, status: 'active', expectedRevision: validProject.revision,
      idempotencyKey: 'idem_resume_valid_01'
    })).resolves.toMatchObject({ status: 'active', revision: validProject.revision + 1 })
  })

  it('lets only active Project member users and Agents read a ProjectRecord', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'record-owner', 'provider-record-owner')
    const member = await onboard(service, authentication, 'record-member', 'provider-record-member')
    const outsider = await onboard(service, authentication, 'record-outsider', 'provider-record-outsider')
    const coordinatorAgent = await registerAgent(service, owner.user, 'recordcoord01')
    const memberAgent = await registerAgent(service, member.user, 'recordmember1')
    if (!memberAgent.deviceCredential) throw new Error('Expected member Agent credential')
    const memberDevice = await authentication.resolveBearer(memberAgent.deviceCredential)
    if (memberDevice.kind !== 'agent_device') throw new Error('Expected member Agent actor')
    const project = await service.createProject(owner.user, {
      displayName: 'ProjectRecord read boundary', goal: 'Share one bounded Project observation.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_project_record_read_project_01'
    })
    const record = await service.submitProjectRecord(member.user, {
      projectId: project.projectId, kind: 'observation', summary: 'A bounded shared observation.',
      idempotencyKey: 'idem_project_record_read_submit_01'
    })

    await expect(service.getProjectRecord(owner.user, record.projectRecordId)).resolves.toEqual(record)
    await expect(service.getProjectRecord(memberDevice, record.projectRecordId)).resolves.toEqual(record)
    await expect(service.getProjectRecord(outsider.user, record.projectRecordId)).rejects.toMatchObject({
      code: 'permission_denied'
    })
    await expect(service.getProjectRecord(owner.endpoint, record.projectRecordId)).rejects.toMatchObject({
      code: 'permission_denied'
    })
    await expect(service.getProjectRecord({ kind: 'system', actorKey: 'system:record-reader' },
      record.projectRecordId)).rejects.toMatchObject({ code: 'permission_denied' })
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
    const task = await service.createTask(alice.user, { projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId, title: '分析数据', objective: '返回有界结果摘要',
      completionCriteria: ['结果可复核'], dependencyTaskIds: [], expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_task_create_bob_01' })
    const repeated = await service.createTask(alice.user, { projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId, title: '分析数据', objective: '返回有界结果摘要',
      completionCriteria: ['结果可复核'], dependencyTaskIds: [], expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_task_create_bob_01' })
    expect(repeated.taskId).toBe(task.taskId)
    expect((await repository.pullInbox({ kind: 'agent', id: bobAgent.agent.agentId }, 0, 20, at.toISOString())))
      .toHaveLength(1)
    await expect(service.transitionTask(aliceDevice, { taskId: task.taskId, executionId: task.executionId, status: 'accepted',
      expectedRevision: 1, idempotencyKey: 'idem_wrong_agent_accept' })).rejects.toMatchObject({ code: 'assignee_mismatch' })

    const restarted = new CollaborationService({ repository, notifier, now })
    const accepted = await restarted.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'accepted',
      expectedRevision: 1, idempotencyKey: 'idem_bob_accept_task_01' })
    const running = await restarted.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_bob_run_task_01' })
    const completed = await restarted.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'completed',
      expectedRevision: running.revision, resultSummary: '分析完成，结果可复核。',
      idempotencyKey: 'idem_bob_complete_task_01' })
    expect(completed.status).toBe('completed')
    const coordinatorInbox = await restarted.pullInbox(aliceDevice, { afterSequence: 0, limit: 20 })
    expect(() => coordinatorInbox.messages.map((message) => toInboxMessage(message))).not.toThrow()
    expect(coordinatorInbox.messages.map((message) => message.sequence)).toEqual(
      coordinatorInbox.messages.map((_, index) => index + 1)
    )
  })

  it('requires the owner for assignment, reassignment, cancellation, and formal Project conclusions', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'governance-owner', 'provider-governance-owner')
    const member = await onboard(service, authentication, 'governance-member', 'provider-governance-member')
    const ownerAgent = await registerAgent(service, owner.user, 'governanceo1')
    const memberAgent = await registerAgent(service, member.user, 'governancem1')
    const coordinator = await authentication.resolveBearer(ownerAgent.deviceCredential!)
    const worker = await authentication.resolveBearer(memberAgent.deviceCredential!)
    if (coordinator.kind !== 'agent_device' || worker.kind !== 'agent_device') throw new Error('Expected Agent actors')
    const project = await service.createProject(owner.user, {
      displayName: 'Human-governed assignment', goal: 'Keep personnel and conclusions under owner authority.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: ownerAgent.agent.agentId,
      idempotencyKey: 'idem_governance_project_01'
    })
    const taskInput = {
      projectId: project.projectId, assigneeAgentId: memberAgent.agent.agentId,
      title: 'Owner-confirmed assignment', objective: 'Exercise the A-only authorization boundary.',
      completionCriteria: ['Every governed mutation records the correct actor'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision
    }
    await expect(service.createTask(coordinator, {
      ...taskInput, idempotencyKey: 'idem_governance_agent_create_denied_01'
    })).rejects.toMatchObject({ code: 'confirmation_required' })
    const task = await service.createTask(owner.user, {
      ...taskInput, idempotencyKey: 'idem_governance_owner_create_01'
    })
    expect(task.createdByAgentId).toBe(ownerAgent.agent.agentId)

    const accepted = await service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'accepted',
      expectedRevision: task.revision, idempotencyKey: 'idem_governance_accept_01' })
    const running = await service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_governance_run_01' })
    const failed = await service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'failed',
      expectedRevision: running.revision, safeFailureCode: 'retry_required',
      idempotencyKey: 'idem_governance_fail_01' })
    await expect(service.retryOrReassignTask(worker, { taskId: task.taskId, executionId: task.executionId,
      assigneeAgentId: memberAgent.agent.agentId, expectedRevision: failed.revision,
      idempotencyKey: 'idem_governance_worker_retry_denied_01' }))
      .rejects.toMatchObject({ code: 'coordinator_mismatch' })
    const retried = await service.retryOrReassignTask(coordinator, { taskId: task.taskId, executionId: task.executionId,
      assigneeAgentId: memberAgent.agent.agentId, expectedRevision: failed.revision,
      idempotencyKey: 'idem_governance_coordinator_same_retry_01' })
    const retryAccepted = await service.transitionTask(worker, { taskId: task.taskId, executionId: retried.executionId, status: 'accepted',
      expectedRevision: retried.revision, idempotencyKey: 'idem_governance_retry_accept_01' })
    const retryRunning = await service.transitionTask(worker, { taskId: task.taskId, executionId: retried.executionId, status: 'in_progress',
      expectedRevision: retryAccepted.revision, idempotencyKey: 'idem_governance_retry_run_01' })
    const retryFailed = await service.transitionTask(worker, { taskId: task.taskId, executionId: retried.executionId, status: 'failed',
      expectedRevision: retryRunning.revision, safeFailureCode: 'reassignment_required',
      idempotencyKey: 'idem_governance_retry_fail_01' })
    await expect(service.retryOrReassignTask(coordinator, { taskId: task.taskId, executionId: retried.executionId,
      assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: retryFailed.revision,
      idempotencyKey: 'idem_governance_coordinator_reassign_denied_01' }))
      .rejects.toMatchObject({ code: 'confirmation_required' })
    const reassigned = await service.retryOrReassignTask(owner.user, { taskId: task.taskId, executionId: retried.executionId,
      assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: retryFailed.revision,
      idempotencyKey: 'idem_governance_owner_reassign_01' })
    await expect(service.cancelTask(coordinator, { taskId: task.taskId, executionId: reassigned.executionId, expectedRevision: reassigned.revision,
      idempotencyKey: 'idem_governance_coordinator_cancel_denied_01' }))
      .rejects.toMatchObject({ code: 'confirmation_required' })
    await expect(service.cancelTask(owner.user, { taskId: task.taskId, executionId: reassigned.executionId, expectedRevision: reassigned.revision,
      idempotencyKey: 'idem_governance_owner_cancel_01' })).resolves.toMatchObject({ status: 'cancelled' })

    const observation = await service.submitProjectRecord(member.user, { projectId: project.projectId,
      kind: 'observation', summary: 'A bounded observation.', idempotencyKey: 'idem_governance_observation_01' })
    await expect(service.acceptProjectRecord(coordinator, { projectRecordId: observation.projectRecordId,
      expectedRevision: observation.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_observation_accept_01' })).resolves.toMatchObject({ status: 'accepted' })
    const disguisedSummary = await service.submitProjectRecord(member.user, { projectId: project.projectId,
      kind: 'observation', summary: 'An observation must not be upgraded by an Agent.',
      idempotencyKey: 'idem_governance_disguised_summary_01' })
    await expect(service.acceptProjectRecord(coordinator, { projectRecordId: disguisedSummary.projectRecordId,
      acceptedKind: 'summary', expectedRevision: disguisedSummary.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_disguised_summary_denied_01' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
    const proposal = await service.submitProjectRecord(member.user, { projectId: project.projectId,
      kind: 'proposal', summary: 'A candidate final conclusion.', idempotencyKey: 'idem_governance_proposal_01' })
    await expect(service.acceptProjectRecord(coordinator, { projectRecordId: proposal.projectRecordId,
      expectedRevision: proposal.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_coordinator_proposal_denied_01' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.acceptProjectRecord(coordinator, { projectRecordId: proposal.projectRecordId,
      acceptedKind: 'observation', expectedRevision: proposal.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_coordinator_proposal_downgrade_denied_01' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.acceptProjectRecord(owner.user, { projectRecordId: proposal.projectRecordId,
      expectedRevision: proposal.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_owner_proposal_accept_01' }))
      .resolves.toMatchObject({ status: 'accepted', kind: 'decision', acceptedByUserId: owner.userId })
    const summary = await service.submitProjectRecord(coordinator, { projectId: project.projectId,
      kind: 'summary', summary: 'A candidate final summary.', idempotencyKey: 'idem_governance_summary_01' })
    await expect(service.acceptProjectRecord(coordinator, { projectRecordId: summary.projectRecordId,
      expectedRevision: summary.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_coordinator_summary_denied_01' }))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.acceptProjectRecord(owner.user, { projectRecordId: summary.projectRecordId,
      expectedRevision: summary.revision, decision: 'accepted',
      idempotencyKey: 'idem_governance_owner_summary_accept_01' }))
      .resolves.toMatchObject({ status: 'accepted', acceptedByUserId: owner.userId })
  })

  it('lets the owner proactively reassign active Tasks and expires every pending HumanNeeded request', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'proactive-owner', 'provider-proactive-owner')
    const member = await onboard(service, authentication, 'proactive-member', 'provider-proactive-member')
    const ownerAgent = await registerAgent(service, owner.user, 'proactiveo1')
    const workerAgent = await registerAgent(service, member.user, 'proactivem1')
    const coordinator = await authentication.resolveBearer(ownerAgent.deviceCredential!)
    const worker = await authentication.resolveBearer(workerAgent.deviceCredential!)
    if (coordinator.kind !== 'agent_device' || worker.kind !== 'agent_device') throw new Error('Expected Agent actors')
    const project = await service.createProject(owner.user, {
      displayName: 'Proactive reassignment', goal: 'Keep an owner-controlled current execution route.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: ownerAgent.agent.agentId,
      budgets: { maxTasks: 20, maxTasksPerRound: 20, maxTaskRetries: 2, maxCoordinationRounds: 2 },
      idempotencyKey: 'idem_proactive_project_01'
    })
    const createWorkerTask = async (label: string) => {
      const currentProject = (await service.getProject(owner.user, project.projectId)).project
      return service.createTask(owner.user, {
        projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
        title: `Proactive ${label}`, objective: `Reach ${label} before an owner reassignment.`,
        completionCriteria: ['Only the new assignee remains authorized'], dependencyTaskIds: [],
        expectedProjectRevision: currentProject.revision, idempotencyKey: `idem_proactive_create_${label}`
      })
    }
    const prepareTask = async (label: string, status: 'offered' | 'accepted' | 'in_progress' | 'failed' | 'rejected') => {
      let task = await createWorkerTask(label)
      if (status === 'rejected') {
        return service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'rejected',
          expectedRevision: task.revision, idempotencyKey: `idem_proactive_reject_${label}` })
      }
      if (status !== 'offered') {
        task = await service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'accepted',
          expectedRevision: task.revision, idempotencyKey: `idem_proactive_accept_${label}` })
      }
      if (status === 'in_progress' || status === 'failed') {
        task = await service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'in_progress',
          expectedRevision: task.revision, idempotencyKey: `idem_proactive_run_${label}` })
      }
      if (status === 'failed') {
        task = await service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'failed',
          expectedRevision: task.revision, safeFailureCode: 'worker_failed',
          idempotencyKey: `idem_proactive_fail_${label}` })
      }
      return task
    }

    for (const status of ['offered', 'accepted', 'in_progress', 'failed', 'rejected'] as const) {
      const task = await prepareTask(status, status)
      const reassigned = await service.retryOrReassignTask(owner.user, {
        taskId: task.taskId, executionId: task.executionId, assigneeAgentId: ownerAgent.agent.agentId,
        expectedRevision: task.revision, idempotencyKey: `idem_proactive_reassign_${status}`
      })
      expect(reassigned).toMatchObject({ status: 'offered', assigneeAgentId: ownerAgent.agent.agentId,
        retryCount: 1, revision: task.revision + 1 })
      expect(reassigned.progress).toBeUndefined()
      expect(reassigned.resultSummary).toBeUndefined()
      expect(reassigned.safeFailureCode).toBeUndefined()
      expect(reassigned.completedAt).toBeUndefined()
      await expect(service.transitionTask(worker, { taskId: task.taskId, executionId: task.executionId, status: 'accepted',
        expectedRevision: reassigned.revision, idempotencyKey: `idem_proactive_old_worker_${status}` }))
        .rejects.toMatchObject({ code: 'assignee_mismatch' })
    }

    const activeSameAssignee = await createWorkerTask('same-assignee-active')
    await expect(service.retryOrReassignTask(owner.user, {
      taskId: activeSameAssignee.taskId, executionId: activeSameAssignee.executionId, assigneeAgentId: workerAgent.agent.agentId,
      expectedRevision: activeSameAssignee.revision, idempotencyKey: 'idem_proactive_same_assignee_active_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.retryOrReassignTask(coordinator, {
      taskId: activeSameAssignee.taskId, executionId: activeSameAssignee.executionId, assigneeAgentId: ownerAgent.agent.agentId,
      expectedRevision: activeSameAssignee.revision, idempotencyKey: 'idem_proactive_coordinator_active_reassign_01'
    })).rejects.toMatchObject({ code: 'confirmation_required' })

    let humanTask = await createWorkerTask('needs-human')
    humanTask = await service.transitionTask(worker, { taskId: humanTask.taskId, executionId: humanTask.executionId, status: 'accepted',
      expectedRevision: humanTask.revision, idempotencyKey: 'idem_proactive_human_accept_01' })
    humanTask = await service.transitionTask(worker, { taskId: humanTask.taskId, executionId: humanTask.executionId, status: 'in_progress',
      expectedRevision: humanTask.revision, idempotencyKey: 'idem_proactive_human_run_01' })
    humanTask = await service.reportTaskProgress(worker, { taskId: humanTask.taskId, executionId: humanTask.executionId,
      expectedRevision: humanTask.revision, percent: 45, summary: 'Waiting for two bounded confirmations.',
      idempotencyKey: 'idem_proactive_human_progress_01' })
    const firstRequest = await service.createHumanNeeded(worker, {
      projectId: project.projectId,
      source: { kind: 'worker', taskId: humanTask.taskId, executionId: humanTask.executionId,
        expectedTaskRevision: humanTask.revision },
      targetUserId: member.userId, requiredAssurance: 'verified', prompt: 'Continue the first branch?',
      expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: 'idem_proactive_human_first_01'
    })
    humanTask = await service.getTask(owner.user, humanTask.taskId)
    const secondRequest = await service.createHumanNeeded(worker, {
      projectId: project.projectId,
      source: { kind: 'worker', taskId: humanTask.taskId, executionId: humanTask.executionId,
        expectedTaskRevision: humanTask.revision },
      targetUserId: member.userId, requiredAssurance: 'verified', prompt: 'Continue the second branch?',
      expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: 'idem_proactive_human_second_01'
    })
    const firstStoredRequest = repository.state.humanRequests.get(firstRequest.humanRequestId)
    if (!firstStoredRequest) throw new Error('Expected first pending HumanNeeded request')
    firstStoredRequest.expiresAt = '2026-08-15T01:59:00.000Z'
    const humanReassigned = await service.retryOrReassignTask(owner.user, {
      taskId: humanTask.taskId, executionId: humanTask.executionId, assigneeAgentId: ownerAgent.agent.agentId,
      expectedRevision: humanTask.revision, idempotencyKey: 'idem_proactive_human_reassign_01'
    })
    expect(humanReassigned).toMatchObject({ status: 'offered', assigneeAgentId: ownerAgent.agent.agentId,
      retryCount: 1, revision: humanTask.revision + 1 })
    expect(humanReassigned.progress).toBeUndefined()
    expect(repository.state.humanRequests.get(firstRequest.humanRequestId)).toMatchObject({
      status: 'expired', revision: firstRequest.revision + 1, updatedAt: at.toISOString()
    })
    expect(repository.state.humanRequests.get(secondRequest.humanRequestId)).toMatchObject({
      status: 'cancelled', revision: secondRequest.revision + 1, updatedAt: at.toISOString()
    })
    for (const request of [firstRequest, secondRequest]) {
      await expect(service.answerHumanNeeded(member.endpoint, {
        humanRequestId: request.humanRequestId, requestRevision: request.revision, answer: 'Too late',
        idempotencyKey: `idem_proactive_expired_answer_${request.humanRequestId}`
      })).rejects.toMatchObject({ code: 'request_expired' })
    }
    expect(repository.state.humanAnswers.size).toBe(0)
    await expect(service.reportTaskProgress(worker, { taskId: humanTask.taskId, executionId: humanTask.executionId,
      expectedRevision: humanReassigned.revision, percent: 50, summary: 'Stale worker progress.',
      idempotencyKey: 'idem_proactive_old_progress_01' })).rejects.toMatchObject({ code: 'assignee_mismatch' })
    await expect(service.createResourceRef(worker, {
      projectId: project.projectId, taskId: humanTask.taskId, executionId: humanTask.executionId,
      expectedTaskRevision: humanReassigned.revision,
      provider: 'example-content', externalId: 'stale-worker-resource', kind: 'shared_document',
      name: 'Stale worker resource', openUrl: 'https://content.example.invalid/stale-worker-resource',
      idempotencyKey: 'idem_proactive_old_resource_01'
    })).rejects.toMatchObject({ code: 'execution_conflict' })
    await expect(service.transitionTask(worker, { taskId: humanTask.taskId, executionId: humanTask.executionId, status: 'completed',
      expectedRevision: humanReassigned.revision, resultSummary: 'Stale worker result.',
      idempotencyKey: 'idem_proactive_old_result_01' })).rejects.toMatchObject({ code: 'assignee_mismatch' })
    const newOffers = (await repository.pullInbox(
      { kind: 'agent', id: ownerAgent.agent.agentId }, 0, 100, at.toISOString()
    )).filter((message) => message.messageType === 'task.offered' && message.payload.taskId === humanTask.taskId)
    expect(newOffers).toHaveLength(1)
    expect(newOffers[0]?.payload.revision).toBe(humanReassigned.revision)

    let sameAssigneeHumanTask = await createWorkerTask('same-assignee-human')
    sameAssigneeHumanTask = await service.transitionTask(worker, {
      taskId: sameAssigneeHumanTask.taskId, executionId: sameAssigneeHumanTask.executionId,
      status: 'accepted', expectedRevision: sameAssigneeHumanTask.revision,
      idempotencyKey: 'idem_proactive_same_human_accept_01'
    })
    sameAssigneeHumanTask = await service.transitionTask(worker, {
      taskId: sameAssigneeHumanTask.taskId, executionId: sameAssigneeHumanTask.executionId,
      status: 'in_progress', expectedRevision: sameAssigneeHumanTask.revision,
      idempotencyKey: 'idem_proactive_same_human_run_01'
    })
    const sameAssigneeRequest = await service.createHumanNeeded(worker, {
      projectId: project.projectId,
      source: { kind: 'worker', taskId: sameAssigneeHumanTask.taskId,
        executionId: sameAssigneeHumanTask.executionId, expectedTaskRevision: sameAssigneeHumanTask.revision },
      targetUserId: member.userId, requiredAssurance: 'verified', prompt: 'Clarify before a same-node retry.',
      expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: 'idem_proactive_same_human_needed_01'
    })
    sameAssigneeHumanTask = await service.getTask(owner.user, sameAssigneeHumanTask.taskId)
    sameAssigneeHumanTask = await service.transitionTask(worker, {
      taskId: sameAssigneeHumanTask.taskId, executionId: sameAssigneeHumanTask.executionId,
      status: 'failed', expectedRevision: sameAssigneeHumanTask.revision, safeFailureCode: 'clarification_timeout',
      idempotencyKey: 'idem_proactive_same_human_failed_01'
    })
    const sameAssigneeRetried = await service.retryOrReassignTask(owner.user, {
      taskId: sameAssigneeHumanTask.taskId, executionId: sameAssigneeHumanTask.executionId,
      assigneeAgentId: workerAgent.agent.agentId, expectedRevision: sameAssigneeHumanTask.revision,
      idempotencyKey: 'idem_proactive_same_human_retry_01'
    })
    expect(sameAssigneeRetried).toMatchObject({ status: 'offered', assigneeAgentId: workerAgent.agent.agentId,
      retryCount: 1, revision: sameAssigneeHumanTask.revision + 1 })
    expect(sameAssigneeRetried.executionId).not.toBe(sameAssigneeHumanTask.executionId)
    expect(repository.state.humanRequests.get(sameAssigneeRequest.humanRequestId)).toMatchObject({
      status: 'cancelled', revision: sameAssigneeRequest.revision + 1, updatedAt: at.toISOString()
    })
    await expect(service.answerHumanNeeded(member.endpoint, {
      humanRequestId: sameAssigneeRequest.humanRequestId, requestRevision: sameAssigneeRequest.revision,
      answer: 'This old execution no longer accepts answers.', idempotencyKey: 'idem_proactive_same_human_answer_01'
    })).rejects.toMatchObject({ code: 'request_expired' })

    const completedTask = await prepareTask('completed-terminal', 'in_progress')
    const completed = await service.transitionTask(worker, { taskId: completedTask.taskId, executionId: completedTask.executionId, status: 'completed',
      expectedRevision: completedTask.revision, resultSummary: 'Terminal result.',
      idempotencyKey: 'idem_proactive_complete_terminal_01' })
    await expect(service.retryOrReassignTask(owner.user, { taskId: completed.taskId, executionId: completed.executionId,
      assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: completed.revision,
      idempotencyKey: 'idem_proactive_completed_reassign_01' }))
      .resolves.toMatchObject({ status: 'offered', assigneeAgentId: ownerAgent.agent.agentId })
    const cancelledTask = await createWorkerTask('cancelled-terminal')
    const cancelled = await service.cancelTask(owner.user, { taskId: cancelledTask.taskId,
      executionId: cancelledTask.executionId,
      expectedRevision: cancelledTask.revision, idempotencyKey: 'idem_proactive_cancel_terminal_01' })
    await expect(service.retryOrReassignTask(owner.user, { taskId: cancelled.taskId, executionId: cancelled.executionId,
      assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: cancelled.revision,
      idempotencyKey: 'idem_proactive_cancelled_reassign_01' }))
      .rejects.toMatchObject({ code: 'invalid_state_transition' })

    const concurrentTask = await createWorkerTask('concurrent-active')
    const competing = await Promise.allSettled([
      service.retryOrReassignTask(owner.user, { taskId: concurrentTask.taskId, executionId: concurrentTask.executionId,
        assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: concurrentTask.revision,
        idempotencyKey: 'idem_proactive_concurrent_first_01' }),
      service.retryOrReassignTask(owner.user, { taskId: concurrentTask.taskId, executionId: concurrentTask.executionId,
        assigneeAgentId: ownerAgent.agent.agentId, expectedRevision: concurrentTask.revision,
        idempotencyKey: 'idem_proactive_concurrent_second_01' })
    ])
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(competing.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'execution_conflict', details: { currentRevision: concurrentTask.revision + 1 } }
    })
    const concurrentOffers = (await repository.pullInbox(
      { kind: 'agent', id: ownerAgent.agent.agentId }, 0, 200, at.toISOString()
    )).filter((message) => message.messageType === 'task.offered' && message.payload.taskId === concurrentTask.taskId)
    expect(concurrentOffers).toHaveLength(1)
  })

  it('requires a current Coordinator HumanNeeded source from its active Project coordination Inbox', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'source-owner', 'provider-source-owner')
    const member = await onboard(service, authentication, 'source-member', 'provider-source-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'sourcecoord1')
    const replacementAgent = await registerAgent(service, owner.user, 'sourcerepl1')
    const coordinator = await authentication.resolveBearer(coordinatorAgent.deviceCredential!)
    const replacement = await authentication.resolveBearer(replacementAgent.deviceCredential!)
    if (coordinator.kind !== 'agent_device' || replacement.kind !== 'agent_device') {
      throw new Error('Expected Agent actors')
    }
    const project = await service.createProject(owner.user, {
      displayName: 'Coordinator source project', goal: 'Accept only real active coordination message provenance.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_source_project_01'
    })
    const otherProject = await service.createProject(owner.user, {
      displayName: 'Other source project', goal: 'Keep coordinator message provenance isolated by Project.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_source_other_project_01'
    })
    const initialInbox = (await service.pullInbox(coordinator, { afterSequence: 0, limit: 20 })).messages
    const projectStarted = initialInbox.find((message) =>
      message.messageType === 'project.started' && message.payload.projectId === project.projectId)
    const otherProjectStarted = initialInbox.find((message) =>
      message.messageType === 'project.started' && message.payload.projectId === otherProject.projectId)
    if (!projectStarted || !otherProjectStarted) throw new Error('Expected both Project start messages')

    const coordinatorWorkerTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: coordinatorAgent.agent.agentId,
      title: 'Coordinator also acting as Worker', objective: 'Create a non-coordination Inbox source type.',
      completionCriteria: ['Task offer is not accepted as Coordinator question provenance'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_source_worker_task_01'
    })
    const taskOffer = (await service.pullInbox(coordinator, { afterSequence: 0, limit: 20 })).messages
      .find((message) => message.messageType === 'task.offered' &&
        message.payload.taskId === coordinatorWorkerTask.taskId)
    if (!taskOffer) throw new Error('Expected Worker Task offer in Coordinator Agent inbox')

    await service.transferCoordinator(owner.user, {
      projectId: project.projectId, coordinatorAgentId: replacementAgent.agent.agentId,
      expectedRevision: project.revision + 1, idempotencyKey: 'idem_source_transfer_away_01'
    })
    await service.transferCoordinator(owner.user, {
      projectId: project.projectId, coordinatorAgentId: coordinatorAgent.agent.agentId,
      expectedRevision: project.revision + 2, idempotencyKey: 'idem_source_transfer_back_01'
    })
    const replacementMessage = (await service.pullInbox(replacement, { afterSequence: 0, limit: 20 })).messages[0]
    const activeReroutedSource = (await service.pullInbox(coordinator, { afterSequence: 0, limit: 50 })).messages
      .find((message) => message.messageType === 'project.started' &&
        message.payload.projectId === project.projectId && message.disposition === 'active' &&
        message.messageId !== projectStarted.messageId)
    if (!replacementMessage || !activeReroutedSource) throw new Error('Expected transferred Coordinator messages')

    const ask = (sourceInboxMessageId: string, key: string) => service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId },
      targetUserId: member.userId, requiredAssurance: 'verified', prompt: 'Provide a bounded Project clarification.',
      expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: key
    })
    await expect(ask('ibx_SourceDoesNotExist01', 'idem_source_missing_01'))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ask(replacementMessage.messageId, 'idem_source_wrong_recipient_01'))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ask(otherProjectStarted.messageId, 'idem_source_wrong_project_01'))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ask(taskOffer.messageId, 'idem_source_wrong_type_01'))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ask(projectStarted.messageId, 'idem_source_superseded_01'))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ask(activeReroutedSource.messageId, 'idem_source_active_01')).resolves.toMatchObject({
      projectId: project.projectId, sourceKind: 'coordinator', sourceInboxMessageId: activeReroutedSource.messageId,
      requestedByAgentId: coordinatorAgent.agent.agentId, status: 'pending'
    })
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
    const task = await service.createTask(alice.user, {
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
      executionId: task.executionId,
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
      executionId: task.executionId,
      status: 'accepted',
      expectedRevision: task.revision,
      idempotencyKey: 'idem_resource_task_accept_01'
    })
    const input = {
      projectId: project.projectId,
      taskId: task.taskId,
      executionId: task.executionId,
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
      executionId: undefined,
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
      executionId: task.executionId,
      status: 'in_progress',
      expectedRevision: accepted.revision,
      idempotencyKey: 'idem_resource_task_running_01'
    })
    await service.transitionTask(bobDevice, {
      taskId: task.taskId,
      executionId: task.executionId,
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
    const reassignedTask = await service.createTask(alice.user, {
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
      taskId: reassignedTask.taskId, executionId: reassignedTask.executionId,
      status: 'accepted', expectedRevision: reassignedTask.revision,
      idempotencyKey: 'idem_resource_reassigned_task_accept_01'
    })
    const reassignedRunning = await service.transitionTask(bobDevice, {
      taskId: reassignedTask.taskId, executionId: reassignedTask.executionId,
      status: 'in_progress', expectedRevision: reassignedAccepted.revision,
      idempotencyKey: 'idem_resource_reassigned_task_running_01'
    })
    const preReassignmentResource = await service.createResourceRef(bobDevice, {
      projectId: project.projectId,
      taskId: reassignedTask.taskId,
      executionId: reassignedTask.executionId,
      expectedTaskRevision: reassignedRunning.revision,
      provider: 'example-content',
      externalId: 'pre-reassignment-document',
      kind: 'shared_document',
      name: 'Pre-reassignment reference',
      openUrl: 'https://content.example.invalid/resources/pre-reassignment-document',
      idempotencyKey: 'idem_resource_pre_reassignment_create_01'
    })
    const failedTask = await service.transitionTask(bobDevice, {
      taskId: reassignedTask.taskId, executionId: reassignedTask.executionId,
      status: 'failed', expectedRevision: reassignedRunning.revision,
      safeFailureCode: 'worker_failed', idempotencyKey: 'idem_resource_reassigned_task_fail_01'
    })
    const replacement = await service.retryOrReassignTask(alice.user, {
      taskId: reassignedTask.taskId,
      executionId: reassignedTask.executionId,
      assigneeAgentId: aliceAgent.agent.agentId,
      expectedRevision: failedTask.revision,
      idempotencyKey: 'idem_resource_task_reassign_01'
    })
    await expect(service.invalidateResourceRef(bobDevice, {
      resourceRefId: preReassignmentResource.resourceRefId,
      expectedRevision: preReassignmentResource.revision,
      idempotencyKey: 'idem_resource_old_worker_invalidate_01'
    })).rejects.toMatchObject({ code: 'assignee_mismatch' })
    await expect(service.createResourceRef(bobDevice, {
      projectId: project.projectId,
      taskId: replacement.taskId,
      executionId: replacement.executionId,
      expectedTaskRevision: failedTask.revision,
      provider: 'example-content',
      externalId: 'old-worker-current-execution-document',
      kind: 'shared_document',
      name: 'Old Worker current execution reference',
      openUrl: 'https://content.example.invalid/resources/old-worker-current-execution-document',
      idempotencyKey: 'idem_resource_old_worker_current_execution_01'
    })).rejects.toMatchObject({ code: 'assignee_mismatch' })
    await expect(service.createResourceRef(bobDevice, {
      projectId: project.projectId,
      taskId: replacement.taskId,
      executionId: reassignedTask.executionId,
      expectedTaskRevision: replacement.revision,
      provider: 'example-content',
      externalId: 'old-worker-document',
      kind: 'shared_document',
      name: 'Old Worker reference',
      openUrl: 'https://content.example.invalid/resources/old-worker-document',
      idempotencyKey: 'idem_resource_old_worker_create_01'
    })).rejects.toMatchObject({ code: 'execution_conflict' })

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
    const aliceAgent = await registerAgent(service, alice.user, 'capaliceagt1', { provisionCapability: false })
    const bobAgent = await registerAgent(service, bob.user, 'capbobagent1', { provisionCapability: false })
    const revokedBobAgent = await registerAgent(service, bob.user, 'capbobagent2')
    const unseenBobAgent = await registerAgent(service, bob.user, 'capbobunseen1', {
      provisionCapability: false,
      heartbeat: false
    })
    const outsiderAgent = await registerAgent(service, outsider.user, 'capoutside01')
    await service.revokeAgent(bob.user, { agentId: revokedBobAgent.agent.agentId,
      expectedRevision: revokedBobAgent.agent.revision, idempotencyKey: 'idem_capability_revoke_bob_agent_01' })
    const aliceDevice = await authentication.resolveBearer(aliceAgent.deviceCredential!)
    const bobDevice = await authentication.resolveBearer(bobAgent.deviceCredential!)
    const unseenBobDevice = await authentication.resolveBearer(unseenBobAgent.deviceCredential!)
    if (aliceDevice.kind !== 'agent_device' || bobDevice.kind !== 'agent_device' || unseenBobDevice.kind !== 'agent_device') {
      throw new Error('Expected Agent actors')
    }
    for (const [device, agent, ownerUserId, label] of [
      [aliceDevice, aliceAgent.agent, alice.userId, 'alice'],
      [bobDevice, bobAgent.agent, bob.userId, 'bob']
    ] as const) {
      await service.reportAgentCapabilityProfile(device, {
        agentId: agent.agentId, ownerUserId, nodeType: 'personal_computer',
        os: { family: 'linux', architecture: 'x64' }, runtimeIds: ['runtime.test'],
        capabilities: [{ capabilityId: 'research.execute', evidence: {
          level: 'verified', checkedAt: at.toISOString(), summary: `${label} capability verified.`
        } }],
        vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
        resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
          fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
        reportedAt: at.toISOString(), expiresAt: '2026-08-15T03:00:00.000Z',
        idempotencyKey: `idem_capability_profile_${label}_01`
      })
    }
    await service.reportAgentCapabilityProfile(unseenBobDevice, {
      agentId: unseenBobAgent.agent.agentId, ownerUserId: bob.userId, nodeType: 'personal_computer',
      os: { family: 'linux', architecture: 'x64' }, runtimeIds: ['runtime.test'],
      capabilities: [{ capabilityId: 'research.execute', evidence: {
        level: 'verified', checkedAt: at.toISOString()
      } }],
      vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
      resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
        fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
      reportedAt: at.toISOString(), expiresAt: '2026-08-15T03:00:00.000Z',
      idempotencyKey: 'idem_capability_profile_unseen_bob_01'
    })

    const project = await service.createProject(alice.user, {
      displayName: 'Capabilities and progress', goal: 'Verify minimal discovery and Task progress.',
      memberUserIds: [alice.userId, bob.userId], coordinatorAgentId: aliceAgent.agent.agentId,
      budgets: { maxTasks: 4, maxTasksPerRound: 4, maxTaskRetries: 1, maxCoordinationRounds: 2 },
      idempotencyKey: 'idem_capability_progress_project_01'
    })
    const task = await service.createTask(alice.user, {
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
    expect(directory.agents.every((agent) => agent.lastSeenAt === at.toISOString())).toBe(true)
    const serializedDirectory = JSON.stringify(directory)
    expect(serializedDirectory).not.toContain('installationId')
    expect(serializedDirectory).not.toContain('credentialVersion')
    expect(serializedDirectory).not.toContain(outsiderAgent.agent.agentId)
    expect(serializedDirectory).not.toContain(revokedBobAgent.agent.agentId)
    expect(serializedDirectory).not.toContain(unseenBobAgent.agent.agentId)
    await expect(service.getProjectCapabilityDirectory(outsider.user, project.projectId))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.getProjectCapabilityDirectory(bobDevice, project.projectId))
      .resolves.toMatchObject({ projectId: project.projectId })

    const accepted = await service.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'accepted',
      expectedRevision: task.revision, idempotencyKey: 'idem_capability_progress_accept_01' })
    const running = await service.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_capability_progress_running_01' })
    const coordinatorInboxBefore = (await repository.pullInbox(
      { kind: 'agent', id: aliceAgent.agent.agentId }, 0, 100, at.toISOString())).length
    const ownerInboxBefore = (await repository.pullInbox(
      { kind: 'user', id: alice.userId }, 0, 100, at.toISOString())).length
    const reportInput = { taskId: task.taskId, executionId: task.executionId,
      expectedRevision: running.revision, percent: 25,
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
      .rejects.toMatchObject({ code: 'assignee_mismatch' })
    await expect(service.reportTaskProgress(bobDevice, { ...reportInput,
      percent: 30, idempotencyKey: 'idem_capability_progress_old_revision_01' }))
      .rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(service.reportTaskProgress(bobDevice, { ...reportInput,
      expectedRevision: progressed.revision, percent: 20, idempotencyKey: 'idem_capability_progress_regress_01' }))
      .rejects.toMatchObject({ code: 'invalid_state_transition' })

    const failed = await service.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'failed',
      expectedRevision: progressed.revision, safeFailureCode: 'input_invalid',
      idempotencyKey: 'idem_capability_progress_failed_01' })
    expect(toTask(failed)).toMatchObject({ status: 'failed', safeFailureCode: 'input_invalid' })
    expect(toTask(failed)).not.toHaveProperty('resultSummary')
    const retried = await service.retryOrReassignTask(alice.user, { taskId: task.taskId, executionId: task.executionId,
      assigneeAgentId: aliceAgent.agent.agentId, expectedRevision: failed.revision,
      idempotencyKey: 'idem_capability_progress_retry_01' })
    expect(retried).not.toHaveProperty('progress')
    expect(retried).not.toHaveProperty('resultSummary')
    expect(retried).not.toHaveProperty('safeFailureCode')
    await expect(service.reportTaskProgress(bobDevice, { taskId: task.taskId, executionId: task.executionId,
      expectedRevision: retried.revision,
      percent: 30, summary: 'Stale assignee report.', idempotencyKey: 'idem_capability_progress_old_assignee_01' }))
      .rejects.toMatchObject({ code: 'assignee_mismatch' })

    const acceptedRetry = await service.transitionTask(aliceDevice, { taskId: task.taskId, executionId: retried.executionId, status: 'accepted',
      expectedRevision: retried.revision, idempotencyKey: 'idem_capability_progress_retry_accept_01' })
    const runningRetry = await service.transitionTask(aliceDevice, { taskId: task.taskId, executionId: retried.executionId, status: 'in_progress',
      expectedRevision: acceptedRetry.revision, idempotencyKey: 'idem_capability_progress_retry_running_01' })
    const completed = await service.transitionTask(aliceDevice, { taskId: task.taskId, executionId: retried.executionId, status: 'completed',
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
      const offeredTask = await service.createTask(alice.user, {
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
      const runningTask = await service.createTask(alice.user, {
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
        executionId: runningTask.executionId,
        status: 'accepted',
        expectedRevision: runningTask.revision,
        idempotencyKey: `idem_inactive_running_accept_${projectStatus}`
      })
      const running = await service.transitionTask(bobDevice, {
        taskId: runningTask.taskId,
        executionId: runningTask.executionId,
        status: 'in_progress',
        expectedRevision: runningAccepted.revision,
        idempotencyKey: `idem_inactive_running_start_${projectStatus}`
      })
      const projectAfterRunning = repository.state.projects.get(project.projectId)
      if (!projectAfterRunning) throw new Error('Expected Project after running Task')
      const failedTask = await service.createTask(alice.user, {
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
        executionId: failedTask.executionId,
        status: 'accepted',
        expectedRevision: failedTask.revision,
        idempotencyKey: `idem_inactive_failed_accept_${projectStatus}`
      })
      const failedRunning = await service.transitionTask(bobDevice, {
        taskId: failedTask.taskId,
        executionId: failedTask.executionId,
        status: 'in_progress',
        expectedRevision: failedAccepted.revision,
        idempotencyKey: `idem_inactive_failed_start_${projectStatus}`
      })
      const failed = await service.transitionTask(bobDevice, {
        taskId: failedTask.taskId,
        executionId: failedTask.executionId,
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
        executionId: offeredTask.executionId,
        status: 'accepted',
        expectedRevision: offeredTask.revision,
        idempotencyKey: `idem_inactive_accept_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.reportTaskProgress(bobDevice, {
        taskId: running.taskId,
        executionId: running.executionId,
        expectedRevision: running.revision,
        percent: 50,
        summary: 'This progress must not be persisted.',
        idempotencyKey: `idem_inactive_progress_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.transitionTask(bobDevice, {
        taskId: running.taskId,
        executionId: running.executionId,
        status: 'completed',
        expectedRevision: running.revision,
        resultSummary: 'This result must not be persisted.',
        idempotencyKey: `idem_inactive_result_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.createHumanNeeded(bobDevice, {
        projectId: project.projectId,
        source: { kind: 'worker', taskId: running.taskId, executionId: running.executionId,
          expectedTaskRevision: running.revision },
        targetUserId: bob.userId,
        requiredAssurance: 'verified',
        prompt: 'This request must not be persisted.',
        expiresAt: '2026-08-15T03:00:00.000Z',
        idempotencyKey: `idem_inactive_human_rejected_${projectStatus}`
      })).rejects.toMatchObject({ code: 'invalid_state_transition' })
      await expect(service.retryOrReassignTask(alice.user, {
        taskId: failed.taskId,
        executionId: failed.executionId,
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
    const completionTask = await service.createTask(alice.user, {
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
      executionId: completionTask.executionId,
      status: 'accepted',
      expectedRevision: completionTask.revision,
      idempotencyKey: 'idem_completion_boundary_accept_01'
    })
    const completionRunning = await service.transitionTask(bobDevice, {
      taskId: completionTask.taskId,
      executionId: completionTask.executionId,
      status: 'in_progress',
      expectedRevision: completionAccepted.revision,
      idempotencyKey: 'idem_completion_boundary_run_01'
    })
    await expect(service.transitionTask(bobDevice, {
      taskId: completionTask.taskId,
      executionId: completionTask.executionId,
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
      executionId: completionTask.executionId,
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
    const cancellationTask = await service.createTask(alice.user, {
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
    const cancelledTask = await service.cancelTask(alice.user, {
      taskId: cancellationTask.taskId,
      executionId: cancellationTask.executionId,
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
    const routedTask = await service.createTask(alice.user, {
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
      executionId: routedTask.executionId,
      status: 'accepted',
      expectedRevision: routedTask.revision,
      idempotencyKey: 'idem_single_route_accept_01'
    })
    const routedRunning = await service.transitionTask(bobDevice, {
      taskId: routedTask.taskId,
      executionId: routedTask.executionId,
      status: 'in_progress',
      expectedRevision: routedAccepted.revision,
      idempotencyKey: 'idem_single_route_run_01'
    })
    const routedFailed = await service.transitionTask(bobDevice, {
      taskId: routedTask.taskId,
      executionId: routedTask.executionId,
      status: 'failed',
      expectedRevision: routedRunning.revision,
      safeFailureCode: 'retry_required',
      idempotencyKey: 'idem_single_route_fail_01'
    })
    const competingRetries = await Promise.allSettled([
      service.retryOrReassignTask(alice.user, {
        taskId: routedTask.taskId,
        executionId: routedTask.executionId,
        assigneeAgentId: aliceAgent.agent.agentId,
        expectedRevision: routedFailed.revision,
        idempotencyKey: 'idem_single_route_retry_alice_01'
      }),
      service.retryOrReassignTask(aliceDevice, {
        taskId: routedTask.taskId,
        executionId: routedTask.executionId,
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
    expect(rejectedRetry.reason).toMatchObject({ code: 'execution_conflict' })

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
      executionId: currentRoutedTask.executionId,
      status: 'accepted',
      expectedRevision: currentRoutedTask.revision,
      idempotencyKey: 'idem_single_route_non_assignee_rejected_01'
    })).rejects.toMatchObject({ code: 'assignee_mismatch' })
    await expect(service.transitionTask(routedAssignee, {
      taskId: routedTask.taskId,
      executionId: currentRoutedTask.executionId,
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
    const task = await service.createTask(alice.user, { projectId: project.projectId,
      assigneeAgentId: bobAgent.agent.agentId, title: '需确认', objective: '等待 Bob 决策',
      completionCriteria: ['收到回答'], dependencyTaskIds: [], expectedProjectRevision: project.revision,
      idempotencyKey: 'idem_task_human_loop' })
    const accepted = await service.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId,
      status: 'accepted', expectedRevision: 1,
      idempotencyKey: 'idem_task_human_accept' })
    const running = await service.transitionTask(bobDevice, { taskId: task.taskId, executionId: task.executionId, status: 'in_progress',
      expectedRevision: accepted.revision, idempotencyKey: 'idem_task_human_running' })
    const request = await service.createHumanNeeded(bobDevice, { projectId: project.projectId,
      source: { kind: 'worker', taskId: task.taskId, executionId: task.executionId,
        expectedTaskRevision: running.revision },
      targetUserId: bob.userId, requiredAssurance: 'verified',
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
    const expiringRequest = await service.createHumanNeeded(bobDevice, { projectId: project.projectId,
      source: { kind: 'worker', taskId: task.taskId, executionId: task.executionId,
        expectedTaskRevision: running.revision + 1 },
      targetUserId: bob.userId, requiredAssurance: 'verified',
      prompt: '过期后不可回答', expiresAt: '2026-08-15T03:30:00.000Z',
      idempotencyKey: 'idem_human_needed_expiring_bob' })
    const laterService = new CollaborationService({ repository, now: () => new Date('2026-08-15T04:00:00.000Z') })
    const answerCountBeforeExpiry = repository.state.humanAnswers.size
    await expect(laterService.answerHumanNeeded(bob.endpoint, { humanRequestId: expiringRequest.humanRequestId,
      requestRevision: expiringRequest.revision, answer: '迟到回答', sourceLocator: movedProjectLocator,
      idempotencyKey: 'idem_human_expired_answer_bob' })).rejects.toMatchObject({ code: 'request_expired' })
    expect(repository.state.humanRequests.get(expiringRequest.humanRequestId)).toMatchObject({
      status: 'expired', revision: expiringRequest.revision + 1, updatedAt: '2026-08-15T04:00:00.000Z'
    })
    expect(repository.state.humanAnswers.size).toBe(answerCountBeforeExpiry)
    const bobInbox = await service.pullInbox(bob.user, { afterSequence: 0, limit: 20 })
    expect(() => bobInbox.messages.map((message) => toInboxMessage(message))).not.toThrow()
    const aliceAgentInbox = await service.pullInbox(aliceDevice, { afterSequence: 0, limit: 50 })
    expect(() => aliceAgentInbox.messages.map((message) => toInboxMessage(message))).not.toThrow()
  })

  it('materializes authoritative HumanNeeded expiry before returning a coordination view', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'expiry-view-owner', 'provider-expiry-view-owner')
    const member = await onboard(service, authentication, 'expiry-view-member', 'provider-expiry-view-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'expirycoord1')
    const workerAgent = await registerAgent(service, member.user, 'expiryworker1')
    const worker = fakeAgentActor(workerAgent.agent, member.userId)
    const project = await service.createProject(owner.user, {
      displayName: 'Expiry coordination view', goal: 'Never project a past-due HumanNeeded request as pending.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_expiry_view_project_01'
    })
    let task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Collect bounded answers', objective: 'Expose authoritative request lifecycle state.',
      completionCriteria: ['Expired requests are materialized'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_expiry_view_task_01'
    })
    task = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'accepted', expectedRevision: task.revision,
      idempotencyKey: 'idem_expiry_view_accept_01'
    })
    task = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'in_progress', expectedRevision: task.revision,
      idempotencyKey: 'idem_expiry_view_run_01'
    })
    const expiredRequest = await service.createHumanNeeded(worker, {
      projectId: project.projectId,
      source: { kind: 'worker', taskId: task.taskId, executionId: task.executionId,
        expectedTaskRevision: task.revision },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'This request should expire.',
      expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: 'idem_expiry_view_expired_01'
    })
    task = await service.getTask(owner.user, task.taskId)
    const futureRequest = await service.createHumanNeeded(worker, {
      projectId: project.projectId,
      source: { kind: 'worker', taskId: task.taskId, executionId: task.executionId,
        expectedTaskRevision: task.revision },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'This request remains pending.',
      expiresAt: '2026-08-15T05:00:00.000Z', idempotencyKey: 'idem_expiry_view_future_01'
    })
    const readAt = '2026-08-15T04:00:00.000Z'
    const laterService = new CollaborationService({ repository, now: () => new Date(readAt) })

    const view = await laterService.getProjectCoordinationView(owner.user, project.projectId)

    expect(view.readAt).toBe(readAt)
    expect(view.humanRequests.find((request) => request.humanRequestId === expiredRequest.humanRequestId))
      .toMatchObject({ status: 'expired', revision: expiredRequest.revision + 1, updatedAt: readAt })
    expect(view.humanRequests.find((request) => request.humanRequestId === futureRequest.humanRequestId))
      .toMatchObject({ status: 'pending', revision: futureRequest.revision })
    expect(view.humanRequests.some((request) => request.status === 'pending' && request.expiresAt <= readAt)).toBe(false)
    expect(repository.state.humanRequests.get(expiredRequest.humanRequestId))
      .toMatchObject({ status: 'expired', revision: expiredRequest.revision + 1, updatedAt: readAt })
    await expect(laterService.pruneExpired()).resolves.toMatchObject({ humanRequests: 0 })
  })

  it('returns expired unacknowledged Inbox entries as sequence-preserving superseded tombstones', async () => {
    const repository = new FakeCollaborationRepository()
    const authentication = new AuthenticationService(repository, now)
    const initialService = new CollaborationService({ repository, now })
    const owner = await onboard(initialService, authentication, 'inbox-expiry-owner', 'provider-inbox-expiry-owner')
    const agent = await registerAgent(initialService, owner.user, 'inboxexpiry1')
    const actor = fakeAgentActor(agent.agent, owner.userId)
    const createdAt = now().toISOString()
    await repository.transaction((tx) => tx.appendInbox({
      recipient: { kind: 'agent', id: agent.agent.agentId },
      messageId: 'ibx_ExpiredTombstone01',
      messageType: 'agent.revoked',
      payload: { protocolVersion: '1.0', type: 'agent.revoked', agentId: agent.agent.agentId },
      createdAt,
      expiresAt: '2026-08-15T03:00:00.000Z'
    }))
    const readAt = '2026-08-15T04:00:00.000Z'
    const laterService = new CollaborationService({ repository, now: () => new Date(readAt) })

    const page = await laterService.pullInbox(actor, { afterSequence: 0, limit: 20 })

    expect(page).toMatchObject({ ackedSequence: 0, nextSequence: 2,
      messages: [{ sequence: 1, disposition: 'superseded', supersededAt: readAt }] })
    expect(toInboxMessage(page.messages[0]!, page.ackedSequence)).toMatchObject({
      sequence: 1, status: 'superseded', disposition: 'superseded'
    })
    await expect(laterService.ackInboxMessage(actor, {
      inboxMessageId: page.messages[0]!.messageId,
      sequence: page.messages[0]!.sequence,
      idempotencyKey: 'idem_inbox_expired_tombstone_ack_01'
    })).resolves.toMatchObject({ ackedSequence: 1, nextSequence: 2 })
  })

  it('keeps an accepted automatic TaskResult immutable across retry and reassignment attempts', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'accepted-result-owner', 'provider-accepted-result-owner')
    const member = await onboard(service, authentication, 'accepted-result-member', 'provider-accepted-result-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'acceptedcoord')
    const workerAgent = await registerAgent(service, member.user, 'acceptedwork1')
    const replacementAgent = await registerAgent(service, owner.user, 'acceptedwork2')
    const coordinator = await authentication.resolveBearer(coordinatorAgent.deviceCredential!)
    const worker = await authentication.resolveBearer(workerAgent.deviceCredential!)
    if (coordinator.kind !== 'agent_device' || worker.kind !== 'agent_device') throw new Error('Expected Agent actors')
    const project = await service.createProject(owner.user, {
      displayName: 'Accepted result fence', goal: 'Never supersede a formally accepted execution result.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_accepted_result_project_01'
    })
    const task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Produce an accepted result', objective: 'Submit one bounded result and have the Coordinator accept it.',
      completionCriteria: ['The result is accepted before any retry'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_accepted_result_task_01'
    })
    const accepted = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'accepted', expectedRevision: task.revision,
      idempotencyKey: 'idem_accepted_result_accept_01'
    })
    const running = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'in_progress', expectedRevision: accepted.revision,
      idempotencyKey: 'idem_accepted_result_running_01'
    })
    const succeeded = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'completed', expectedRevision: running.revision,
      result: {
        summary: 'The execution produced a bounded reproducible result.',
        criterionEvidence: [{ criterionId: task.completionCriteria[0]!.criterionId,
          summary: 'The accepted criterion is supported by the execution summary.', resourceRefIds: [] }],
        resourceRefIds: []
      },
      idempotencyKey: 'idem_accepted_result_complete_01'
    })
    if (!succeeded.resultRecordId) throw new Error('Expected an atomic TaskResult ProjectRecord')
    const compatibilityRead = await service.submitProjectRecord(worker, {
      projectId: project.projectId, kind: 'task_result',
      summary: 'The execution produced a bounded reproducible result.',
      sourceTaskId: task.taskId, sourceExecutionId: task.executionId, sourceRevision: succeeded.revision,
      idempotencyKey: 'idem_accepted_result_compat_read_01'
    })
    expect(compatibilityRead).toMatchObject({ projectRecordId: succeeded.resultRecordId,
      sourceTaskId: task.taskId, sourceExecutionId: task.executionId, status: 'candidate' })
    await expect(service.submitProjectRecord(worker, {
      projectId: project.projectId, kind: 'task_result', summary: 'A conflicting manual result summary.',
      sourceTaskId: task.taskId, sourceExecutionId: task.executionId, sourceRevision: succeeded.revision,
      idempotencyKey: 'idem_accepted_result_compat_conflict_01'
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })

    const currentProject = (await service.getProject(owner.user, project.projectId)).project
    const unfinishedTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'No manual TaskResult', objective: 'Prove a TaskResult cannot be manufactured before success.',
      completionCriteria: ['Only the atomic success transition creates the result'], dependencyTaskIds: [],
      expectedProjectRevision: currentProject.revision, idempotencyKey: 'idem_accepted_result_unfinished_task_01'
    })
    await expect(service.submitProjectRecord(worker, {
      projectId: project.projectId, kind: 'task_result', summary: 'This record must never be created.',
      sourceTaskId: unfinishedTask.taskId, sourceExecutionId: unfinishedTask.executionId,
      sourceRevision: unfinishedTask.revision, idempotencyKey: 'idem_accepted_result_manual_create_denied_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    expect([...repository.state.projectRecords.values()].filter((record) => record.kind === 'task_result')).toHaveLength(1)

    const resultRecord = await service.acceptProjectRecord(coordinator, {
      projectRecordId: succeeded.resultRecordId, decision: 'accepted', acceptedKind: 'task_result',
      expectedRevision: 1, idempotencyKey: 'idem_accepted_result_record_accept_01'
    })
    expect(resultRecord).toMatchObject({ kind: 'task_result', status: 'accepted',
      sourceTaskId: task.taskId, sourceExecutionId: task.executionId, acceptedByAgentId: coordinatorAgent.agent.agentId })

    await expect(service.retryOrReassignTask(owner.user, {
      taskId: task.taskId, executionId: task.executionId, assigneeAgentId: workerAgent.agent.agentId,
      expectedRevision: succeeded.revision, idempotencyKey: 'idem_accepted_result_retry_denied_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })
    await expect(service.retryOrReassignTask(owner.user, {
      taskId: task.taskId, executionId: task.executionId, assigneeAgentId: replacementAgent.agent.agentId,
      expectedRevision: succeeded.revision, idempotencyKey: 'idem_accepted_result_reassign_denied_01'
    })).rejects.toMatchObject({ code: 'invalid_state_transition' })

    expect(repository.state.projectRecords.get(resultRecord.projectRecordId)).toMatchObject({
      status: 'accepted', revision: resultRecord.revision, sourceExecutionId: task.executionId
    })
    expect(repository.state.tasks.get(task.taskId)).toMatchObject({
      status: 'completed', executionId: task.executionId, revision: succeeded.revision,
      resultRecordId: resultRecord.projectRecordId
    })
    const replacementOffers = (await service.pullInbox(
      await authentication.resolveBearer(replacementAgent.deviceCredential!), { afterSequence: 0, limit: 20 }
    )).messages.filter((message) => message.messageType === 'task.offered' && message.payload.taskId === task.taskId)
    expect(replacementOffers).toHaveLength(0)
  })

  it('binds delegated Coordinator confirmations to one immutable proposal and consumes them once', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'confirmation-owner', 'provider-confirmation-owner')
    const member = await onboard(service, authentication, 'confirmation-member', 'provider-confirmation-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'confirmcoord1')
    const workerAgent = await registerAgent(service, member.user, 'confirmworker1')
    const wrongWorkerAgent = await registerAgent(service, member.user, 'confirmworker2')
    const coordinator = await authentication.resolveBearer(coordinatorAgent.deviceCredential!)
    if (coordinator.kind !== 'agent_device') throw new Error('Expected Coordinator Agent actor')
    const project = await service.createProject(owner.user, {
      displayName: 'Immutable confirmation', goal: 'Authorize one exact Coordinator Task proposal.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_confirmation_project_01'
    })
    const projectStarted = (await service.pullInbox(coordinator, { afterSequence: 0, limit: 20 })).messages
      .find((message) => message.messageType === 'project.started')
    if (!projectStarted) throw new Error('Expected Project start message')
    const completionCriteria = ['The immutable proposal is executed exactly once']
    const proposalDigest = stableDigest({
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Confirmed Task proposal', objective: 'Execute exactly the proposal approved by the Project owner.',
      completionCriteria: completionCriteria.map((text) => ({ text })), dependencyTaskIds: [],
      requiredCapabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
      resourceRefIds: [], authorizationRequirements: []
    })
    const request = await service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified',
      prompt: 'Approve this exact Task proposal?', expiresAt: '2026-08-15T03:00:00.000Z',
      confirmableAction: { kind: 'tasks.create', projectId: project.projectId, proposalDigest },
      idempotencyKey: 'idem_confirmation_request_01'
    })
    const answer = await service.answerHumanNeeded(owner.endpoint, {
      humanRequestId: request.humanRequestId, requestRevision: request.revision,
      answer: 'Approved for this exact proposal only.', decision: 'approve',
      idempotencyKey: 'idem_confirmation_answer_01'
    })
    if (!answer.confirmationId) throw new Error('Expected approved action confirmation')

    await expect(service.transitionProject(coordinator, {
      projectId: project.projectId, status: 'completed', expectedRevision: project.revision,
      finalRecordDigest: 'sha256:not-the-approved-action', confirmationId: answer.confirmationId,
      idempotencyKey: 'idem_confirmation_wrong_action_01'
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' })
    await expect(service.createTask(coordinator, {
      projectId: project.projectId, assigneeAgentId: wrongWorkerAgent.agent.agentId,
      title: 'Confirmed Task proposal', objective: 'Execute exactly the proposal approved by the Project owner.',
      completionCriteria, dependencyTaskIds: [], expectedProjectRevision: project.revision,
      confirmationId: answer.confirmationId, idempotencyKey: 'idem_confirmation_wrong_assignee_01'
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' })

    const created = await service.createTask(coordinator, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Confirmed Task proposal', objective: 'Execute exactly the proposal approved by the Project owner.',
      completionCriteria, dependencyTaskIds: [], expectedProjectRevision: project.revision,
      confirmationId: answer.confirmationId, idempotencyKey: 'idem_confirmation_exact_action_01'
    })
    expect(created.assigneeAgentId).toBe(workerAgent.agent.agentId)
    await expect(service.getActionConfirmation(coordinator, answer.confirmationId)).resolves.toMatchObject({
      status: 'consumed', consumedByActorKey: coordinator.actorKey, consumedOperation: 'task.create'
    })
    await expect(service.createTask(coordinator, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Confirmed Task proposal', objective: 'Execute exactly the proposal approved by the Project owner.',
      completionCriteria, dependencyTaskIds: [], expectedProjectRevision: project.revision + 1,
      confirmationId: answer.confirmationId, idempotencyKey: 'idem_confirmation_reuse_denied_01'
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' })
    expect(repository.state.tasks.size).toBe(1)
  })

  it('binds Task confirmations to the current Project, owner, Task execution, and one consumption', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'task-confirm-owner', 'provider-task-confirm-owner')
    const member = await onboard(service, authentication, 'task-confirm-member', 'provider-task-confirm-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'taskcnfcoord')
    const workerAgent = await registerAgent(service, member.user, 'taskcnfworker')
    const replacementAgent = await registerAgent(service, member.user, 'taskcnfreplc')
    const coordinator = await authentication.resolveBearer(coordinatorAgent.deviceCredential!)
    if (coordinator.kind !== 'agent_device') throw new Error('Expected Coordinator Agent actor')

    const project = await service.createProject(owner.user, {
      displayName: 'Task confirmation scope', goal: 'Fence delegated Task governance to one Project and owner.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_task_confirmation_project_01'
    })
    const otherProject = await service.createProject(owner.user, {
      displayName: 'Other Task confirmation scope', goal: 'Provide an independent Project boundary.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_task_confirmation_project_02'
    })
    const projectStarted = (await service.pullInbox(coordinator, { afterSequence: 0, limit: 20 })).messages
      .find((message) => message.messageType === 'project.started' && message.payload.projectId === project.projectId)
    if (!projectStarted) throw new Error('Expected Project start message')

    const task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Governed reassignment', objective: 'Move this exact execution only after owner approval.',
      completionCriteria: ['The replacement receives one current offer'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_task_confirmation_task_01'
    })
    const cancelTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Governed cancellation', objective: 'Cancel this exact execution only after owner approval.',
      completionCriteria: ['The exact execution is cancelled'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision + 1, idempotencyKey: 'idem_task_confirmation_task_02'
    })
    const otherTask = await service.createTask(owner.user, {
      projectId: otherProject.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Other Project Task', objective: 'Remain outside the first Project confirmation boundary.',
      completionCriteria: ['No cross-Project authorization is accepted'], dependencyTaskIds: [],
      expectedProjectRevision: otherProject.revision, idempotencyKey: 'idem_task_confirmation_other_task_01'
    })

    const retryAction = {
      kind: 'task.retry_reassign' as const, projectId: project.projectId,
      taskId: task.taskId, fromExecutionId: task.executionId,
      assigneeAgentId: replacementAgent.agent.agentId
    }
    await expect(service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: member.userId, requiredAssurance: 'verified', prompt: 'Wrong owner must not approve.',
      expiresAt: '2026-08-15T03:00:00.000Z', confirmableAction: retryAction,
      idempotencyKey: 'idem_task_confirmation_wrong_owner_01'
    })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'Cross-Project action must fail.',
      expiresAt: '2026-08-15T03:00:00.000Z', confirmableAction: {
        ...retryAction, projectId: otherProject.projectId, taskId: otherTask.taskId,
        fromExecutionId: otherTask.executionId
      }, idempotencyKey: 'idem_task_confirmation_cross_project_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })
    await expect(service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'Cross-Project Task must fail.',
      expiresAt: '2026-08-15T03:00:00.000Z', confirmableAction: {
        ...retryAction, taskId: otherTask.taskId, fromExecutionId: otherTask.executionId
      }, idempotencyKey: 'idem_task_confirmation_cross_task_01'
    })).rejects.toMatchObject({ code: 'validation_failed' })

    const crossReuseRequest = await service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'Approve only the first Project action.',
      expiresAt: '2026-08-15T03:00:00.000Z', confirmableAction: retryAction,
      idempotencyKey: 'idem_task_confirmation_cross_reuse_request_01'
    })
    const crossReuseAnswer = await service.answerHumanNeeded(owner.endpoint, {
      humanRequestId: crossReuseRequest.humanRequestId, requestRevision: crossReuseRequest.revision,
      answer: 'Approve only the first Project scope.', decision: 'approve',
      idempotencyKey: 'idem_task_confirmation_cross_reuse_answer_01'
    })
    if (!crossReuseAnswer.confirmationId) throw new Error('Expected Project-scoped confirmation')
    const storedCrossReuse = repository.state.actionConfirmations.get(crossReuseAnswer.confirmationId)
    if (!storedCrossReuse) throw new Error('Expected stored Project-scoped confirmation')
    const forgedCrossProjectAction = {
      kind: 'task.retry_reassign' as const, projectId: otherProject.projectId,
      taskId: otherTask.taskId, fromExecutionId: otherTask.executionId,
      assigneeAgentId: replacementAgent.agent.agentId
    }
    repository.state.actionConfirmations.set(crossReuseAnswer.confirmationId, {
      ...storedCrossReuse, action: forgedCrossProjectAction, actionDigest: stableDigest(forgedCrossProjectAction)
    })
    await expect(service.retryOrReassignTask(coordinator, {
      taskId: otherTask.taskId, executionId: otherTask.executionId,
      assigneeAgentId: replacementAgent.agent.agentId, expectedRevision: otherTask.revision,
      confirmationId: crossReuseAnswer.confirmationId,
      idempotencyKey: 'idem_task_confirmation_cross_reuse_execute_01'
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' })
    expect(repository.state.tasks.get(otherTask.taskId)).toMatchObject({
      projectId: otherProject.projectId, executionId: otherTask.executionId,
      assigneeAgentId: workerAgent.agent.agentId, revision: otherTask.revision
    })

    const retryRequest = await service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'Approve this exact reassignment?',
      expiresAt: '2026-08-15T03:00:00.000Z', confirmableAction: retryAction,
      idempotencyKey: 'idem_task_confirmation_retry_request_01'
    })
    const retryAnswer = await service.answerHumanNeeded(owner.endpoint, {
      humanRequestId: retryRequest.humanRequestId, requestRevision: retryRequest.revision,
      answer: 'Approve this exact Project Task execution.', decision: 'approve',
      idempotencyKey: 'idem_task_confirmation_retry_answer_01'
    })
    if (!retryAnswer.confirmationId) throw new Error('Expected reassignment confirmation')
    const reassigned = await service.retryOrReassignTask(coordinator, {
      taskId: task.taskId, executionId: task.executionId,
      assigneeAgentId: replacementAgent.agent.agentId, expectedRevision: task.revision,
      confirmationId: retryAnswer.confirmationId, idempotencyKey: 'idem_task_confirmation_retry_execute_01'
    })
    expect(reassigned).toMatchObject({ projectId: project.projectId, assigneeAgentId: replacementAgent.agent.agentId,
      status: 'offered' })
    expect(reassigned.executionId).not.toBe(task.executionId)

    const cancelAction = { kind: 'task.cancel' as const, projectId: project.projectId,
      taskId: cancelTask.taskId, executionId: cancelTask.executionId }
    const cancelRequest = await service.createHumanNeeded(coordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'Approve this exact cancellation?',
      expiresAt: '2026-08-15T03:00:00.000Z', confirmableAction: cancelAction,
      idempotencyKey: 'idem_task_confirmation_cancel_request_01'
    })
    const cancelAnswer = await service.answerHumanNeeded(owner.endpoint, {
      humanRequestId: cancelRequest.humanRequestId, requestRevision: cancelRequest.revision,
      answer: 'Approve this exact Project Task cancellation.', decision: 'approve',
      idempotencyKey: 'idem_task_confirmation_cancel_answer_01'
    })
    if (!cancelAnswer.confirmationId) throw new Error('Expected cancellation confirmation')
    const cancelled = await service.cancelTask(coordinator, {
      taskId: cancelTask.taskId, executionId: cancelTask.executionId, expectedRevision: cancelTask.revision,
      confirmationId: cancelAnswer.confirmationId, idempotencyKey: 'idem_task_confirmation_cancel_execute_01'
    })
    expect(cancelled).toMatchObject({ projectId: project.projectId, status: 'cancelled' })
    await expect(service.cancelTask(coordinator, {
      taskId: cancelTask.taskId, executionId: cancelTask.executionId, expectedRevision: cancelled.revision,
      confirmationId: cancelAnswer.confirmationId, idempotencyKey: 'idem_task_confirmation_cancel_reuse_01'
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' })
  })

  it('persists supersession when authoritative Project and Task facts conflict with approved actions', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'supersession-owner', 'provider-supersession-owner')
    const member = await onboard(service, authentication, 'supersession-member', 'provider-supersession-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'supersede-coord')
    const workerAgent = await registerAgent(service, member.user, 'supersede-worker')
    const worker = await authentication.resolveBearer(workerAgent.deviceCredential!)
    if (worker.kind !== 'agent_device') throw new Error('Expected Worker Agent actor')
    const project = await service.createProject(owner.user, {
      displayName: 'Confirmation supersession', goal: 'Persist conflicts as authoritative lifecycle state.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_supersession_project_01'
    })
    const currentProjectRevision = async (projectId: string) =>
      (await service.getProject(owner.user, projectId)).project.revision

    const retryTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Owner reassignment', objective: 'Invalidate competing actions for the old execution.',
      completionCriteria: ['Only the new execution remains current'], dependencyTaskIds: [],
      expectedProjectRevision: await currentProjectRevision(project.projectId),
      idempotencyKey: 'idem_supersession_retry_task_01'
    })
    const staleRetry = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeRetry01', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'task.retry_reassign', projectId: project.projectId, taskId: retryTask.taskId,
        fromExecutionId: retryTask.executionId, assigneeAgentId: coordinatorAgent.agent.agentId }
    })
    const staleCancelForRetry = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeCancel01', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'task.cancel', projectId: project.projectId, taskId: retryTask.taskId,
        executionId: retryTask.executionId }
    })
    await service.retryOrReassignTask(owner.user, {
      taskId: retryTask.taskId, executionId: retryTask.executionId,
      assigneeAgentId: coordinatorAgent.agent.agentId, expectedRevision: retryTask.revision,
      idempotencyKey: 'idem_supersession_owner_retry_01'
    })
    await expect(service.getActionConfirmation(owner.user, staleRetry.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })
    await expect(service.getActionConfirmation(owner.user, staleCancelForRetry.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })

    const cancelTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Owner cancellation', objective: 'Invalidate retry and cancellation approval for this execution.',
      completionCriteria: ['Task is cancelled'], dependencyTaskIds: [],
      expectedProjectRevision: await currentProjectRevision(project.projectId),
      idempotencyKey: 'idem_supersession_cancel_task_01'
    })
    const staleCancel = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeCancel02', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'task.cancel', projectId: project.projectId, taskId: cancelTask.taskId,
        executionId: cancelTask.executionId }
    })
    await service.cancelTask(owner.user, { taskId: cancelTask.taskId, executionId: cancelTask.executionId,
      expectedRevision: cancelTask.revision, idempotencyKey: 'idem_supersession_owner_cancel_01' })
    await expect(service.getActionConfirmation(owner.user, staleCancel.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })

    const resultTask = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Accepted result fence', objective: 'Accepted results invalidate ordinary retry approval.',
      completionCriteria: ['Candidate result is accepted'], dependencyTaskIds: [],
      expectedProjectRevision: await currentProjectRevision(project.projectId),
      idempotencyKey: 'idem_supersession_result_task_01'
    })
    const accepted = await service.transitionTask(worker, { taskId: resultTask.taskId,
      executionId: resultTask.executionId, status: 'accepted', expectedRevision: resultTask.revision,
      idempotencyKey: 'idem_supersession_result_accept_01' })
    const running = await service.transitionTask(worker, { taskId: resultTask.taskId,
      executionId: resultTask.executionId, status: 'in_progress', expectedRevision: accepted.revision,
      idempotencyKey: 'idem_supersession_result_run_01' })
    const staleTerminalCancel = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeTerminal1', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'task.cancel', projectId: project.projectId, taskId: resultTask.taskId,
        executionId: resultTask.executionId }
    })
    const completed = await service.transitionTask(worker, { taskId: resultTask.taskId,
      executionId: resultTask.executionId, status: 'completed', expectedRevision: running.revision,
      result: { summary: 'Bounded successful result.', criterionEvidence: [], resourceRefIds: [] },
      idempotencyKey: 'idem_supersession_result_complete_01' })
    await expect(service.getActionConfirmation(owner.user, staleTerminalCancel.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })
    const staleAcceptedRetry = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeAccepted1', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'task.retry_reassign', projectId: project.projectId, taskId: resultTask.taskId,
        fromExecutionId: resultTask.executionId, assigneeAgentId: coordinatorAgent.agent.agentId }
    })
    await service.acceptProjectRecord(owner.user, { projectRecordId: completed.resultRecordId!,
      expectedRevision: 1, idempotencyKey: 'idem_supersession_result_record_accept_01' })
    await expect(service.getActionConfirmation(owner.user, staleAcceptedRetry.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })

    const staleCoordinator = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeCoord001', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'project.complete', projectId: project.projectId, finalRecordDigest: 'sha256:old-coordinator' }
    })
    await service.transferCoordinator(owner.user, { projectId: project.projectId,
      coordinatorAgentId: workerAgent.agent.agentId, expectedRevision: await currentProjectRevision(project.projectId),
      idempotencyKey: 'idem_supersession_coordinator_transfer_01' })
    await expect(service.getActionConfirmation(owner.user, staleCoordinator.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })

    const closingProject = await service.createProject(owner.user, {
      displayName: 'Terminal Project supersession', goal: 'Close with no open Task.',
      memberUserIds: [owner.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_supersession_closing_project_01'
    })
    const staleProjectAction = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeProject1', projectId: closingProject.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      action: { kind: 'project.complete', projectId: closingProject.projectId, finalRecordDigest: 'sha256:closing' }
    })
    await service.transitionProject(owner.user, { projectId: closingProject.projectId, status: 'cancelled',
      expectedRevision: closingProject.revision, idempotencyKey: 'idem_supersession_project_cancel_01' })
    await expect(service.getActionConfirmation(owner.user, staleProjectAction.confirmationId))
      .resolves.toMatchObject({ status: 'superseded' })

    const expired = seedApprovedConfirmation(repository, {
      confirmationId: 'cnf_SupersedeExpired1', projectId: project.projectId, ownerUserId: owner.userId,
      coordinatorAgentId: workerAgent.agent.agentId, expiresAt: '2026-08-15T01:30:00.000Z',
      action: { kind: 'project.complete', projectId: project.projectId, finalRecordDigest: 'sha256:expired' }
    })
    await expect(service.getActionConfirmation(owner.user, expired.confirmationId))
      .resolves.toMatchObject({ status: 'superseded', updatedAt: at.toISOString() })
  })

  it('requires a fresh owner-bound profile for create, retry, and reassignment even without capability IDs', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'empty-profile-owner', 'provider-empty-profile-owner')
    const member = await onboard(service, authentication, 'empty-profile-member', 'provider-empty-profile-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'emptyprofco1')
    const workerAgent = await registerAgent(service, member.user, 'emptyprofwrk1')
    const replacementAgent = await registerAgent(service, member.user, 'emptyprofrep1', {
      provisionCapability: false
    })
    const worker = await authentication.resolveBearer(workerAgent.deviceCredential!)
    if (worker.kind !== 'agent_device') throw new Error('Expected Worker Agent actor')
    const project = await service.createProject(owner.user, {
      displayName: 'Empty requirement profile fence',
      goal: 'Require current capability evidence before any assignment.',
      memberUserIds: [owner.userId, member.userId],
      coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_empty_profile_project_01'
    })
    const profile = repository.state.capabilityProfiles.get(workerAgent.agent.agentId)
    if (!profile) throw new Error('Expected provisioned Worker capability profile')
    repository.state.capabilityProfiles.delete(workerAgent.agent.agentId)
    const taskInput = {
      projectId: project.projectId,
      assigneeAgentId: workerAgent.agent.agentId,
      title: 'Capability-profile-gated Task',
      objective: 'Reject assignments without a current profile even when requirements are empty.',
      completionCriteria: ['The assignment gate is deterministic'],
      dependencyTaskIds: [],
      expectedProjectRevision: project.revision
    }
    await expect(service.createTask(owner.user, {
      ...taskInput,
      idempotencyKey: 'idem_empty_profile_create_missing_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    repository.state.capabilityProfiles.set(workerAgent.agent.agentId, profile)
    const task = await service.createTask(owner.user, {
      ...taskInput,
      idempotencyKey: 'idem_empty_profile_create_valid_01'
    })
    const accepted = await service.transitionTask(worker, {
      taskId: task.taskId,
      executionId: task.executionId,
      status: 'accepted',
      expectedRevision: task.revision,
      idempotencyKey: 'idem_empty_profile_accept_01'
    })
    const running = await service.transitionTask(worker, {
      taskId: task.taskId,
      executionId: task.executionId,
      status: 'in_progress',
      expectedRevision: accepted.revision,
      idempotencyKey: 'idem_empty_profile_running_01'
    })
    const failed = await service.transitionTask(worker, {
      taskId: task.taskId,
      executionId: task.executionId,
      status: 'failed',
      expectedRevision: running.revision,
      safeFailureCode: 'retry_profile_gate',
      idempotencyKey: 'idem_empty_profile_failed_01'
    })
    repository.state.capabilityProfiles.delete(workerAgent.agent.agentId)
    await expect(service.retryOrReassignTask(owner.user, {
      taskId: task.taskId,
      executionId: task.executionId,
      assigneeAgentId: workerAgent.agent.agentId,
      expectedRevision: failed.revision,
      idempotencyKey: 'idem_empty_profile_retry_missing_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    repository.state.capabilityProfiles.set(workerAgent.agent.agentId, profile)
    await expect(service.retryOrReassignTask(owner.user, {
      taskId: task.taskId,
      executionId: task.executionId,
      assigneeAgentId: replacementAgent.agent.agentId,
      expectedRevision: failed.revision,
      idempotencyKey: 'idem_empty_profile_reassign_missing_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    expect(repository.state.tasks.get(task.taskId)).toMatchObject({
      status: 'failed', executionId: task.executionId, revision: failed.revision, retryCount: 0
    })
  })

  it('rejects expired and owner-mismatched capability profiles for required Task creation and retry', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'profile-owner', 'provider-profile-owner')
    const member = await onboard(service, authentication, 'profile-member', 'provider-profile-member')
    const coordinatorAgent = await registerAgent(service, owner.user, 'profilecoord1')
    const workerAgent = await registerAgent(service, member.user, 'profilework01', { provisionCapability: false })
    const worker = await authentication.resolveBearer(workerAgent.deviceCredential!)
    if (worker.kind !== 'agent_device') throw new Error('Expected Worker Agent actor')
    await service.reportAgentCapabilityProfile(worker, {
      agentId: workerAgent.agent.agentId, ownerUserId: member.userId, nodeType: 'personal_computer',
      os: { family: 'linux', architecture: 'x64' }, runtimeIds: ['runtime.test'],
      capabilities: [{ capabilityId: 'research.execute', evidence: {
        level: 'verified', checkedAt: at.toISOString(), summary: 'Execution capability verified.'
      } }],
      vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
      resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
        fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
      reportedAt: at.toISOString(), expiresAt: '2026-08-15T03:00:00.000Z',
      idempotencyKey: 'idem_profile_report_worker_01'
    })
    const project = await service.createProject(owner.user, {
      displayName: 'Capability freshness fence', goal: 'Require a fresh owner-bound capability profile.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: coordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_profile_project_01'
    })
    const requiredCapabilities = {
      capabilityIds: ['research.execute'], minimumEvidenceLevel: 'verified' as const,
      vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: []
    }
    const taskInput = {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Capability-bound Task', objective: 'Run only with a fresh owner-bound profile.',
      completionCriteria: ['The capability profile remains current'], dependencyTaskIds: [], requiredCapabilities,
      expectedProjectRevision: project.revision
    }
    const mutateProfile = (changes: { ownerUserId?: string; expiresAt?: string }) => {
      const profile = repository.state.capabilityProfiles.get(workerAgent.agent.agentId)
      if (!profile) throw new Error('Expected stored capability profile')
      Object.assign(profile, changes)
    }
    mutateProfile({ expiresAt: at.toISOString() })
    await expect(service.createTask(owner.user, {
      ...taskInput, idempotencyKey: 'idem_profile_create_expired_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    mutateProfile({ expiresAt: '2026-08-15T03:00:00.000Z', ownerUserId: owner.userId })
    await expect(service.createTask(owner.user, {
      ...taskInput, idempotencyKey: 'idem_profile_create_owner_mismatch_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    mutateProfile({ ownerUserId: member.userId })
    const task = await service.createTask(owner.user, {
      ...taskInput, idempotencyKey: 'idem_profile_create_valid_01'
    })
    const accepted = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'accepted', expectedRevision: task.revision,
      idempotencyKey: 'idem_profile_accept_01'
    })
    const running = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'in_progress', expectedRevision: accepted.revision,
      idempotencyKey: 'idem_profile_running_01'
    })
    const failed = await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'failed', expectedRevision: running.revision,
      safeFailureCode: 'profile_recheck_required', idempotencyKey: 'idem_profile_failed_01'
    })
    mutateProfile({ expiresAt: at.toISOString() })
    await expect(service.retryOrReassignTask(owner.user, {
      taskId: task.taskId, executionId: task.executionId, assigneeAgentId: workerAgent.agent.agentId,
      expectedRevision: failed.revision, idempotencyKey: 'idem_profile_retry_expired_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    mutateProfile({ expiresAt: '2026-08-15T03:00:00.000Z', ownerUserId: owner.userId })
    await expect(service.retryOrReassignTask(owner.user, {
      taskId: task.taskId, executionId: task.executionId, assigneeAgentId: workerAgent.agent.agentId,
      expectedRevision: failed.revision, idempotencyKey: 'idem_profile_retry_owner_mismatch_01'
    })).rejects.toMatchObject({ code: 'capability_profile_expired' })
    expect(repository.state.tasks.get(task.taskId)).toMatchObject({
      status: 'failed', executionId: task.executionId, revision: failed.revision, retryCount: 0
    })
  })

  it('reroutes unacknowledged Coordinator work on transfer and ACKs continuously across tombstones', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now })
    const authentication = new AuthenticationService(repository, now)
    const owner = await onboard(service, authentication, 'reroute-owner', 'provider-reroute-owner')
    const member = await onboard(service, authentication, 'reroute-member', 'provider-reroute-member')
    const oldCoordinatorAgent = await registerAgent(service, owner.user, 'rerouteold01')
    const newCoordinatorAgent = await registerAgent(service, owner.user, 'reroutenew01')
    const workerAgent = await registerAgent(service, member.user, 'reroutework1')
    const oldCoordinator = await authentication.resolveBearer(oldCoordinatorAgent.deviceCredential!)
    const newCoordinator = await authentication.resolveBearer(newCoordinatorAgent.deviceCredential!)
    const worker = await authentication.resolveBearer(workerAgent.deviceCredential!)
    if (oldCoordinator.kind !== 'agent_device' || newCoordinator.kind !== 'agent_device' || worker.kind !== 'agent_device') {
      throw new Error('Expected Agent actors')
    }
    const project = await service.createProject(owner.user, {
      displayName: 'Coordinator inbox handoff', goal: 'Preserve unacknowledged coordination work during transfer.',
      memberUserIds: [owner.userId, member.userId], coordinatorAgentId: oldCoordinatorAgent.agent.agentId,
      idempotencyKey: 'idem_reroute_project_01'
    })
    const task = await service.createTask(owner.user, {
      projectId: project.projectId, assigneeAgentId: workerAgent.agent.agentId,
      title: 'Generate coordinator work', objective: 'Send one Task update to the current Coordinator.',
      completionCriteria: ['The update is rerouted once'], dependencyTaskIds: [],
      expectedProjectRevision: project.revision, idempotencyKey: 'idem_reroute_task_01'
    })
    await service.transitionTask(worker, {
      taskId: task.taskId, executionId: task.executionId, status: 'accepted', expectedRevision: task.revision,
      idempotencyKey: 'idem_reroute_task_accept_01'
    })
    const beforeAnswer = (await service.pullInbox(oldCoordinator, { afterSequence: 0, limit: 20 })).messages
    const projectStarted = beforeAnswer.find((message) => message.messageType === 'project.started')
    if (!projectStarted) throw new Error('Expected Project start source message')
    const humanRequest = await service.createHumanNeeded(oldCoordinator, {
      projectId: project.projectId, source: { kind: 'coordinator', sourceInboxMessageId: projectStarted.messageId },
      targetUserId: owner.userId, requiredAssurance: 'verified', prompt: 'Return an answer before Coordinator transfer.',
      expiresAt: '2026-08-15T03:00:00.000Z', idempotencyKey: 'idem_reroute_human_needed_01'
    })
    await service.answerHumanNeeded(owner.endpoint, {
      humanRequestId: humanRequest.humanRequestId, requestRevision: humanRequest.revision,
      answer: 'This answer must follow the current Coordinator.', idempotencyKey: 'idem_reroute_human_answer_01'
    })
    const oldBefore = (await service.pullInbox(oldCoordinator, { afterSequence: 0, limit: 20 })).messages
    expect(oldBefore.map((message) => message.messageType))
      .toEqual(['project.started', 'task.updated', 'human.answer.received'])
    expect(oldBefore.map((message) => message.sequence)).toEqual([1, 2, 3])

    const transferred = await service.transferCoordinator(owner.user, {
      projectId: project.projectId, coordinatorAgentId: newCoordinatorAgent.agent.agentId,
      expectedRevision: project.revision + 1, idempotencyKey: 'idem_reroute_transfer_01'
    })
    expect(transferred.coordinatorAgentId).toBe(newCoordinatorAgent.agent.agentId)
    const oldAfter = (await service.pullInbox(oldCoordinator, { afterSequence: 0, limit: 20 })).messages
    expect(oldAfter.slice(0, 3)).toEqual(oldBefore.map((message) => expect.objectContaining({
      messageId: message.messageId, sequence: message.sequence, disposition: 'superseded',
      supersededAt: at.toISOString()
    })))
    expect(oldAfter[3]).toMatchObject({ messageType: 'coordinator.transferred', sequence: 4, disposition: 'active' })

    const newInbox = (await service.pullInbox(newCoordinator, { afterSequence: 0, limit: 20 })).messages
    expect(newInbox.map((message) => message.sequence)).toEqual([1, 2, 3, 4])
    expect(newInbox.slice(0, 3).map((message) => message.messageType))
      .toEqual(['project.started', 'task.updated', 'human.answer.received'])
    expect(newInbox.slice(0, 3).map((message) => message.payload.reroutedFromMessageId))
      .toEqual(oldBefore.map((message) => message.messageId))
    expect(newInbox[2]?.payload.answer).toMatchObject({ projectId: project.projectId,
      humanRequestId: humanRequest.humanRequestId })
    expect(newInbox[3]).toMatchObject({ messageType: 'coordinator.transferred', payload: {
      projectId: project.projectId, previousCoordinatorAgentId: oldCoordinatorAgent.agent.agentId,
      coordinatorAgentId: newCoordinatorAgent.agent.agentId
    } })

    await expect(service.ackInbox(oldCoordinator, {
      throughSequence: 4, idempotencyKey: 'idem_reroute_old_ack_through_tombstones_01'
    })).resolves.toMatchObject({ ackedSequence: 4, nextSequence: 5 })
    await expect(service.ackInbox(newCoordinator, {
      throughSequence: 4, idempotencyKey: 'idem_reroute_new_ack_contiguous_01'
    })).rejects.toMatchObject({ code: 'inbox_ack_gap' })
    const firstAck = await service.ackInboxMessage(newCoordinator, {
      inboxMessageId: newInbox[0]!.messageId, sequence: 1, idempotencyKey: 'idem_reroute_new_ack_01'
    })
    expect(firstAck.ackedSequence).toBe(1)
    const secondAck = await service.ackInboxMessage(newCoordinator, {
      inboxMessageId: newInbox[1]!.messageId, sequence: 2, idempotencyKey: 'idem_reroute_new_ack_02'
    })
    expect(secondAck.ackedSequence).toBe(2)
    const thirdAck = await service.ackInboxMessage(newCoordinator, {
      inboxMessageId: newInbox[2]!.messageId, sequence: 3, idempotencyKey: 'idem_reroute_new_ack_03'
    })
    expect(thirdAck.ackedSequence).toBe(3)
    await expect(service.ackInboxMessage(newCoordinator, {
      inboxMessageId: newInbox[3]!.messageId, sequence: 4, idempotencyKey: 'idem_reroute_new_ack_04'
    })).resolves.toMatchObject({ ackedSequence: 4, nextSequence: 5 })
  })
})
