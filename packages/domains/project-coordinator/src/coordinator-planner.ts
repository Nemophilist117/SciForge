import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  agentIdSchema,
  resourceRefIdSchema,
  taskIdSchema,
  workerRequirementSchema,
  type AgentInboxMessage,
  type ProjectCapabilityDirectory,
  type ProjectCoordinationView
} from '@sciforge/collaboration-contracts'
import type { DomainMainAgentExecutionHost } from '@sciforge/domain-sdk/agent-execution'
import type { CoordinatorPlannerPort, ProjectPlan } from './coordinator.js'

const taskDraftSchema = z.object({
  assigneeAgentId: agentIdSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(32_000),
  completionCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  dependencyTaskIds: z.array(taskIdSchema).max(1_000),
  requiredCapabilities: workerRequirementSchema,
  resourceRefIds: z.array(resourceRefIdSchema).max(1_000)
}).strict()

const modelProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan'),
    objective: z.string().trim().min(1).max(32_000),
    tasks: z.array(taskDraftSchema).min(1).max(1_000)
  }).strict(),
  z.object({
    kind: z.literal('no_action'),
    reason: z.string().trim().min(1).max(2_000)
  }).strict()
])

export class NoCoordinatorActionError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'NoCoordinatorActionError'
  }
}

export class AgentCoordinatorPlanner implements CoordinatorPlannerPort {
  constructor(
    private readonly agentExecution: DomainMainAgentExecutionHost,
    private readonly trigger: AgentInboxMessage
  ) {}

  async plan(input: Readonly<{
    view: ProjectCoordinationView
    capabilities: ProjectCapabilityDirectory
  }>): Promise<ProjectPlan> {
    const first = await this.agentExecution.run({
      prompt: prompt(input),
      clientDirectiveId: `${this.trigger.inboxMessageId}:coordinator-plan`,
      allowedTools: [],
      interaction: 'background',
      mode: 'agent'
    })
    let proposal = parse(first.state, first.text)
    if (!proposal) {
      const repaired = await this.agentExecution.run({
        prompt: repairPrompt(input.view),
        clientDirectiveId: `${this.trigger.inboxMessageId}:coordinator-plan-repair`,
        allowedTools: [],
        interaction: 'background',
        mode: 'agent'
      })
      proposal = parse(repaired.state, repaired.text)
    }
    if (!proposal) throw new Error('Agent Runtime did not return strict Coordinator plan JSON.')
    if (proposal.kind === 'no_action') throw new NoCoordinatorActionError(proposal.reason)
    return {
      projectId: input.view.projectId,
      basedOnProjectRevision: input.view.projectRevision,
      objective: proposal.objective,
      tasks: proposal.tasks.map((task, taskIndex) => ({
        ...task,
        completionCriteria: task.completionCriteria.map((text, criterionIndex) => ({
          criterionId: criterionId(this.trigger.inboxMessageId, taskIndex, criterionIndex),
          text
        }))
      }))
    }
  }
}

function prompt(input: Readonly<{
  view: ProjectCoordinationView
  capabilities: ProjectCapabilityDirectory
}>): string {
  return [
    'You are the SciForge Project Coordinator.',
    'Return exactly one strict JSON object: either {"kind":"plan",...} or {"kind":"no_action","reason":"..."}.',
    'Do not claim execution. Do not include credentials, local paths, file contents, tokens, or logs.',
    'Use only A ResourceRef IDs and Agent IDs present in the supplied A views.',
    'Assign only online Agents that meet every required capability.',
    `Trigger: ${JSON.stringify(input.view.projectId)}`,
    `A coordination view: ${JSON.stringify(input.view)}`,
    `A capability directory: ${JSON.stringify(input.capabilities)}`
  ].join('\n')
}

function repairPrompt(view: ProjectCoordinationView): string {
  return [
    'The prior response was not valid strict Coordinator plan JSON.',
    'Repair structure only; return JSON and no Markdown.',
    `Project: ${view.projectId}`,
    `Revision: ${view.projectRevision}`
  ].join('\n')
}

function parse(state: string, text: string): z.infer<typeof modelProposalSchema> | null {
  if (state !== 'completed') return null
  try {
    return modelProposalSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

function criterionId(sourceInboxMessageId: string, taskIndex: number, criterionIndex: number): string {
  const suffix = createHash('sha256')
    .update(`${sourceInboxMessageId}\u0000${taskIndex}\u0000${criterionIndex}`)
    .digest('hex')
    .slice(0, 24)
  return `cri_${suffix}`
}
