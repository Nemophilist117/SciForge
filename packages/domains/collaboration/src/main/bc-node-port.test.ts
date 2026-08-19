import assert from 'node:assert/strict'
import test from 'node:test'

import type { RestRequest } from '@sciforge/collaboration-contracts'
import {
  TEST_IDS,
  agentInboxMessageFixture,
  taskFixture
} from '@sciforge/collaboration-contracts/testing'

import {
  BCInboxRetryError,
  CollaborationBCNodePortImpl
} from './bc-node-port.js'

test('B/C port durably retries while B is unavailable and allows only one handler', async () => {
  const capabilityChanges: boolean[] = []
  const port = createPort((enabled) => capabilityChanges.push(enabled))

  await assert.rejects(
    port.handle(agentInboxMessageFixture, new AbortController().signal),
    (error: unknown) => error instanceof BCInboxRetryError && error.safeCode === 'bc_unavailable'
  )
  const unregister = port.register(async () => ({ status: 'completed' }))
  assert.throws(() => port.register(async () => ({ status: 'completed' })), /already registered/u)
  await port.handle(agentInboxMessageFixture, new AbortController().signal)
  unregister()
  unregister()

  assert.deepEqual(capabilityChanges, [true, false])
})

test('B/C port preserves retry outcomes and freezes C-owned values', async () => {
  const port = createPort()
  const unregister = port.register(async () => ({ status: 'retry', safeCode: 'worker_busy' }))

  await assert.rejects(
    port.handle(agentInboxMessageFixture, new AbortController().signal),
    (error: unknown) => error instanceof BCInboxRetryError && error.safeCode === 'worker_busy'
  )
  unregister()

  const principal = await port.current()
  const response = await port.execute({
    protocolVersion: '1.0', requestId: TEST_IDS.requestId,
    type: 'task.get', taskId: TEST_IDS.taskId
  })
  assert.equal(Object.isFrozen(principal), true)
  assert.equal(Object.isFrozen(response), true)
})

test('B/C port rejects valid A commands outside the exact B allowlist at runtime', async () => {
  let executions = 0
  const port = new CollaborationBCNodePortImpl({
    current: async () => ({
      userId: TEST_IDS.userId,
      agentId: TEST_IDS.agentId,
      connected: true
    }),
    execute: async () => {
      executions += 1
      throw new Error('must not execute')
    },
    wake: () => undefined,
    registrationChanged: () => undefined
  })

  await assert.rejects(port.execute({
    protocolVersion: '1.0', requestId: TEST_IDS.requestId,
    type: 'project.get', projectId: TEST_IDS.projectId
  } as never), /unauthorized B cloud command/u)
  assert.equal(executions, 0)
})

function createPort(registrationChanged: (enabled: boolean) => void = () => undefined) {
  return new CollaborationBCNodePortImpl({
    current: async () => ({
      userId: TEST_IDS.userId,
      agentId: TEST_IDS.agentId,
      connected: true
    }),
    execute: async (_request: Extract<RestRequest, { type: 'task.get' }>) => ({
      protocolVersion: '1.0', requestId: TEST_IDS.requestId,
      type: 'rest.entity', entity: taskFixture
    }),
    wake: () => undefined,
    registrationChanged
  })
}
