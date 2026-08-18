import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  collaborationErrorSchema,
  inboxMessageSchema,
  restEntitySchema,
  restRequestSchema,
  restResponseSchema
} from '../packages/collaboration-contracts/src/index.ts'
import {
  ARTIFACT_DIRECTORY,
  COMMIT_PLACEHOLDER,
  generateContractArtifactFiles
} from './collaboration-contract-artifacts.mjs'

const documentSchemas = {
  command: restRequestSchema,
  response: restResponseSchema,
  inbox: inboxMessageSchema,
  entity: restEntitySchema,
  error: collaborationErrorSchema
}

test('machine-readable collaboration artifacts are deterministic and current', async () => {
  const first = generateContractArtifactFiles()
  const second = generateContractArtifactFiles()
  assert.deepEqual([...first], [...second])
  for (const [relativePath, expected] of first) {
    assert.equal(await readFile(join(ARTIFACT_DIRECTORY, relativePath), 'utf8'), expected, relativePath)
    assert.doesNotThrow(() => JSON.parse(expected), relativePath)
  }
})

test('manifest hashes every schema, state table, and fixture without claiming business E2E', () => {
  const files = generateContractArtifactFiles()
  const manifest = JSON.parse(files.get('ARTIFACT_MANIFEST.json'))
  assert.equal(manifest.protocolVersion, '1.0')
  assert.equal(manifest.contractCommit, COMMIT_PLACEHOLDER)
  assert.equal(manifest.acceptance.coreOnly.status, 'available')
  assert.equal(manifest.acceptance.businessEndToEnd.status, 'not-open')
  assert.equal(manifest.acceptance.identityProvider.status, 'not-selected')
  assert.equal(manifest.acceptance.formalProductTransport.status, 'not-selected')
  assert.equal(manifest.files.length, files.size - 1)
  for (const entry of manifest.files) {
    const content = files.get(entry.path)
    assert.ok(content, entry.path)
    assert.equal(entry.sha256, createHash('sha256').update(content).digest('hex'), entry.path)
    assert.equal(entry.bytes, Buffer.byteLength(content), entry.path)
  }
})

test('JSON Schemas expose the complete strict public roots and actor table', () => {
  const files = generateContractArtifactFiles()
  for (const path of [
    'schemas/commands.schema.json',
    'schemas/responses.schema.json',
    'schemas/inbox.schema.json',
    'schemas/entities.schema.json',
    'schemas/errors.schema.json'
  ]) {
    const schema = JSON.parse(files.get(path))
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema['x-sciforge-contract'].protocolVersion, '1.0')
  }
  const commands = JSON.parse(files.get('schemas/commands.schema.json')).oneOf
    .map((entry) => entry.properties.type.const).sort()
  const actorTable = JSON.parse(files.get('state-and-actors.json'))
  const permissions = actorTable.permissions
    .map((entry) => entry.command).sort()
  assert.deepEqual(permissions, commands)
  assert.ok(commands.includes('task.create'))
  assert.ok(commands.includes('inbox.ack'))

  const permissionByCommand = new Map(actorTable.permissions.map((entry) => [entry.command, entry]))
  assert.equal(permissionByCommand.has('pairing.verify'), false)
  assert.deepEqual(permissionByCommand.get('pairing.begin').actors, ['user'])
  assert.deepEqual(permissionByCommand.get('pairing.redeem').actors, ['user'])
  assert.deepEqual(permissionByCommand.get('endpoint.catalog.get').actors, ['anonymous'])
  assert.deepEqual(permissionByCommand.get('credential.revoke_current').actors, ['agent'])
  assert.equal(permissionByCommand.get('credential.revoke_current').availability, 'current')
  assert.deepEqual(permissionByCommand.get('endpoint.challenge.create').actors, [])
  assert.equal(permissionByCommand.get('endpoint.challenge.create').availability, 'reserved')
  assert.deepEqual(permissionByCommand.get('endpoint.bind').actors, [])
  assert.equal(permissionByCommand.get('endpoint.bind').availability, 'reserved')
  assert.deepEqual(permissionByCommand.get('user.create').actors, [])
  assert.equal(permissionByCommand.get('user.create').availability, 'reserved')
  assert.deepEqual(permissionByCommand.get('task.create').authorizationModes, [
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'initial_assignment' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'tasks.create', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'initial_assignment' }
  ])
  assert.deepEqual(permissionByCommand.get('task.retry').authorizationModes, [
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'same_assignee_retry_or_reassign' },
    { actor: 'agent', authority: 'current_coordinator', confirmation: 'not_required', decisionAuthority: 'current_coordinator', scope: 'same_assignee_terminal_retry' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'task.retry_reassign', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'different_assignee_reassign' }
  ])
  assert.deepEqual(permissionByCommand.get('task.transition').authorizationModes, [
    { actor: 'agent', authority: 'current_assignee', confirmation: 'not_applicable', decisionAuthority: 'current_assignee', scope: 'execution_transition' },
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'cancel_only' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'task.cancel', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'cancel_only' }
  ])
  assert.deepEqual(permissionByCommand.get('project.transition').authorizationModes, [
    { actor: 'user', authority: 'project_owner', confirmation: 'owner_direct', decisionAuthority: 'project_owner', scope: 'permitted_project_transition' },
    { actor: 'agent', authority: 'current_coordinator', confirmableActionKind: 'project.complete', confirmation: 'required', decisionAuthority: 'project_owner', scope: 'completed_only' }
  ])

  assert.deepEqual(actorTable.stateTransitions.task.succeeded, ['offered'])
  assert.deepEqual(actorTable.stateTransitions.task.failed, ['offered'])
  assert.deepEqual(actorTable.stateTransitions.task.rejected, ['offered'])
  assert.ok(actorTable.stateTransitions.task.running.includes('offered'))
  assert.deepEqual(actorTable.stateTransitions.resource_ref.unavailable, ['available', 'revoked'])
  assert.deepEqual(actorTable.stateTransitions.resource_ref.revoked, ['available', 'unavailable'])
  assert.deepEqual(actorTable.stateTransitions.resource_ref.invalidated, [])
})

test('machine schemas distinguish command input defaults from normalized entity output', () => {
  const files = generateContractArtifactFiles()
  const commands = JSON.parse(files.get('schemas/commands.schema.json'))
  const responses = JSON.parse(files.get('schemas/responses.schema.json'))
  const entities = JSON.parse(files.get('schemas/entities.schema.json'))
  for (const [name, variants] of [
    ['command', strictObjectVariants(commands.oneOf)],
    ['response', strictObjectVariants(responses.oneOf)],
    ['entity', strictObjectVariants(entities.anyOf)]
  ]) {
    assert.ok(variants.length > 0, `${name} root variants`)
    for (const variant of variants) {
      assert.equal(variant.additionalProperties, false,
        `${name} ${variant.properties?.type?.const ?? '<unknown>'} must reject unknown properties`)
    }
  }

  const capabilityReport = commands.oneOf.find(
    (entry) => entry.properties?.type?.const === 'agent.capability_profile.report'
  )
  assert.ok(capabilityReport, 'agent.capability_profile.report command schema')
  assert.equal(capabilityReport.additionalProperties, false)
  assert.equal(capabilityReport.properties.profile.additionalProperties, false)
  assert.equal(capabilityReport.properties.profile.required.includes('gpu'), false,
    'the input command may omit gpu because Zod defaults it to []')
  assert.deepEqual(capabilityReport.properties.profile.properties.gpu.default, [])

  const commandWithoutGpu = {
    protocolVersion: '1.0',
    requestId: 'req_Capability01',
    type: 'agent.capability_profile.report',
    idempotencyKey: 'idem_contract_fixture_capability-without-gpu',
    expectedProfileRevision: 0,
    profile: {
      agentId: 'agt_Agent0000001',
      ownerUserId: 'usr_User00000001',
      nodeType: 'personal_computer',
      os: { family: 'macos', architecture: 'arm64' },
      runtimeIds: ['runtime.default'],
      capabilities: [],
      vpnAccessIds: [],
      slurmClusterIds: [],
      accessibleResourceRefIds: [],
      resultReturnPolicy: {
        summary: true,
        evidenceRefs: true,
        resourceRefs: true,
        logSummary: true,
        fullFileRequiresConfirmation: true,
        fullLogRequiresConfirmation: true
      },
      reportedAt: '2026-08-15T08:00:00.000Z',
      expiresAt: '2026-08-15T09:00:00.000Z'
    }
  }
  const normalizedCommand = restRequestSchema.parse(commandWithoutGpu)
  assert.deepEqual(normalizedCommand.profile.gpu, [])

  const capabilityProfile = entities.anyOf.find(
    (entry) => entry.properties?.type?.const === 'agent_capability_profile'
  )
  assert.ok(capabilityProfile, 'agent_capability_profile entity schema')
  assert.equal(capabilityProfile.additionalProperties, false)
  assert.ok(capabilityProfile.required.includes('gpu'),
    'normalized capability profile output must always contain gpu')
})

function strictObjectVariants(variants) {
  return variants.flatMap((variant) => {
    if (Array.isArray(variant.oneOf)) return strictObjectVariants(variant.oneOf)
    if (Array.isArray(variant.anyOf)) return strictObjectVariants(variant.anyOf)
    return [variant]
  })
}

test('fixtures cover required compatibility and ordering scenarios with valid public documents', () => {
  const files = generateContractArtifactFiles()
  const fixtures = [...files.entries()]
    .filter(([path]) => path.startsWith('fixtures/'))
    .map(([, content]) => JSON.parse(content))
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.category)), new Set([
    'normal',
    'duplicate',
    'out-of-order',
    'revision-conflict',
    'idempotency-conflict',
    'execution-conflict',
    'confirmation-conflict'
  ]))
  for (const fixture of fixtures) {
    assert.equal(fixture.protocolVersion, '1.0')
    for (const document of fixture.documents) {
      assert.doesNotThrow(() => documentSchemas[document.schema].parse(document.value),
        `${fixture.id}:${document.role}`)
    }
  }
  const outOfOrder = fixtures.find((fixture) => fixture.category === 'out-of-order')
  assert.equal(outOfOrder.contractStatus, 'current')
  const gapResponse = outOfOrder.documents.find((document) => document.role === 'gap-response').value
  assert.equal(gapResponse.error.code, 'inbox_ack_gap')
  assert.equal(gapResponse.error.ackedSequence, 11)
  assert.equal(gapResponse.error.nextSequence, 12)
  assert.deepEqual(outOfOrder.expectations.serverCursorAtGap, { ackedSequence: 11, nextSequence: 12 })
  assert.equal(fixtures.find((fixture) => fixture.category === 'execution-conflict').contractStatus, 'current')
  assert.equal(fixtures.find((fixture) => fixture.category === 'confirmation-conflict').contractStatus, 'current')
})

test('release generation can inject one fixed commit without changing the source artifact set', () => {
  const commit = 'a'.repeat(40)
  const files = generateContractArtifactFiles(commit)
  const manifest = JSON.parse(files.get('ARTIFACT_MANIFEST.json'))
  assert.equal(manifest.contractCommit, commit)
  for (const [path, content] of files) {
    if (path === 'ARTIFACT_MANIFEST.json') continue
    assert.equal(content.includes(COMMIT_PLACEHOLDER), false, path)
  }
})
