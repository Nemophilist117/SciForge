import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { z } from 'zod'
import type { DomainMainAgentExecutionHost } from '@sciforge/domain-sdk/agent-execution'
import type {
  DomainMainHost,
  DomainMainRuntimeLifecycleContribution
} from '@sciforge/domain-sdk/host'
import type { TrustedDomainProcessEntryInput } from '@sciforge/domain-sdk/main'
import {
  COLLABORATION_BC_NODE_CONTRACT_VERSION,
  COLLABORATION_BC_NODE_SERVICE_ID,
  type CollaborationBCNodePort
} from '@sciforge/domain-collaboration/bc-node-port'
import {
  PROJECT_COORDINATOR_CAPABILITY_IDS,
  projectCoordinatorStatusReadInputSchema,
  projectCoordinatorStatusSchema
} from './contract.js'
import { parseAgentRunResult } from './agent-result.js'
import { Coordinator } from './coordinator.js'
import { AgentCoordinatorPlanner } from './coordinator-planner.js'
import {
  FileCoordinatorPlanStore,
  coordinatorPlanStatePath
} from './coordinator-plan-store.js'
import {
  PROJECT_COORDINATOR_CAPABILITY_FACTORY_CONTRIBUTION,
  PROJECT_COORDINATOR_DOMAIN_MODULE_ID,
  PROJECT_COORDINATOR_RUNTIME_LIFECYCLE_CONTRIBUTION,
  domainPackageDefinition
} from './definition.js'
import { FileWorkerJournal } from './journal.js'
import { MockContentSpacePort } from './mock-content-space.js'
import { AgentRuntimeTerminalError, type AgentRuntimePort } from './ports.js'
import { BCRuntime, type BCRuntimeOptions } from './runtime.js'
import { WorkerRunner } from './worker-runner.js'

export { Coordinator } from './coordinator.js'
export { AgentCoordinatorPlanner } from './coordinator-planner.js'
export { FileCoordinatorPlanStore } from './coordinator-plan-store.js'
export { FileWorkerJournal } from './journal.js'
export { MockContentSpacePort } from './mock-content-space.js'
export { BCRuntime } from './runtime.js'
export { WorkerRunner } from './worker-runner.js'

export type ProjectCoordinatorCapabilityOptions = Readonly<{
  id: string
  version: string
  title: string
  description: string
  audiences: readonly ('ui' | 'agent' | 'system')[]
  scope: 'global'
  effect: 'read'
  approval: 'none'
  concurrency: Readonly<{ revision: 'none'; idempotency: 'none' }>
  tags: readonly string[]
  inputSchema: z.ZodType
  outputSchema: z.ZodType
  handler: () => Promise<Readonly<{ output: unknown }>>
}>

export type ProjectCoordinatorCapabilityFactory<CapabilityDefinition = unknown> = Readonly<{
  moduleId: typeof PROJECT_COORDINATOR_DOMAIN_MODULE_ID
  policy: Readonly<{
    id: 'project'
    title: 'Project Coordinator'
    directTransportPrefixes: readonly []
    allowedDirectTransports: readonly []
  }>
  createDefinitions(): readonly CapabilityDefinition[]
}>

type MainContribution<CapabilityDefinition = unknown> =
  | ProjectCoordinatorCapabilityFactory<CapabilityDefinition>
  | DomainMainRuntimeLifecycleContribution

type ProjectCoordinatorHost = DomainMainHost & Readonly<{
  createBCRuntime?: (options: BCRuntimeOptions) => BCRuntime
}>

export function createDomainMainEntry<CapabilityDefinition = unknown>(
  host: ProjectCoordinatorHost
): TrustedDomainProcessEntryInput<MainContribution<CapabilityDefinition>> {
  if (!host.internalServices) throw new Error('B requires Host service mediation for C.')
  let runtime: BCRuntime | null = null
  const createRuntime = host.createBCRuntime ?? ((options) => new BCRuntime(options))
  const lifecycle: DomainMainRuntimeLifecycleContribution = Object.freeze({
    activate: async (context) => {
      if (runtime) throw new Error('B runtime lifecycle is already active.')
      if (!context.agentExecution) throw new Error('B requires the canonical Agent execution Host.')
      const node = host.internalServices!.acquire<CollaborationBCNodePort>(
        COLLABORATION_BC_NODE_SERVICE_ID,
        COLLABORATION_BC_NODE_CONTRACT_VERSION
      )
      const journal = new FileWorkerJournal(join(
        context.userDataDir,
        'domains',
        'project-coordinator',
        'worker-state.json'
      ))
      const principal = {
        current: async () => {
          const current = await node.current()
          return { userId: current.userId, agentId: current.agentId }
        }
      }
      const cloud = { execute: (request: Parameters<typeof node.execute>[0]) => node.execute(request) }
      const workerRunner = new WorkerRunner({
        journal,
        cloud,
        principal,
        contentSpace: productionMockContentSpace(),
        agentRuntime: hostAgentRuntime(context.agentExecution)
      })
      const owned = createRuntime({
        node,
        journal,
        coordinatorPlans: new FileCoordinatorPlanStore(coordinatorPlanStatePath(context.userDataDir)),
        coordinator: new Coordinator(cloud, principal, journal),
        workerRunner,
        plannerFor: (message) => new AgentCoordinatorPlanner(context.agentExecution!, message),
        log: (level, message) => context.log({ level, message })
      })
      await owned.activate()
      runtime = owned
      return async () => {
        if (runtime !== owned) return
        runtime = null
        await owned.dispose()
      }
    }
  })
  const capabilityFactory = createProjectCoordinatorCapabilityFactory({
    defineCapability: host.defineCapability as (
      options: ProjectCoordinatorCapabilityOptions
    ) => CapabilityDefinition,
    getRuntime: () => {
      if (!runtime) throw new Error('B runtime is not active.')
      return runtime
    }
  })
  return {
    definition: domainPackageDefinition,
    contributions: [
      { ...PROJECT_COORDINATOR_CAPABILITY_FACTORY_CONTRIBUTION, value: capabilityFactory },
      { ...PROJECT_COORDINATOR_RUNTIME_LIFECYCLE_CONTRIBUTION, value: lifecycle }
    ]
  }
}

export function createProjectCoordinatorCapabilityFactory<CapabilityDefinition>(options: Readonly<{
  defineCapability(options: ProjectCoordinatorCapabilityOptions): CapabilityDefinition
  getRuntime(): Pick<BCRuntime, 'status'>
}>): ProjectCoordinatorCapabilityFactory<CapabilityDefinition> {
  return Object.freeze({
    moduleId: PROJECT_COORDINATOR_DOMAIN_MODULE_ID,
    policy: Object.freeze({
      id: 'project' as const,
      title: 'Project Coordinator' as const,
      directTransportPrefixes: Object.freeze([]) as readonly [],
      allowedDirectTransports: Object.freeze([]) as readonly []
    }),
    createDefinitions: () => [options.defineCapability({
      id: PROJECT_COORDINATOR_CAPABILITY_IDS.statusRead,
      version: '1.0.0',
      title: 'Inspect B Runtime',
      description: 'Reads Coordinator and Worker recovery state.',
      audiences: ['ui', 'agent', 'system'],
      scope: 'global',
      effect: 'read',
      approval: 'none',
      concurrency: { revision: 'none', idempotency: 'none' },
      tags: ['project', 'coordinator', 'worker'],
      inputSchema: projectCoordinatorStatusReadInputSchema,
      outputSchema: projectCoordinatorStatusSchema,
      handler: async () => ({ output: await options.getRuntime().status() })
    })]
  })
}

function hostAgentRuntime(agentExecution: DomainMainAgentExecutionHost): AgentRuntimePort {
  return {
    run: async ({ task, inputs, signal }) => {
      const result = await agentExecution.run({
        clientDirectiveId: `bc-worker:${task.taskId}:${task.executionId}`,
        prompt: [
          'Execute this SciForge Task and return exactly one strict JSON object with no Markdown.',
          'Schema: {"summary":string,"criterionEvidence":[{"criterionId":string,"summary":string,"resourceRefIds":string[],"outputNames":string[]}],"outputs":[{"name":string,"workspaceRelativePath":string}],"logSummary"?:string}.',
          'Provide evidence for every completion criterion exactly once.',
          'resourceRefIds may contain only input A ResourceRef IDs listed on the Task.',
          'For newly created files, cite their declared output name in outputNames; B will upload them through E and register the resulting A ResourceRef.',
          'Output paths must be relative to the workspace, use forward slashes, and contain no traversal segments.',
          `Task: ${task.title}`,
          `Objective: ${task.objective}`,
          `Completion criteria: ${JSON.stringify(task.completionCriteria)}`,
          `Available input ResourceRef IDs: ${JSON.stringify(task.resourceRefIds)}`,
          `Materialized input paths: ${JSON.stringify(inputs.map((input) => input.workspaceRelativePath))}`
        ].join('\n'),
        metadata: {
          source: 'collaboration.project-task',
          projectId: task.projectId,
          taskId: task.taskId,
          executionId: task.executionId
        },
        interaction: 'background',
        mode: 'agent',
        ...(signal ? { signal } : {})
      })
      if (result.state !== 'completed') throw new AgentRuntimeTerminalError(result.state)
      return parseAgentRunResult(result.text, task)
    }
  }
}

function productionMockContentSpace(): MockContentSpacePort {
  return new MockContentSpacePort({
    downloadPathFor: (reference) => (
      `.sciforge/content-space/${createHash('sha256').update(JSON.stringify(reference)).digest('hex')}`
    ),
    uploadResultFor: (input) => {
      const id = createHash('sha256')
        .update(`${input.idempotencyKey}\u0000${input.name}`)
        .digest('hex')
      return {
        provider: 'mock-opencontent',
        externalId: id,
        kind: 'content-space.file-reference',
        name: input.name,
        portableReference: {
          contractVersion: 1,
          kind: 'content-space.file-reference',
          authority: 'mock-opencontent',
          identity: { fileId: id }
        }
      }
    }
  })
}
