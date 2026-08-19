import type {
  ProjectCapabilityDirectory,
  ProjectCoordinationView,
  Task,
  WorkerRequirement
} from '@sciforge/collaboration-contracts'
import {
  execute,
  expectCapabilityDirectory,
  expectCoordinationView,
  loadTask,
  operationKey,
  operationRequestId,
  requestId
} from './cloud.js'
import { assertCloudSafeText } from './cloud-safety.js'
import { FileWorkerJournal } from './journal.js'
import { DurableAOutbox } from './outbox.js'
import type { ACloudPort, BCloudRequest, CPrincipalPort } from './ports.js'

export type TaskProposal = Readonly<{
  title: string
  objective: string
  completionCriteria: readonly Readonly<{ criterionId: string; text: string }>[]
  dependencyTaskIds: readonly string[]
  requiredCapabilities: WorkerRequirement
  resourceRefIds: readonly string[]
  assigneeAgentId: string
}>

export type ConfirmedTaskProposal = TaskProposal & Readonly<{
  confirmationId: string
}>

export type ProjectPlan = Readonly<{
  projectId: string
  basedOnProjectRevision: number
  objective: string
  tasks: readonly TaskProposal[]
}>

export interface CoordinatorPlannerPort {
  plan(input: Readonly<{
    view: ProjectCoordinationView
    capabilities: ProjectCapabilityDirectory
  }>): Promise<ProjectPlan>
}

export class ProposalDigestUnavailableError extends Error {
  constructor() {
    super('A has not published the public Task proposal digest helper.')
    this.name = 'ProposalDigestUnavailableError'
  }
}

export class Coordinator {
  private readonly outbox: DurableAOutbox

  constructor(
    private readonly cloud: ACloudPort,
    private readonly principal: CPrincipalPort,
    private readonly journal: FileWorkerJournal
  ) {
    this.outbox = new DurableAOutbox(journal, cloud, (taskId) => loadTask(cloud, taskId))
  }

  async recoverPendingWrites(): Promise<number> {
    let recovered = 0
    for (const entry of await this.journal.pendingEntries()) {
      const request = entry.request as Partial<BCloudRequest>
      if (request.type !== 'task.create' && request.type !== 'task.retry') continue
      await this.outbox.replay(entry.idempotencyKey, {})
      recovered += 1
    }
    return recovered
  }

  async context(projectId: string): Promise<Readonly<{
    view: ProjectCoordinationView
    capabilities: ProjectCapabilityDirectory
  }>> {
    const [viewResponse, capabilityResponse] = await Promise.all([
      execute(this.cloud, {
        protocolVersion: '1.0', requestId: requestId(), type: 'project.coordination_view.get', projectId
      }),
      execute(this.cloud, {
        protocolVersion: '1.0', requestId: requestId(), type: 'project.capability_directory.get', projectId
      })
    ])
    return {
      view: expectCoordinationView(viewResponse),
      capabilities: expectCapabilityDirectory(capabilityResponse)
    }
  }

  requestTaskProposalConfirmation(): never {
    throw new ProposalDigestUnavailableError()
  }

  async plan(projectId: string, planner: CoordinatorPlannerPort): Promise<ProjectPlan> {
    const context = await this.context(projectId)
    const actor = await this.principal.current()
    if (context.view.project.coordinatorAgentId !== actor.agentId) {
      throw new Error('Current C Principal is not the Project Coordinator.')
    }
    const plan = await planner.plan(context)
    if (plan.projectId !== projectId || plan.basedOnProjectRevision !== context.view.projectRevision) {
      throw new Error('Project Plan was produced from a stale or different Project view.')
    }
    if (plan.tasks.length === 0 || plan.tasks.length > context.view.project.budget.maxTasksPerRound) {
      throw new Error('Project Plan violates the A Project task budget.')
    }
    assertCloudSafeText(plan.objective)
    for (const proposal of plan.tasks) {
      assertEligible(proposal, context.capabilities, context.view)
      for (const dependencyTaskId of proposal.dependencyTaskIds) {
        if (!context.view.tasks.some((task) => task.taskId === dependencyTaskId)) {
          throw new Error('Project Plan cites a dependency outside the A coordination view.')
        }
      }
    }
    return plan
  }

  async createTasks(
    projectId: string,
    proposals: readonly ConfirmedTaskProposal[]
  ): Promise<readonly Task[]> {
    const actor = await this.principal.current()
    const created: Task[] = []
    for (const [index, proposal] of proposals.entries()) {
      assertCloudSafeProposal(proposal)
      const { view, capabilities } = await this.context(projectId)
      if (view.project.coordinatorAgentId !== actor.agentId) {
        throw new Error('Current C Principal is not the Project Coordinator.')
      }
      assertEligible(proposal, capabilities, view)
      const cloudKey = operationKey(
        `task-create:${projectId}:${proposal.confirmationId}:${index}:${JSON.stringify(proposal)}`
      )
      const response = await this.outbox.sendOnce(cloudKey, {}, () => ({
        protocolVersion: '1.0', requestId: operationRequestId(cloudKey), idempotencyKey: cloudKey,
        type: 'task.create', projectId, expectedRevision: view.projectRevision,
        assigneeAgentId: proposal.assigneeAgentId, title: proposal.title,
        objective: proposal.objective, completionCriteria: [...proposal.completionCriteria],
        dependencyTaskIds: [...proposal.dependencyTaskIds],
        requiredCapabilities: proposal.requiredCapabilities, resourceRefIds: [...proposal.resourceRefIds],
        authorizationRequirements: [], confirmationId: proposal.confirmationId
      }))
      if (response.type !== 'rest.entity' || response.entity.type !== 'task') {
        throw new Error('A returned an unexpected task.create response.')
      }
      created.push(response.entity)
    }
    return created
  }

  async retryTask(task: Task, assigneeAgentId: string, confirmationId?: string): Promise<Task> {
    const cloudKey = operationKey(
      `task-retry:${task.taskId}:${task.executionId}:${assigneeAgentId}:${confirmationId ?? 'owner-direct'}`
    )
    const response = await this.outbox.sendOnce(cloudKey, {}, async () => {
      const current = await loadTask(this.cloud, task.taskId)
      if (current.executionId !== task.executionId) throw new Error('Task retry execution fence is stale.')
      return {
        protocolVersion: '1.0', requestId: operationRequestId(cloudKey), idempotencyKey: cloudKey,
        type: 'task.retry', taskId: task.taskId, executionId: task.executionId,
        assigneeAgentId, expectedRevision: current.revision,
        ...(confirmationId ? { confirmationId } : {})
      }
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'task') {
      throw new Error('A returned an unexpected task.retry response.')
    }
    return response.entity
  }
}

function assertEligible(
  proposal: TaskProposal,
  directory: ProjectCapabilityDirectory,
  view: ProjectCoordinationView
): void {
  const agent = directory.agents.find((candidate) => candidate.agentId === proposal.assigneeAgentId)
  if (!agent || agent.status !== 'online') throw new Error('Proposed assignee is not online in A capability directory.')
  const member = view.members.find((candidate) => candidate.userId === agent.ownerUserId)
  if (!member?.active) throw new Error('Proposed assignee owner is not an active Project member.')
  const requirement = proposal.requiredCapabilities
  const profile = agent.profile
  if (Date.parse(profile.expiresAt) <= Date.parse(view.readAt)) {
    throw new Error('Proposed assignee capability profile is expired.')
  }
  if (requirement.osFamilies && !requirement.osFamilies.includes(profile.os.family)) {
    throw new Error(`Proposed assignee OS ${profile.os.family} is not eligible.`)
  }
  const capabilityById = new Map(profile.capabilities.map((capability) => [capability.capabilityId, capability]))
  const missing = requirement.capabilityIds.filter((id) => !capabilityById.has(id))
  if (missing.length > 0) throw new Error(`Proposed assignee lacks capabilities: ${missing.join(', ')}`)
  if (requirement.minimumEvidenceLevel) {
    const minimum = evidenceRank(requirement.minimumEvidenceLevel)
    const insufficient = requirement.capabilityIds.filter((id) => {
      const capability = capabilityById.get(id)
      return capability === undefined || evidenceRank(capability.evidence.level) < minimum
    })
    if (insufficient.length > 0) {
      throw new Error(`Proposed assignee capability evidence is insufficient: ${insufficient.join(', ')}`)
    }
  }
  if (requirement.minGpuMemoryGB !== undefined) {
    const minimumEvidence = requirement.minimumEvidenceLevel
    const eligibleGpu = profile.gpu.some((gpu) => (
      (gpu.memoryGB ?? 0) >= requirement.minGpuMemoryGB! &&
      (minimumEvidence === undefined || evidenceRank(gpu.evidence.level) >= evidenceRank(minimumEvidence))
    ))
    if (!eligibleGpu) throw new Error('Proposed assignee does not meet the GPU memory/evidence requirement.')
  }
  assertIncludesAll(profile.vpnAccessIds, requirement.vpnAccessIds, 'VPN access')
  assertIncludesAll(profile.slurmClusterIds, requirement.slurmClusterIds, 'Slurm cluster access')
  assertIncludesAll(
    profile.accessibleResourceRefIds,
    requirement.requiredResourceRefIds,
    'ResourceRef access'
  )
  if (!profile.resultReturnPolicy.evidenceRefs || !profile.resultReturnPolicy.resourceRefs) {
    throw new Error('Proposed assignee cannot return structured evidence and ResourceRefs.')
  }
  if (requirement.requireLogSummary === true && !profile.resultReturnPolicy.logSummary) {
    throw new Error('Proposed assignee cannot return the required log summary.')
  }
}

function evidenceRank(level: 'detected' | 'configured' | 'verified'): number {
  return ['detected', 'configured', 'verified'].indexOf(level)
}

function assertIncludesAll(available: readonly string[], required: readonly string[], label: string): void {
  const values = new Set(available)
  const missing = required.filter((value) => !values.has(value))
  if (missing.length > 0) throw new Error(`Proposed assignee lacks ${label}: ${missing.join(', ')}`)
}

function assertCloudSafeProposal(proposal: TaskProposal): void {
  assertCloudSafeText(proposal.title)
  assertCloudSafeText(proposal.objective)
  for (const criterion of proposal.completionCriteria) assertCloudSafeText(criterion.text)
}
