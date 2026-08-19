import type { AgentInboxMessage } from '@sciforge/collaboration-contracts'
import type {
  BCInboxOutcome,
  CollaborationBCNodePort
} from '@sciforge/domain-collaboration/bc-node-port'
import { Coordinator } from './coordinator.js'
import {
  AgentCoordinatorPlanner,
  NoCoordinatorActionError
} from './coordinator-planner.js'
import { FileCoordinatorPlanStore } from './coordinator-plan-store.js'
import { FileWorkerJournal, workerKey } from './journal.js'
import { ManualRecoveryRequiredError, WorkerRunner } from './worker-runner.js'

export type BCRuntimeStatus = Readonly<{
  active: boolean
  connected: boolean
  agentId?: string
  runningWorkerExecutions: number
  pendingWorkerExecutions: number
  pendingCoordinatorPlans: number
}>

export type BCRuntimeOptions = Readonly<{
  node: CollaborationBCNodePort
  journal: FileWorkerJournal
  coordinatorPlans: FileCoordinatorPlanStore
  coordinator: Coordinator
  workerRunner: WorkerRunner
  plannerFor(message: AgentInboxMessage): AgentCoordinatorPlanner
  now?: () => Date
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}>

export class BCRuntime {
  private unregister: (() => void) | null = null
  private abortController: AbortController | null = null
  private readonly workers = new Map<string, Readonly<{
    controller: AbortController
    work: Promise<void>
  }>>()
  private readonly projectTails = new Map<string, Promise<BCInboxOutcome>>()
  private readonly now: () => Date

  constructor(private readonly options: BCRuntimeOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async activate(): Promise<void> {
    if (this.unregister) throw new Error('B runtime is already active.')
    await this.options.coordinator.recoverPendingWrites().catch((error) => {
      this.options.log?.('warn', `Coordinator outbox recovery deferred: ${safeError(error)}`)
    })
    await this.options.workerRunner.recoverPendingWrites().catch((error) => {
      this.options.log?.('warn', `Worker outbox recovery deferred: ${safeError(error)}`)
    })
    const controller = new AbortController()
    this.abortController = controller
    this.unregister = this.options.node.register((message, signal) => (
      this.enqueue(message, AbortSignal.any([signal, controller.signal]))
    ))
    for (const entry of await this.options.journal.entries()) {
      if (entry.phase === 'succeeded' || entry.phase === 'failed' || entry.phase === 'manual_recovery') continue
      this.startWorker(entry.taskId, entry.executionId)
    }
    this.options.node.wake()
  }

  async dispose(): Promise<void> {
    const unregister = this.unregister
    if (!unregister) return
    this.unregister = null
    unregister()
    this.abortController?.abort(new Error('B runtime disposed.'))
    this.abortController = null
    for (const worker of this.workers.values()) worker.controller.abort(new Error('B runtime disposed.'))
    await Promise.allSettled([
      ...[...this.workers.values()].map((worker) => worker.work),
      ...this.projectTails.values()
    ])
    this.workers.clear()
    this.projectTails.clear()
  }

  async status(): Promise<BCRuntimeStatus> {
    const [principal, workerEntries, plans] = await Promise.all([
      this.options.node.current().catch(() => undefined),
      this.options.journal.entries(),
      this.options.coordinatorPlans.list()
    ])
    return {
      active: this.unregister !== null,
      connected: principal?.connected ?? false,
      ...(principal ? { agentId: principal.agentId } : {}),
      runningWorkerExecutions: this.workers.size,
      pendingWorkerExecutions: workerEntries.filter((entry) => (
        entry.phase !== 'succeeded' && entry.phase !== 'failed' && entry.phase !== 'manual_recovery'
      )).length,
      pendingCoordinatorPlans: plans.length
    }
  }

  private enqueue(message: AgentInboxMessage, signal: AbortSignal): Promise<BCInboxOutcome> {
    const projectId = projectIdFor(message)
    if (!projectId) return this.handle(message, signal)
    const previous = this.projectTails.get(projectId) ?? Promise.resolve({ status: 'completed' as const })
    const work = previous.then(
      () => this.handle(message, signal),
      () => this.handle(message, signal)
    )
    this.projectTails.set(projectId, work)
    const cleanup = () => {
      if (this.projectTails.get(projectId) === work) this.projectTails.delete(projectId)
    }
    void work.then(cleanup, cleanup)
    return work
  }

  private async handle(message: AgentInboxMessage, signal: AbortSignal): Promise<BCInboxOutcome> {
    if (signal.aborted) return { status: 'retry', safeCode: 'bc_aborted' }
    try {
      await this.options.coordinator.recoverPendingWrites()
    } catch (error) {
      this.options.log?.('warn', `Coordinator outbox recovery failed: ${safeError(error)}`)
      return { status: 'retry', safeCode: 'coordinator_outbox_recovery_failed' }
    }
    const payload = message.payload
    if (payload.type === 'task.offered') {
      await this.options.workerRunner.queue(payload.taskId, payload.executionId)
      this.startWorker(payload.taskId, payload.executionId)
      return { status: 'completed' }
    }
    if (payload.type === 'task.cancelled') {
      this.abortWorker(payload.taskId, payload.executionId, 'A cancelled the Task execution.')
      return { status: 'completed' }
    }
    if (payload.type === 'task.updated' && isTerminal(payload.status)) {
      this.abortWorker(payload.taskId, payload.executionId, `A moved the Task to ${payload.status}.`)
    }
    const projectId = projectIdFor(message)
    if (!projectId || !isCoordinatorTrigger(message)) return { status: 'completed' }
    if (await this.options.coordinatorPlans.get(message.inboxMessageId)) return { status: 'completed' }
    try {
      const plan = await this.options.coordinator.plan(projectId, this.options.plannerFor(message))
      await this.options.coordinatorPlans.save(
        message.inboxMessageId,
        plan,
        this.now().toISOString()
      )
      return { status: 'completed' }
    } catch (error) {
      if (error instanceof NoCoordinatorActionError) return { status: 'completed' }
      if (signal.aborted) return { status: 'retry', safeCode: 'bc_aborted' }
      this.options.log?.('warn', safeError(error))
      return { status: 'retry', safeCode: 'coordinator_processing_failed' }
    }
  }

  private startWorker(taskId: string, executionId: string): void {
    const key = workerKey(taskId, executionId)
    if (this.workers.has(key)) return
    const controller = new AbortController()
    const work = this.options.workerRunner.run(taskId, executionId, controller.signal)
      .catch((error) => {
        const level = error instanceof ManualRecoveryRequiredError ? 'warn' : 'error'
        this.options.log?.(level, safeError(error))
      })
      .finally(() => {
        if (this.workers.get(key)?.work === work) this.workers.delete(key)
      })
    this.workers.set(key, { controller, work })
  }

  private abortWorker(taskId: string, executionId: string, reason: string): void {
    this.workers.get(workerKey(taskId, executionId))?.controller.abort(new Error(reason))
  }
}

function projectIdFor(message: AgentInboxMessage): string | undefined {
  return message.payload.type === 'human.answer.received'
    ? message.payload.answer.projectId
    : 'projectId' in message.payload
      ? message.payload.projectId
      : undefined
}

function isCoordinatorTrigger(message: AgentInboxMessage): boolean {
  return [
    'project.started',
    'project.input.received',
    'coordinator.transferred',
    'project_record.submitted',
    'human.answer.received',
    'task.updated'
  ].includes(message.payload.type)
}

function isTerminal(status: string): boolean {
  return ['succeeded', 'failed', 'cancelled', 'rejected'].includes(status)
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'B runtime operation failed.')
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, '[REDACTED]')
    .slice(0, 2_000)
}
