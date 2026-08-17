import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acceptanceEnvironmentContract,
  createZulipAcceptanceDriver
} from './collaboration-zulip-acceptance-driver.mjs'

const requiredMethods = [
  'validateSecretOutputDirectory',
  'bindParticipant',
  'createPersonalProjection',
  'sendMobileMessage',
  'awaitDesktopTurn',
  'replyFromAgent',
  'awaitMobileMessage',
  'sendDesktopMessage',
  'setAgentOnline',
  'createProject',
  'sendProjectInput',
  'awaitProjectInput',
  'createTask',
  'awaitTaskOffer',
  'awaitUniqueTaskOffer',
  'verifyOfflineInboxReplay',
  'inspectCapabilityDirectory',
  'startTask',
  'reportTaskProgress',
  'reportTaskProgressIdempotently',
  'createTaskResource',
  'createHumanNeededForTask',
  'awaitRequesterHumanAnswer',
  'resumeTaskAfterHuman',
  'finishTask',
  'submitTaskResultRecord',
  'awaitProjectRecord',
  'acceptProjectRecord',
  'failTask',
  'retryTaskConcurrently',
  'assertFormerAssigneeRejected',
  'completeTask',
  'awaitTaskResult',
  'createHumanNeeded',
  'awaitHumanNeeded',
  'assertNoHumanNeeded',
  'answerHumanNeeded',
  'awaitHumanAnswer',
  'handoffCoordinator',
  'createTaskAsAgent',
  'completeProject',
  'revokeCurrentCredential',
  'restoreRevokedParticipantCredentials',
  'writeAcceptanceIdentityManifest'
]

test('real Zulip acceptance adapter exposes the complete driver contract without reading credentials at import', async () => {
  const values = new Map([
    ['SCIFORGE_COLLAB_ZULIP_SERVER_URL', 'https://collaboration.example.invalid/collaboration'],
    ['SCIFORGE_COLLAB_ZULIP_REALM_URL', 'https://zulip.example.invalid'],
    ['SCIFORGE_COLLAB_ZULIP_STREAM', '验收'],
    ['SCIFORGE_COLLAB_ZULIP_BOT_EMAIL', 'collaboration-bot@example.invalid'],
    ['SCIFORGE_COLLAB_ZULIP_SECRET_OUTPUT_DIR', '/not-read-at-import']
  ])
  const driver = createZulipAcceptanceDriver({ environment: (name) => values.get(name) })
  for (const method of requiredMethods) assert.equal(typeof driver[method], 'function')
  await assert.rejects(driver.bindParticipant({ slot: 'A' }), (error) => {
    assert.equal(error?.code, 'ACCEPTANCE_CONFIGURATION_MISSING')
    assert.doesNotMatch(error.message, /credential|secret|token|api.?key/iu)
    return true
  })
})

test('environment contract publishes names and placeholders only', () => {
  const serialized = JSON.stringify(acceptanceEnvironmentContract)
  assert.match(serialized, /<SLOT>/u)
  assert.match(serialized, /SECRET_OUTPUT_DIR/u)
  assert.doesNotMatch(serialized, /Bearer\s+|Basic\s+|-----BEGIN/u)
})

test('secret output directory must be an owned non-symlink directory with mode 0700', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'sciforge-acceptance-dir-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const secureDirectory = join(root, 'secure')
  const permissiveDirectory = join(root, 'permissive')
  const linkedDirectory = join(root, 'linked')
  await mkdir(secureDirectory, { mode: 0o700 })
  await chmod(secureDirectory, 0o700)
  await mkdir(permissiveDirectory, { mode: 0o755 })
  await chmod(permissiveDirectory, 0o755)
  await symlink(secureDirectory, linkedDirectory)

  const base = new Map([
    ['SCIFORGE_COLLAB_ZULIP_SERVER_URL', 'https://collaboration.example.invalid/collaboration'],
    ['SCIFORGE_COLLAB_ZULIP_REALM_URL', 'https://zulip.example.invalid'],
    ['SCIFORGE_COLLAB_ZULIP_STREAM', '验收'],
    ['SCIFORGE_COLLAB_ZULIP_BOT_EMAIL', 'collaboration-bot@example.invalid']
  ])
  const create = (directory) => createZulipAcceptanceDriver({
    environment(name) {
      return name === 'SCIFORGE_COLLAB_ZULIP_SECRET_OUTPUT_DIR' ? directory : base.get(name)
    }
  })

  assert.deepEqual(await create(secureDirectory).validateSecretOutputDirectory(), { ready: true })
  await assert.rejects(create(permissiveDirectory).validateSecretOutputDirectory(), {
    code: 'SECRET_OUTPUT_DIRECTORY_PERMISSION_REJECTED'
  })
  await assert.rejects(create(linkedDirectory).validateSecretOutputDirectory(), {
    code: 'SECRET_OUTPUT_DIRECTORY_PERMISSION_REJECTED'
  })
})
