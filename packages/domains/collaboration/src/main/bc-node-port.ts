import {
  restRequestSchema,
  type AgentInboxMessage,
  type RestRequest,
  type RestResponse
} from '@sciforge/collaboration-contracts'

export const COLLABORATION_BC_NODE_SERVICE_ID = 'collaboration.bc-node' as const
export const COLLABORATION_BC_NODE_CONTRACT_VERSION = '1.0.0' as const

type BCCloudRequestType =
  | 'project.coordination_view.get'
  | 'project.capability_directory.get'
  | 'task.create'
  | 'task.get'
  | 'task.retry'
  | 'task.transition'
  | 'task.progress.report'
  | 'resource.create'
  | 'resource.get'
  | 'human.needed.create'

const BC_CLOUD_REQUEST_TYPES = new Set<BCCloudRequestType>([
  'project.coordination_view.get',
  'project.capability_directory.get',
  'task.create',
  'task.get',
  'task.retry',
  'task.transition',
  'task.progress.report',
  'resource.create',
  'resource.get',
  'human.needed.create'
])

export type CollaborationBCCloudRequest = Extract<RestRequest, { type: BCCloudRequestType }>

export type CollaborationNodePrincipal = Readonly<{
  userId: string
  agentId: string
  connected: boolean
}>

export type BCInboxOutcome =
  | Readonly<{ status: 'completed' }>
  | Readonly<{ status: 'retry'; safeCode: string }>

export type BCInboxHandler = (
  message: AgentInboxMessage,
  signal: AbortSignal
) => Promise<BCInboxOutcome>

export interface CollaborationBCNodePort {
  register(handler: BCInboxHandler): () => void
  current(): Promise<CollaborationNodePrincipal>
  execute(request: CollaborationBCCloudRequest): Promise<RestResponse>
  wake(): void
}

export type CollaborationBCNodePortOptions = Readonly<{
  current(): Promise<CollaborationNodePrincipal>
  execute(request: CollaborationBCCloudRequest): Promise<RestResponse>
  wake(): void
  registrationChanged(enabled: boolean): void
}>

export class CollaborationBCNodePortImpl implements CollaborationBCNodePort {
  private handler: BCInboxHandler | null = null

  constructor(private readonly options: CollaborationBCNodePortOptions) {}

  register(handler: BCInboxHandler): () => void {
    if (this.handler) throw new Error('A B/C inbox handler is already registered.')
    this.handler = handler
    this.options.registrationChanged(true)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      if (this.handler !== handler) return
      this.handler = null
      this.options.registrationChanged(false)
    }
  }

  async current(): Promise<CollaborationNodePrincipal> {
    return deepFreeze(structuredClone(await this.options.current()))
  }

  async execute(request: CollaborationBCCloudRequest): Promise<RestResponse> {
    const parsed = restRequestSchema.parse(request)
    if (!BC_CLOUD_REQUEST_TYPES.has(parsed.type as BCCloudRequestType)) {
      throw new Error(`C rejected unauthorized B cloud command: ${parsed.type}.`)
    }
    return deepFreeze(structuredClone(await this.options.execute(
      parsed as CollaborationBCCloudRequest
    )))
  }

  wake(): void {
    this.options.wake()
  }

  async handle(message: AgentInboxMessage, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BCInboxRetryError('bc_aborted')
    const handler = this.handler
    if (!handler) throw new BCInboxRetryError('bc_unavailable')
    const outcome = await handler(deepFreeze(structuredClone(message)), signal)
    if (signal.aborted) throw new BCInboxRetryError('bc_aborted')
    if (outcome.status === 'retry') throw new BCInboxRetryError(outcome.safeCode)
  }
}

export class BCInboxRetryError extends Error {
  constructor(readonly safeCode: string) {
    super(`B/C inbox delivery must retry (${safeCode}).`)
    this.name = 'BCInboxRetryError'
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
