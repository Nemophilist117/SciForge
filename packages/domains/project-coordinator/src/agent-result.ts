import { z } from 'zod'
import {
  criterionIdSchema,
  resourceRefIdSchema,
  type Task
} from '@sciforge/collaboration-contracts'
import type { AgentRunResult } from './ports.js'

const outputNameSchema = z.string().trim().min(1).max(255)
  .refine((value) => !/[\\/]/u.test(value), 'Output name must not contain path separators.')

const workspaceRelativePathSchema = z.string().trim().min(1).max(4_096)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value), {
    message: 'Agent output path must be workspace-relative.'
  })
  .refine((value) => !value.includes('\\'), {
    message: 'Agent output path must use portable forward slashes.'
  })
  .refine((value) => value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'), {
    message: 'Agent output path must not contain empty or traversal segments.'
  })

export const agentRunResultSchema = z.object({
  summary: z.string().trim().min(1).max(32_000),
  criterionEvidence: z.array(z.object({
    criterionId: criterionIdSchema,
    summary: z.string().trim().min(1).max(2_000),
    resourceRefIds: z.array(resourceRefIdSchema).max(1_000),
    outputNames: z.array(outputNameSchema).max(1_000)
  }).strict()).max(100),
  outputs: z.array(z.object({
    name: outputNameSchema,
    workspaceRelativePath: workspaceRelativePathSchema
  }).strict()).max(1_000),
  logSummary: z.string().trim().min(1).max(2_000).optional()
}).strict().superRefine((result, context) => {
  requireUnique(result.outputs.map((output) => output.name), context, ['outputs'], 'Output names must be unique.')
  requireUnique(
    result.criterionEvidence.map((evidence) => evidence.criterionId),
    context,
    ['criterionEvidence'],
    'Criterion evidence IDs must be unique.'
  )
  for (const [index, evidence] of result.criterionEvidence.entries()) {
    requireUnique(evidence.resourceRefIds, context, ['criterionEvidence', index, 'resourceRefIds'], 'Evidence ResourceRefs must be unique.')
    requireUnique(evidence.outputNames, context, ['criterionEvidence', index, 'outputNames'], 'Evidence output names must be unique.')
  }
})

export function parseAgentRunResult(text: string, task: Task): AgentRunResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Agent Runtime did not return strict Worker result JSON.')
  }
  const result = agentRunResultSchema.parse(raw)
  const expectedCriteria = new Set(task.completionCriteria.map((criterion) => criterion.criterionId))
  const actualCriteria = new Set(result.criterionEvidence.map((evidence) => evidence.criterionId))
  if (
    expectedCriteria.size !== actualCriteria.size ||
    [...expectedCriteria].some((criterionId) => !actualCriteria.has(criterionId))
  ) {
    throw new Error('Agent result must provide evidence for every Task completion criterion exactly once.')
  }
  const taskResources = new Set(task.resourceRefIds)
  const outputNames = new Set(result.outputs.map((output) => output.name))
  for (const evidence of result.criterionEvidence) {
    if (evidence.resourceRefIds.some((resourceRefId) => !taskResources.has(resourceRefId))) {
      throw new Error('Agent evidence may cite only A ResourceRefs supplied to the Task.')
    }
    if (evidence.outputNames.some((name) => !outputNames.has(name))) {
      throw new Error('Agent evidence cites an output that was not declared.')
    }
  }
  if (task.requiredCapabilities.requireLogSummary === true && result.logSummary === undefined) {
    throw new Error('Task requires an Agent log summary.')
  }
  return result
}

function requireUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', path, message })
  }
}
