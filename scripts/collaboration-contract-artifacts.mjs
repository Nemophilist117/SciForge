#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import {
  STATE_TRANSITIONS,
  PORTABLE_RESOURCE_CARRIER_SCHEMA_VERSION,
  collaborationErrorSchema,
  createCollaborationError,
  inboxMessageSchema,
  restEntitySchema,
  restRequestSchema,
  restResponseSchema
} from '../packages/collaboration-contracts/src/index.ts'
import {
  ARTIFACT_REFERENCE_KIND,
  CONTENT_CONTAINER_REFERENCE_KIND,
  CONTENT_FILE_REFERENCE_KIND,
  toPortableArtifactReference,
  toPortableContentContainerReference,
  toPortableContentFileReference
} from '../packages/domains/content-space/src/contract.ts'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
export const ARTIFACT_DIRECTORY = join(
  repositoryRoot,
  'packages/collaboration-contracts/artifacts/protocol-1.0'
)
export const COMMIT_PLACEHOLDER = '__SCIFORGE_COLLABORATION_COMMIT__'
const PROTOCOL_VERSION = '1.0'
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const COLLABORATION_CONTRACTS_PACKAGE_VERSION = '0.1.0'
const DOMAIN_SDK_PACKAGE_VERSION = '0.2.1'
const CONTENT_SPACE_PACKAGE_VERSION = '1.0.0'
const DATABASE_SCHEMA_VERSION = 6
const PORTABLE_REFERENCE_UPSTREAM_COMMIT = 'e58ed48e94812d0c56da48ab7387f53135439cc5'
const PORTABLE_REFERENCE_PARSER_SHA256 = 'af402fbb108a02588c9af7a684146ff12fe0bf48f35b534c4b5f3f233e5d650d'
const CONTENT_SPACE_CONTRACT_SHA256 = '5d7a0967591c8b1e33c207fb41d4429374a9b6f9c761a3c9e2395ea146c53e3d'
const PORTABLE_CONTENT_SPACE_REFERENCE_KINDS = Object.freeze([
  CONTENT_FILE_REFERENCE_KIND,
  CONTENT_CONTAINER_REFERENCE_KIND,
  ARTIFACT_REFERENCE_KIND
])
const TEST_TIMESTAMP = '2026-08-15T08:00:00.000Z'
const TEST_IDS = Object.freeze({
  userId: 'usr_User00000001',
  secondUserId: 'usr_User00000002',
  agentId: 'agt_Agent0000001',
  secondAgentId: 'agt_Agent0000002',
  projectId: 'prj_Proj00000001',
  taskId: 'tsk_Task00000001',
  executionId: 'exe_Execution0001',
  previousExecutionId: 'exe_Execution0000',
  criterionId: 'cri_Criterion0001',
  inboxMessageId: 'ibx_Inbox0000001',
  confirmationId: 'cnf_Confirm000001',
  traceId: 'trc_Trace00000001'
})
const projectFixture = Object.freeze({
  schemaVersion: 1,
  type: 'project',
  projectId: TEST_IDS.projectId,
  ownerUserId: TEST_IDS.userId,
  displayName: 'Contract fixture Project',
  goal: 'Validate the public collaboration contract without private module state.',
  memberUserIds: [TEST_IDS.userId, TEST_IDS.secondUserId],
  coordinatorAgentId: TEST_IDS.agentId,
  status: 'active',
  budget: {
    maxTasks: 20,
    maxTasksPerRound: 4,
    maxCoordinationRounds: 10,
    maxTaskRetries: 2
  },
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})
const taskFixture = Object.freeze({
  schemaVersion: 1,
  type: 'task',
  taskId: TEST_IDS.taskId,
  projectId: TEST_IDS.projectId,
  executionId: TEST_IDS.executionId,
  createdByCoordinatorAgentId: TEST_IDS.agentId,
  assigneeAgentId: TEST_IDS.secondAgentId,
  assigneeUserId: TEST_IDS.secondUserId,
  title: 'Validate one bounded result',
  objective: 'Return a safe result through the public A contract.',
  completionCriteria: [{ criterionId: TEST_IDS.criterionId, text: 'Return a safe summary.' }],
  dependencyTaskIds: [],
  requiredCapabilities: {
    capabilityIds: [],
    vpnAccessIds: [],
    slurmClusterIds: [],
    requiredResourceRefIds: []
  },
  resourceRefIds: [],
  authorizationRequirements: [],
  status: 'offered',
  attempt: 1,
  maxRetries: 2,
  revision: 1,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})
const agentInboxMessageFixture = Object.freeze({
  schemaVersion: 1,
  type: 'inbox_message',
  inboxMessageId: TEST_IDS.inboxMessageId,
  recipientType: 'agent',
  recipientAgentId: TEST_IDS.agentId,
  sequence: 1,
  status: 'pending',
  disposition: 'active',
  createdAt: TEST_TIMESTAMP,
  payload: {
    protocolVersion: PROTOCOL_VERSION,
    type: 'task.offered',
    projectId: TEST_IDS.projectId,
    taskId: TEST_IDS.taskId,
    executionId: TEST_IDS.executionId,
    revision: 1
  }
})

const actorDefinitions = Object.freeze({
  anonymous: 'No credential; limited to public Provider catalog discovery.',
  user: 'A stable human principal resolved from a strictly verified OIDC access token.',
  agent: 'A registered SciForge node resolved from its Agent credential and linked ACTIVE Device.',
  human_endpoint: 'A verified Provider gateway identity; not a caller-supplied Bearer actor.',
  system: 'A service-internal actor that is not available through the public command endpoint.'
})

const permissionGroups = [
  permission(['endpoint.catalog.get'], ['anonymous'], 'Only the non-sensitive Provider catalog is public.'),
  permission(['pairing.begin', 'pairing.redeem'], ['user'],
    'The OIDC User adapter uses the authoritative Zulip binding state and never creates a User or issues a User credential.'),
  permission(['project.input.create', 'human.answer'], ['human_endpoint'],
    'Only the verified Provider gateway may create this actor context.', 'provider-dependent'),
  permission(['user.create', 'endpoint.challenge.create', 'endpoint.bind'], [],
    'The legacy strict command shape is reserved, but the public HTTP boundary permanently rejects direct use.', 'reserved'),
  permission(['user.get', 'user.update'], ['user'], 'The credential userId must equal the target userId.'),
  permission(['endpoint.transition', 'endpoint.transfer'], ['user'],
    'The user must own the Human Endpoint; lifecycle and assurance rules apply.'),
  permission(['agent.register'], ['user'],
    'deviceId must reference an ACTIVE Device owned by the OIDC User; ownerUserId, if present, is non-authoritative and must match.'),
  permission(['agent.heartbeat', 'agent.capability_profile.report'], ['agent'],
    'The credential agentId and owner must match the target Agent; capability evidence remains bounded metadata.'),
  permission(['agent.rotate_credential', 'agent.owner.transfer', 'agent.revoke'], ['user'],
    'The user must own the Agent; transfer and revocation assurance rules apply.'),
  permission(['credential.revoke_current'], ['agent'],
    'Only the opaque Agent credential used for this request is revoked; OIDC User token logout and revocation remain issuer-managed.'),
  permission(['participant.get', 'participant.update_primary'], ['user'],
    'The credential userId must equal the Participant userId.'),
  permission(['endpoint.locator.list'], ['user'], 'The user must own the active Human Endpoint.', 'provider-dependent'),
  permission(['projection.create', 'projection.get', 'projection.list', 'projection.update'], ['user'],
    'The user must own the projection and all referenced endpoints/agents.'),
  permission(['projection.message.publish'], ['agent'], 'The Agent must own the active projection.'),
  permission(['project.create'], ['user'], 'The authenticated user becomes Project owner.'),
  permission(['project.get', 'project.capability_directory.get', 'project.endpoint.get'], ['user', 'agent'],
    'The actor must belong to an active Project member.'),
  permission(['project.coordination_view.get'], ['user', 'agent'],
    'Only the Project owner User or current Coordinator Agent may read the consolidated coordination view.'),
  permission(['project.transfer_coordinator', 'project.endpoint.bind', 'project.endpoint.update'], ['user'],
    'Only the Project owner may perform this administrative write.'),
  permission(['project.transition'], ['user', 'agent'],
    'The Project owner User may directly perform a permitted transition. The current Coordinator Agent may only complete the Project with a matching one-time project.complete confirmation; the Owner remains the business decision authority.', 'current', [
      authorizationMode('user', 'project_owner', 'owner_direct', 'permitted_project_transition'),
      authorizationMode('agent', 'current_coordinator', 'required', 'completed_only', 'project.complete', 'project_owner')
    ]),
  permission(['task.create'], ['user', 'agent'],
    'The Project owner User may directly authorize the initial assignment. The current Coordinator Agent is only the delegated technical caller and requires a matching one-time tasks.create confirmation from the Owner.', 'current', [
      authorizationMode('user', 'project_owner', 'owner_direct', 'initial_assignment'),
      authorizationMode('agent', 'current_coordinator', 'required', 'initial_assignment', 'tasks.create', 'project_owner')
    ]),
  permission(['task.get'], ['user', 'agent'], 'The actor must belong to an active Project member.'),
  permission(['task.retry'], ['user', 'agent'],
    'The Project owner User may directly retry or reassign. The current Coordinator Agent may directly retry the same assignee from succeeded, failed, or rejected; changing assignee requires a matching one-time task.retry_reassign confirmation from the Owner.', 'current', [
      authorizationMode('user', 'project_owner', 'owner_direct', 'same_assignee_retry_or_reassign'),
      authorizationMode('agent', 'current_coordinator', 'not_required', 'same_assignee_terminal_retry'),
      authorizationMode('agent', 'current_coordinator', 'required', 'different_assignee_reassign', 'task.retry_reassign', 'project_owner')
    ]),
  permission(['task.transition'], ['user', 'agent'],
    'Execution facts require the current assignee Agent. Cancellation may be called directly by the Project owner User, or delegated to the current Coordinator Agent only with a matching one-time task.cancel confirmation; the Owner remains the business decision authority.', 'current', [
      authorizationMode('agent', 'current_assignee', 'not_applicable', 'execution_transition'),
      authorizationMode('user', 'project_owner', 'owner_direct', 'cancel_only'),
      authorizationMode('agent', 'current_coordinator', 'required', 'cancel_only', 'task.cancel', 'project_owner')
    ]),
  permission(['task.progress.report'], ['agent'], 'Only the current assignee of a running Task may report progress.'),
  permission(['project_record.submit'], ['user', 'agent'],
    'The actor must be an active member; a Worker Agent must cite its assigned Task.'),
  permission(['project_record.get'], ['user', 'agent'], 'The actor must belong to an active Project member.'),
  permission(['project_record.accept'], ['user', 'agent'],
    'The owner may decide all record kinds; the current Coordinator Agent is limited to worker-result record kinds.'),
  permission(['resource.create', 'resource.invalidate', 'resource.transition'], ['user', 'agent'],
    'The actor must be an active member; Worker writes require the current active Task assignment.'),
  permission(['resource.get'], ['user', 'agent'], 'The actor must belong to an active Project member.'),
  permission(['inbox.pull', 'inbox.ack'], ['user', 'agent'], 'The credential selects the Inbox; recipient IDs cannot be self-reported.'),
  permission(['human.needed.create'], ['agent'],
    'The current Worker or current Coordinator creates a bounded request with matching source provenance.'),
  permission(['confirmation.get'], ['user', 'agent'],
    'The actor must be authorized for the confirmation Project and action context.'),
  permission(['receipt.get'], ['user', 'agent'], 'The receipt must belong to the authenticated actor.')
]

function authorizationMode(
  actor,
  authority,
  confirmation,
  scope,
  confirmableActionKind,
  decisionAuthority = authority
) {
  return Object.freeze({
    actor,
    authority,
    decisionAuthority,
    confirmation,
    scope,
    ...(confirmableActionKind ? { confirmableActionKind } : {})
  })
}

function permission(commands, actors, condition, availability = 'current', authorizationModes = []) {
  return Object.freeze({
    commands: Object.freeze(commands),
    actors: Object.freeze(actors),
    condition,
    availability,
    authorizationModes: Object.freeze(authorizationModes)
  })
}

function jsonSchemaDocument(name, schema, io) {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io
  })
  return {
    ...generated,
    $id: `https://contracts.sciforge.invalid/collaboration/1.0/${name}.schema.json`,
    title: `SciForge Collaboration ${name}`,
    'x-sciforge-contract': {
      protocolVersion: PROTOCOL_VERSION,
      contractCommit: COMMIT_PLACEHOLDER
    }
  }
}

function requestId(suffix) {
  return `req_${suffix.padEnd(12, '0')}`
}

function idempotencyKey(suffix) {
  return `idem_contract_fixture_${suffix}`
}

function parseDocument(schemaName, value) {
  const schemas = {
    command: restRequestSchema,
    response: restResponseSchema,
    inbox: inboxMessageSchema,
    entity: restEntitySchema,
    error: collaborationErrorSchema
  }
  const schema = schemas[schemaName]
  if (!schema) throw new Error(`Unknown fixture document schema: ${schemaName}`)
  return schema.parse(value)
}

function parseFirst(schema, candidates, label) {
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  throw new Error(`No ${label} fixture candidate matches the current strict contract.`)
}

function document(role, schema, value) {
  return { role, schema, value: parseDocument(schema, value) }
}

function errorResponse(request, code, message, fields = {}) {
  return restResponseSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: 'rest.error',
    requestId: request.requestId,
    error: createCollaborationError(code, message, {
      requestId: request.requestId,
      traceId: TEST_IDS.traceId,
      ...fields
    })
  })
}

function taskUpdatedInbox({ sequence, revision, status = 'running' }) {
  const base = {
    ...agentInboxMessageFixture,
    inboxMessageId: `ibx_Fixture${String(sequence).padStart(8, '0')}`,
    sequence,
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      type: 'task.updated',
      projectId: TEST_IDS.projectId,
      taskId: TEST_IDS.taskId,
      revision,
      status
    }
  }
  return parseFirst(inboxMessageSchema, [
    { ...base, payload: { ...base.payload, executionId: TEST_IDS.executionId } },
    base
  ], 'task.updated Inbox')
}

function fixture(id, category, documents, expectations, contractStatus = 'current') {
  return {
    fixtureVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    contractCommit: COMMIT_PLACEHOLDER,
    id,
    category,
    contractStatus,
    documents,
    expectations
  }
}

function buildFixtures() {
  const taskCreateBase = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId('normal01'),
    type: 'task.create',
    idempotencyKey: idempotencyKey('normal-task-create'),
    projectId: TEST_IDS.projectId,
    expectedRevision: projectFixture.revision,
    assigneeAgentId: TEST_IDS.secondAgentId,
    title: taskFixture.title,
    objective: taskFixture.objective,
    dependencyTaskIds: []
  }
  const taskCreate = parseFirst(restRequestSchema, [
    { ...taskCreateBase, completionCriteria: taskFixture.completionCriteria },
    { ...taskCreateBase, completionCriteria: taskFixture.completionCriteria.map((criterion) => criterion.text) }
  ], 'task.create command')
  const normalResponse = restResponseSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: 'rest.entity',
    requestId: taskCreate.requestId,
    entity: taskFixture
  })
  const taskOfferBase = {
    ...agentInboxMessageFixture,
    recipientAgentId: TEST_IDS.secondAgentId,
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      type: 'task.offered',
      projectId: TEST_IDS.projectId,
      taskId: TEST_IDS.taskId,
      revision: taskFixture.revision
    }
  }
  const taskOffer = parseFirst(inboxMessageSchema, [
    { ...taskOfferBase, payload: { ...taskOfferBase.payload, executionId: TEST_IDS.executionId } },
    taskOfferBase
  ], 'task.offered Inbox')

  const firstProgress = restRequestSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId('duplicate01'),
    type: 'task.progress.report',
    idempotencyKey: idempotencyKey('duplicate-progress'),
    taskId: TEST_IDS.taskId,
    executionId: TEST_IDS.executionId,
    expectedRevision: 3,
    percent: 50,
    summary: 'Half of the bounded work is complete.'
  })
  const duplicateProgress = restRequestSchema.parse({ ...firstProgress, requestId: requestId('duplicate02') })

  const staleRevision = restRequestSchema.parse({
    ...firstProgress,
    requestId: requestId('revision01'),
    idempotencyKey: idempotencyKey('revision-conflict'),
    expectedRevision: 2
  })
  const revisionError = errorResponse(staleRevision, 'revision_conflict',
    'The Task revision is no longer current.', { expectedRevision: 2, currentRevision: 4 })

  const idempotencyOriginal = restRequestSchema.parse({
    ...firstProgress,
    requestId: requestId('idempotency1'),
    idempotencyKey: idempotencyKey('conflicting-payload')
  })
  const idempotencyChanged = restRequestSchema.parse({
    ...idempotencyOriginal,
    requestId: requestId('idempotency2'),
    percent: 60,
    summary: 'A different payload must not reuse the original key.'
  })
  const idempotencyError = errorResponse(idempotencyChanged, 'idempotency_conflict',
    'The idempotency key is already bound to another payload.')

  const staleExecution = restRequestSchema.parse({
    ...firstProgress,
    requestId: requestId('execution01'),
    idempotencyKey: idempotencyKey('stale-execution'),
    executionId: TEST_IDS.previousExecutionId
  })
  const executionError = errorResponse(staleExecution, 'execution_conflict',
    'The Task execution is no longer current.', { currentExecutionId: TEST_IDS.executionId, currentRevision: 4 })

  const mismatchedConfirmation = restRequestSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId('confirmation'),
    type: 'task.retry',
    idempotencyKey: idempotencyKey('confirmation-mismatch'),
    taskId: TEST_IDS.taskId,
    executionId: TEST_IDS.executionId,
    assigneeAgentId: TEST_IDS.agentId,
    expectedRevision: 4,
    confirmationId: TEST_IDS.confirmationId
  })
  const confirmationError = errorResponse(mismatchedConfirmation, 'confirmation_mismatch',
    'The confirmation does not match this immutable action.', { confirmationId: TEST_IDS.confirmationId })

  const ack13Before12 = restRequestSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId('ackgap13'),
    type: 'inbox.ack',
    idempotencyKey: idempotencyKey('ack-gap-13'),
    inboxMessageId: 'ibx_Fixture00000013',
    sequence: 13
  })
  const ackGapError = errorResponse(ack13Before12, 'inbox_ack_gap',
    'Inbox ACK cannot pass an unfinished active message.', { ackedSequence: 11, nextSequence: 12 })
  const ack12 = restRequestSchema.parse({
    ...ack13Before12,
    requestId: requestId('ackseq12'),
    idempotencyKey: idempotencyKey('ack-sequence-12'),
    inboxMessageId: 'ibx_Fixture00000012',
    sequence: 12
  })
  const acked12 = restResponseSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId: ack12.requestId,
    type: 'inbox.acked',
    ackedSequence: 12,
    nextSequence: 13
  })
  const ack13 = restRequestSchema.parse({
    ...ack13Before12,
    requestId: requestId('ackseq13'),
    idempotencyKey: idempotencyKey('ack-sequence-13')
  })
  const acked13 = restResponseSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId: ack13.requestId,
    type: 'inbox.acked',
    ackedSequence: 13,
    nextSequence: 14
  })

  const portableCases = [
    {
      id: 'portable-input-file-reference',
      label: 'R0 input file',
      externalId: 'opencontent_input_file_001',
      envelope: toPortableContentFileReference({
        providerInstanceRef: 'opencontent.owner-input',
        fileId: 'opencontent_input_file_001'
      })
    },
    {
      id: 'portable-output-container-reference',
      label: 'R0 output container',
      externalId: 'opencontent_output_container_001',
      envelope: toPortableContentContainerReference({
        providerInstanceRef: 'opencontent.worker-output',
        containerId: 'opencontent_output_container_001'
      })
    },
    {
      id: 'portable-uploaded-mutable-file-reference',
      label: 'R0 uploaded mutable file',
      externalId: 'opencontent_uploaded_mutable_file_001',
      envelope: toPortableContentFileReference({
        providerInstanceRef: 'opencontent.worker-output',
        fileId: 'opencontent_uploaded_mutable_file_001'
      })
    },
    {
      id: 'portable-artifact-digest-boundary',
      label: 'R0 immutable artifact',
      externalId: 'opencontent_uploaded_artifact_001',
      envelope: toPortableArtifactReference({
        providerInstanceRef: 'opencontent.worker-output',
        fileId: 'opencontent_uploaded_artifact_001',
        immutableVersionId: 'immutable_version_001',
        digest: { algorithm: 'sha256', value: 'f'.repeat(64) }
      })
    },
    {
      id: 'portable-reference-without-open-url',
      label: 'R0 reference with no deep link',
      externalId: 'opencontent_no_open_url_001',
      envelope: toPortableContentFileReference({
        providerInstanceRef: 'opencontent.no-deep-link',
        fileId: 'opencontent_no_open_url_001'
      })
    },
    {
      id: 'portable-reference-maximum-length',
      label: 'R0 maximum reference boundary',
      externalId: `f${'b'.repeat(255)}`,
      envelope: toPortableContentFileReference({
        providerInstanceRef: `p${'a'.repeat(255)}`,
        fileId: `f${'b'.repeat(255)}`
      })
    }
  ].map((value, index) => {
    const resourceRefId = `rrf_PortableR0${String(index + 1).padStart(2, '0')}`
    const create = restRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(`portable${index + 1}`),
      type: 'resource.create',
      idempotencyKey: idempotencyKey(value.id),
      projectId: TEST_IDS.projectId,
      taskId: TEST_IDS.taskId,
      executionId: TEST_IDS.executionId,
      expectedTaskRevision: 3,
      provider: 'opencontent',
      externalId: value.externalId,
      kind: value.envelope.kind,
      name: value.label,
      portableReference: value.envelope,
      version: '1'
    })
    const entity = restEntitySchema.parse({
      schemaVersion: 1,
      type: 'resource_ref',
      resourceRefId,
      projectId: TEST_IDS.projectId,
      taskId: TEST_IDS.taskId,
      executionId: TEST_IDS.executionId,
      taskRevision: 3,
      createdByUserId: TEST_IDS.secondUserId,
      createdByAgentId: TEST_IDS.secondAgentId,
      provider: 'opencontent',
      externalId: value.externalId,
      kind: value.envelope.kind,
      name: value.label,
      openUrl: null,
      portableReference: value.envelope,
      version: '1',
      status: 'available',
      statusReasonCode: null,
      unavailableAt: null,
      revokedAt: null,
      invalidatedAt: null,
      revision: 1,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP
    })
    const created = restResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: 'rest.entity',
      requestId: create.requestId,
      entity
    })
    const get = restRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(`portableget${index + 1}`),
      type: 'resource.get',
      resourceRefId
    })
    const fetched = restResponseSchema.parse({
      ...created,
      requestId: get.requestId
    })
    return fixture(value.id, 'portable-round-trip', [
      document('create-request', 'command', create),
      document('create-response', 'response', created),
      document('get-request', 'command', get),
      document('get-response', 'response', fetched)
    ], {
      accepted: true,
      openUrl: null,
      canonicalPortableReference: value.envelope,
      losslessAfterCreateGet: true
    })
  })

  const validPortable = portableCases[0].expectations.canonicalPortableReference
  const invalidPortableRequest = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId('portablebad'),
    type: 'resource.create',
    idempotencyKey: idempotencyKey('portable-invalid'),
    projectId: TEST_IDS.projectId,
    taskId: TEST_IDS.taskId,
    executionId: TEST_IDS.executionId,
    expectedTaskRevision: 3,
    provider: 'opencontent',
    externalId: 'invalid-portable-reference',
    kind: 'content-space.file-reference',
    name: 'Rejected portable reference',
    version: '1'
  }
  const portableRejectionResponse = errorResponse(
    { requestId: invalidPortableRequest.requestId },
    'validation_error',
    'The portable resource reference is invalid.'
  )

  return [
    fixture('normal-task-offer', 'normal', [
      document('request', 'command', taskCreate),
      document('response', 'response', normalResponse),
      document('delivery', 'inbox', taskOffer)
    ], {
      accepted: true,
      durableEffects: ['task-created', 'single-task-offered-message']
    }),
    fixture('duplicate-idempotent-replay', 'duplicate', [
      document('original-request', 'command', firstProgress),
      document('replay-request', 'command', duplicateProgress)
    ], {
      accepted: true,
      sameBusinessReceipt: true,
      duplicateDomainWrites: 0,
      note: 'requestId may change; actor, idempotency key, and business payload do not.'
    }),
    fixture('out-of-order-inbox-completion', 'out-of-order', [
      document('sequence-12', 'inbox', taskUpdatedInbox({ sequence: 12, revision: 4 })),
      document('sequence-13', 'inbox', taskUpdatedInbox({ sequence: 13, revision: 5 })),
      document('premature-ack-13', 'command', ack13Before12),
      document('gap-response', 'response', ackGapError),
      document('continuous-ack-12', 'command', ack12),
      document('cursor-after-ack-12', 'response', acked12),
      document('continuous-ack-13', 'command', ack13),
      document('server-cursor-after-ack-13', 'response', acked13)
    ], {
      localCompletionOrder: [13, 12],
      permittedAckOrder: [12, 13],
      forbiddenAckUntilGapClosed: [13],
      gapErrorCode: 'inbox_ack_gap',
      serverCursorAtGap: { ackedSequence: 11, nextSequence: 12 },
      authoritativeAckSequenceAfterCompletion: 13,
      note: 'This is the normative enforced continuous-ACK scenario: sequence 13 is rejected until active sequence 12 is complete.'
    }),
    fixture('revision-conflict', 'revision-conflict', [
      document('request', 'command', staleRevision),
      document('response', 'response', revisionError)
    ], {
      accepted: false,
      rereadRequired: true,
      retryWithSameIdempotencyKey: false
    }),
    fixture('idempotency-conflict', 'idempotency-conflict', [
      document('original-request', 'command', idempotencyOriginal),
      document('conflicting-request', 'command', idempotencyChanged),
      document('response', 'response', idempotencyError)
    ], {
      accepted: false,
      originalReceiptUnchanged: true
    }),
    fixture('stale-execution-write', 'execution-conflict', [
      document('stale-request', 'command', staleExecution),
      document('response', 'response', executionError)
    ], {
      taskId: TEST_IDS.taskId,
      priorExecutionId: TEST_IDS.previousExecutionId,
      currentExecutionId: TEST_IDS.executionId,
      attemptedOperations: ['task.progress.report', 'resource.create', 'task.transition'],
      expectedErrorCode: 'execution_conflict',
      accepted: false
    }),
    fixture('superseded-confirmation', 'confirmation-conflict', [
      document('mismatched-action-request', 'command', mismatchedConfirmation),
      document('response', 'response', confirmationError)
    ], {
      confirmationId: TEST_IDS.confirmationId,
      approvedActionDigest: 'a'.repeat(64),
      attemptedActionDigest: 'b'.repeat(64),
      expectedErrorCode: 'confirmation_mismatch',
      accepted: false
    }),
    ...portableCases,
    fixture('portable-invalid-version-kind', 'portable-rejection', [
      document('response', 'response', portableRejectionResponse)
    ], {
      accepted: false,
      expectedErrorCode: 'validation_error',
      rejectedRequests: [
        { ...invalidPortableRequest, portableReference: { ...validPortable, contractVersion: 2 } },
        { ...invalidPortableRequest, portableReference: {
          ...validPortable,
          kind: 'content-space.unknown-reference'
        } }
      ]
    })
  ]
}

function commandTypes(schemaDocument) {
  return schemaDocument.oneOf.map((entry) => entry.properties.type.const).sort()
}

function flattenPermissionRows() {
  return permissionGroups.flatMap((group) => group.commands.map((command) => ({
    command,
    actors: group.actors,
    condition: group.condition,
    availability: group.availability,
    ...(group.authorizationModes.length > 0 ? { authorizationModes: group.authorizationModes } : {})
  }))).sort((left, right) => left.command.localeCompare(right.command))
}

function stringify(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, sortObject(nested)]))
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function resolveCommit(value = process.env.SCIFORGE_COLLAB_CONTRACT_COMMIT ?? COMMIT_PLACEHOLDER) {
  if (value !== COMMIT_PLACEHOLDER && !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error('Contract commit must be a lowercase 40-character Git SHA or the documented injection placeholder.')
  }
  return value
}

function injectCommit(value, commit) {
  return JSON.parse(JSON.stringify(value).replaceAll(COMMIT_PLACEHOLDER, commit))
}

export function generateContractArtifactFiles(commitInput) {
  const commit = resolveCommit(commitInput)
  const schemas = {
    'schemas/commands.schema.json': jsonSchemaDocument('commands', restRequestSchema, 'input'),
    'schemas/responses.schema.json': jsonSchemaDocument('responses', restResponseSchema, 'output'),
    'schemas/inbox.schema.json': jsonSchemaDocument('inbox', inboxMessageSchema, 'output'),
    'schemas/entities.schema.json': jsonSchemaDocument('entities', restEntitySchema, 'output'),
    'schemas/errors.schema.json': jsonSchemaDocument('errors', collaborationErrorSchema, 'output')
  }
  const commandSchema = schemas['schemas/commands.schema.json']
  const permissionRows = flattenPermissionRows()
  const declaredCommands = commandTypes(commandSchema)
  const permissionCommands = permissionRows.map((row) => row.command).sort()
  if (JSON.stringify(declaredCommands) !== JSON.stringify(permissionCommands)) {
    throw new Error('The generated actor permission table does not cover the exact public command union.')
  }

  const files = new Map()
  for (const [path, value] of Object.entries(schemas)) files.set(path, stringify(injectCommit(value, commit)))
  files.set('state-and-actors.json', stringify({
    artifactVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    contractCommit: commit,
    actors: actorDefinitions,
    permissions: permissionRows,
    stateTransitions: STATE_TRANSITIONS
  }))
  for (const value of buildFixtures()) {
    files.set(`fixtures/${value.id}.json`, stringify(injectCommit(value, commit)))
  }
  const describedFiles = [...files.entries()].map(([path, content]) => ({
    path,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content)
  })).sort((left, right) => left.path.localeCompare(right.path))
  files.set('ARTIFACT_MANIFEST.json', stringify({
    artifactVersion: 1,
    contractVersion: PROTOCOL_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    contractCommit: commit,
    commitInjectionPlaceholder: COMMIT_PLACEHOLDER,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    source: 'packages/collaboration-contracts/src strict Zod exports',
    packages: {
      '@sciforge/collaboration-contracts': COLLABORATION_CONTRACTS_PACKAGE_VERSION,
      '@sciforge/domain-sdk': DOMAIN_SDK_PACKAGE_VERSION,
      '@sciforge/domain-content-space': CONTENT_SPACE_PACKAGE_VERSION
    },
    databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
    portableResourceCarrier: {
      schemaVersion: PORTABLE_RESOURCE_CARRIER_SCHEMA_VERSION,
      upstreamRepository: 'SCU-areszhang/SciForge_Loop',
      upstreamCommit: PORTABLE_REFERENCE_UPSTREAM_COMMIT,
      upstreamParserPath: 'packages/domain-sdk/src/portable-resource-references.ts',
      parserSourceSha256: PORTABLE_REFERENCE_PARSER_SHA256,
      contentSpaceContractPath: 'packages/domains/content-space/src/contract.ts',
      contentSpaceContractSourceSha256: CONTENT_SPACE_CONTRACT_SHA256,
      validationAuthority: '@sciforge/domain-sdk/portable-resource-references',
      kinds: PORTABLE_CONTENT_SPACE_REFERENCE_KINDS,
      openUrlRequired: false
    },
    files: describedFiles,
    acceptance: {
      coreOnly: {
        status: 'available',
        proves: ['schema-generation', 'fixture-validation', 'loopback-transport', 'healthz', 'readyz', 'provider-catalog-boundary', 'anonymous-error-boundary'],
        doesNotProve: ['pairing', 'agent-registration', 'project-task-business-loop', 'formal-product-end-to-end']
      },
      identityProvider: { status: 'not-selected' },
      formalProductTransport: { status: 'not-selected' },
      businessEndToEnd: { status: 'not-open' }
    }
  }))
  return files
}

async function writeArtifacts(files) {
  for (const [relativePath, content] of files) {
    const path = join(ARTIFACT_DIRECTORY, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}

async function checkArtifacts(files) {
  const mismatches = []
  let actualFiles = []
  try {
    actualFiles = (await readdir(ARTIFACT_DIRECTORY, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(ARTIFACT_DIRECTORY, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .sort()
  } catch {
    mismatches.push('artifact directory: missing')
  }
  const expectedFiles = [...files.keys()].sort()
  for (const path of actualFiles.filter((path) => !files.has(path))) mismatches.push(`${path}: unexpected`)
  for (const path of expectedFiles.filter((path) => !actualFiles.includes(path))) mismatches.push(`${path}: missing`)
  for (const [relativePath, expected] of files) {
    const path = join(ARTIFACT_DIRECTORY, relativePath)
    let actual
    try {
      actual = await readFile(path, 'utf8')
    } catch {
      continue
    }
    if (actual !== expected) mismatches.push(`${relativePath}: stale`)
  }
  if (mismatches.length > 0) {
    throw new Error(`Collaboration contract artifacts are not current:\n${mismatches.join('\n')}`)
  }
}

function parseArguments(argv) {
  let mode
  let commit
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write' || argument === '--check') {
      if (mode) throw new Error('Choose exactly one of --write or --check.')
      mode = argument.slice(2)
      continue
    }
    if (argument === '--commit') {
      commit = argv[index + 1]
      if (!commit) throw new Error('--commit requires a value.')
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (!mode) throw new Error('Choose exactly one of --write or --check.')
  return { mode, commit }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const files = generateContractArtifactFiles(options.commit)
  if (options.mode === 'write') await writeArtifacts(files)
  else await checkArtifacts(files)
  process.stdout.write(`Collaboration contract artifacts ${options.mode === 'write' ? 'generated' : 'verified'} for protocol ${PROTOCOL_VERSION}.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
