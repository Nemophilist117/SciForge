import { randomUUID } from 'node:crypto'
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  restRequestSchema,
  restResponseSchema,
  webSocketMessageSchema
} from '@sciforge/collaboration-contracts'
import { WebSocket } from 'ws'

// Optional server-conformance harness only. Participant API keys must belong to
// dedicated QA identities, never ordinary team members; owner-controlled 0600
// files are the preferred source. This driver does not start or substitute for
// the latest SciForge desktop client.
const PARTICIPANT_SLOTS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F'])
const PROTOCOL_VERSION = '1.0'
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_NEGATIVE_WINDOW_MS = 5_000
const MAX_SECRET_BYTES = 4_096
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const ZULIP_MESSAGES_PATH = ['api', 'v1', 'messages'].join('/')
const ZULIP_SELF_PATH = ['api', 'v1', 'users', 'me'].join('/')
const ZULIP_USERS_PATH = ['api', 'v1', 'users'].join('/')
const ZULIP_SUBSCRIPTIONS_PATH = ['api', 'v1', 'users', 'me', 'subscriptions'].join('/')

export const acceptanceEnvironmentContract = Object.freeze({
  common: Object.freeze([
    'SCIFORGE_COLLAB_ZULIP_SERVER_URL',
    'SCIFORGE_COLLAB_ZULIP_REALM_URL',
    'SCIFORGE_COLLAB_ZULIP_STREAM',
    'SCIFORGE_COLLAB_ZULIP_BOT_EMAIL',
    'SCIFORGE_COLLAB_ZULIP_SECRET_OUTPUT_DIR'
  ]),
  optionalCommon: Object.freeze([
    'SCIFORGE_COLLAB_ZULIP_PAIRING_TOPIC',
    'SCIFORGE_COLLAB_ZULIP_ORIGIN',
    'SCIFORGE_COLLAB_ZULIP_TIMEOUT_MS',
    'SCIFORGE_COLLAB_ZULIP_NEGATIVE_WINDOW_MS'
  ]),
  perParticipant: Object.freeze([
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_EMAIL',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_API_KEY or ..._API_KEY_FILE',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_PAIRING_STREAM (optional; defaults to the Project stream)',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_PAIRING_TOPIC (optional; defaults to the common pairing topic)'
  ]),
  optionalExistingBinding: Object.freeze([
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_USER_ID',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_HUMAN_ENDPOINT_ID',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_AGENT_ID',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_USER_CREDENTIAL or ..._USER_CREDENTIAL_FILE',
    'SCIFORGE_COLLAB_ZULIP_<SLOT>_DEVICE_CREDENTIAL or ..._DEVICE_CREDENTIAL_FILE'
  ])
})

class AcceptanceDriverError extends Error {
  constructor(code, details = {}) {
    super('The external acceptance operation did not complete.')
    this.name = 'AcceptanceDriverError'
    this.code = code
    if (Number.isSafeInteger(details.expectedRevision) && details.expectedRevision >= 1) {
      this.expectedRevision = details.expectedRevision
    }
    if (Number.isSafeInteger(details.currentRevision) && details.currentRevision >= 1) {
      this.currentRevision = details.currentRevision
    }
  }
}

function fail(code) {
  throw new AcceptanceDriverError(code)
}

function required(value, code = 'ACCEPTANCE_CONFIGURATION_MISSING') {
  if (typeof value !== 'string' || !value.trim()) fail(code)
  return value.trim()
}

function normalizedBaseUrl(value, code) {
  let parsed
  try {
    parsed = new URL(required(value, code))
  } catch {
    fail(code)
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) fail('INSECURE_ENDPOINT_REJECTED')
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '')
  return parsed.toString().replace(/\/$/u, '')
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('ACCEPTANCE_CONFIGURATION_INVALID')
  }
  return parsed
}

function opaque(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`
}

function idempotency(label) {
  return `idem_acceptance_${label}_${randomUUID().replaceAll('-', '')}`.slice(0, 128)
}

function topicBootstrapCommand(runId) {
  // Keep topic discovery races non-executable: the provider classifies this as an answer,
  // while the random nonexistent request is rejected by the canonical service.
  return `sciforge-answer ${opaque('hrq')} 1 acceptance-bootstrap-${runId}`
}

function request(command) {
  const candidate = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: opaque('req'),
    ...command
  }
  const parsed = restRequestSchema.safeParse(candidate)
  if (!parsed.success) fail('DRIVER_CONTRACT_INVALID')
  return parsed.data
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeText(value) {
  return String(value)
    .replace(/^<p>|<\/p>$/gu, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function canonicalZulipUserId(value) {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' ? value.trim()
      : ''
  if (!/^[1-9][0-9]*$/u.test(candidate)) fail('ZULIP_RESPONSE_INVALID')
  return candidate
}

async function readSecret(environment, name) {
  const inline = environment(name)
  const fileName = environment(`${name}_FILE`)
  if (inline && fileName) fail('SECRET_SOURCE_AMBIGUOUS')
  if (inline) return required(inline)
  const path = required(fileName)
  let info
  try {
    info = await lstat(path)
  } catch {
    fail('SECRET_FILE_UNAVAILABLE')
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SECRET_BYTES ||
      (info.mode & 0o777) !== 0o600) {
    fail('SECRET_FILE_PERMISSION_REJECTED')
  }
  try {
    return required(await readFile(path, 'utf8'), 'SECRET_FILE_UNAVAILABLE')
  } catch (error) {
    if (error instanceof AcceptanceDriverError) throw error
    fail('SECRET_FILE_UNAVAILABLE')
  }
}

function safeReport(report, label) {
  if (typeof report !== 'function' || !/^[a-z][a-z0-9.-]{0,63}$/u.test(label)) return
  report(label)
}

function collaborationCode(code) {
  if (typeof code !== 'string') return 'COLLABORATION_REQUEST_FAILED'
  return `COLLABORATION_${code.toUpperCase()}`.replace(/[^A-Z0-9_]/gu, '_')
}

function participantPrefix(slot) {
  if (!PARTICIPANT_SLOTS.includes(slot)) fail('PARTICIPANT_SLOT_INVALID')
  return `SCIFORGE_COLLAB_ZULIP_${slot}`
}

function exactTopic(locator, topic) {
  return locator?.provider === 'zulip' && locator.topicDisplayName === topic
}

function configuredSecretBasename(environment, name) {
  const fileName = environment(`${name}_FILE`)
  return typeof fileName === 'string' && fileName.trim() ? basename(fileName.trim()) : null
}

async function validatePrivateDirectory(directory) {
  let info
  try {
    info = await lstat(required(directory))
  } catch (error) {
    if (error instanceof AcceptanceDriverError) throw error
    fail('SECRET_OUTPUT_DIRECTORY_UNAVAILABLE')
  }
  const processUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (processUid !== undefined && info.uid !== processUid)) {
    fail('SECRET_OUTPUT_DIRECTORY_PERMISSION_REJECTED')
  }
  return directory
}

async function assertPathAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    fail('SECRET_ARTIFACT_WRITE_FAILED')
  }
  fail('SECRET_ARTIFACT_ALREADY_EXISTS')
}

async function writePrivateArtifact(directory, fileName, contents) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,159}$/u.test(fileName) || typeof contents !== 'string' || !contents) {
    fail('SECRET_ARTIFACT_INVALID')
  }
  const validatedDirectory = await validatePrivateDirectory(directory)
  const target = join(validatedDirectory, fileName)
  const temporaryName = `.${fileName}.${opaque('tmp')}`
  const temporary = join(validatedDirectory, temporaryName)
  try {
    await assertPathAbsent(target)
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE })
    const temporaryInfo = await lstat(temporary)
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() ||
        (temporaryInfo.mode & 0o777) !== PRIVATE_FILE_MODE) {
      fail('SECRET_ARTIFACT_PERMISSION_REJECTED')
    }
    await link(temporary, target)
    await unlink(temporary)
    const targetInfo = await lstat(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() ||
        (targetInfo.mode & 0o777) !== PRIVATE_FILE_MODE) {
      fail('SECRET_ARTIFACT_PERMISSION_REJECTED')
    }
    return fileName
  } catch (error) {
    await unlink(temporary).catch(() => {})
    if (error instanceof AcceptanceDriverError) throw error
    fail(error?.code === 'EEXIST' ? 'SECRET_ARTIFACT_ALREADY_EXISTS' : 'SECRET_ARTIFACT_WRITE_FAILED')
  }
}

export function createZulipAcceptanceDriver({ environment, report } = {}) {
  if (typeof environment !== 'function') fail('ACCEPTANCE_CONFIGURATION_MISSING')

  const serverUrl = normalizedBaseUrl(environment('SCIFORGE_COLLAB_ZULIP_SERVER_URL'), 'ACCEPTANCE_CONFIGURATION_MISSING')
  const realmUrl = normalizedBaseUrl(environment('SCIFORGE_COLLAB_ZULIP_REALM_URL'), 'ACCEPTANCE_CONFIGURATION_MISSING')
  const stream = required(environment('SCIFORGE_COLLAB_ZULIP_STREAM'))
  const botEmail = required(environment('SCIFORGE_COLLAB_ZULIP_BOT_EMAIL')).toLocaleLowerCase('en-US')
  const pairingTopic = environment('SCIFORGE_COLLAB_ZULIP_PAIRING_TOPIC')?.trim() || 'SciForge 配对'
  const origin = environment('SCIFORGE_COLLAB_ZULIP_ORIGIN')?.trim()
  const timeoutMs = boundedInteger(environment('SCIFORGE_COLLAB_ZULIP_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS, 5_000, 600_000)
  const negativeWindowMs = boundedInteger(
    environment('SCIFORGE_COLLAB_ZULIP_NEGATIVE_WINDOW_MS'),
    DEFAULT_NEGATIVE_WINDOW_MS,
    1_000,
    30_000
  )
  const secretOutputDirectory = environment('SCIFORGE_COLLAB_ZULIP_SECRET_OUTPUT_DIR')?.trim()
  const runId = randomUUID().replaceAll('-', '').slice(0, 12)

  const participantStates = new Map()
  const projectionStates = new Map()
  const projectStates = new Map()
  const projectRecordStates = new Map()
  const humanStates = new Map()
  const outboundTexts = new Map()
  let botProviderUserId

  async function collaborationCommand(token, command) {
    const body = request(command)
    const headers = {
      'content-type': 'application/json'
    }
    if (token) headers.authorization = `Bearer ${token}`
    if ('idempotencyKey' in body) headers['idempotency-key'] = body.idempotencyKey
    let response
    try {
      response = await fetch(new URL('v1/commands', `${serverUrl}/`), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      fail('COLLABORATION_TRANSPORT_FAILED')
    }
    let raw
    try {
      raw = await response.json()
    } catch {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    const parsed = restResponseSchema.safeParse(raw)
    if (!parsed.success) fail('COLLABORATION_RESPONSE_INVALID')
    if (parsed.data.type === 'rest.error') {
      throw new AcceptanceDriverError(collaborationCode(parsed.data.error.code), {
        expectedRevision: parsed.data.error.expectedRevision,
        currentRevision: parsed.data.error.currentRevision
      })
    }
    if (!response.ok) fail('COLLABORATION_REQUEST_FAILED')
    return parsed.data
  }

  async function zulipRequest(state, path, { method = 'GET', form, query } = {}) {
    const url = new URL(path.replace(/^\//u, ''), `${realmUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    let response
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${state.email}:${state.zulipApiKey}`, 'utf8').toString('base64')}`,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      fail('ZULIP_TRANSPORT_FAILED')
    }
    let body
    try {
      body = await response.json()
    } catch {
      fail('ZULIP_RESPONSE_INVALID')
    }
    if (!response.ok || body?.result !== 'success') fail('ZULIP_REQUEST_FAILED')
    return body
  }

  async function sendZulipMessage(state, topic, text, streamName = stream) {
    const body = await zulipRequest(state, ZULIP_MESSAGES_PATH, {
      method: 'POST',
      form: { type: 'stream', to: required(streamName), topic, content: text }
    })
    if ((typeof body.id !== 'number' && typeof body.id !== 'string') || !String(body.id).trim()) {
      fail('ZULIP_RESPONSE_INVALID')
    }
    return String(body.id)
  }

  async function listZulipMessages(state, topic, streamName = stream) {
    const body = await zulipRequest(state, ZULIP_MESSAGES_PATH, {
      query: {
        anchor: 'newest',
        num_before: 1_000,
        num_after: 0,
        apply_markdown: 'false',
        narrow: JSON.stringify([['stream', required(streamName)], ['topic', topic]])
      }
    })
    if (!Array.isArray(body.messages) || body.messages.length > 10_000) fail('ZULIP_RESPONSE_INVALID')
    return body.messages.filter((message) => message && typeof message === 'object')
  }

  async function currentZulipUserId(state) {
    const self = await zulipRequest(state, ZULIP_SELF_PATH)
    if (typeof self.email !== 'string' ||
        self.email.toLocaleLowerCase('en-US') !== state.email.toLocaleLowerCase('en-US')) {
      fail('ZULIP_IDENTITY_MISMATCH')
    }
    return canonicalZulipUserId(self.user_id)
  }

  async function resolveBotProviderUserId(state) {
    if (botProviderUserId) return botProviderUserId
    const response = await zulipRequest(state, ZULIP_USERS_PATH, {
      query: { include_custom_profile_fields: 'false' }
    })
    if (!Array.isArray(response.members)) fail('ZULIP_RESPONSE_INVALID')
    const matching = response.members.filter((member) => (
      member && typeof member.email === 'string' &&
      member.email.toLocaleLowerCase('en-US') === botEmail && member.is_bot === true &&
      member.is_active !== false
    ))
    if (matching.length !== 1) fail('ZULIP_BOT_IDENTITY_MISMATCH')
    botProviderUserId = canonicalZulipUserId(matching[0].user_id)
    return botProviderUserId
  }

  async function verifyZulipAccount(state, endpoint) {
    const providerUserId = await currentZulipUserId(state)
    if (providerUserId !== endpoint?.identity?.providerUserId ||
        endpoint?.identity?.provider !== 'zulip' || endpoint?.identity?.realmId !== realmUrl) {
      fail('ZULIP_IDENTITY_MISMATCH')
    }
    return providerUserId
  }

  async function verifyPrivateStream(state, streamName, expectedHumanUserIds, reportLabel) {
    const response = await zulipRequest(state, ZULIP_SUBSCRIPTIONS_PATH)
    if (!Array.isArray(response.subscriptions)) fail('ZULIP_RESPONSE_INVALID')
    const matching = response.subscriptions.filter((subscription) => (
      subscription && subscription.name === streamName
    ))
    if (matching.length !== 1 || matching[0].invite_only !== true ||
        !Number.isSafeInteger(matching[0].stream_id) || matching[0].stream_id < 1) {
      fail('ACCEPTANCE_STREAM_NOT_PRIVATE')
    }
    const subscribersResponse = await zulipRequest(
      state,
      ['api', 'v1', 'streams', String(matching[0].stream_id), 'members'].join('/')
    )
    if (!Array.isArray(subscribersResponse.subscribers)) fail('ZULIP_RESPONSE_INVALID')
    const actual = subscribersResponse.subscribers.map(canonicalZulipUserId).sort()
    const expected = [
      ...expectedHumanUserIds.map(canonicalZulipUserId),
      await resolveBotProviderUserId(state)
    ].sort()
    if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length ||
        actual.length !== expected.length || actual.some((userId, index) => userId !== expected[index])) {
      fail('ACCEPTANCE_STREAM_MEMBERSHIP_INVALID')
    }
    safeReport(report, reportLabel)
  }

  async function verifyPrivatePairingStream(state) {
    const currentUserId = await currentZulipUserId(state)
    await verifyPrivateStream(
      state,
      state.pairingStream,
      [currentUserId],
      'pairing.stream-private.verified'
    )
  }

  async function verifyZulipSourceMessage(state, topic, providerMessageId) {
    const messages = await listZulipMessages(state, topic)
    const message = messages.find((candidate) => String(candidate.id) === providerMessageId)
    if (!message || String(message.sender_id) !== state.providerUserId) fail('ZULIP_IDENTITY_MISMATCH')
  }

  async function awaitZulipMessage(state, locator, text) {
    const topic = required(locator?.topicDisplayName, 'DRIVER_STATE_INVALID')
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const messages = await listZulipMessages(state, topic)
      const matching = messages.filter((message) => (
        normalizeText(message.content) === text &&
        typeof message.sender_email === 'string' &&
        message.sender_email.toLocaleLowerCase('en-US') === botEmail
      ))
      if (matching.length > 0) {
        return {
          providerMessageId: String(matching.at(-1).id),
          deliveryCount: matching.length
        }
      }
      await sleep(750)
    }
    fail('ZULIP_MESSAGE_TIMEOUT')
  }

  function stateFor(participant) {
    const state = participantStates.get(participant?.userId)
    if (!state || state.public !== participant) fail('PARTICIPANT_STATE_INVALID')
    return state
  }

  function projectionStateFor(projection) {
    const state = projectionStates.get(projection?.projectionId)
    if (!state || state.public !== projection) fail('PROJECTION_STATE_INVALID')
    return state
  }

  function projectStateFor(project) {
    const state = projectStates.get(project?.projectId)
    if (!state || state.public !== project) fail('PROJECT_STATE_INVALID')
    return state
  }

  function credentialFor(state, recipientType) {
    return recipientType === 'agent' ? state.deviceCredential : state.userCredential
  }

  function inboxStateFor(state, recipientType) {
    return recipientType === 'agent' ? state.agentInbox : state.userInbox
  }

  function cacheInboxMessages(inbox, messages) {
    for (const message of messages) {
      if (!inbox.ids.has(message.inboxMessageId)) {
        inbox.ids.add(message.inboxMessageId)
        inbox.messages.push(message)
      }
      inbox.pullCursor = Math.max(inbox.pullCursor, message.sequence)
    }
  }

  async function synchronizeInbox(state, recipientType) {
    const inbox = inboxStateFor(state, recipientType)
    const response = await collaborationCommand(credentialFor(state, recipientType), {
      type: 'inbox.pull',
      recipientType,
      afterSequence: inbox.pullCursor,
      limit: 200
    })
    if (response.type !== 'rest.inbox_page') fail('COLLABORATION_RESPONSE_INVALID')
    cacheInboxMessages(inbox, response.messages)
    return inbox
  }

  async function consumeInboxMessage(state, recipientType, message) {
    const inbox = inboxStateFor(state, recipientType)
    if (message.sequence <= inbox.ackedSequence) return
    inbox.consumed.add(message.inboxMessageId)
    const ordered = [...inbox.messages].sort((left, right) => left.sequence - right.sequence)
    let throughSequence = inbox.ackedSequence
    let throughMessage
    for (const candidate of ordered) {
      if (candidate.sequence <= throughSequence) continue
      if (candidate.sequence !== throughSequence + 1 || !inbox.consumed.has(candidate.inboxMessageId)) break
      throughSequence = candidate.sequence
      throughMessage = candidate
    }
    if (!throughMessage || throughSequence < message.sequence) fail('INBOX_ACK_GAP')
    const ack = await collaborationCommand(credentialFor(state, recipientType), {
      type: 'inbox.ack',
      inboxMessageId: throughMessage.inboxMessageId,
      sequence: throughMessage.sequence,
      idempotencyKey: idempotency('inbox_ack')
    })
    if (ack.type !== 'rest.receipt' || ack.receipt.type !== 'inbox.receipt' ||
        ack.receipt.sequence !== throughSequence) {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    inbox.ackedSequence = throughSequence
    if (inbox.ackedSequence < message.sequence) fail('INBOX_ACK_GAP')
  }

  function webSocketUrl() {
    const url = new URL('v1/events', `${serverUrl}/`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url
  }

  async function openInboxSocket(state, recipientType) {
    const token = credentialFor(state, recipientType)
    const socket = new WebSocket(webSocketUrl(), {
      headers: { authorization: `Bearer ${token}` },
      ...(origin ? { origin } : {}),
      maxPayload: 8 * 1_024,
      perMessageDeflate: false,
      handshakeTimeout: Math.min(timeoutMs, 15_000)
    })
    const signal = { generation: 0 }
    const notifications = []
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new AcceptanceDriverError('WEBSOCKET_CONNECTION_FAILED')), Math.min(timeoutMs, 15_000))
        const finish = (operation) => {
          clearTimeout(timer)
          operation()
        }
        socket.on('message', (data, binary) => {
          if (binary) return finish(() => reject(new AcceptanceDriverError('WEBSOCKET_PROTOCOL_INVALID')))
          let raw
          try {
            raw = JSON.parse(data.toString())
          } catch {
            return finish(() => reject(new AcceptanceDriverError('WEBSOCKET_PROTOCOL_INVALID')))
          }
          const parsed = webSocketMessageSchema.safeParse(raw)
          if (!parsed.success) return finish(() => reject(new AcceptanceDriverError('WEBSOCKET_PROTOCOL_INVALID')))
          signal.generation += 1
          notifications.push(parsed.data)
          if (parsed.data.type === 'connection.ready') finish(resolve)
        })
        socket.once('error', () => finish(() => reject(new AcceptanceDriverError('WEBSOCKET_CONNECTION_FAILED'))))
        socket.once('unexpected-response', () => finish(() => reject(new AcceptanceDriverError('WEBSOCKET_CONNECTION_FAILED'))))
      })
    } catch (error) {
      socket.terminate()
      throw error
    }
    return { socket, signal, notifications }
  }

  async function waitForArmedInbox(channel, state, recipientType, matcher, { consume = false } = {}) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const highestSequence = channel.notifications
        .filter((message) => message.type === 'inbox.available' && message.recipientType === recipientType)
        .reduce((highest, message) => Math.max(highest, message.highestSequence), 0)
      if (highestSequence > 0) {
        const inbox = await synchronizeInbox(state, recipientType)
        const match = inbox.messages.find((message) => !inbox.consumed.has(message.inboxMessageId) && matcher(message))
        if (match && highestSequence >= match.sequence) {
          if (consume) await consumeInboxMessage(state, recipientType, match)
          safeReport(report, 'websocket.inbox-available.verified')
          return match
        }
      }
      await sleep(250)
    }
    fail('WEBSOCKET_NOTIFICATION_TIMEOUT')
  }

  async function withArmedInbox(state, recipientType, operation, matcher, options) {
    const channel = await openInboxSocket(state, recipientType)
    try {
      const value = await operation()
      const message = await waitForArmedInbox(channel, state, recipientType, (candidate) => matcher(candidate, value), options)
      return { value, message }
    } finally {
      channel.socket.terminate()
    }
  }

  async function waitForInbox(state, recipientType, matcher, { consume = true } = {}) {
    const channel = await openInboxSocket(state, recipientType)
    const startedAt = Date.now()
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const inbox = await synchronizeInbox(state, recipientType)
        const match = inbox.messages.find((message) => !inbox.consumed.has(message.inboxMessageId) && matcher(message))
        if (match) {
          if (consume) await consumeInboxMessage(state, recipientType, match)
          return match
        }
        const generation = channel.signal.generation
        await sleep(500)
        if (generation !== channel.signal.generation) continue
      }
    } finally {
      channel.socket.terminate()
    }
    fail('INBOX_MESSAGE_TIMEOUT')
  }

  async function waitForInboxCount(state, recipientType, matcher, count) {
    const channel = await openInboxSocket(state, recipientType)
    const startedAt = Date.now()
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const inbox = await synchronizeInbox(state, recipientType)
        const matching = inbox.messages.filter((message) => !inbox.consumed.has(message.inboxMessageId) && matcher(message))
        if (matching.length >= count) return matching.sort((left, right) => left.sequence - right.sequence)
        await sleep(500)
      }
    } finally {
      channel.socket.terminate()
    }
    fail('INBOX_MESSAGE_TIMEOUT')
  }

  async function assertInboxAbsent(state, recipientType, matcher) {
    const channel = await openInboxSocket(state, recipientType)
    const deadline = Date.now() + negativeWindowMs
    try {
      while (Date.now() < deadline) {
        const inbox = await synchronizeInbox(state, recipientType)
        if (inbox.messages.some(matcher)) fail('UNEXPECTED_INBOX_DELIVERY')
        await sleep(250)
      }
    } finally {
      channel.socket.terminate()
    }
  }

  async function discoverLocator(state, topic) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const response = await collaborationCommand(state.userCredential, {
        type: 'endpoint.locator.list',
        humanEndpointId: state.public.endpointId,
        query: topic,
        limit: 500
      })
      if (response.type !== 'endpoint.locator_page') fail('COLLABORATION_RESPONSE_INVALID')
      const exact = response.locators.filter((locator) => (
        exactTopic(locator, topic) && locator.containerDisplayName === stream && locator.realmId === realmUrl
      ))
      if (exact.length === 1) return exact[0]
      if (exact.length > 1) fail('LOCATOR_AMBIGUOUS')
      await sleep(750)
    }
    fail('LOCATOR_DISCOVERY_TIMEOUT')
  }

  async function heartbeat(state, online) {
    const response = await collaborationCommand(state.deviceCredential, {
      type: 'agent.heartbeat',
      agentId: state.public.agentId,
      expectedRevision: state.agentRevision,
      connectionStatus: online ? 'online' : 'offline',
      capabilities: ['collaboration.acceptance'],
      idempotencyKey: idempotency('agent_heartbeat')
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'agent_node') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    state.agentRevision = response.entity.revision
    state.online = online
  }

  async function validateSecretOutputDirectory() {
    await validatePrivateDirectory(secretOutputDirectory)
    safeReport(report, 'secret.output-directory.verified')
    return Object.freeze({ ready: true })
  }

  async function persistCredential(slot, credentialType, generation, secret) {
    if (!PARTICIPANT_SLOTS.includes(slot) || !['user', 'device'].includes(credentialType) ||
        !Number.isSafeInteger(generation) || generation < 1) {
      fail('SECRET_ARTIFACT_INVALID')
    }
    const fileName = `acceptance-${slot.toLocaleLowerCase('en-US')}-${credentialType}-g${generation}-${runId}.token`
    return writePrivateArtifact(secretOutputDirectory, fileName, `${required(secret)}\n`)
  }

  function hasExistingBindingConfiguration(slot) {
    const prefix = participantPrefix(slot)
    return [
      `${prefix}_USER_ID`,
      `${prefix}_HUMAN_ENDPOINT_ID`,
      `${prefix}_AGENT_ID`,
      `${prefix}_USER_CREDENTIAL`,
      `${prefix}_USER_CREDENTIAL_FILE`,
      `${prefix}_DEVICE_CREDENTIAL`,
      `${prefix}_DEVICE_CREDENTIAL_FILE`
    ].some((name) => Boolean(environment(name)))
  }

  async function performPairing(slot, common) {
    const begun = await collaborationCommand(undefined, {
      type: 'pairing.begin',
      provider: 'zulip',
      realmId: realmUrl,
      requestedDisplayName: `验收用户 ${slot}`,
      idempotencyKey: idempotency('pairing_begin')
    })
    if (begun.type !== 'pairing.begun') fail('COLLABORATION_RESPONSE_INVALID')
    await sendZulipMessage(
      common,
      common.pairingTopic,
      `sciforge-pair ${begun.challengeId} ${begun.challengeCode}`,
      common.pairingStream
    )
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const response = await collaborationCommand(undefined, {
        type: 'pairing.redeem',
        pollSecret: begun.pollSecret,
        idempotencyKey: idempotency('pairing_redeem')
      })
      if (response.type === 'pairing.verified') return response
      if (response.type !== 'pairing.pending') fail('COLLABORATION_RESPONSE_INVALID')
      await sleep(Math.max(500, response.retryAfterSeconds * 1_000))
    }
    fail('PAIRING_TIMEOUT')
  }

  async function bindExistingParticipant(slot, common) {
    const prefix = participantPrefix(slot)
    const userId = environment(`${prefix}_USER_ID`)
    const endpointId = environment(`${prefix}_HUMAN_ENDPOINT_ID`)
    const agentId = environment(`${prefix}_AGENT_ID`)
    const present = [userId, endpointId, agentId].filter(Boolean).length
    const secretNames = [`${prefix}_USER_CREDENTIAL`, `${prefix}_DEVICE_CREDENTIAL`]
    const secretsConfigured = secretNames.filter((name) => environment(name) || environment(`${name}_FILE`)).length
    if (present === 0 && secretsConfigured === 0) return null
    if (present !== 3 || secretsConfigured !== 2) fail('EXISTING_BINDING_CONFIGURATION_INCOMPLETE')
    const userCredential = await readSecret(environment, secretNames[0])
    const deviceCredential = await readSecret(environment, secretNames[1])
    const snapshot = await collaborationCommand(userCredential, { type: 'participant.get', userId: required(userId) })
    if (snapshot.type !== 'participant.snapshot' || snapshot.user.userId !== userId ||
        !snapshot.humanEndpoints.some((endpoint) => endpoint.humanEndpointId === endpointId && endpoint.status === 'active') ||
        !snapshot.agents.some((agent) => agent.agentId === agentId && agent.lifecycleStatus === 'active')) {
      fail('EXISTING_BINDING_MISMATCH')
    }
    let participant = snapshot.participant
    if (participant.primaryHumanEndpointId !== endpointId || participant.primaryAgentId !== agentId) {
      const selected = await collaborationCommand(userCredential, {
        type: 'participant.update_primary',
        userId: required(userId),
        expectedRevision: participant.revision,
        primaryHumanEndpointId: required(endpointId),
        primaryAgentId: required(agentId),
        idempotencyKey: idempotency('participant_primary')
      })
      if (selected.type !== 'rest.entity' || selected.entity.type !== 'participant_profile' || selected.entity.status !== 'active') {
        fail('COLLABORATION_RESPONSE_INVALID')
      }
      participant = selected.entity
    }
    if (participant.status !== 'active') fail('EXISTING_BINDING_MISMATCH')
    const endpoint = snapshot.humanEndpoints.find((item) => item.humanEndpointId === endpointId)
    const providerUserId = await verifyZulipAccount(common, endpoint)
    const agent = snapshot.agents.find((item) => item.agentId === agentId)
    return {
      ...common,
      userCredential,
      deviceCredential,
      providerUserId,
      agentRevision: agent.revision,
      bindingMode: 'existing',
      secretGeneration: 0,
      credentialFiles: {
        user: configuredSecretBasename(environment, secretNames[0]),
        device: configuredSecretBasename(environment, secretNames[1])
      },
      revokedCredentials: new Set(),
      public: Object.freeze({ slot, userId: required(userId), endpointId: required(endpointId), agentId: required(agentId) })
    }
  }

  async function bindFreshParticipant(slot, common) {
    await validateSecretOutputDirectory()
    await verifyPrivatePairingStream(common)
    const verified = await performPairing(slot, common)
    const userCredentialFile = await persistCredential(slot, 'user', 1, verified.userCredential)
    const registered = await collaborationCommand(verified.userCredential, {
      type: 'agent.register',
      ownerUserId: verified.userId,
      installationId: opaque('ins'),
      displayName: `验收 Agent ${slot}`,
      nodeType: 'desktop',
      capabilities: ['collaboration.acceptance'],
      idempotencyKey: idempotency('agent_register')
    })
    if (registered.type !== 'agent.registered') fail('COLLABORATION_RESPONSE_INVALID')
    const deviceCredentialFile = await persistCredential(slot, 'device', 1, registered.deviceCredential)
    const snapshot = await collaborationCommand(verified.userCredential, {
      type: 'participant.get',
      userId: verified.userId
    })
    if (snapshot.type !== 'participant.snapshot') fail('COLLABORATION_RESPONSE_INVALID')
    const selected = await collaborationCommand(verified.userCredential, {
      type: 'participant.update_primary',
      userId: verified.userId,
      expectedRevision: snapshot.participant.revision,
      primaryHumanEndpointId: verified.humanEndpointId,
      primaryAgentId: registered.agent.agentId,
      idempotencyKey: idempotency('participant_primary')
    })
    if (selected.type !== 'rest.entity' || selected.entity.type !== 'participant_profile' || selected.entity.status !== 'active') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    const endpoint = snapshot.humanEndpoints.find((item) => item.humanEndpointId === verified.humanEndpointId)
    const providerUserId = await verifyZulipAccount(common, endpoint)
    return {
      ...common,
      userCredential: verified.userCredential,
      deviceCredential: registered.deviceCredential,
      providerUserId,
      agentRevision: registered.agent.revision,
      bindingMode: 'fresh',
      secretGeneration: 1,
      credentialFiles: { user: userCredentialFile, device: deviceCredentialFile },
      revokedCredentials: new Set(),
      public: Object.freeze({
        slot,
        userId: verified.userId,
        endpointId: verified.humanEndpointId,
        agentId: registered.agent.agentId
      })
    }
  }

  async function bindParticipant({ slot, requireFreshPairing = false }) {
    const prefix = participantPrefix(slot)
    const common = {
      slot,
      email: required(environment(`${prefix}_EMAIL`)),
      zulipApiKey: await readSecret(environment, `${prefix}_API_KEY`),
      pairingStream: environment(`${prefix}_PAIRING_STREAM`)?.trim() || stream,
      pairingTopic: environment(`${prefix}_PAIRING_TOPIC`)?.trim() || pairingTopic,
      agentInbox: { pullCursor: 0, ackedSequence: 0, ids: new Set(), messages: [], consumed: new Set() },
      userInbox: { pullCursor: 0, ackedSequence: 0, ids: new Set(), messages: [], consumed: new Set() },
      online: false
    }
    if (requireFreshPairing && hasExistingBindingConfiguration(slot)) fail('FRESH_PAIRING_REQUIRED')
    const state = await bindExistingParticipant(slot, common) ?? await bindFreshParticipant(slot, common)
    if (requireFreshPairing && state.bindingMode !== 'fresh') fail('FRESH_PAIRING_REQUIRED')
    participantStates.set(state.public.userId, state)
    await heartbeat(state, true)
    safeReport(report, 'participant.bound')
    return state.public
  }

  async function createPersonalProjection({ participant, label }) {
    const state = stateFor(participant)
    const topic = `${required(label).slice(0, 180)}-${runId}-${participant.slot}`
    await sendZulipMessage(state, topic, topicBootstrapCommand(runId))
    const locator = await discoverLocator(state, topic)
    const created = await collaborationCommand(state.userCredential, {
      type: 'projection.create',
      ownerUserId: participant.userId,
      agentId: participant.agentId,
      humanEndpointId: participant.endpointId,
      locator,
      displayName: topic,
      allowedSenderUserIds: [participant.userId],
      idempotencyKey: idempotency('projection_create')
    })
    if (created.type !== 'rest.entity' || created.entity.type !== 'remote_session_projection') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    const publicProjection = Object.freeze({
      projectionId: created.entity.projectionId,
      revision: created.entity.revision,
      threadId: `acceptance-thread-${runId}-${participant.slot}`,
      locator,
      label: topic
    })
    projectionStates.set(publicProjection.projectionId, {
      public: publicProjection,
      participant: state,
      processedProviderMessages: new Set(),
      lastInboundSequence: 0
    })
    safeReport(report, 'projection.created')
    return publicProjection
  }

  async function sendMobileMessage({ participant, projection, text }) {
    const state = stateFor(participant)
    const projectionState = projectionStateFor(projection)
    if (projectionState.participant !== state) fail('PROJECTION_PARTICIPANT_MISMATCH')
    const providerMessageId = await sendZulipMessage(state, projection.locator.topicDisplayName, required(text))
    await verifyZulipSourceMessage(state, projection.locator.topicDisplayName, providerMessageId)
    safeReport(report, 'mobile.message.sent')
    return Object.freeze({ providerMessageId, status: state.online ? 'submitted' : 'queued', text })
  }

  async function awaitDesktopTurn({ participant, projection, sourceMessage }) {
    const state = stateFor(participant)
    const projectionState = projectionStateFor(projection)
    const message = await waitForInbox(state, 'agent', (candidate) => (
      candidate.recipientType === 'agent' &&
      candidate.recipientAgentId === participant.agentId &&
      candidate.payload.type === 'personal.message.received' &&
      candidate.payload.projectionId === projection.projectionId &&
      candidate.payload.providerMessageId === sourceMessage.providerMessageId
    ))
    if (message.payload.projectionRevision !== projection.revision ||
        message.payload.senderUserId !== participant.userId ||
        message.payload.humanEndpointId !== participant.endpointId) {
      fail('PERSONAL_ROUTE_MISMATCH')
    }
    await sleep(negativeWindowMs)
    const inbox = await synchronizeInbox(state, 'agent')
    const matching = inbox.messages.filter((candidate) => (
      candidate.payload.type === 'personal.message.received' &&
      candidate.payload.providerMessageId === sourceMessage.providerMessageId
    ))
    if (matching.length !== 1 || projectionState.processedProviderMessages.has(sourceMessage.providerMessageId)) {
      fail('PERSONAL_MESSAGE_DUPLICATED')
    }
    if (message.sequence <= projectionState.lastInboundSequence) fail('PERSONAL_MESSAGE_OUT_OF_ORDER')
    projectionState.processedProviderMessages.add(sourceMessage.providerMessageId)
    projectionState.lastInboundSequence = message.sequence
    safeReport(report, 'desktop.turn.received')
    return Object.freeze({
      threadId: projection.threadId,
      localTurnId: opaque('trn'),
      sourceSequence: message.sequence,
      executionCount: matching.length
    })
  }

  async function publishProjectionMessage(state, projection, { text, kind, localTurnId }) {
    const localItemId = opaque('lit')
    const response = await collaborationCommand(state.deviceCredential, {
      type: 'projection.message.publish',
      projectionId: projection.projectionId,
      projectionRevision: projection.revision,
      localItemId,
      ...(localTurnId ? { localTurnId } : {}),
      kind,
      text: required(text),
      occurredAt: new Date().toISOString(),
      idempotencyKey: idempotency('projection_publish')
    })
    if (response.type !== 'rest.receipt') fail('COLLABORATION_RESPONSE_INVALID')
    outboundTexts.set(localItemId, text)
    return localItemId
  }

  async function replyFromAgent({ participant, projection, turn, text }) {
    const state = stateFor(participant)
    if (turn.threadId !== projection.threadId) fail('THREAD_MAPPING_CHANGED')
    const localItemId = await publishProjectionMessage(state, projection, {
      text,
      kind: 'assistant_final',
      localTurnId: turn.localTurnId
    })
    safeReport(report, 'agent.reply.published')
    return Object.freeze({ logicalMessageId: localItemId })
  }

  async function awaitMobileMessage({ participant, projection, text, logicalMessageId }) {
    const state = stateFor(participant)
    projectionStateFor(projection)
    const expectedText = text ?? outboundTexts.get(logicalMessageId)
    const delivered = await awaitZulipMessage(state, projection.locator, required(expectedText, 'DRIVER_STATE_INVALID'))
    if (delivered.deliveryCount !== 1) fail('MOBILE_MESSAGE_DUPLICATED')
    safeReport(report, 'mobile.message.received')
    return Object.freeze(delivered)
  }

  async function sendDesktopMessage({ participant, projection, text }) {
    const state = stateFor(participant)
    projectionStateFor(projection)
    const logicalMessageId = await publishProjectionMessage(state, projection, { text, kind: 'user_message' })
    safeReport(report, 'desktop.message.published')
    return Object.freeze({ logicalMessageId })
  }

  async function setAgentOnline({ participant, online }) {
    const state = stateFor(participant)
    await heartbeat(state, Boolean(online))
    safeReport(report, online ? 'agent.online' : 'agent.offline')
  }

  async function createProject({ owner, members, coordinator, label }) {
    const ownerState = stateFor(owner)
    const coordinatorState = stateFor(coordinator)
    const memberStates = members.map(stateFor)
    await verifyPrivateStream(
      ownerState,
      stream,
      [...new Set([ownerState.providerUserId, ...memberStates.map((state) => state.providerUserId)])],
      'project.stream-private.verified'
    )
    const routedProject = await withArmedInbox(
      coordinatorState,
      'agent',
      () => collaborationCommand(ownerState.userCredential, {
        type: 'project.create',
        ownerUserId: owner.userId,
        displayName: required(label),
        goal: `Zulip 六用户真实验收 ${runId}`,
        memberUserIds: members.map((member) => member.userId),
        coordinatorAgentId: coordinator.agentId,
        budget: { maxTasks: 20, maxTasksPerRound: 20, maxCoordinationRounds: 5, maxTaskRetries: 1 },
        idempotencyKey: idempotency('project_create')
      }),
      (message, response) => (
        response.type === 'rest.entity' && response.entity.type === 'project' &&
        message.payload.type === 'project.started' &&
        message.payload.projectId === response.entity.projectId &&
        message.payload.revision === response.entity.revision
      ),
      { consume: true }
    )
    const created = routedProject.value
    if (created.type !== 'rest.entity' || created.entity.type !== 'project') fail('COLLABORATION_RESPONSE_INVALID')
    const topic = `${required(label).slice(0, 180)}-${runId}`
    await sendZulipMessage(ownerState, topic, topicBootstrapCommand(runId))
    const locator = await discoverLocator(ownerState, topic)
    const bound = await collaborationCommand(ownerState.userCredential, {
      type: 'project.endpoint.bind',
      projectId: created.entity.projectId,
      locator,
      idempotencyKey: idempotency('project_endpoint_bind')
    })
    if (bound.type !== 'rest.entity' || bound.entity.type !== 'project_endpoint_binding') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    const publicProject = Object.freeze({
      projectId: created.entity.projectId,
      coordinatorAgentId: coordinator.agentId,
      locator,
      revision: created.entity.revision
    })
    projectStates.set(publicProject.projectId, {
      public: publicProject,
      owner: ownerState,
      coordinator: coordinatorState,
      members: memberStates,
      sourceInputs: [],
      inputMappings: new Map(),
      taskLock: Promise.resolve()
    })
    safeReport(report, 'project.created')
    return publicProject
  }

  async function sendProjectInput({ participant, project, text }) {
    const state = stateFor(participant)
    const projectState = projectStateFor(project)
    if (!projectState.members.includes(state)) fail('PROJECT_MEMBER_REQUIRED')
    const providerMessageId = await sendZulipMessage(state, project.locator.topicDisplayName, required(text))
    await verifyZulipSourceMessage(state, project.locator.topicDisplayName, providerMessageId)
    const source = Object.freeze({
      providerMessageId,
      senderUserId: participant.userId,
      senderEndpointId: participant.endpointId,
      projectId: project.projectId,
      text
    })
    projectState.sourceInputs.push(source)
    safeReport(report, 'project.input.sent')
    return source
  }

  async function awaitProjectInput({ coordinator, project, sourceInput }) {
    const state = stateFor(coordinator)
    const projectState = projectStateFor(project)
    if (projectState.coordinator !== state) fail('COORDINATOR_REQUIRED')
    if (!projectState.inputMappings.has(sourceInput.providerMessageId)) {
      const notifications = await waitForInboxCount(state, 'agent', (message) => (
        message.payload.type === 'project.input.received' && message.payload.projectId === project.projectId
      ), projectState.sourceInputs.length)
      const sources = [...projectState.sourceInputs].sort((left, right) => Number(left.providerMessageId) - Number(right.providerMessageId))
      for (let index = 0; index < sources.length; index += 1) {
        const notification = notifications[index]
        const source = sources[index]
        if (!notification || !source) fail('PROJECT_INPUT_CORRELATION_FAILED')
        projectState.inputMappings.set(source.providerMessageId, notification)
      }
    }
    const notification = projectState.inputMappings.get(sourceInput.providerMessageId)
    if (!notification) fail('PROJECT_INPUT_CORRELATION_FAILED')
    await consumeInboxMessage(state, 'agent', notification)
    safeReport(report, 'project.input.received')
    return Object.freeze({
      projectInputId: notification.payload.projectInputId,
      senderUserId: sourceInput.senderUserId
    })
  }

  async function currentProject(projectState, token = projectState.owner.userCredential) {
    const response = await collaborationCommand(token, { type: 'project.get', projectId: projectState.public.projectId })
    if (response.type !== 'rest.entity' || response.entity.type !== 'project') fail('COLLABORATION_RESPONSE_INVALID')
    return response.entity
  }

  async function withProjectTaskLock(projectState, operation) {
    const previous = projectState.taskLock
    let release
    projectState.taskLock = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async function createTaskWithCredential(credential, projectState, assigneeState, label) {
    return withProjectTaskLock(projectState, async () => {
      const current = await currentProject(projectState, credential)
      const routed = await withArmedInbox(
        assigneeState,
        'agent',
        () => collaborationCommand(credential, {
          type: 'task.create',
          projectId: projectState.public.projectId,
          expectedRevision: current.revision,
          assigneeAgentId: assigneeState.public.agentId,
          title: required(label),
          objective: `真实 Zulip 验收任务 ${label}`,
          completionCriteria: ['由指定 Worker 通过生产 Agent inbox 完成'],
          dependencyTaskIds: [],
          idempotencyKey: idempotency('task_create')
        }),
        (message, response) => (
          response.type === 'rest.entity' && response.entity.type === 'task' &&
          message.payload.type === 'task.offered' &&
          message.payload.taskId === response.entity.taskId &&
          message.payload.revision === response.entity.revision
        )
      )
      const response = routed.value
      if (response.type !== 'rest.entity' || response.entity.type !== 'task') fail('COLLABORATION_RESPONSE_INVALID')
      return response.entity
    })
  }

  async function createTask({ coordinator, project, assignee, label }) {
    const projectState = projectStateFor(project)
    const coordinatorState = stateFor(coordinator)
    const assigneeState = stateFor(assignee)
    if (projectState.coordinator !== coordinatorState) fail('COORDINATOR_REQUIRED')
    const task = await createTaskWithCredential(projectState.owner.userCredential, projectState, assigneeState, label)
    safeReport(report, 'task.created')
    return Object.freeze(task)
  }

  async function awaitTaskOffer({ participant, task }) {
    const state = stateFor(participant)
    const message = await waitForInbox(state, 'agent', (candidate) => (
      candidate.payload.type === 'task.offered' &&
      candidate.payload.taskId === task.taskId &&
      candidate.payload.revision === task.revision
    ))
    if (message.recipientType !== 'agent' || message.recipientAgentId !== participant.agentId) {
      fail('TASK_ROUTE_MISMATCH')
    }
    safeReport(report, 'task.offer.received')
    return Object.freeze({ task, sequence: message.sequence })
  }

  async function transitionTask(state, task, status, extra = {}) {
    const response = await collaborationCommand(state.deviceCredential, {
      type: 'task.transition',
      taskId: task.taskId,
      expectedRevision: task.revision,
      status,
      ...extra,
      idempotencyKey: idempotency(`task_${status}`)
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'task') fail('COLLABORATION_RESPONSE_INVALID')
    return response.entity
  }

  async function transitionTaskWithCoordinatorNotice(state, task, status, extra = {}) {
    const projectState = projectStates.get(task.projectId)
    if (!projectState) fail('PROJECT_STATE_INVALID')
    const routed = await withArmedInbox(
      projectState.coordinator,
      'agent',
      () => transitionTask(state, task, status, extra),
      (message, updated) => (
        message.payload.type === 'task.updated' && message.payload.taskId === task.taskId &&
        message.payload.status === status && message.payload.revision === updated.revision
      ),
      { consume: true }
    )
    return routed.value
  }

  async function readTask(state, taskId) {
    const response = await collaborationCommand(state.deviceCredential, { type: 'task.get', taskId })
    if (response.type !== 'rest.entity' || response.entity.type !== 'task') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    return response.entity
  }

  async function inspectCapabilityDirectory({ participant, project, expectedParticipants = [] }) {
    const state = stateFor(participant)
    projectStateFor(project)
    const response = await collaborationCommand(state.userCredential, {
      type: 'project.capability_directory.get',
      projectId: project.projectId
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'project_capability_directory') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    const agentIds = new Set(response.entity.agents.map((agent) => agent.agentId))
    if (expectedParticipants.some((candidate) => !agentIds.has(candidate.agentId))) {
      fail('CAPABILITY_DIRECTORY_INCOMPLETE')
    }
    safeReport(report, 'capability.directory.verified')
    return Object.freeze(response.entity)
  }

  async function startTask({ participant, offer }) {
    const state = stateFor(participant)
    let task = await transitionTaskWithCoordinatorNotice(state, offer.task, 'accepted')
    task = await transitionTaskWithCoordinatorNotice(state, task, 'running')
    safeReport(report, 'task.started')
    return Object.freeze(task)
  }

  async function reportTaskProgress({ participant, task, percent, summary }) {
    const state = stateFor(participant)
    const projectState = projectStates.get(task.projectId)
    if (!projectState) fail('PROJECT_STATE_INVALID')
    const routed = await withArmedInbox(
      projectState.coordinator,
      'agent',
      () => collaborationCommand(state.deviceCredential, {
        type: 'task.progress.report',
        taskId: task.taskId,
        expectedRevision: task.revision,
        percent,
        summary: required(summary),
        idempotencyKey: idempotency('task_progress')
      }),
      (message, response) => (
        response.type === 'rest.entity' && response.entity.type === 'task' &&
        message.payload.type === 'task.updated' && message.payload.taskId === task.taskId &&
        message.payload.revision === response.entity.revision
      ),
      { consume: true }
    )
    const response = routed.value
    if (response.type !== 'rest.entity' || response.entity.type !== 'task' ||
        response.entity.progress?.percent !== percent) {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    safeReport(report, 'task.progress.reported')
    return Object.freeze(response.entity)
  }

  async function reportTaskProgressIdempotently({ participant, task, percent, summary }) {
    const state = stateFor(participant)
    const projectState = projectStates.get(task.projectId)
    if (!projectState) fail('PROJECT_STATE_INVALID')
    const command = {
      type: 'task.progress.report',
      taskId: task.taskId,
      expectedRevision: task.revision,
      percent,
      summary: required(summary),
      idempotencyKey: idempotency('task_progress_replay')
    }
    const channel = await openInboxSocket(projectState.coordinator, 'agent')
    try {
      const first = await collaborationCommand(state.deviceCredential, command)
      if (first.type !== 'rest.entity' || first.entity.type !== 'task' ||
          first.entity.progress?.percent !== percent) {
        fail('COLLABORATION_RESPONSE_INVALID')
      }
      const message = await waitForArmedInbox(channel, projectState.coordinator, 'agent', (candidate) => (
        candidate.payload.type === 'task.updated' && candidate.payload.taskId === task.taskId &&
        candidate.payload.revision === first.entity.revision
      ), { consume: true })
      const availableBeforeReplay = channel.notifications.filter((candidate) => (
        candidate.type === 'inbox.available' && candidate.recipientType === 'agent'
      )).length
      const replayed = await collaborationCommand(state.deviceCredential, command)
      if (replayed.type !== 'rest.entity' || replayed.entity.type !== 'task' ||
          JSON.stringify(replayed.entity) !== JSON.stringify(first.entity)) {
        fail('IDEMPOTENCY_REPLAY_MISMATCH')
      }
      await sleep(negativeWindowMs)
      const availableAfterReplay = channel.notifications.filter((candidate) => (
        candidate.type === 'inbox.available' && candidate.recipientType === 'agent'
      )).length
      if (availableAfterReplay !== availableBeforeReplay) fail('IDEMPOTENCY_REPLAY_REDISTRIBUTED')
      const inbox = await synchronizeInbox(projectState.coordinator, 'agent')
      const duplicates = inbox.messages.filter((candidate) => (
        candidate.payload.type === 'task.updated' && candidate.payload.taskId === task.taskId &&
        candidate.payload.revision === first.entity.revision
      ))
      if (duplicates.length !== 1 || duplicates[0].inboxMessageId !== message.inboxMessageId) {
        fail('IDEMPOTENCY_REPLAY_REDISTRIBUTED')
      }
      safeReport(report, 'task.progress.idempotency.verified')
      return Object.freeze(first.entity)
    } finally {
      channel.socket.terminate()
    }
  }

  async function createTaskResource({ participant, project, task, label = 'acceptance-evidence' }) {
    const state = stateFor(participant)
    projectStateFor(project)
    const response = await collaborationCommand(state.deviceCredential, {
      type: 'resource.create',
      projectId: project.projectId,
      taskId: task.taskId,
      expectedTaskRevision: task.revision,
      provider: 'acceptance',
      externalId: opaque('external'),
      kind: 'evidence.summary',
      name: required(label),
      openUrl: `https://example.invalid/sciforge-acceptance/${opaque('resource')}`,
      version: '1',
      idempotencyKey: idempotency('resource_create')
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'resource_ref' ||
        response.entity.taskId !== task.taskId || response.entity.taskRevision !== task.revision) {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    safeReport(report, 'resource.created')
    return Object.freeze(response.entity)
  }

  async function createHumanNeededForTask({ participant, project, task, target, text }) {
    const requester = stateFor(participant)
    const targetState = stateFor(target)
    const projectState = projectStateFor(project)
    const targetChannel = await openInboxSocket(targetState, 'user')
    const coordinatorChannel = await openInboxSocket(projectState.coordinator, 'agent')
    let response
    let neededMessage
    try {
      response = await collaborationCommand(requester.deviceCredential, {
        type: 'human.needed.create',
        projectId: project.projectId,
        taskId: task.taskId,
        expectedTaskRevision: task.revision,
        targetUserId: target.userId,
        requiredAssurance: 'verified',
        prompt: required(text),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        idempotencyKey: idempotency('human_needed_task')
      })
      if (response.type !== 'rest.entity' || response.entity.type !== 'human_needed') {
        fail('COLLABORATION_RESPONSE_INVALID')
      }
      neededMessage = await waitForArmedInbox(targetChannel, targetState, 'user', (message) => (
        message.payload.type === 'human.needed' &&
        message.payload.request.humanRequestId === response.entity.humanRequestId
      ))
      await waitForArmedInbox(coordinatorChannel, projectState.coordinator, 'agent', (message) => (
        message.payload.type === 'task.updated' && message.payload.taskId === task.taskId &&
        message.payload.status === 'needs_human' &&
        message.payload.humanRequestId === response.entity.humanRequestId
      ), { consume: true })
    } finally {
      targetChannel.socket.terminate()
      coordinatorChannel.socket.terminate()
    }
    humanStates.set(response.entity.humanRequestId, {
      projectState,
      requester,
      target: targetState,
      task: await readTask(requester, task.taskId),
      sourceTask: task,
      prompt: text,
      notificationText: `${text}\n\n回复命令：sciforge-answer ${response.entity.humanRequestId} ${response.entity.revision} <answer>`,
      neededMessage,
      answerMessage: null,
      requesterAnswerMessage: null
    })
    safeReport(report, 'human.needed.created.for-task')
    return Object.freeze(response.entity)
  }

  async function awaitRequesterHumanAnswer({ participant, humanNeeded }) {
    const state = stateFor(participant)
    const humanState = humanStates.get(humanNeeded?.humanRequestId)
    if (!humanState || humanState.requester !== state) fail('HUMAN_STATE_INVALID')
    const message = humanState.requesterAnswerMessage
    if (!message || message.payload.type !== 'human.answer.received' ||
        message.payload.answer.humanRequestId !== humanNeeded.humanRequestId) {
      fail('HUMAN_ANSWER_MISMATCH')
    }
    await consumeInboxMessage(state, 'agent', message)
    safeReport(report, 'human.answer.received.by-requester')
    return Object.freeze(message.payload.answer)
  }

  async function resumeTaskAfterHuman({ participant, humanNeeded }) {
    const state = stateFor(participant)
    const humanState = humanStates.get(humanNeeded?.humanRequestId)
    if (!humanState || humanState.requester !== state) fail('HUMAN_STATE_INVALID')
    const current = await readTask(state, humanState.task.taskId)
    const task = await transitionTaskWithCoordinatorNotice(state, current, 'running')
    humanState.task = task
    safeReport(report, 'task.resumed.after-human')
    return Object.freeze(task)
  }

  async function finishTask({ participant, task, result }) {
    const state = stateFor(participant)
    const projectState = projectStates.get(task.projectId)
    if (!projectState) fail('PROJECT_STATE_INVALID')
    const routed = await withArmedInbox(
      projectState.coordinator,
      'agent',
      () => transitionTask(state, task, 'succeeded', { resultSummary: required(result) }),
      (message, completed) => (
        message.payload.type === 'task.updated' && message.payload.taskId === task.taskId &&
        message.payload.status === 'succeeded' && message.payload.revision === completed.revision
      )
    )
    const completed = routed.value
    safeReport(report, 'task.completed')
    return Object.freeze(completed)
  }

  async function submitTaskResultRecord({ participant, project, task, body }) {
    const state = stateFor(participant)
    const projectState = projectStateFor(project)
    const routed = await withArmedInbox(
      projectState.coordinator,
      'agent',
      () => collaborationCommand(state.deviceCredential, {
        type: 'project_record.submit',
        projectId: project.projectId,
        sourceTaskId: task.taskId,
        sourceRevision: task.revision,
        kind: 'task_result',
        body: required(body),
        idempotencyKey: idempotency('project_record_submit')
      }),
      (message, response) => (
        response.type === 'rest.entity' && response.entity.type === 'project_record' &&
        message.payload.type === 'project_record.submitted' &&
        message.payload.projectRecordId === response.entity.projectRecordId &&
        message.payload.revision === response.entity.revision
      )
    )
    const response = routed.value
    if (response.type !== 'rest.entity' || response.entity.type !== 'project_record' ||
        response.entity.sourceTaskId !== task.taskId) {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    projectRecordStates.set(response.entity.projectRecordId, {
      public: response.entity,
      coordinator: projectState.coordinator,
      message: routed.message
    })
    safeReport(report, 'project.record.submitted')
    return Object.freeze(response.entity)
  }

  async function awaitProjectRecord({ coordinator, record }) {
    const state = stateFor(coordinator)
    const recordState = projectRecordStates.get(record?.projectRecordId)
    if (!recordState || recordState.public !== record || recordState.coordinator !== state) {
      fail('PROJECT_RECORD_STATE_INVALID')
    }
    const response = await collaborationCommand(state.deviceCredential, {
      type: 'project_record.get',
      projectRecordId: record.projectRecordId
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'project_record') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    for (const field of [
      'projectRecordId', 'projectId', 'kind', 'status', 'body', 'authorUserId',
      'authorAgentId', 'sourceTaskId', 'sourceRevision', 'revision'
    ]) {
      if (response.entity[field] !== record[field]) fail('PROJECT_RECORD_MISMATCH')
    }
    await consumeInboxMessage(state, 'agent', recordState.message)
    safeReport(report, 'project.record.read-by-coordinator')
    return Object.freeze(response.entity)
  }

  async function acceptProjectRecord({ coordinator, record }) {
    const state = stateFor(coordinator)
    const response = await collaborationCommand(state.deviceCredential, {
      type: 'project_record.accept',
      projectRecordId: record.projectRecordId,
      expectedRevision: record.revision,
      decision: 'accepted',
      idempotencyKey: idempotency('project_record_accept')
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'project_record' ||
        response.entity.status !== 'accepted') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    safeReport(report, 'project.record.accepted')
    return Object.freeze(response.entity)
  }

  async function failTask({ participant, task, safeFailureCode = 'acceptance_failure' }) {
    const state = stateFor(participant)
    const projectState = projectStates.get(task.projectId)
    if (!projectState) fail('PROJECT_STATE_INVALID')
    const routed = await withArmedInbox(
      projectState.coordinator,
      'agent',
      () => transitionTask(state, task, 'failed', { safeFailureCode }),
      (message, failed) => (
        message.payload.type === 'task.updated' && message.payload.taskId === task.taskId &&
        message.payload.status === 'failed' && message.payload.revision === failed.revision
      ),
      { consume: true }
    )
    const failed = routed.value
    safeReport(report, 'task.failed.safely')
    return Object.freeze(failed)
  }

  async function retryTaskConcurrently({ coordinator, task, assignee }) {
    const coordinatorState = stateFor(coordinator)
    const assigneeState = stateFor(assignee)
    const projectState = projectStates.get(task?.projectId)
    if (!projectState || projectState.coordinator !== coordinatorState) fail('COORDINATOR_REQUIRED')
    const retryCredential = task.assigneeAgentId === assignee.agentId
      ? coordinatorState.deviceCredential
      : projectState.owner.userCredential
    const channel = await openInboxSocket(assigneeState, 'agent')
    let response
    try {
      const attempts = await Promise.allSettled([0, 1].map((index) => collaborationCommand(
        retryCredential,
        {
          type: 'task.retry',
          taskId: task.taskId,
          assigneeAgentId: assignee.agentId,
          expectedRevision: task.revision,
          idempotencyKey: idempotency(`task_retry_${index}`)
        }
      )))
      const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled')
      const rejected = attempts.filter((attempt) => attempt.status === 'rejected')
      if (succeeded.length !== 1 || rejected.length !== 1 ||
          rejected[0].reason?.code !== 'COLLABORATION_REVISION_CONFLICT' ||
          rejected[0].reason?.expectedRevision !== task.revision ||
          rejected[0].reason?.currentRevision !== task.revision + 1) {
        fail('TASK_RETRY_CONCURRENCY_INVALID')
      }
      response = succeeded[0].value
      if (response.type !== 'rest.entity' || response.entity.type !== 'task' ||
          response.entity.status !== 'offered' || response.entity.assigneeAgentId !== assignee.agentId ||
          response.entity.revision !== task.revision + 1 || response.entity.attempt !== task.attempt + 1 ||
          response.entity.progress !== undefined || response.entity.resultSummary !== undefined ||
          response.entity.safeFailureCode !== undefined || response.entity.completedAt !== undefined) {
        fail('COLLABORATION_RESPONSE_INVALID')
      }
      await waitForArmedInbox(channel, assigneeState, 'agent', (message) => (
        message.payload.type === 'task.offered' && message.payload.taskId === task.taskId &&
        message.payload.revision === response.entity.revision
      ))
    } finally {
      channel.socket.terminate()
    }
    safeReport(report, 'task.retry.concurrent.verified')
    return Object.freeze(response.entity)
  }

  async function assertFormerAssigneeRejected({ participant, project, task }) {
    const state = stateFor(participant)
    const commands = [
      {
        type: 'task.progress.report', taskId: task.taskId, expectedRevision: task.revision,
        percent: 1, summary: 'former assignee must be rejected', idempotencyKey: idempotency('stale_progress')
      },
      {
        type: 'resource.create', projectId: project.projectId, taskId: task.taskId,
        expectedTaskRevision: task.revision, provider: 'acceptance', externalId: opaque('stale'),
        kind: 'evidence.summary', name: 'former-assignee-evidence',
        openUrl: `https://example.invalid/sciforge-acceptance/${opaque('stale')}`,
        version: '1', idempotencyKey: idempotency('stale_resource')
      },
      {
        type: 'task.transition', taskId: task.taskId, expectedRevision: task.revision,
        status: 'succeeded', resultSummary: 'former assignee must not submit',
        idempotencyKey: idempotency('stale_result')
      },
      {
        type: 'project_record.submit', projectId: project.projectId, sourceTaskId: task.taskId,
        sourceRevision: task.revision, kind: 'task_result', body: 'former assignee must not submit',
        idempotencyKey: idempotency('stale_record')
      }
    ]
    for (const command of commands) {
      try {
        await collaborationCommand(state.deviceCredential, command)
      } catch (error) {
        if (error?.code === 'COLLABORATION_PERMISSION_DENIED') continue
        throw error
      }
      fail('FORMER_ASSIGNEE_ACCEPTED')
    }
    safeReport(report, 'task.former-assignee.rejected')
  }

  async function awaitUniqueTaskOffer({ participant, task }) {
    const offer = await awaitTaskOffer({ participant, task })
    const state = stateFor(participant)
    await sleep(negativeWindowMs)
    const inbox = await synchronizeInbox(state, 'agent')
    const matching = inbox.messages.filter((candidate) => (
      candidate.payload.type === 'task.offered' &&
      candidate.payload.taskId === task.taskId &&
      candidate.payload.revision === task.revision
    ))
    if (matching.length !== 1) fail('TASK_OFFER_DUPLICATED')
    safeReport(report, 'task.offer.unique')
    return offer
  }

  async function verifyOfflineInboxReplay({ coordinator, project, participant, label = '离线 Inbox 重放门禁' }) {
    const coordinatorState = stateFor(coordinator)
    const projectState = projectStateFor(project)
    const state = stateFor(participant)
    if (projectState.coordinator !== coordinatorState || state === coordinatorState) fail('COORDINATOR_REQUIRED')
    return withProjectTaskLock(projectState, async () => {
      const inbox = await synchronizeInbox(state, 'agent')
      if (inbox.messages.some((message) => !inbox.consumed.has(message.inboxMessageId)) ||
          inbox.pullCursor !== inbox.ackedSequence) {
        fail('INBOX_REPLAY_BASELINE_DIRTY')
      }
      const baselineSequence = inbox.pullCursor
      const disconnected = await openInboxSocket(state, 'agent')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new AcceptanceDriverError('WEBSOCKET_DISCONNECT_FAILED')),
          Math.min(timeoutMs, 15_000)
        )
        disconnected.socket.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        disconnected.socket.terminate()
      })

      const current = await currentProject(projectState, projectState.owner.userCredential)
      const createdResponse = await collaborationCommand(projectState.owner.userCredential, {
        type: 'task.create',
        projectId: project.projectId,
        expectedRevision: current.revision,
        assigneeAgentId: participant.agentId,
        title: required(label),
        objective: '在 Worker WSS 断开期间持久化并按 sequence 重放事件。',
        completionCriteria: ['离线产生的 offered 与 cancelled 事件按序补取'],
        dependencyTaskIds: [],
        idempotencyKey: idempotency('offline_replay_task_create')
      })
      if (createdResponse.type !== 'rest.entity' || createdResponse.entity.type !== 'task') {
        fail('COLLABORATION_RESPONSE_INVALID')
      }
      const created = createdResponse.entity
      const cancelledResponse = await collaborationCommand(projectState.owner.userCredential, {
        type: 'task.transition',
        taskId: created.taskId,
        expectedRevision: created.revision,
        status: 'cancelled',
        idempotencyKey: idempotency('offline_replay_task_cancel')
      })
      if (cancelledResponse.type !== 'rest.entity' || cancelledResponse.entity.type !== 'task' ||
          cancelledResponse.entity.status !== 'cancelled') {
        fail('COLLABORATION_RESPONSE_INVALID')
      }

      const replay = await collaborationCommand(state.deviceCredential, {
        type: 'inbox.pull', recipientType: 'agent', afterSequence: baselineSequence, limit: 200
      })
      if (replay.type !== 'rest.inbox_page' || replay.messages.length !== 2 ||
          replay.messages.some((message, index) => (
            message.recipientType !== 'agent' || message.recipientAgentId !== participant.agentId ||
            message.sequence !== baselineSequence + index + 1
          ))) {
        fail('INBOX_REPLAY_INVALID')
      }
      const [offered, cancelled] = replay.messages
      if (offered.payload.type !== 'task.offered' || offered.payload.taskId !== created.taskId ||
          offered.payload.revision !== created.revision ||
          cancelled.payload.type !== 'task.cancelled' || cancelled.payload.taskId !== created.taskId ||
          cancelled.payload.revision !== cancelledResponse.entity.revision) {
        fail('INBOX_REPLAY_INVALID')
      }
      cacheInboxMessages(inbox, replay.messages)
      await consumeInboxMessage(state, 'agent', offered)
      await consumeInboxMessage(state, 'agent', cancelled)
      if (inbox.ackedSequence !== cancelled.sequence) fail('INBOX_REPLAY_INVALID')

      const reconnected = await openInboxSocket(state, 'agent')
      reconnected.socket.terminate()
      const afterCursor = await collaborationCommand(state.deviceCredential, {
        type: 'inbox.pull', recipientType: 'agent', afterSequence: cancelled.sequence, limit: 200
      })
      if (afterCursor.type !== 'rest.inbox_page' || afterCursor.messages.some((message) => (
        message.payload.taskId === created.taskId
      ))) {
        fail('INBOX_REPLAY_INVALID')
      }
      safeReport(report, 'inbox.offline-replay.verified')
      return Object.freeze(cancelledResponse.entity)
    })
  }

  async function completeProject({ owner, project }) {
    const ownerState = stateFor(owner)
    const projectState = projectStateFor(project)
    if (projectState.owner !== ownerState) fail('PROJECT_OWNER_REQUIRED')
    const current = await currentProject(projectState)
    const response = await collaborationCommand(ownerState.userCredential, {
      type: 'project.transition',
      projectId: project.projectId,
      expectedRevision: current.revision,
      status: 'completed',
      idempotencyKey: idempotency('project_complete')
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'project' || response.entity.status !== 'completed') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    safeReport(report, 'project.completed')
    return Object.freeze(response.entity)
  }

  async function revokeCurrentCredential({ participant, credentialType }) {
    const state = stateFor(participant)
    const token = credentialType === 'agent' ? state.deviceCredential
      : credentialType === 'user' ? state.userCredential
        : fail('CREDENTIAL_TYPE_INVALID')
    const response = await collaborationCommand(token, {
      type: 'credential.revoke_current',
      idempotencyKey: idempotency('credential_revoke')
    })
    if (response.type !== 'rest.receipt' || response.receipt.type !== 'operation.receipt' ||
        response.receipt.status !== 'succeeded') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    try {
      await collaborationCommand(token, { type: 'user.get', userId: participant.userId })
    } catch (error) {
      if (error?.code !== 'COLLABORATION_CREDENTIAL_REVOKED') throw error
      state.revokedCredentials.add(credentialType)
      safeReport(report, `credential.${credentialType}.revoked`)
      return Object.freeze({ credentialType, revoked: true })
    }
    fail('CREDENTIAL_REVOCATION_NOT_ENFORCED')
  }

  async function restoreRevokedParticipantCredentials({ participant }) {
    const state = stateFor(participant)
    if (!state.revokedCredentials.has('user') || !state.revokedCredentials.has('agent')) {
      fail('CREDENTIAL_RECOVERY_PRECONDITION_FAILED')
    }
    await validateSecretOutputDirectory()
    await verifyPrivatePairingStream(state)
    const nextGeneration = state.secretGeneration + 1
    const verified = await performPairing(participant.slot, state)
    if (verified.userId !== participant.userId || verified.humanEndpointId !== participant.endpointId) {
      fail('PAIRING_IDENTITY_CHANGED')
    }
    const userCredentialFile = await persistCredential(
      participant.slot,
      'user',
      nextGeneration,
      verified.userCredential
    )
    const snapshot = await collaborationCommand(verified.userCredential, {
      type: 'participant.get',
      userId: participant.userId
    })
    if (snapshot.type !== 'participant.snapshot' || snapshot.user.userId !== participant.userId ||
        snapshot.participant.primaryHumanEndpointId !== participant.endpointId ||
        snapshot.participant.primaryAgentId !== participant.agentId) {
      fail('CREDENTIAL_RECOVERY_IDENTITY_MISMATCH')
    }
    const endpoint = snapshot.humanEndpoints.find((candidate) => (
      candidate.humanEndpointId === participant.endpointId && candidate.status === 'active'
    ))
    const agent = snapshot.agents.find((candidate) => (
      candidate.agentId === participant.agentId && candidate.ownerUserId === participant.userId &&
      candidate.lifecycleStatus === 'active'
    ))
    if (!endpoint || !agent) fail('CREDENTIAL_RECOVERY_IDENTITY_MISMATCH')
    const providerUserId = await verifyZulipAccount(state, endpoint)
    if (providerUserId !== state.providerUserId) fail('PAIRING_IDENTITY_CHANGED')
    const rotated = await collaborationCommand(verified.userCredential, {
      type: 'agent.rotate_credential',
      agentId: participant.agentId,
      expectedRevision: agent.revision,
      idempotencyKey: idempotency('agent_credential_restore')
    })
    if (rotated.type !== 'agent.credential_rotated' || rotated.agent.agentId !== participant.agentId ||
        rotated.agent.ownerUserId !== participant.userId || rotated.agent.lifecycleStatus !== 'active') {
      fail('COLLABORATION_RESPONSE_INVALID')
    }
    const deviceCredentialFile = await persistCredential(
      participant.slot,
      'device',
      nextGeneration,
      rotated.deviceCredential
    )
    state.userCredential = verified.userCredential
    state.deviceCredential = rotated.deviceCredential
    state.agentRevision = rotated.agent.revision
    state.secretGeneration = nextGeneration
    state.credentialFiles = { user: userCredentialFile, device: deviceCredentialFile }
    state.bindingMode = 'fresh'
    state.providerUserId = providerUserId
    state.revokedCredentials.clear()
    await heartbeat(state, true)
    safeReport(report, 'credential.recovery.verified')
    return Object.freeze({
      userId: participant.userId,
      endpointId: participant.endpointId,
      agentId: participant.agentId,
      credentialFiles: Object.freeze({ ...state.credentialFiles }),
      online: state.online
    })
  }

  async function writeAcceptanceIdentityManifest({ participants }) {
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > PARTICIPANT_SLOTS.length) {
      fail('IDENTITY_MANIFEST_INVALID')
    }
    await validateSecretOutputDirectory()
    const seenUsers = new Set()
    const identities = participants.map((participant) => {
      const state = stateFor(participant)
      if (seenUsers.has(participant.userId) || typeof state.credentialFiles.user !== 'string' ||
          typeof state.credentialFiles.device !== 'string' ||
          basename(state.credentialFiles.user) !== state.credentialFiles.user ||
          basename(state.credentialFiles.device) !== state.credentialFiles.device) {
        fail('IDENTITY_MANIFEST_INVALID')
      }
      seenUsers.add(participant.userId)
      return {
        slot: participant.slot,
        userId: participant.userId,
        humanEndpointId: participant.endpointId,
        agentId: participant.agentId,
        credentialFiles: {
          user: state.credentialFiles.user,
          device: state.credentialFiles.device
        }
      }
    })
    const manifest = {
      schemaVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
      runId,
      generatedAt: new Date().toISOString(),
      participants: identities
    }
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    for (const participant of participants) {
      const state = stateFor(participant)
      if (serialized.includes(state.userCredential) || serialized.includes(state.deviceCredential) ||
          serialized.includes(state.zulipApiKey)) {
        fail('IDENTITY_MANIFEST_CONTAINS_SECRET')
      }
    }
    const manifestFile = await writePrivateArtifact(
      secretOutputDirectory,
      `acceptance-identities-${runId}.json`,
      serialized
    )
    safeReport(report, 'identity.manifest.written')
    return Object.freeze({ manifestFile, participantCount: identities.length })
  }

  async function completeTask({ participant, offer, result }) {
    const running = await startTask({ participant, offer })
    const task = await finishTask({ participant, task: running, result })
    return Object.freeze({ task, result })
  }

  async function awaitTaskResult({ coordinator, task, result }) {
    const state = stateFor(coordinator)
    const message = await waitForInbox(state, 'agent', (candidate) => (
      candidate.payload.type === 'task.updated' &&
      candidate.payload.taskId === task.taskId &&
      candidate.payload.status === 'succeeded'
    ))
    const current = await collaborationCommand(state.deviceCredential, { type: 'task.get', taskId: task.taskId })
    if (current.type !== 'rest.entity' || current.entity.type !== 'task' || current.entity.status !== 'succeeded' ||
        result?.task?.taskId !== task.taskId || current.entity.resultSummary !== result.task.resultSummary) {
      fail('TASK_RESULT_MISMATCH')
    }
    safeReport(report, 'task.result.received')
    return Object.freeze({ task: current.entity, sequence: message.sequence })
  }

  async function createHumanNeeded({ participant, project, task, target, text }) {
    const requester = stateFor(participant)
    const targetState = stateFor(target)
    const projectState = projectStateFor(project)
    if (requester !== targetState) fail('HUMAN_TARGET_REQUIRED')
    const decisionTask = await createTaskWithCredential(
      projectState.owner.userCredential,
      projectState,
      requester,
      `human-needed-${task.taskId.slice(-12)}`
    )
    const offer = await awaitTaskOffer({ participant, task: decisionTask })
    let running = await transitionTaskWithCoordinatorNotice(requester, offer.task, 'accepted')
    running = await transitionTaskWithCoordinatorNotice(requester, running, 'running')
    const targetChannel = await openInboxSocket(targetState, 'user')
    const coordinatorChannel = await openInboxSocket(projectState.coordinator, 'agent')
    let response
    let neededMessage
    try {
      response = await collaborationCommand(requester.deviceCredential, {
        type: 'human.needed.create',
        projectId: project.projectId,
        taskId: running.taskId,
        expectedTaskRevision: running.revision,
        targetUserId: target.userId,
        requiredAssurance: 'verified',
        prompt: required(text),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        idempotencyKey: idempotency('human_needed')
      })
      if (response.type !== 'rest.entity' || response.entity.type !== 'human_needed') {
        fail('COLLABORATION_RESPONSE_INVALID')
      }
      neededMessage = await waitForArmedInbox(targetChannel, targetState, 'user', (message) => (
        message.payload.type === 'human.needed' &&
        message.payload.request.humanRequestId === response.entity.humanRequestId
      ))
      await waitForArmedInbox(coordinatorChannel, projectState.coordinator, 'agent', (message) => (
        message.payload.type === 'task.updated' && message.payload.taskId === running.taskId &&
        message.payload.status === 'needs_human' &&
        message.payload.humanRequestId === response.entity.humanRequestId
      ), { consume: true })
    } finally {
      targetChannel.socket.terminate()
      coordinatorChannel.socket.terminate()
    }
    humanStates.set(response.entity.humanRequestId, {
      projectState,
      requester,
      target: targetState,
      task: running,
      sourceTask: task,
      prompt: text,
      notificationText: `${text}\n\n回复命令：sciforge-answer ${response.entity.humanRequestId} ${response.entity.revision} <answer>`,
      neededMessage,
      answerMessage: null,
      requesterAnswerMessage: null
    })
    safeReport(report, 'human.needed.created')
    return Object.freeze(response.entity)
  }

  async function awaitHumanNeeded({ participant, humanNeeded }) {
    const state = stateFor(participant)
    const humanState = humanStates.get(humanNeeded?.humanRequestId)
    if (!humanState || humanState.target !== state) fail('HUMAN_STATE_INVALID')
    const message = humanState.neededMessage
    if (!message || message.payload.type !== 'human.needed' ||
        message.payload.request.humanRequestId !== humanNeeded.humanRequestId) {
      fail('HUMAN_STATE_INVALID')
    }
    const mobile = await awaitZulipMessage(state, humanState.projectState.public.locator, humanState.notificationText)
    if (mobile.deliveryCount !== 1) fail('HUMAN_NOTIFICATION_DUPLICATED')
    await consumeInboxMessage(state, 'user', message)
    safeReport(report, 'human.needed.received')
    return Object.freeze({ sequence: message.sequence, providerMessageId: mobile.providerMessageId })
  }

  async function assertNoHumanNeeded({ participant, humanNeeded }) {
    const state = stateFor(participant)
    await assertInboxAbsent(state, 'user', (candidate) => (
      candidate.payload.type === 'human.needed' &&
      candidate.payload.request.humanRequestId === humanNeeded.humanRequestId
    ))
    safeReport(report, 'human.needed.absent')
  }

  function humanAnswerCommand(humanNeeded, text) {
    return `sciforge-answer ${humanNeeded.humanRequestId} ${humanNeeded.revision} ${required(text)}`
  }

  async function answerHumanNeeded({ participant, humanNeeded, text }) {
    const state = stateFor(participant)
    const humanState = humanStates.get(humanNeeded?.humanRequestId)
    if (!humanState) fail('HUMAN_STATE_INVALID')
    const coordinator = humanState.projectState.coordinator
    const matcher = (candidate) => (
      candidate.payload.type === 'human.answer.received' &&
      candidate.payload.answer.humanRequestId === humanNeeded.humanRequestId
    )
    const command = humanAnswerCommand(humanNeeded, text)
    if (state !== humanState.target) {
      await sendZulipMessage(state, humanState.projectState.public.locator.topicDisplayName, command)
      await assertInboxAbsent(coordinator, 'agent', matcher)
      const current = await collaborationCommand(state.userCredential, { type: 'task.get', taskId: humanState.task.taskId })
      if (current.type !== 'rest.entity' || current.entity.type !== 'task' || current.entity.status !== 'needs_human') {
        fail('HUMAN_REJECTION_NOT_OBSERVED')
      }
      fail('HUMAN_TARGET_REQUIRED')
    }
    const requester = humanState.requester
    const coordinatorChannel = await openInboxSocket(coordinator, 'agent')
    const requesterChannel = requester === coordinator ? coordinatorChannel : await openInboxSocket(requester, 'agent')
    try {
      const coordinatorBefore = coordinator.agentInbox.messages.filter(matcher).length
      const requesterBefore = requester.agentInbox.messages.filter(matcher).length
      await sendZulipMessage(state, humanState.projectState.public.locator.topicDisplayName, command)
      await sendZulipMessage(state, humanState.projectState.public.locator.topicDisplayName, command)
      const message = await waitForArmedInbox(coordinatorChannel, coordinator, 'agent', matcher)
      const requesterMessage = requester === coordinator
        ? message
        : await waitForArmedInbox(requesterChannel, requester, 'agent', matcher)
      await sleep(negativeWindowMs)
      await synchronizeInbox(coordinator, 'agent')
      if (requester !== coordinator) await synchronizeInbox(requester, 'agent')
      const coordinatorMatching = coordinator.agentInbox.messages.filter(matcher)
      const requesterMatching = requester.agentInbox.messages.filter(matcher)
      if (coordinatorMatching.length - coordinatorBefore !== 1 ||
          requesterMatching.length - requesterBefore !== 1) {
        fail('HUMAN_ANSWER_DUPLICATED')
      }
      humanState.answerMessage = message
      humanState.requesterAnswerMessage = requesterMessage
    } finally {
      coordinatorChannel.socket.terminate()
      if (requesterChannel !== coordinatorChannel) requesterChannel.socket.terminate()
    }
    safeReport(report, 'human.answer.received')
    return Object.freeze(humanState.answerMessage.payload.answer)
  }

  async function awaitHumanAnswer({ coordinator, humanNeeded, humanAnswer }) {
    const state = stateFor(coordinator)
    const humanState = humanStates.get(humanNeeded?.humanRequestId)
    if (!humanState || humanState.projectState.coordinator !== state || !humanState.answerMessage) {
      fail('HUMAN_STATE_INVALID')
    }
    const message = humanState.answerMessage
    if (message.payload.type !== 'human.answer.received' ||
        message.payload.answer.humanAnswerId !== humanAnswer.humanAnswerId ||
        message.payload.answer.answeredByUserId !== humanState.target.public.userId ||
        message.payload.answer.answeredFromHumanEndpointId !== humanState.target.public.endpointId) {
      fail('HUMAN_ANSWER_MISMATCH')
    }
    await consumeInboxMessage(state, 'agent', message)
    safeReport(report, 'human.answer.confirmed')
    return Object.freeze({ sequence: message.sequence })
  }

  async function handoffCoordinator({ owner, project, from, to }) {
    const ownerState = stateFor(owner)
    const fromState = stateFor(from)
    const toState = stateFor(to)
    const projectState = projectStateFor(project)
    if (projectState.owner !== ownerState || projectState.coordinator !== fromState) fail('COORDINATOR_REQUIRED')
    const current = await currentProject(projectState)
    const response = await collaborationCommand(ownerState.userCredential, {
      type: 'project.transfer_coordinator',
      projectId: project.projectId,
      expectedRevision: current.revision,
      coordinatorAgentId: to.agentId,
      idempotencyKey: idempotency('coordinator_transfer')
    })
    if (response.type !== 'rest.entity' || response.entity.type !== 'project') fail('COLLABORATION_RESPONSE_INVALID')
    projectState.coordinator = toState
    safeReport(report, 'coordinator.transferred')
    return Object.freeze({ coordinatorAgentId: response.entity.coordinatorAgentId, revision: response.entity.revision })
  }

  async function createTaskAsAgent({ agent, project, assignee, label }) {
    const agentState = stateFor(agent)
    const assigneeState = stateFor(assignee)
    const projectState = projectStateFor(project)
    try {
      const task = await createTaskWithCredential(agentState.deviceCredential, projectState, assigneeState, label)
      safeReport(report, 'task.created.by-agent')
      return Object.freeze(task)
    } catch (error) {
      if (error?.code === 'COLLABORATION_PERMISSION_DENIED') fail('OWNER_CONFIRMATION_REQUIRED')
      throw error
    }
  }

  return Object.freeze({
    validateSecretOutputDirectory,
    bindParticipant,
    createPersonalProjection,
    sendMobileMessage,
    awaitDesktopTurn,
    replyFromAgent,
    awaitMobileMessage,
    sendDesktopMessage,
    setAgentOnline,
    createProject,
    sendProjectInput,
    awaitProjectInput,
    createTask,
    awaitTaskOffer,
    awaitUniqueTaskOffer,
    verifyOfflineInboxReplay,
    inspectCapabilityDirectory,
    startTask,
    reportTaskProgress,
    reportTaskProgressIdempotently,
    createTaskResource,
    createHumanNeededForTask,
    awaitRequesterHumanAnswer,
    resumeTaskAfterHuman,
    finishTask,
    submitTaskResultRecord,
    awaitProjectRecord,
    acceptProjectRecord,
    failTask,
    retryTaskConcurrently,
    assertFormerAssigneeRejected,
    completeTask,
    awaitTaskResult,
    createHumanNeeded,
    awaitHumanNeeded,
    assertNoHumanNeeded,
    answerHumanNeeded,
    awaitHumanAnswer,
    handoffCoordinator,
    createTaskAsAgent,
    completeProject,
    revokeCurrentCredential,
    restoreRevokedParticipantCredentials,
    writeAcceptanceIdentityManifest
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(process.env.SCIFORGE_COLLAB_ZULIP_E2E === '1'
    ? 'acceptance:driver-ready\n'
    : 'acceptance:skipped\n')
}
