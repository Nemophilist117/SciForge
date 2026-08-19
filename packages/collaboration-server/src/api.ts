import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  createCollaborationError,
  deviceCreateRequestSchema,
  deviceEnrollmentCreateRequestSchema,
  deviceRevokeRequestSchema,
  externalIdentityRevokeRequestSchema,
  requestIdSchema,
  restRequestSchema,
  restResponseSchema,
  trustedZulipConfirmContextSchema,
  zulipBindingBeginRequestSchema,
  zulipBindingConfirmRequestSchema,
  type HumanEndpointProviderContract,
  type ProviderLocator,
  type RestRequest,
  type RestResponse,
  type TrustedZulipConfirmContext,
  type ZulipBindingConfirmRequest
} from '@sciforge/collaboration-contracts'
import { ZodError } from 'zod'

import { AuthenticationService, type AgentActor, type AuthContext, type HumanEndpointActor, type UserActor } from './auth.js'
import {
  toActionConfirmation,
  toAgent,
  toAgentCapabilityProfile,
  toEndpoint,
  toHumanAnswer,
  toHumanNeeded,
  toInboxMessage,
  toParticipant,
  toProject,
  toProjectCapabilityDirectory,
  toProjectCoordinationView,
  toProjectEndpointBinding,
  toProjectInput,
  toProjectRecord,
  toResourceRef,
  toProjection,
  toTask,
  toUserPrincipal
} from './contracts.js'
import { getCollaborationConsoleAsset, type CollaborationConsoleAsset } from './console.js'
import { stableDigest } from './crypto.js'
import { CollaborationServiceError } from './errors.js'
import type { IdentityService } from './identity-service.js'
import type { CollaborationService } from './service.js'

export const COLLABORATION_SERVER_ID = 'sciforge.collaboration-server'
export const COLLABORATION_SERVER_VERSION = '0.1.0'
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

export interface ProviderDirectory {
  contracts(): readonly HumanEndpointProviderContract[]
  listLocators(input: {
    actor: AuthContext
    humanEndpointId: string
    query?: string
    cursor?: string
    limit: number
  }): Promise<{ locators: ProviderLocator[]; nextCursor?: string }>
}

export type BindingConfirmAuthenticator = (
  request: IncomingMessage,
  body: ZulipBindingConfirmRequest
) => Promise<TrustedZulipConfirmContext | null>

export type CollaborationHttpOptions = {
  service: CollaborationService
  identities?: IdentityService
  authentication: AuthenticationService
  readiness: () => Promise<boolean>
  providers?: ProviderDirectory
  resolveProviderActor?: (request: IncomingMessage, command: RestRequest) => Promise<HumanEndpointActor | null>
  authenticateZulipBindingConfirm?: BindingConfirmAuthenticator
  basePath?: string
  maxBodyBytes?: number
  now?: () => Date
}

export function createCollaborationHttpServer(options: CollaborationHttpOptions): Server {
  const basePath = normalizeBasePath(options.basePath)
  const maxBodyBytes = Math.max(1_024, Math.min(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 1024 * 1024))
  const limiter = new AnonymousBootstrapLimiter(options.now)
  return createServer((request, response) => {
    handle(request, response, options, basePath, maxBodyBytes, limiter).catch((error) => sendFailure(response, error))
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: CollaborationHttpOptions,
  basePath: string,
  maxBodyBytes: number,
  limiter: AnonymousBootstrapLimiter
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === `${basePath}/console`) {
    response.writeHead(308, {
      location: `${basePath}/console/`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    })
    response.end()
    return
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith(`${basePath}/console/`)) {
    const asset = getCollaborationConsoleAsset(url.pathname.slice(basePath.length))
    if (!asset) return sendJson(response, 404, { ok: false })
    return sendConsoleAsset(response, asset, request.method === 'HEAD')
  }
  if (request.method === 'GET' && url.pathname === `${basePath}/healthz`) {
    return sendJson(response, 200, { ok: true })
  }
  if (request.method === 'GET' && url.pathname === `${basePath}/readyz`) {
    const ready = await options.readiness().catch(() => false)
    return sendJson(response, ready ? 200 : 503, { ok: ready })
  }
  if (await handleIdentityRoute(request, response, url, options, basePath, maxBodyBytes)) return
  if (request.method !== 'POST' || url.pathname !== `${basePath}/v1/commands`) {
    return sendJson(response, 404, { ok: false })
  }
  const failureContext: { requestId?: string; expectedRevision?: number } = {}
  try {
    requireJson(request)
    const raw = await readJson(request, maxBodyBytes)
    if (raw && typeof raw === 'object' && 'requestId' in raw) {
      const parsedRequestId = requestIdSchema.safeParse(raw.requestId)
      if (parsedRequestId.success) failureContext.requestId = parsedRequestId.data
    }
    const command = restRequestSchema.parse(raw)
    failureContext.requestId = command.requestId
    if ('expectedRevision' in command) failureContext.expectedRevision = command.expectedRevision
    else if ('expectedTaskRevision' in command && command.expectedTaskRevision !== undefined) {
      failureContext.expectedRevision = command.expectedTaskRevision
    }
    const headerKey = firstHeader(request.headers['idempotency-key'])
    if ('idempotencyKey' in command && headerKey !== command.idempotencyKey) {
      throw new CollaborationServiceError('validation_failed', 'Idempotency-Key header must match the strict command body.')
    }
    if (isAnonymousBootstrapCommand(command)) {
      limiter.consume(request.socket.remoteAddress ?? 'unknown', command.type)
    }
    const actor = await resolveActor(request, command, options)
    let body: RestResponse
    try {
      body = await dispatch(command, actor, options)
    } catch (error) {
      if (actor && error instanceof CollaborationServiceError && !error.auditRecorded) {
        await options.service.recordRejectedBoundary(actor, command.type, error).catch(() => undefined)
      }
      throw error
    }
    const validated = restResponseSchema.parse(body)
    sendJson(response, 200, validated)
  } catch (error) {
    sendFailure(response, error, failureContext)
  }
}

async function handleIdentityRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: CollaborationHttpOptions,
  basePath: string,
  maxBodyBytes: number
): Promise<boolean> {
  const path = url.pathname.slice(basePath.length)
  const identities = options.identities
  const isIdentityPath = path === '/v1/me' || path === '/v1/device-enrollments' || path === '/v1/devices' ||
    path === '/v1/me/devices' || path === '/v1/integrations/zulip/bindings' ||
    path === '/v1/integrations/zulip/bindings/confirm' || path === '/v1/me/external-identities' ||
    /^\/v1\/me\/devices\/[^/]+$/u.test(path) || /^\/v1\/me\/external-identities\/[^/]+$/u.test(path)
  if (!isIdentityPath) return false
  if (!identities) {
    throw new CollaborationServiceError('resource_offline', 'The A identity service is not configured.', { retryable: true })
  }

  if (request.method === 'POST' && path === '/v1/integrations/zulip/bindings/confirm') {
    if (!options.authenticateZulipBindingConfirm) {
      throw new CollaborationServiceError('authentication_required',
        'Trusted Zulip binding confirmation authentication is not configured.')
    }
    requireJson(request)
    const body = zulipBindingConfirmRequestSchema.parse(await readJson(request, maxBodyBytes))
    requireMatchingIdempotencyKey(request, body.idempotencyKey)
    const authenticatedContext = await options.authenticateZulipBindingConfirm(request, body)
    if (!authenticatedContext) {
      throw new CollaborationServiceError('authentication_required',
        'The Zulip binding confirmation caller is not trusted.')
    }
    const trusted = trustedZulipConfirmContextSchema.parse(authenticatedContext)
    if (trusted.realmUrl !== body.realmUrl || trusted.realmId !== body.realmId ||
        trusted.zulipUserId !== body.zulipUserId || trusted.providerEventId !== body.providerEventId) {
      throw new CollaborationServiceError('permission_denied',
        'The trusted Zulip context does not match the confirmation payload.')
    }
    try {
      sendJson(response, 200, await identities.confirmZulipBinding(trusted.actor, {
        bindingCode: body.bindingCode,
        realmUrl: trusted.realmUrl,
        realmId: trusted.realmId,
        zulipUserId: trusted.zulipUserId,
        providerEventId: trusted.providerEventId,
        idempotencyKey: body.idempotencyKey
      }))
    } catch (error) {
      if (error instanceof CollaborationServiceError && !error.auditRecorded) {
        await identities.recordRejectedBoundary(trusted.actor, 'zulip.binding.confirm', error).catch(() => undefined)
      }
      throw error
    }
    return true
  }

  const actor = await resolveOidcUserRequest(request, options.authentication)
  try {
    if (request.method === 'GET' && path === '/v1/me') {
      sendJson(response, 200, await identities.me(actor))
      return true
    }
    if (request.method === 'POST' && path === '/v1/device-enrollments') {
      requireJson(request)
      const body = deviceEnrollmentCreateRequestSchema.parse(await readJson(request, maxBodyBytes))
      requireMatchingIdempotencyKey(request, body.idempotencyKey)
      sendJson(response, 200, await identities.createDeviceEnrollment(actor, body))
      return true
    }
    if (request.method === 'POST' && path === '/v1/devices') {
      requireJson(request)
      const body = deviceCreateRequestSchema.parse(await readJson(request, maxBodyBytes))
      requireMatchingIdempotencyKey(request, body.idempotencyKey)
      sendJson(response, 200, await identities.createDevice(actor, body))
      return true
    }
    if (request.method === 'GET' && path === '/v1/me/devices') {
      sendJson(response, 200, await identities.listDevices(actor))
      return true
    }
    const deviceMatch = /^\/v1\/me\/devices\/([^/]+)$/u.exec(path)
    if (request.method === 'DELETE' && deviceMatch) {
      requireJson(request)
      const body = deviceRevokeRequestSchema.parse(await readJson(request, maxBodyBytes))
      if (body.deviceId !== deviceMatch[1]) {
        throw new CollaborationServiceError('validation_failed', 'Device path and body IDs must match.')
      }
      requireMatchingIdempotencyKey(request, body.idempotencyKey)
      sendJson(response, 200, await identities.revokeDevice(actor, body.deviceId, body.idempotencyKey))
      return true
    }
    if (request.method === 'POST' && path === '/v1/integrations/zulip/bindings') {
      requireJson(request)
      const body = zulipBindingBeginRequestSchema.parse(await readJson(request, maxBodyBytes))
      requireMatchingIdempotencyKey(request, body.idempotencyKey)
      sendJson(response, 200, await identities.beginZulipBinding(actor, body))
      return true
    }
    if (request.method === 'GET' && path === '/v1/me/external-identities') {
      sendJson(response, 200, await identities.listExternalIdentities(actor))
      return true
    }
    const identityMatch = /^\/v1\/me\/external-identities\/([^/]+)$/u.exec(path)
    if (request.method === 'DELETE' && identityMatch) {
      requireJson(request)
      const body = externalIdentityRevokeRequestSchema.parse(await readJson(request, maxBodyBytes))
      if (body.externalIdentityId !== identityMatch[1]) {
        throw new CollaborationServiceError('validation_failed', 'External identity path and body IDs must match.')
      }
      requireMatchingIdempotencyKey(request, body.idempotencyKey)
      sendJson(response, 200, await identities.revokeExternalIdentity(actor, body.externalIdentityId, body.idempotencyKey))
      return true
    }
    sendJson(response, 405, { ok: false })
    return true
  } catch (error) {
    if (error instanceof CollaborationServiceError && !error.auditRecorded) {
      await identities.recordRejectedBoundary(actor, `http.${request.method?.toLowerCase() ?? 'unknown'}${path}`, error)
        .catch(() => undefined)
    }
    throw error
  }
}

async function resolveOidcUserRequest(
  request: IncomingMessage,
  authentication: AuthenticationService
): Promise<UserActor> {
  const authorization = firstHeader(request.headers.authorization)
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  const actor = await authentication.resolveBearer(token)
  if (actor.kind !== 'user') {
    throw new CollaborationServiceError('permission_denied', 'This identity API requires an OIDC User actor.')
  }
  return actor
}

function requireMatchingIdempotencyKey(request: IncomingMessage, bodyKey: string): void {
  if (firstHeader(request.headers['idempotency-key']) !== bodyKey) {
    throw new CollaborationServiceError('validation_failed',
      'Idempotency-Key header must match the strict request body.')
  }
}

function requiredIdentityService(options: CollaborationHttpOptions): IdentityService {
  if (!options.identities) {
    throw new CollaborationServiceError('resource_offline', 'The A identity service is not configured.', { retryable: true })
  }
  return options.identities
}

async function resolveActor(
  request: IncomingMessage,
  command: RestRequest,
  options: CollaborationHttpOptions
): Promise<AuthContext | null> {
  if (isAnonymousBootstrapCommand(command)) return null
  if (command.type === 'project.input.create' || command.type === 'human.answer') {
    const providerActor = await options.resolveProviderActor?.(request, command)
    if (providerActor) return providerActor
    throw new CollaborationServiceError('permission_denied', 'This command is accepted only from the verified provider gateway.')
  }
  const authorization = firstHeader(request.headers.authorization)
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  return options.authentication.resolveBearer(token)
}

async function dispatch(command: RestRequest, actor: AuthContext | null, options: CollaborationHttpOptions): Promise<RestResponse> {
  const { service } = options
  switch (command.type) {
    case 'pairing.begin': {
      const result = await requiredIdentityService(options).beginZulipBinding(requiredUser(actor), {
        realmUrl: command.realmUrl,
        idempotencyKey: command.idempotencyKey
      })
      return response(command, { type: 'pairing.begun', bindingRequestId: result.bindingRequestId,
        bindingCode: result.bindingCode, expiresAt: result.expiresAt })
    }
    case 'pairing.redeem': {
      const result = await requiredIdentityService(options).getZulipBindingStatus(requiredUser(actor), command.bindingRequestId)
      if (result.status === 'pending') return response(command, { type: 'pairing.pending',
        bindingRequestId: result.bindingRequestId, retryAfterSeconds: 3 })
      return response(command, { type: 'pairing.bound', identity: result.identity })
    }
    case 'user.create': throw new CollaborationServiceError('permission_denied', 'Users are created only by verified OIDC JIT resolution.')
    case 'user.get': return entityResponse(command, toUserPrincipal(await service.getUser(requiredActor(actor), command.userId)))
    case 'user.update': return entityResponse(command, toUserPrincipal(await service.updateUser(requiredUser(actor), command)))
    case 'endpoint.challenge.create': {
      const user = requiredUser(actor)
      if (user.userId !== command.userId) throw new CollaborationServiceError('permission_denied', 'Cannot create another user endpoint challenge.')
      requireAvailableProvider(options.providers, command.expectedIdentity.provider)
      const result = await service.beginPairing({ provider: command.expectedIdentity.provider,
        realmId: command.expectedIdentity.realmId, requestedDisplayName: (await service.getUser(user, user.userId)).displayName,
        idempotencyKey: command.idempotencyKey, requestedBy: user,
        expectedProviderUserId: command.expectedIdentity.providerUserId })
      if (typeof result.challengeCode !== 'string' || typeof result.pollSecret !== 'string') {
        throw new CollaborationServiceError('idempotency_conflict', 'One-time challenge material was already returned.')
      }
      return response(command, { type: 'pairing.begun', challengeId: result.challengeId,
        challengeCode: result.challengeCode, pollSecret: result.pollSecret, expiresAt: result.expiresAt })
    }
    case 'endpoint.bind': throw new CollaborationServiceError('permission_denied', 'Endpoint binding requires a verified provider event.')
    case 'endpoint.transition': return entityResponse(command, toEndpoint(await service.setEndpointStatus(requiredUser(actor), {
      humanEndpointId: command.humanEndpointId, status: command.status, expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey })))
    case 'endpoint.transfer': return entityResponse(command, toEndpoint(await service.transferEndpoint(requiredUser(actor), command)))
    case 'agent.register': {
      const user = requiredUser(actor)
      if (command.ownerUserId !== undefined && user.userId !== command.ownerUserId) {
        throw new CollaborationServiceError('permission_denied', 'Cannot register an Agent for another user.')
      }
      const result = await service.registerAgent(user, command)
      if (!result.deviceCredential) throw new CollaborationServiceError('idempotency_conflict', 'The one-time Agent credential was already returned.')
      return response(command, { type: 'agent.registered', agent: toAgent(result.agent), deviceCredential: result.deviceCredential })
    }
    case 'agent.heartbeat': {
      const device = requiredAgent(actor, command.agentId)
      return entityResponse(command, toAgent(await service.heartbeatAgent(device, command)))
    }
    case 'agent.capability_profile.report': {
      const device = requiredAgent(actor, command.profile.agentId)
      return entityResponse(command, toAgentCapabilityProfile(await service.reportAgentCapabilityProfile(device, {
        ...command.profile,
        expectedRevision: command.expectedProfileRevision === 0 ? undefined : command.expectedProfileRevision,
        idempotencyKey: command.idempotencyKey
      })))
    }
    case 'agent.rotate_credential': {
      const result = await service.rotateAgentCredential(requiredUser(actor), { agentId: command.agentId,
        expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey })
      if (!result.deviceCredential) throw new CollaborationServiceError('idempotency_conflict', 'The rotated credential was already returned.')
      return response(command, { type: 'agent.credential_rotated', agent: toAgent(result.agent), deviceCredential: result.deviceCredential })
    }
    case 'agent.revoke': return entityResponse(command, toAgent(await service.revokeAgent(requiredUser(actor), command)))
    case 'credential.revoke_current': {
      const authenticated = requiredHumanOrAgent(actor)
      await service.revokeCurrentCredential(requiredAgent(authenticated), { idempotencyKey: command.idempotencyKey })
      return receiptResponse(command, authenticated)
    }
    case 'agent.owner.transfer': {
      const result = await service.transferAgentOwnership(requiredUser(actor), command)
      if (!result.deviceCredential) throw new CollaborationServiceError('idempotency_conflict', 'The transferred Agent credential was already returned.')
      return response(command, { type: 'agent.owner_transferred', agent: toAgent(result.agent), deviceCredential: result.deviceCredential })
    }
    case 'participant.get': {
      const snapshot = await service.getParticipantSnapshot(requiredActor(actor), command.userId)
      return response(command, { type: 'participant.snapshot', user: toUserPrincipal(snapshot.user),
        participant: toParticipant(snapshot.participant), humanEndpoints: snapshot.humanEndpoints.map(toEndpoint),
        agents: snapshot.agents.map(toAgent) })
    }
    case 'endpoint.catalog.get': {
      const providers = options.providers?.contracts().filter((contract) => !command.provider || contract.provider === command.provider) ?? []
      return response(command, { type: 'endpoint.catalog', providers })
    }
    case 'endpoint.locator.list': {
      if (!options.providers) throw new CollaborationServiceError('resource_offline', 'No provider directory is running.')
      const page = await options.providers.listLocators({ actor: requiredActor(actor), humanEndpointId: command.humanEndpointId,
        query: command.query, cursor: command.cursor, limit: command.limit })
      return response(command, { type: 'endpoint.locator_page', ...page })
    }
    case 'participant.update_primary': return entityResponse(command, toParticipant(await service.selectPrimary(requiredUser(actor), {
      primaryHumanEndpointId: command.primaryHumanEndpointId,
      primaryAgentId: command.primaryAgentId, expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey })))
    case 'projection.create': {
      const user = requiredUser(actor)
      if (user.userId !== command.ownerUserId) throw new CollaborationServiceError('permission_denied', 'Cannot create another user projection.')
      return entityResponse(command, toProjection(await service.createProjection(user, command)))
    }
    case 'projection.get': return entityResponse(command, toProjection(await service.getProjection(requiredActor(actor), command.projectionId)))
    case 'projection.list': return collectionResponse(command,
      (await service.listProjections(requiredActor(actor), command.ownerUserId)).map(toProjection))
    case 'projection.update': return entityResponse(command, toProjection(await service.updateProjection(requiredUser(actor), command)))
    case 'projection.message.publish': {
      const device = requiredAgent(actor)
      await service.publishProjectionMessage(device, command)
      return receiptResponse(command, device)
    }
    case 'project.create': {
      const user = requiredUser(actor)
      if (user.userId !== command.ownerUserId) throw new CollaborationServiceError('permission_denied', 'Cannot create another user Project.')
      const project = await service.createProject(user, { displayName: command.displayName, goal: command.goal,
        memberUserIds: command.memberUserIds, coordinatorAgentId: command.coordinatorAgentId, budgets: command.budget,
        idempotencyKey: command.idempotencyKey })
      const view = await service.getProject(user, project.projectId)
      return entityResponse(command, toProject(project, view.members))
    }
    case 'project.get': {
      const view = await service.getProject(requiredActor(actor), command.projectId)
      return entityResponse(command, toProject(view.project, view.members))
    }
    case 'project.coordination_view.get': return entityResponse(command,
      toProjectCoordinationView(await service.getProjectCoordinationView(
        requiredHumanOrAgent(actor), command.projectId
      )))
    case 'project.capability_directory.get': return entityResponse(command,
      toProjectCapabilityDirectory(await service.getProjectCapabilityDirectory(requiredHumanOrAgent(actor), command.projectId)))
    case 'project.transition': {
      const project = await service.transitionProject(requiredHumanOrAgent(actor), command)
      const view = await service.getProject(requiredActor(actor), project.projectId)
      return entityResponse(command, toProject(project, view.members))
    }
    case 'project.transfer_coordinator': {
      const project = await service.transferCoordinator(requiredUser(actor), command)
      const view = await service.getProject(requiredActor(actor), project.projectId)
      return entityResponse(command, toProject(project, view.members))
    }
    case 'project.input.create': {
      if (actor?.kind !== 'human_endpoint' || actor.userId !== command.senderUserId || actor.humanEndpointId !== command.sourceHumanEndpointId) {
        throw new CollaborationServiceError('permission_denied', 'Project input sender identity does not match the verified provider actor.')
      }
      return entityResponse(command, toProjectInput(await service.acceptProjectInput(actor, {
        projectId: command.projectId, providerMessageId: command.providerMessageId, text: command.text,
        occurredAt: command.occurredAt, idempotencyKey: command.idempotencyKey
      })))
    }
    case 'project.endpoint.bind': return entityResponse(command, toProjectEndpointBinding(await service.bindProjectEndpoint(requiredUser(actor), {
      projectId: command.projectId, locator: command.locator, expectedRevision: null, idempotencyKey: command.idempotencyKey })))
    case 'project.endpoint.update': {
      return entityResponse(command, toProjectEndpointBinding(await service.updateProjectEndpointBinding(requiredUser(actor), command)))
    }
    case 'project.endpoint.get': return entityResponse(command,
      toProjectEndpointBinding(await service.getProjectEndpointBinding(requiredActor(actor), command.projectId)))
    case 'task.create': return entityResponse(command, toTask(await service.createTask(requiredHumanOrAgent(actor), {
      projectId: command.projectId, assigneeAgentId: command.assigneeAgentId, title: command.title,
      objective: command.objective, completionCriteria: command.completionCriteria, dependencyTaskIds: command.dependencyTaskIds,
      requiredCapabilities: command.requiredCapabilities, resourceRefIds: command.resourceRefIds,
      authorizationRequirements: command.authorizationRequirements,
      expectedProjectRevision: command.expectedRevision, confirmationId: command.confirmationId,
      idempotencyKey: command.idempotencyKey })))
    case 'task.get': return entityResponse(command, toTask(await service.getTask(requiredActor(actor), command.taskId)))
    case 'task.retry': return entityResponse(command, toTask(await service.retryOrReassignTask(requiredHumanOrAgent(actor), {
      taskId: command.taskId, executionId: command.executionId, assigneeAgentId: command.assigneeAgentId,
      expectedRevision: command.expectedRevision, confirmationId: command.confirmationId,
      idempotencyKey: command.idempotencyKey
    })))
    case 'task.transition': {
      const status = command.status === 'running' ? 'in_progress' : command.status === 'succeeded' ? 'completed' : command.status
      if (status === 'offered') throw new CollaborationServiceError('invalid_state_transition', 'Retrying a terminal Task requires task.retry; changing the assignee also requires Project owner confirmation.')
      if (status === 'cancelled') return entityResponse(command,
        toTask(await service.cancelTask(requiredHumanOrAgent(actor), command)))
      return entityResponse(command, toTask(await service.transitionTask(requiredAgent(actor), {
        taskId: command.taskId, executionId: command.executionId, expectedRevision: command.expectedRevision, status,
        ...(command.result ? { result: command.result } : command.resultSummary ? { resultSummary: command.resultSummary } : {}),
        safeFailureCode: command.safeFailureCode, safeFailureSummary: command.safeFailureSummary,
        idempotencyKey: command.idempotencyKey })))
    }
    case 'task.progress.report': return entityResponse(command, toTask(await service.reportTaskProgress(
      requiredAgent(actor), command
    )))
    case 'project_record.submit': return entityResponse(command, toProjectRecord(await service.submitProjectRecord(requiredHumanOrAgent(actor), {
      projectId: command.projectId, kind: command.kind, summary: command.body,
      sourceTaskId: command.sourceTaskId ?? undefined, sourceExecutionId: command.sourceExecutionId ?? undefined,
      sourceRevision: command.sourceRevision, resourceRefIds: command.resourceRefIds,
      idempotencyKey: command.idempotencyKey })))
    case 'project_record.get': return entityResponse(command, toProjectRecord(await service.getProjectRecord(
      requiredHumanOrAgent(actor), command.projectRecordId
    )))
    case 'project_record.accept': return entityResponse(command, toProjectRecord(await service.acceptProjectRecord(requiredHumanOrAgent(actor), command)))
    case 'resource.create': return entityResponse(command, toResourceRef(await service.createResourceRef(
      requiredHumanOrAgent(actor), command
    )))
    case 'resource.get': return entityResponse(command, toResourceRef(await service.getResourceRef(
      requiredActor(actor), command.resourceRefId
    )))
    case 'resource.invalidate': return entityResponse(command, toResourceRef(await service.invalidateResourceRef(
      requiredHumanOrAgent(actor), command
    )))
    case 'resource.transition': return entityResponse(command, toResourceRef(await service.transitionResourceRef(
      requiredHumanOrAgent(actor), command
    )))
    case 'inbox.pull': {
      const authenticated = requiredActor(actor)
      requireRecipientType(authenticated, command.recipientType)
      const page = await service.pullInbox(authenticated, command)
      return response(command, { type: 'rest.inbox_page',
        messages: page.messages.map((message) => toInboxMessage(message, page.ackedSequence)),
        ackedSequence: page.ackedSequence, nextSequence: page.nextSequence })
    }
    case 'inbox.ack': {
      const authenticated = requiredActor(actor)
      const acknowledged = command.throughSequence !== undefined
        ? await service.ackInbox(authenticated, { throughSequence: command.throughSequence,
          idempotencyKey: command.idempotencyKey })
        : await service.ackInboxMessage(authenticated, { inboxMessageId: requiredString(command.inboxMessageId),
          sequence: requiredNumber(command.sequence), idempotencyKey: command.idempotencyKey })
      return response(command, { type: 'inbox.acked', ...acknowledged })
    }
    case 'human.answer': {
      if (actor?.kind !== 'human_endpoint') throw new CollaborationServiceError('permission_denied', 'HumanAnswer requires a verified human endpoint.')
      return entityResponse(command, toHumanAnswer(await service.answerHumanNeeded(actor, command)))
    }
    case 'human.needed.create': return entityResponse(command, toHumanNeeded(await service.createHumanNeeded(requiredAgent(actor), {
      projectId: command.projectId,
      source: command.sourceKind === 'worker'
        ? { kind: 'worker', taskId: requiredString(command.taskId), executionId: requiredString(command.executionId),
          expectedTaskRevision: requiredNumber(command.expectedTaskRevision) }
        : { kind: 'coordinator', sourceInboxMessageId: requiredString(command.sourceInboxMessageId) },
      targetUserId: command.targetUserId, requiredAssurance: command.requiredAssurance,
      prompt: command.prompt, confirmableAction: command.confirmableAction, expiresAt: command.expiresAt,
      idempotencyKey: command.idempotencyKey
    })))
    case 'confirmation.get': return entityResponse(command, toActionConfirmation(await service.getActionConfirmation(
      requiredHumanOrAgent(actor), command.confirmationId
    )))
    case 'receipt.get': {
      const authenticated = requiredActor(actor)
      const receipt = await service.getReceipt(authenticated, command.receiptId)
      if (!receipt) throw new CollaborationServiceError('not_found', 'Receipt was not found.')
      return response(command, { type: 'rest.receipt', receipt: { schemaVersion: 1, type: 'operation.receipt',
        receiptId: receipt.receiptId, actor: contractActor(authenticated), idempotencyKey: receipt.idempotencyKey,
        requestHash: receipt.requestDigest, status: 'succeeded', resultHash: stableDigest(receipt.response),
        createdAt: receipt.createdAt } })
    }
  }
}

function requireAvailableProvider(providers: ProviderDirectory | undefined, provider: string): void {
  if (!providers?.contracts().some((contract) => contract.provider === provider)) {
    throw new CollaborationServiceError('resource_offline', 'The requested Human Endpoint provider is not running.')
  }
}

function response(command: RestRequest, body: Record<string, unknown>): RestResponse {
  return { protocolVersion: '1.0', requestId: command.requestId, ...body } as RestResponse
}
function entityResponse(command: RestRequest, entity: RestResponse extends never ? never : unknown): RestResponse {
  return response(command, { type: 'rest.entity', entity })
}
function collectionResponse(command: RestRequest, items: unknown[]): RestResponse {
  return response(command, { type: 'rest.collection', items })
}
function receiptResponse(command: Extract<RestRequest, { idempotencyKey: string }>, actor: AuthContext): RestResponse {
  return response(command, { type: 'rest.receipt', receipt: { schemaVersion: 1, type: 'operation.receipt',
    receiptId: `rcp_${stableDigest({ actorKey: actor.actorKey, idempotencyKey: command.idempotencyKey }).slice(0, 24)}`,
    actor: contractActor(actor),
    idempotencyKey: command.idempotencyKey, requestHash: stableDigest(command), status: 'succeeded',
    resultHash: stableDigest({ accepted: true }), createdAt: new Date().toISOString() } })
}

function contractActor(actor: AuthContext): Record<string, unknown> {
  switch (actor.kind) {
    case 'system': throw new CollaborationServiceError('permission_denied', 'System actor cannot own a public receipt.')
    case 'user': return { actorType: 'user', userId: actor.userId, assurance: actor.assurance }
    case 'human_endpoint': return { actorType: 'human_endpoint', userId: actor.userId,
      humanEndpointId: actor.humanEndpointId, assurance: actor.assurance }
    case 'agent_device': return { actorType: 'agent', userId: actor.userId, agentId: actor.agentId, assurance: 'strong' }
  }
}

function requiredActor(actor: AuthContext | null): AuthContext {
  if (!actor) throw new CollaborationServiceError('authentication_required', 'Authentication is required.')
  return actor
}
function requiredUser(actor: AuthContext | null): UserActor {
  if (actor?.kind !== 'user') throw new CollaborationServiceError('permission_denied', 'An authenticated OIDC User actor is required.')
  return actor
}
function requiredAgent(actor: AuthContext | null, expectedAgentId?: string): AgentActor {
  if (actor?.kind !== 'agent_device' || (expectedAgentId && actor.agentId !== expectedAgentId)) {
    throw new CollaborationServiceError('permission_denied', 'The matching Agent device credential is required.')
  }
  return actor
}
function requiredHumanOrAgent(actor: AuthContext | null): UserActor | AgentActor {
  if (actor?.kind !== 'user' && actor?.kind !== 'agent_device') {
    throw new CollaborationServiceError('permission_denied', 'A user or Agent credential is required.')
  }
  return actor
}

function requireRecipientType(actor: AuthContext, recipientType: 'user' | 'agent'): void {
  if (actor.kind === 'system' || (actor.kind === 'agent_device') !== (recipientType === 'agent')) {
    throw new CollaborationServiceError('recipient_mismatch',
      'Inbox recipientType does not match the authenticated credential.')
  }
}

function requiredString(value: string | undefined): string {
  if (value === undefined) {
    throw new CollaborationServiceError('validation_failed', 'The strict command is missing required source identity.')
  }
  return value
}

function requiredNumber(value: number | undefined): number {
  if (value === undefined) {
    throw new CollaborationServiceError('validation_failed', 'The strict command is missing required source revision or sequence.')
  }
  return value
}

function requireJson(request: IncomingMessage): void {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new CollaborationServiceError('validation_failed', 'Content-Type must be application/json.')
  }
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.byteLength
    if (length > maxBodyBytes) throw new CollaborationServiceError('payload_too_large', 'Command body is too large.')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new CollaborationServiceError('validation_failed', 'Command body must be valid JSON.') }
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') return ''
  const normalized = `/${value.replace(/^\/+|\/+$/g, '')}`
  if (!/^\/[A-Za-z0-9/_-]*$/.test(normalized)) throw new Error('Invalid collaboration server base path.')
  return normalized
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sendFailure(
  response: ServerResponse,
  error: unknown,
  context: { requestId?: string; expectedRevision?: number } = {}
): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const serviceError = error instanceof CollaborationServiceError
    ? error
    : error instanceof ZodError
      ? new CollaborationServiceError('validation_failed', 'The strict collaboration schema rejected this request or response.')
      : new CollaborationServiceError('internal_error', 'The collaboration server could not complete the request.', { retryable: true })
  const codeMap = {
    validation_failed: 'validation_error', budget_exhausted: 'invalid_state_transition',
    resource_offline: 'provider_unavailable', request_expired: 'expired'
  } as const
  const code = codeMap[serviceError.code as keyof typeof codeMap] ?? serviceError.code
  const requestId = context.requestId ?? `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const traceId = `trc_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const currentRevision = safeRevision(serviceError.details?.currentRevision)
  const currentExecutionId = safeOpaqueId(serviceError.details?.currentExecutionId, 'exe')
  const confirmationId = safeOpaqueId(serviceError.details?.confirmationId, 'cnf')
  const ackedSequence = safeSequence(serviceError.details?.ackedSequence, true)
  const nextSequence = safeSequence(serviceError.details?.nextSequence, false)
  const errorBody = createCollaborationError(
    code as Parameters<typeof createCollaborationError>[0],
    serviceError.message,
    {
      requestId,
      traceId,
      ...(context.expectedRevision === undefined ? {} : { expectedRevision: context.expectedRevision }),
      ...(currentRevision === undefined ? {} : { currentRevision }),
      ...(currentExecutionId === undefined ? {} : { currentExecutionId }),
      ...(confirmationId === undefined ? {} : { confirmationId }),
      ...(ackedSequence === undefined ? {} : { ackedSequence }),
      ...(nextSequence === undefined ? {} : { nextSequence })
    }
  )
  sendJson(response, errorBody.httpStatus, { protocolVersion: '1.0', type: 'rest.error',
    requestId, error: errorBody })
}

function safeRevision(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : undefined
}

function safeSequence(value: unknown, allowZero: boolean): number | undefined {
  const minimum = allowZero ? 0 : 1
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : undefined
}

function safeOpaqueId(value: unknown, prefix: 'exe' | 'cnf'): string | undefined {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{12,64}$`, 'u').test(value)
    ? value
    : undefined
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
  response.end(JSON.stringify(body))
}

function sendConsoleAsset(response: ServerResponse, asset: CollaborationConsoleAsset, headOnly: boolean): void {
  response.writeHead(200, {
    'content-type': asset.contentType,
    'content-length': String(Buffer.byteLength(asset.body)),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  })
  response.end(headOnly ? undefined : asset.body)
}

type AnonymousBootstrapCommand = Extract<RestRequest, { type: 'endpoint.catalog.get' }>

function isAnonymousBootstrapCommand(command: RestRequest): command is AnonymousBootstrapCommand {
  return command.type === 'endpoint.catalog.get'
}

const ANONYMOUS_BOOTSTRAP_LIMITS = {
  'endpoint.catalog.get': 120
} as const

class AnonymousBootstrapLimiter {
  private readonly buckets = new Map<string, { windowStartedAt: number; count: number }>()
  private readonly now: () => Date
  constructor(now: (() => Date) | undefined) { this.now = now ?? (() => new Date()) }
  consume(remoteAddress: string, operation: AnonymousBootstrapCommand['type']): void {
    const current = this.now().getTime()
    const key = `${operation}:${remoteAddress}`
    const bucket = this.buckets.get(key)
    if (!bucket || current - bucket.windowStartedAt >= 10 * 60_000) {
      if (!bucket && this.buckets.size >= 10_000) {
        for (const [candidate, value] of this.buckets) {
          if (current - value.windowStartedAt >= 10 * 60_000) this.buckets.delete(candidate)
        }
        if (this.buckets.size >= 10_000) {
          throw new CollaborationServiceError('rate_limited', 'Too many anonymous bootstrap attempts; retry later.', { retryable: true })
        }
      }
      this.buckets.set(key, { windowStartedAt: current, count: 1 })
      return
    }
    if (bucket.count >= ANONYMOUS_BOOTSTRAP_LIMITS[operation]) {
      throw new CollaborationServiceError('rate_limited', 'Too many anonymous bootstrap attempts; retry later.', { retryable: true })
    }
    bucket.count += 1
  }
}
