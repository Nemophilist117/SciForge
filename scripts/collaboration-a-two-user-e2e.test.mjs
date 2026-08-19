import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const enabled = process.env.SCIFORGE_COLLAB_A_E2E === '1'

function configurationFailure(code) {
  const error = new Error('The acceptance configuration is not safe to run.')
  error.code = code
  throw error
}

function requireFreshTwoUserConfiguration() {
  const projectStream = process.env.SCIFORGE_COLLAB_ZULIP_STREAM?.trim()
  const ownerPairingStream = process.env.SCIFORGE_COLLAB_ZULIP_A_PAIRING_STREAM?.trim()
  const memberPairingStream = process.env.SCIFORGE_COLLAB_ZULIP_B_PAIRING_STREAM?.trim()
  const secretOutputDirectory = process.env.SCIFORGE_COLLAB_ZULIP_SECRET_OUTPUT_DIR?.trim()
  if (!projectStream || !ownerPairingStream || !memberPairingStream || !secretOutputDirectory) {
    configurationFailure('ACCEPTANCE_CONFIGURATION_MISSING')
  }
  if (ownerPairingStream === memberPairingStream || ownerPairingStream === projectStream ||
      memberPairingStream === projectStream) {
    configurationFailure('PAIRING_STREAM_ISOLATION_REQUIRED')
  }
  const forbiddenSuffixes = [
    'USER_ID',
    'HUMAN_ENDPOINT_ID',
    'AGENT_ID',
    'USER_CREDENTIAL',
    'USER_CREDENTIAL_FILE',
    'DEVICE_CREDENTIAL',
    'DEVICE_CREDENTIAL_FILE'
  ]
  if (['A', 'B'].some((slot) => forbiddenSuffixes.some((suffix) => (
    typeof process.env[`SCIFORGE_COLLAB_ZULIP_${slot}_${suffix}`] === 'string' &&
    process.env[`SCIFORGE_COLLAB_ZULIP_${slot}_${suffix}`].trim()
  )))) {
    configurationFailure('FRESH_PAIRING_REQUIRED')
  }
  for (const slot of ['A', 'B']) {
    const inlineApiKey = process.env[`SCIFORGE_COLLAB_ZULIP_${slot}_API_KEY`]?.trim()
    const apiKeyFile = process.env[`SCIFORGE_COLLAB_ZULIP_${slot}_API_KEY_FILE`]?.trim()
    if (inlineApiKey || !apiKeyFile) configurationFailure('ZULIP_API_KEY_FILE_REQUIRED')
  }
  return Object.freeze({ projectStream, ownerPairingStream, memberPairingStream })
}

async function step(label, operation) {
  try {
    const value = await operation()
    process.stdout.write(`a-acceptance:${label}:ok\n`)
    return value
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : 'UNCLASSIFIED_FAILURE'
    throw new Error(`${label} failed (${code})`)
  }
}

test('A private acceptance: two paired users complete routing, human, resource, retry and revocation flows', {
  skip: enabled ? false : 'set SCIFORGE_COLLAB_A_E2E=1 to run against the provider-enabled A service'
}, async () => {
  await step('configuration-gate', async () => requireFreshTwoUserConfiguration())
  const driverPath = process.env.SCIFORGE_COLLAB_A_DRIVER ||
    fileURLToPath(new URL('./collaboration-zulip-acceptance-driver.mjs', import.meta.url))
  const module = await step('driver-load', () => import(pathToFileURL(driverPath).href))
  assert.equal(typeof module.createZulipAcceptanceDriver, 'function')
  const driver = module.createZulipAcceptanceDriver({
    environment(name) {
      return process.env[name]
    },
    report() {
      process.stdout.write('a-acceptance:progress\n')
    }
  })
  await step('secret-output-directory', () => driver.validateSecretOutputDirectory())

  const owner = await step('owner-pairing', () => driver.bindParticipant({ slot: 'A', requireFreshPairing: true }))
  const member = await step('member-pairing', () => driver.bindParticipant({ slot: 'B', requireFreshPairing: true }))
  assert.notEqual(owner.userId, member.userId)
  assert.notEqual(owner.endpointId, member.endpointId)
  assert.notEqual(owner.agentId, member.agentId)

  const project = await step('project-create', () => driver.createProject({
    owner,
    members: [owner, member],
    coordinator: owner,
    label: 'A-两用户真实验收'
  }))
  const directory = await step('capability-directory', () => driver.inspectCapabilityDirectory({
    participant: owner,
    project,
    expectedParticipants: [owner, member]
  }))
  assert.equal(directory.agents.length, 2)

  const offlineTask = await step('offline-inbox-replay', () => driver.verifyOfflineInboxReplay({
    coordinator: owner,
    project,
    participant: member
  }))
  assert.equal(offlineTask.status, 'cancelled')

  const task = await step('main-task-create', () => driver.createTask({
    coordinator: owner,
    project,
    assignee: member,
    label: '公开接口主闭环'
  }))
  const offer = await step('main-task-route', () => driver.awaitUniqueTaskOffer({ participant: member, task }))
  let running = await step('main-task-start', () => driver.startTask({ participant: member, offer }))
  running = await step('main-progress-20-idempotent', () => driver.reportTaskProgressIdempotently({
    participant: member,
    task: running,
    percent: 20,
    summary: '已完成输入校验'
  }))
  const resource = await step('main-task-resource', () => driver.createTaskResource({
    participant: member,
    project,
    task: running,
    label: '验收证据摘要'
  }))
  assert.equal(resource.status, 'available')

  const humanNeeded = await step('main-task-human-needed', () => driver.createHumanNeededForTask({
    participant: member,
    project,
    task: running,
    target: owner,
    text: '是否允许继续完成本次验收任务？'
  }))
  await step('owner-human-notification', () => driver.awaitHumanNeeded({ participant: owner, humanNeeded }))
  const humanAnswer = await step('owner-human-answer', () => driver.answerHumanNeeded({
    participant: owner,
    humanNeeded,
    text: '允许继续'
  }))
  assert.equal(humanAnswer.answeredByUserId, owner.userId)
  await step('coordinator-human-answer-inbox', () => driver.awaitHumanAnswer({
    coordinator: owner,
    humanNeeded,
    humanAnswer
  }))
  const requesterAnswer = await step('worker-human-answer-inbox', () => driver.awaitRequesterHumanAnswer({
    participant: member,
    humanNeeded
  }))
  assert.equal(requesterAnswer.humanAnswerId, humanAnswer.humanAnswerId)

  running = await step('main-task-resume', () => driver.resumeTaskAfterHuman({ participant: member, humanNeeded }))
  running = await step('main-task-progress-100', () => driver.reportTaskProgress({
    participant: member,
    task: running,
    percent: 100,
    summary: '任务已完成并生成证据摘要'
  }))
  const completed = await step('main-task-result', () => driver.finishTask({
    participant: member,
    task: running,
    result: '公开 API 主业务闭环完成'
  }))
  await step('coordinator-result-inbox', () => driver.awaitTaskResult({
    coordinator: owner,
    task,
    result: { task: completed }
  }))
  const record = await step('task-result-record', () => driver.submitTaskResultRecord({
    participant: member,
    project,
    task: completed,
    body: '任务结果已由真实 Worker 通过公开 API 提交。'
  }))
  const coordinatorRecord = await step('result-read-by-coordinator', () => driver.awaitProjectRecord({
    coordinator: owner,
    record
  }))
  await step('task-result-accept', () => driver.acceptProjectRecord({
    coordinator: owner,
    record: coordinatorRecord
  }))

  const retrySource = await step('retry-task-create', () => driver.createTask({
    coordinator: owner,
    project,
    assignee: member,
    label: '改派并发闭环'
  }))
  const retryOffer = await step('retry-task-route', () => driver.awaitUniqueTaskOffer({
    participant: member,
    task: retrySource
  }))
  let retryRunning = await step('retry-task-start', () => driver.startTask({ participant: member, offer: retryOffer }))
  retryRunning = await step('retry-task-progress', () => driver.reportTaskProgress({
    participant: member,
    task: retryRunning,
    percent: 30,
    summary: '触发可安全重试的测试失败'
  }))
  const failed = await step('retry-task-fail', () => driver.failTask({
    participant: member,
    task: retryRunning,
    safeFailureCode: 'acceptance_retry_required'
  }))
  const reassigned = await step('retry-task-concurrency', () => driver.retryTaskConcurrently({
    coordinator: owner,
    task: failed,
    assignee: owner
  }))
  await step('former-worker-denied', () => driver.assertFormerAssigneeRejected({
    participant: member,
    project,
    task: reassigned
  }))
  const reassignedOffer = await step('reassigned-task-route', () => driver.awaitUniqueTaskOffer({
    participant: owner,
    task: reassigned
  }))
  const reassignedResult = await step('reassigned-task-complete', () => driver.completeTask({
    participant: owner,
    offer: reassignedOffer,
    result: '改派后的唯一新执行者完成任务'
  }))
  await step('reassigned-result-inbox', () => driver.awaitTaskResult({
    coordinator: owner,
    task: reassigned,
    result: reassignedResult
  }))

  const sameAssigneeSource = await step('same-assignee-retry-create', () => driver.createTask({
    coordinator: owner,
    project,
    assignee: member,
    label: '同一 Worker 重试闭环'
  }))
  const sameAssigneeOffer = await step('same-assignee-retry-route', () => driver.awaitUniqueTaskOffer({
    participant: member,
    task: sameAssigneeSource
  }))
  const sameAssigneeRunning = await step('same-assignee-retry-start', () => driver.startTask({
    participant: member,
    offer: sameAssigneeOffer
  }))
  const sameAssigneeFailed = await step('same-assignee-retry-fail', () => driver.failTask({
    participant: member,
    task: sameAssigneeRunning,
    safeFailureCode: 'acceptance_same_worker_retry'
  }))
  const sameAssigneeRetried = await step('same-assignee-retry-concurrency', () => driver.retryTaskConcurrently({
    coordinator: owner,
    task: sameAssigneeFailed,
    assignee: member
  }))
  assert.equal(sameAssigneeRetried.assigneeAgentId, member.agentId)
  const sameAssigneeRetriedOffer = await step('same-assignee-retry-unique-offer', () => (
    driver.awaitUniqueTaskOffer({ participant: member, task: sameAssigneeRetried })
  ))
  const sameAssigneeResult = await step('same-assignee-retry-complete', () => driver.completeTask({
    participant: member,
    offer: sameAssigneeRetriedOffer,
    result: '同一 Worker 以新 attempt 完成重试'
  }))
  await step('same-assignee-retry-result-inbox', () => driver.awaitTaskResult({
    coordinator: owner,
    task: sameAssigneeRetried,
    result: sameAssigneeResult
  }))

  await step('project-complete', () => driver.completeProject({ owner, project }))
  await step('member-agent-credential-revoke', () => driver.revokeCurrentCredential({
    participant: member,
    credentialType: 'agent'
  }))
  await step('member-user-credential-revoke', () => driver.revokeCurrentCredential({
    participant: member,
    credentialType: 'user'
  }))
  const restoredMember = await step('member-credential-restore', () => (
    driver.restoreRevokedParticipantCredentials({ participant: member })
  ))
  assert.equal(restoredMember.userId, member.userId)
  assert.equal(restoredMember.endpointId, member.endpointId)
  assert.equal(restoredMember.agentId, member.agentId)
  assert.equal(restoredMember.online, true)
  assert.match(restoredMember.credentialFiles.user, /^[a-z0-9_.-]+$/u)
  assert.match(restoredMember.credentialFiles.device, /^[a-z0-9_.-]+$/u)
  const identityManifest = await step('identity-manifest', () => (
    driver.writeAcceptanceIdentityManifest({ participants: [owner, member] })
  ))
  assert.equal(identityManifest.participantCount, 2)
  assert.match(identityManifest.manifestFile, /^[a-z0-9_.-]+$/u)
})
