import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInboxMessage } from '@sciforge/collaboration-contracts'
import type { CollaborationBCNodePort } from '@sciforge/domain-collaboration/bc-node-port'
import type { Coordinator } from './coordinator.js'
import type { FileCoordinatorPlanStore } from './coordinator-plan-store.js'
import type { FileWorkerJournal } from './journal.js'
import { BCRuntime } from './runtime.js'
import type { WorkerRunner } from './worker-runner.js'

test('B durably queues a Task offer before C may ACK it', async () => {
  let handler: Parameters<CollaborationBCNodePort['register']>[0] | undefined
  let woke = 0
  const events: string[] = []
  let releaseQueue!: () => void
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve })
  const runtime = new BCRuntime({
    node: {
      register: (candidate) => {
        handler = candidate
        return () => { handler = undefined }
      },
      current: async () => ({
        userId: 'usr_123456789012', agentId: 'agt_123456789012', connected: true
      }),
      execute: async () => { throw new Error('unused') },
      wake: () => { woke += 1 }
    },
    journal: {
      entries: async () => []
    } as unknown as FileWorkerJournal,
    coordinatorPlans: {
      get: async () => undefined,
      save: async () => { throw new Error('unused') },
      list: async () => []
    } as unknown as FileCoordinatorPlanStore,
    coordinator: {
      recoverPendingWrites: async () => 0,
      plan: async () => { throw new Error('unused') }
    } as unknown as Coordinator,
    workerRunner: {
      recoverPendingWrites: async () => 0,
      queue: async () => {
        events.push('journal-queue-start')
        await queueGate
        events.push('journal-queue-committed')
      },
      run: async () => { events.push('worker-started') }
    } as unknown as WorkerRunner,
    plannerFor: () => { throw new Error('unused') }
  })

  await runtime.activate()
  assert.equal(woke, 1)
  assert.ok(handler)
  const delivery = handler(taskOffer(), new AbortController().signal)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['journal-queue-start'])

  releaseQueue()
  assert.deepEqual(await delivery, { status: 'completed' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [
    'journal-queue-start',
    'journal-queue-committed',
    'worker-started'
  ])
  await runtime.dispose()
})

function taskOffer(): AgentInboxMessage {
  return {
    schemaVersion: 1,
    type: 'inbox_message',
    inboxMessageId: 'ibx_Inbox0000001',
    recipientType: 'agent',
    recipientAgentId: 'agt_123456789012',
    sequence: 1,
    status: 'pending',
    disposition: 'active',
    createdAt: '2026-08-20T00:00:00.000Z',
    payload: {
      protocolVersion: '1.0',
      type: 'task.offered',
      projectId: 'prj_123456789012',
      taskId: 'tsk_123456789012',
      executionId: 'exe_123456789012',
      revision: 1
    }
  }
}
