import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  agentIdSchema,
  inboxMessageIdSchema,
  projectIdSchema,
  resourceRefIdSchema,
  revisionSchema,
  taskCriterionSchema,
  taskIdSchema,
  timestampSchema,
  workerRequirementSchema
} from '@sciforge/collaboration-contracts'
import type { ProjectPlan } from './coordinator.js'

const taskProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(32_000),
  completionCriteria: z.array(taskCriterionSchema).min(1).max(100),
  dependencyTaskIds: z.array(taskIdSchema).max(1_000),
  requiredCapabilities: workerRequirementSchema,
  resourceRefIds: z.array(resourceRefIdSchema).max(1_000),
  assigneeAgentId: agentIdSchema
}).strict()

const projectPlanSchema = z.object({
  projectId: projectIdSchema,
  basedOnProjectRevision: revisionSchema,
  objective: z.string().trim().min(1).max(32_000),
  tasks: z.array(taskProposalSchema).min(1).max(1_000)
}).strict()

const planRecordSchema = z.object({
  sourceInboxMessageId: inboxMessageIdSchema,
  plan: projectPlanSchema,
  state: z.literal('awaiting_proposal_digest'),
  savedAt: timestampSchema
}).strict()

const fileSchema = z.object({
  version: z.literal(1),
  records: z.array(planRecordSchema).max(10_000)
}).strict()

export type CoordinatorPlanRecord = z.infer<typeof planRecordSchema>

export class FileCoordinatorPlanStore {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(sourceInboxMessageId: string): Promise<CoordinatorPlanRecord | undefined> {
    return (await this.read()).records.find((record) => (
      record.sourceInboxMessageId === sourceInboxMessageId
    ))
  }

  async save(sourceInboxMessageId: string, plan: ProjectPlan, savedAt: string): Promise<CoordinatorPlanRecord> {
    let saved!: CoordinatorPlanRecord
    await this.mutate((state) => {
      const existing = state.records.find((record) => record.sourceInboxMessageId === sourceInboxMessageId)
      saved = planRecordSchema.parse({
        sourceInboxMessageId,
        plan,
        state: 'awaiting_proposal_digest',
        savedAt
      })
      if (existing) {
        if (JSON.stringify(existing.plan) !== JSON.stringify(saved.plan)) {
          throw new Error('Coordinator plan is immutable for its source Inbox message.')
        }
        saved = existing
        return
      }
      state.records.push(saved)
    })
    return structuredClone(saved)
  }

  async list(): Promise<readonly CoordinatorPlanRecord[]> {
    return (await this.read()).records.map((record) => structuredClone(record))
  }

  private async mutate(change: (state: z.infer<typeof fileSchema>) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      const state = await this.read()
      change(state)
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(fileSchema.parse(state), null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600
      })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    })
    this.tail = operation.catch(() => undefined)
    await operation
  }

  private async read(): Promise<z.infer<typeof fileSchema>> {
    try {
      return fileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] }
      throw error
    }
  }
}

export function coordinatorPlanStatePath(userDataDir: string): string {
  return join(userDataDir, 'domains', 'project-coordinator', 'coordinator-plans.json')
}
