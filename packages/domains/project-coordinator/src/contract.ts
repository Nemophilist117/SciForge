import { z } from 'zod'
import { agentIdSchema } from '@sciforge/collaboration-contracts'

export const PROJECT_COORDINATOR_CAPABILITY_IDS = Object.freeze({
  statusRead: 'project.coordinator.status.read'
})

export const projectCoordinatorStatusReadInputSchema = z.object({}).strict()
export const projectCoordinatorStatusSchema = z.object({
  active: z.boolean(),
  connected: z.boolean(),
  agentId: agentIdSchema.optional(),
  runningWorkerExecutions: z.number().int().nonnegative(),
  pendingWorkerExecutions: z.number().int().nonnegative(),
  pendingCoordinatorPlans: z.number().int().nonnegative()
}).strict()
