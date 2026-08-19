import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  agentInboxMessageSchema,
  portableResourceReferenceCarrierSchema,
  resourceRefSchema,
  restResponseSchema,
  taskSchema,
  type AgentInboxMessage,
  type PortableResourceReferenceCarrier,
  type ResourceRef,
  type RestResponse,
  type Task
} from '@sciforge/collaboration-contracts'
import {
  CollaborationBCNodePortImpl,
  type CollaborationBCCloudRequest
} from '@sciforge/domain-collaboration/bc-node-port'
import { Coordinator } from './coordinator.js'
import { FileCoordinatorPlanStore } from './coordinator-plan-store.js'
import { FileWorkerJournal } from './journal.js'
import { MockContentSpacePort } from './mock-content-space.js'
import { BCRuntime } from './runtime.js'
import { taskFixture } from './test-fixtures.js'
import { WorkerRunner } from './worker-runner.js'

const INPUT_RESOURCE_ID = 'rrf_Input00000001'
const CONTAINER_RESOURCE_ID = 'rrf_Container0001'
const OUTPUT_RESOURCE_ID = 'rrf_Output0000001'
const RESULT_RECORD_ID = 'rec_Result0000001'
const NOW = '2026-08-20T00:00:00.000Z'

test('C and B complete a fenced A/E Worker execution through the durable production path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-integration-'))
  const journal = new FileWorkerJournal(join(directory, 'worker.json'))
  const plans = new FileCoordinatorPlanStore(join(directory, 'plans.json'))
  const task = taskSchema.parse(taskFixture({
    status: 'offered',
    revision: 1,
    resourceRefIds: [INPUT_RESOURCE_ID, CONTAINER_RESOURCE_ID]
  }))
  const events: string[] = []
  const fakeA = new FakeA(task, events)
  let registered = false
  let wakeCount = 0
  const node = new CollaborationBCNodePortImpl({
    current: async () => ({
      userId: task.assigneeUserId,
      agentId: task.assigneeAgentId,
      connected: true
    }),
    execute: (request) => fakeA.execute(request),
    wake: () => { wakeCount += 1 },
    registrationChanged: (enabled) => { registered = enabled }
  })
  const mockE = new MockContentSpacePort({
    downloadPathFor: () => 'private/workspace/inputs/data.csv',
    uploadResultFor: ({ name }) => ({
      provider: 'mock-opencontent',
      externalId: 'uploaded-output-1',
      kind: 'content-space.file-reference',
      name,
      portableReference: portable('content-space.file-reference', 'uploaded-output-1')
    })
  })
  const contentSpace = {
    materialize: async (reference: PortableResourceReferenceCarrier) => {
      events.push(`E:materialize:${reference.kind}`)
      return mockE.materialize(reference)
    },
    agentDownload: async (
      input: Awaited<ReturnType<MockContentSpacePort['materialize']>>,
      destinationName: string
    ) => {
      events.push('E:agent-download')
      assert.equal(destinationName, 'data.csv')
      return mockE.agentDownload(input)
    },
    agentUploadNew: async (input: Parameters<MockContentSpacePort['agentUploadNew']>[0]) => {
      events.push('E:agent-upload-new')
      return mockE.agentUploadNew(input)
    }
  }
  let releaseAgent!: () => void
  let markAgentStarted!: () => void
  const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve })
  const agentStarted = new Promise<void>((resolve) => { markAgentStarted = resolve })
  const worker = new WorkerRunner({
    journal,
    cloud: node,
    principal: node,
    contentSpace,
    agentRuntime: {
      run: async ({ task: runningTask, inputs }) => {
        events.push('AgentRuntime:run')
        assert.equal(runningTask.status, 'running')
        assert.deepEqual(inputs, [{ workspaceRelativePath: 'private/workspace/inputs/data.csv' }])
        markAgentStarted()
        await agentGate
        return {
          summary: 'Analysis completed.',
          criterionEvidence: [{
            criterionId: task.completionCriteria[0]!.criterionId,
            summary: 'The uploaded result satisfies the criterion.',
            resourceRefIds: [INPUT_RESOURCE_ID],
            outputNames: ['result.csv']
          }],
          outputs: [{
            name: 'result.csv',
            workspaceRelativePath: 'private/workspace/outputs/result.csv'
          }],
          logSummary: 'Completed without warnings.'
        }
      }
    },
    now: () => new Date(NOW)
  })
  const coordinator = new Coordinator(node, node, journal)
  const errors: string[] = []
  const runtime = new BCRuntime({
    node,
    journal,
    coordinatorPlans: plans,
    coordinator,
    workerRunner: worker,
    plannerFor: () => { throw new Error('Coordinator planning is not part of a Task offer.') },
    now: () => new Date(NOW),
    log: (level, message) => {
      if (level === 'error') errors.push(message)
    }
  })

  await runtime.activate()
  assert.equal(registered, true)
  assert.equal(wakeCount, 1)
  try {
    await node.handle(taskOffer(task), new AbortController().signal)

    const durableAtAck = await journal.get(task.taskId, task.executionId)
    assert.ok(durableAtAck, 'C may return from delivery only after B durably queues the execution.')
    assert.equal(durableAtAck.taskId, task.taskId)
    assert.equal(durableAtAck.executionId, task.executionId)

    await agentStarted
    assert.equal((await journal.get(task.taskId, task.executionId))?.phase, 'agent_started')
    releaseAgent()
    await waitFor(() => journal.get(task.taskId, task.executionId), (entry) => entry?.phase === 'succeeded')

    const requests = fakeA.requests
    assert.equal(requests.some((request) => request.type === 'project_record.submit' as never), false)
    const terminal = requests.find((request) => (
      request.type === 'task.transition' && request.status === 'succeeded'
    ))
    assert.ok(terminal && terminal.type === 'task.transition')
    assert.equal('resultSummary' in terminal, false)
    assert.deepEqual(Object.keys(terminal.result ?? {}).sort(), [
      'criterionEvidence', 'logSummary', 'resourceRefIds', 'summary'
    ])
    assert.deepEqual(terminal.result, {
      summary: 'Analysis completed.',
      criterionEvidence: [{
        criterionId: task.completionCriteria[0]!.criterionId,
        summary: 'The uploaded result satisfies the criterion.',
        resourceRefIds: [INPUT_RESOURCE_ID, OUTPUT_RESOURCE_ID]
      }],
      resourceRefIds: [OUTPUT_RESOURCE_ID, INPUT_RESOURCE_ID],
      logSummary: 'Completed without warnings.'
    })

    assertOrdered(events, [
      `A:resource.get:${INPUT_RESOURCE_ID}`,
      'E:materialize:content-space.file-reference',
      'E:agent-download',
      'AgentRuntime:run',
      'E:agent-upload-new',
      'A:resource.create',
      'A:task.transition:succeeded'
    ])
    const cloudJson = JSON.stringify(requests)
    for (const forbidden of [
      'resourceHandle', 'workspaceRelativePath', 'local:', 'private/workspace',
      '/tmp/', 'accessToken', 'refreshToken', 'Bearer '
    ]) {
      assert.equal(cloudJson.includes(forbidden), false, `A request leaked ${forbidden}.`)
    }
    assert.equal(await journal.pendingCount(), 0)
    assert.deepEqual(errors, [])
  } finally {
    releaseAgent()
    await runtime.dispose()
  }
  assert.equal(registered, false)
})

class FakeA {
  readonly requests: CollaborationBCCloudRequest[] = []
  private task: Task
  private readonly resources = new Map<string, ResourceRef>()

  constructor(task: Task, private readonly events: string[]) {
    this.task = task
    this.resources.set(INPUT_RESOURCE_ID, resource(
      task,
      INPUT_RESOURCE_ID,
      'content-space.file-reference',
      'data.csv',
      portable('content-space.file-reference', 'input-file-1')
    ))
    this.resources.set(CONTAINER_RESOURCE_ID, resource(
      task,
      CONTAINER_RESOURCE_ID,
      'content-space.container-reference',
      'outputs',
      portable('content-space.container-reference', 'output-container-1')
    ))
  }

  async execute(request: CollaborationBCCloudRequest): Promise<RestResponse> {
    this.requests.push(structuredClone(request))
    if (request.type === 'task.get') {
      assert.equal(request.taskId, this.task.taskId)
      this.events.push('A:task.get')
      return entity(request.requestId, this.task)
    }
    if (request.type === 'resource.get') {
      this.events.push(`A:resource.get:${request.resourceRefId}`)
      const found = this.resources.get(request.resourceRefId)
      assert.ok(found, `Unknown A ResourceRef ${request.resourceRefId}.`)
      return entity(request.requestId, found)
    }
    if (request.type === 'task.transition') {
      this.assertTaskFence(request.taskId, request.executionId, request.expectedRevision)
      this.events.push(`A:task.transition:${request.status}`)
      this.task = request.status === 'succeeded'
        ? taskSchema.parse({
            ...this.task,
            status: 'succeeded',
            resultSummary: request.result?.summary,
            resultProjectRecordId: RESULT_RECORD_ID,
            completedAt: NOW,
            revision: this.task.revision + 1,
            updatedAt: NOW
          })
        : taskSchema.parse({
            ...this.task,
            status: request.status,
            revision: this.task.revision + 1,
            updatedAt: NOW
          })
      return entity(request.requestId, this.task)
    }
    if (request.type === 'task.progress.report') {
      this.assertTaskFence(request.taskId, request.executionId, request.expectedRevision)
      assert.equal(this.task.status, 'running')
      this.events.push('A:task.progress.report')
      this.task = taskSchema.parse({
        ...this.task,
        progress: { percent: request.percent, summary: request.summary, reportedAt: NOW },
        revision: this.task.revision + 1,
        updatedAt: NOW
      })
      return entity(request.requestId, this.task)
    }
    if (request.type === 'resource.create') {
      assert.ok(request.taskId && request.executionId && request.expectedTaskRevision)
      this.assertTaskFence(request.taskId, request.executionId, request.expectedTaskRevision)
      this.events.push('A:resource.create')
      const portableReference = portableResourceReferenceCarrierSchema.parse(request.portableReference)
      assert.equal(request.kind, portableReference.kind)
      const created = resource(
        this.task,
        OUTPUT_RESOURCE_ID,
        portableReference.kind,
        request.name,
        portableReference
      )
      this.resources.set(created.resourceRefId, created)
      return entity(request.requestId, created)
    }
    throw new Error(`Unexpected A command in Worker integration: ${request.type}`)
  }

  private assertTaskFence(taskId: string, executionId: string, revision: number): void {
    assert.equal(taskId, this.task.taskId)
    assert.equal(executionId, this.task.executionId)
    assert.equal(revision, this.task.revision)
    assert.equal(this.task.assigneeAgentId, 'agt_123456789012')
  }
}

function taskOffer(task: Task): AgentInboxMessage {
  return agentInboxMessageSchema.parse({
    schemaVersion: 1,
    type: 'inbox_message',
    inboxMessageId: 'ibx_Inbox0000001',
    recipientType: 'agent',
    recipientAgentId: task.assigneeAgentId,
    sequence: 1,
    status: 'pending',
    disposition: 'active',
    createdAt: NOW,
    payload: {
      protocolVersion: '1.0',
      type: 'task.offered',
      projectId: task.projectId,
      taskId: task.taskId,
      executionId: task.executionId,
      revision: task.revision
    }
  })
}

function portable(
  kind: PortableResourceReferenceCarrier['kind'],
  fileId: string
): PortableResourceReferenceCarrier {
  return portableResourceReferenceCarrierSchema.parse({
    contractVersion: 1,
    kind,
    authority: 'mock-opencontent',
    identity: { fileId }
  })
}

function resource(
  task: Task,
  resourceRefId: string,
  kind: PortableResourceReferenceCarrier['kind'],
  name: string,
  portableReference: PortableResourceReferenceCarrier
): ResourceRef {
  return resourceRefSchema.parse({
    schemaVersion: 1,
    type: 'resource_ref',
    resourceRefId,
    projectId: task.projectId,
    taskId: task.taskId,
    executionId: task.executionId,
    taskRevision: task.revision,
    createdByUserId: task.assigneeUserId,
    createdByAgentId: task.assigneeAgentId,
    provider: 'mock-opencontent',
    externalId: `external-${resourceRefId}`,
    kind,
    name,
    openUrl: null,
    portableReference,
    version: null,
    status: 'available',
    statusReasonCode: null,
    unavailableAt: null,
    revokedAt: null,
    invalidatedAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW
  })
}

function entity(requestId: string, value: Task | ResourceRef): RestResponse {
  return restResponseSchema.parse({
    protocolVersion: '1.0',
    type: 'rest.entity',
    requestId,
    entity: value
  })
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the Worker integration flow.')
}

function assertOrdered(actual: readonly string[], expected: readonly string[]): void {
  let position = -1
  for (const item of expected) {
    position = actual.indexOf(item, position + 1)
    assert.notEqual(position, -1, `Missing ordered event ${item}. Events: ${actual.join(', ')}`)
  }
}
