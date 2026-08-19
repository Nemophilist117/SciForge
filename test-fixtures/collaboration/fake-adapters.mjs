function copy(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function recipientKey(recipient) {
  return `${recipient.kind}:${recipient.id}`
}

export function fakeAgentActor(agent, userId = agent.ownerUserId) {
  return {
    kind: 'agent_device',
    actorKey: `fake-agent:${agent.agentId}`,
    userId,
    agentId: agent.agentId,
    ...(agent.deviceId ? { deviceId: agent.deviceId } : {}),
    credentialId: `fake-credential:${agent.agentId}`,
    assurance: 'device'
  }
}

function revisionUpdate(map, id, value, expectedRevision) {
  const current = map.get(id)
  if (!current || current.revision !== expectedRevision) throw new Error('fake repository revision conflict')
  map.set(id, copy(value))
}

function endpointFromExternalIdentity(identity) {
  return {
    ...copy(identity),
    providerUserId: identity.zulipUserId,
    assurance: 'verified'
  }
}

function externalIdentityFromEndpoint(endpoint) {
  if (!endpoint?.externalIdentityId || endpoint.provider !== 'zulip') return null
  return copy({
    externalIdentityId: endpoint.externalIdentityId,
    humanEndpointId: endpoint.humanEndpointId,
    userId: endpoint.userId,
    provider: 'zulip',
    realmUrl: endpoint.realmUrl,
    realmId: endpoint.realmId,
    zulipUserId: endpoint.providerUserId,
    status: endpoint.status,
    revision: endpoint.revision,
    verifiedAt: endpoint.verifiedAt,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    ...(endpoint.revokedAt ? { revokedAt: endpoint.revokedAt } : {})
  })
}

export class FakeClock {
  constructor(start = '2026-08-15T00:00:00.000Z') {
    this.value = new Date(start)
  }

  now = () => new Date(this.value)

  tick(milliseconds = 1) {
    this.value = new Date(this.value.getTime() + milliseconds)
  }
}

export class FakeInboxNotifier {
  constructor() {
    this.notifications = []
  }

  notifyInboxAvailable(recipient, latestSequence) {
    this.notifications.push(copy({ recipient, latestSequence }))
  }
}

export class FakeHumanProvider {
  constructor({ provider = 'fake-im', realmId = 'fake-realm' } = {}) {
    this.provider = provider
    this.realmId = realmId
    this.online = true
    this.outbound = []
    this.listeners = new Set()
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async emit(event) {
    for (const listener of this.listeners) await listener(copy(event))
  }

  async send(message) {
    if (!this.online) {
      const error = new Error('fake provider offline')
      error.code = 'resource_offline'
      throw error
    }
    this.outbound.push(copy(message))
    return { remoteMessageId: `fake-outbound-${this.outbound.length}` }
  }

  setOnline(online) {
    this.online = online
  }
}

export class FakeAgentRuntime {
  constructor() {
    this.online = true
    this.started = []
    this.completed = []
  }

  async submitTurn(turn) {
    if (!this.online) {
      const error = new Error('fake runtime offline')
      error.code = 'resource_offline'
      throw error
    }
    this.started.push(copy(turn))
    return { localTurnId: `fake-turn-${this.started.length}` }
  }

  complete(turn) {
    this.completed.push(copy(turn))
  }

  setOnline(online) {
    this.online = online
  }
}

export class FakeAgentExecutionHost {
  constructor() {
    this.requests = []
    this.pending = []
  }

  run = (request) => {
    this.requests.push(copy(request))
    const index = this.requests.length
    return new Promise((resolve, reject) => {
      this.pending.push({ request: copy(request), index, resolve, reject })
    })
  }

  completeNext({ text = 'fake final reply', state = 'completed', runtimeId, threadId } = {}) {
    const pending = this.pending.shift()
    if (!pending) throw new Error('fake execution host has no pending turn')
    pending.resolve({
      runtimeId: runtimeId ?? pending.request.runtimeId ?? 'fake-runtime',
      threadId: threadId ?? pending.request.threadId ?? 'fake-created-thread',
      turnId: `fake-turn-${pending.index}`,
      state,
      text
    })
  }

  failNext(error = new Error('fake execution failure')) {
    const pending = this.pending.shift()
    if (!pending) throw new Error('fake execution host has no pending turn')
    pending.reject(error)
  }
}

export class FakeProjectionOutbox {
  constructor() {
    this.deliveries = []
    this.failure = null
  }

  async enqueueProjectionDelivery(command, idempotencyKey) {
    if (this.failure) throw this.failure
    this.deliveries.push(copy({ command, idempotencyKey }))
  }
}

export class FakeServiceProjectionOutbox {
  constructor({ service, actor }) {
    this.service = service
    this.actor = actor
    this.deliveries = []
  }

  async enqueueProjectionDelivery(command, idempotencyKey) {
    this.deliveries.push(copy({ command, idempotencyKey }))
    return this.service.publishProjectionMessage(this.actor, { ...copy(command), idempotencyKey })
  }
}

export class FakeHumanEndpointDeliveryWorker {
  constructor({ service, actor, provider, afterSequence = 0 }) {
    this.service = service
    this.actor = actor
    this.provider = provider
    this.afterSequence = afterSequence
    this.deliveries = []
  }

  async drain() {
    const page = await this.service.pullInbox(this.actor, {
      afterSequence: this.afterSequence,
      limit: 100
    })
    for (const message of page.messages) {
      const receipt = await this.provider.send(message.payload)
      this.deliveries.push(copy({ message, receipt }))
      this.afterSequence = message.sequence
      await this.service.ackInbox(this.actor, {
        throughSequence: message.sequence,
        idempotencyKey: `fake-endpoint-ack-${message.messageId}`
      })
    }
    return copy(this.deliveries)
  }
}

export class FakeAgentThreadsHost {
  constructor() {
    this.threads = new Map()
  }

  setTurn({ runtimeId, threadId, turnId, messages }) {
    const key = `${runtimeId}:${threadId}`
    const thread = this.threads.get(key) ?? {
      id: threadId,
      runtimeId,
      watermark: '0',
      turns: [],
      artifacts: []
    }
    const existing = thread.turns.findIndex((turn) => turn.id === turnId)
    const turn = { id: turnId, status: 'completed', messages: copy(messages), artifacts: [] }
    if (existing >= 0) thread.turns[existing] = turn
    else thread.turns.push(turn)
    thread.watermark = String(Number(thread.watermark) + 1)
    this.threads.set(key, thread)
  }

  async list() {
    return copy([...this.threads.values()].map(({ turns: _turns, artifacts: _artifacts, watermark: _watermark, ...thread }) => thread))
  }

  async read({ runtimeId, threadId }) {
    const thread = this.threads.get(`${runtimeId}:${threadId}`)
    if (!thread) throw new Error('fake canonical thread was not found')
    return copy(thread)
  }

  async *subscribeMessages() {}

  hasActiveTurns() {
    return false
  }
}

export class FakeCollaborationStateBackend {
  constructor(initial) {
    this.value = copy(initial)
    this.writes = []
  }

  async read() {
    return copy(this.value)
  }

  async write(value) {
    this.value = copy(value)
    this.writes.push(copy(value))
  }
}

export class FakeCapabilityHost {
  constructor() {
    this.requests = []
  }

  async request(input) {
    const request = {
      requestId: `fake-capability-${this.requests.length + 1}`,
      status: 'pending',
      ...copy(input)
    }
    this.requests.push(request)
    return copy(request)
  }
}

export class FakeCollaborationRepository {
  constructor() {
    this.state = this.#emptyState()
    this.closed = false
    this.transactionTail = Promise.resolve()
  }

  #emptyState() {
    return {
      users: new Map(),
      oidcIdentities: new Map(),
      deviceEnrollments: new Map(),
      devices: new Map(),
      zulipBindingRequests: new Map(),
      challenges: new Map(),
      endpoints: new Map(),
      agents: new Map(),
      capabilityProfiles: new Map(),
      participants: new Map(),
      projections: new Map(),
      projectEndpointBindings: new Map(),
      projectInputs: new Map(),
      humanRequests: new Map(),
      humanAnswers: new Map(),
      actionConfirmations: new Map(),
      projects: new Map(),
      projectMembers: new Map(),
      tasks: new Map(),
      projectRecords: new Map(),
      resourceRefs: new Map(),
      credentials: new Map(),
      receipts: new Map(),
      inboxes: new Map(),
      inboxCursors: new Map(),
      auditEvents: []
    }
  }

  #assertOpen() {
    if (this.closed) throw new Error('fake repository is closed')
  }

  async transaction(work) {
    this.#assertOpen()
    const previous = this.transactionTail
    let release
    this.transactionTail = new Promise((resolve) => { release = resolve })
    await previous
    const snapshot = copy(this.state)
    try {
      return await work(this)
    } catch (error) {
      this.state = snapshot
      throw error
    } finally {
      release()
    }
  }

  async lockIdempotency() {}

  // Fake transactions are globally serialized, so both advisory-lock APIs are
  // already represented by transactionTail rather than a second lock graph.
  async lockOidcIdentity() {}

  async lockZulipBindingIdentity() {}

  async getUser(userId) {
    return copy(this.state.users.get(userId) ?? null)
  }

  async getUserForUpdate(userId) {
    return this.getUser(userId)
  }

  async insertUser(user) {
    if (this.state.users.has(user.userId)) throw new Error('fake repository duplicate user')
    this.state.users.set(user.userId, copy(user))
  }

  async updateUser(user, expectedRevision) {
    revisionUpdate(this.state.users, user.userId, user, expectedRevision)
  }

  async getOidcIdentity(identityId) {
    return copy(this.state.oidcIdentities.get(identityId) ?? null)
  }

  async getOidcIdentityByIssuerSubject(issuer, subject) {
    return copy([...this.state.oidcIdentities.values()].find((identity) => (
      identity.issuer === issuer && identity.subject === subject
    )) ?? null)
  }

  async getOidcIdentityForUpdate(identityId) {
    return this.getOidcIdentity(identityId)
  }

  async getOidcIdentityByIssuerSubjectForUpdate(issuer, subject) {
    return this.getOidcIdentityByIssuerSubject(issuer, subject)
  }

  async insertOidcIdentity(identity) {
    if (this.state.oidcIdentities.has(identity.identityId) ||
        await this.getOidcIdentityByIssuerSubject(identity.issuer, identity.subject)) {
      throw new Error('fake repository duplicate OIDC identity')
    }
    if (!this.state.users.has(identity.userId)) throw new Error('fake repository OIDC identity user not found')
    this.state.oidcIdentities.set(identity.identityId, copy(identity))
  }

  async updateOidcIdentity(identity, expectedRevision) {
    const current = this.state.oidcIdentities.get(identity.identityId)
    if (!current || current.userId !== identity.userId || current.issuer !== identity.issuer ||
        current.subject !== identity.subject) {
      throw new Error('fake repository immutable OIDC identity mismatch')
    }
    revisionUpdate(this.state.oidcIdentities, identity.identityId, identity, expectedRevision)
  }

  async getDeviceEnrollment(enrollmentId) {
    return copy(this.state.deviceEnrollments.get(enrollmentId) ?? null)
  }

  async getDeviceEnrollmentForUpdate(enrollmentId) {
    return this.getDeviceEnrollment(enrollmentId)
  }

  async insertDeviceEnrollment(enrollment) {
    if (this.state.deviceEnrollments.has(enrollment.enrollmentId) ||
        [...this.state.deviceEnrollments.values()].some((item) => item.nonceDigest === enrollment.nonceDigest)) {
      throw new Error('fake repository duplicate Device enrollment')
    }
    if (!this.state.users.has(enrollment.userId)) throw new Error('fake repository Device enrollment user not found')
    this.state.deviceEnrollments.set(enrollment.enrollmentId, copy(enrollment))
  }

  async consumeDeviceEnrollment(enrollmentId, consumedAt, expectedRevision) {
    const enrollment = this.state.deviceEnrollments.get(enrollmentId)
    if (!enrollment || enrollment.status !== 'pending' || enrollment.revision !== expectedRevision ||
        enrollment.expiresAt <= consumedAt) return false
    Object.assign(enrollment, {
      status: 'consumed',
      consumedAt,
      updatedAt: consumedAt,
      revision: enrollment.revision + 1
    })
    return true
  }

  async getDevice(deviceId) {
    return copy(this.state.devices.get(deviceId) ?? null)
  }

  async getDeviceForUpdate(deviceId) {
    return this.getDevice(deviceId)
  }

  async getDeviceByInstallation(installationId) {
    return copy([...this.state.devices.values()].find((device) => device.installationId === installationId) ?? null)
  }

  async listDevicesForUser(userId) {
    return copy([...this.state.devices.values()]
      .filter((device) => device.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId)))
  }

  async insertDevice(device) {
    if (this.state.devices.has(device.deviceId) || await this.getDeviceByInstallation(device.installationId)) {
      throw new Error('fake repository duplicate Device identity')
    }
    if (!this.state.users.has(device.userId)) throw new Error('fake repository Device owner not found')
    this.state.devices.set(device.deviceId, copy(device))
  }

  async updateDevice(device, expectedRevision) {
    const current = this.state.devices.get(device.deviceId)
    if (!current || current.userId !== device.userId || current.installationId !== device.installationId) {
      throw new Error('fake repository immutable Device identity mismatch')
    }
    revisionUpdate(this.state.devices, device.deviceId, device, expectedRevision)
  }

  async getZulipBindingRequest(bindingRequestId) {
    return copy(this.state.zulipBindingRequests.get(bindingRequestId) ?? null)
  }

  async getZulipBindingRequestByCodeDigest(codeDigest) {
    return copy([...this.state.zulipBindingRequests.values()].find((request) => (
      request.codeDigest === codeDigest
    )) ?? null)
  }

  async getZulipBindingRequestByProviderEvent(providerEventId) {
    return copy([...this.state.zulipBindingRequests.values()].find((request) => (
      request.providerEventId === providerEventId
    )) ?? null)
  }

  async getZulipBindingRequestForUpdate(bindingRequestId) {
    return this.getZulipBindingRequest(bindingRequestId)
  }

  async getZulipBindingRequestByCodeDigestForUpdate(codeDigest) {
    return this.getZulipBindingRequestByCodeDigest(codeDigest)
  }

  async insertZulipBindingRequest(request) {
    const duplicate = this.state.zulipBindingRequests.has(request.bindingRequestId) ||
      await this.getZulipBindingRequestByCodeDigest(request.codeDigest) ||
      (request.providerEventId && await this.getZulipBindingRequestByProviderEvent(request.providerEventId)) ||
      [...this.state.zulipBindingRequests.values()].some((item) => (
        item.userId === request.userId && item.realmUrl === request.realmUrl && item.status === 'pending'
      ))
    if (duplicate) throw new Error('fake repository duplicate Zulip binding request')
    if (!this.state.users.has(request.userId)) throw new Error('fake repository binding User not found')
    this.state.zulipBindingRequests.set(request.bindingRequestId, copy(request))
  }

  async updateZulipBindingRequest(request, expectedRevision) {
    const current = this.state.zulipBindingRequests.get(request.bindingRequestId)
    if (!current || current.userId !== request.userId || current.realmUrl !== request.realmUrl ||
        current.codeDigest !== request.codeDigest) {
      throw new Error('fake repository immutable Zulip binding request mismatch')
    }
    if (request.providerEventId && [...this.state.zulipBindingRequests.values()].some((item) => (
      item.bindingRequestId !== request.bindingRequestId && item.providerEventId === request.providerEventId
    ))) throw new Error('fake repository duplicate provider event')
    revisionUpdate(this.state.zulipBindingRequests, request.bindingRequestId, request, expectedRevision)
  }

  async expirePendingZulipBindingRequests(userId, realmUrl, expiredAt) {
    let updated = 0
    for (const request of this.state.zulipBindingRequests.values()) {
      if (request.userId === userId && request.realmUrl === realmUrl && request.status === 'pending') {
        request.status = 'expired'
        request.revision += 1
        request.updatedAt = expiredAt
        updated += 1
      }
    }
    return updated
  }

  async insertChallenge(challenge) {
    if (this.state.challenges.has(challenge.challengeId)) throw new Error('fake repository duplicate challenge')
    this.state.challenges.set(challenge.challengeId, copy(challenge))
  }

  async getChallenge(challengeId) {
    return copy(this.state.challenges.get(challengeId) ?? null)
  }

  async getChallengeByCodeDigest(challengeDigest) {
    return copy([...this.state.challenges.values()].find((item) => item.challengeDigest === challengeDigest) ?? null)
  }

  async getChallengeByPollDigest(pollSecretDigest) {
    return copy([...this.state.challenges.values()].find((item) => item.pollSecretDigest === pollSecretDigest) ?? null)
  }

  async verifyChallenge(challengeId, userId, humanEndpointId, verifiedAt) {
    const challenge = this.state.challenges.get(challengeId)
    if (!challenge || challenge.verifiedAt || challenge.consumedAt) return false
    Object.assign(challenge, { verifiedUserId: userId, verifiedEndpointId: humanEndpointId, verifiedAt })
    return true
  }

  async consumeChallenge(challengeId, consumedAt) {
    const challenge = this.state.challenges.get(challengeId)
    if (!challenge || challenge.consumedAt) return false
    challenge.consumedAt = consumedAt
    return true
  }

  async getEndpoint(humanEndpointId) {
    return copy(this.state.endpoints.get(humanEndpointId) ?? null)
  }

  async getEndpointByProviderIdentity(provider, realmId, providerUserId) {
    return copy([...this.state.endpoints.values()].find((item) => (
      item.provider === provider && item.realmId === realmId && item.providerUserId === providerUserId &&
      item.status === 'active'
    )) ?? null)
  }

  async getExternalIdentity(externalIdentityId) {
    const endpoint = [...this.state.endpoints.values()].find((item) => (
      item.externalIdentityId === externalIdentityId
    ))
    return externalIdentityFromEndpoint(endpoint)
  }

  async getExternalIdentityByProviderIdentity(realmId, zulipUserId) {
    const endpoint = [...this.state.endpoints.values()].find((item) => (
      item.externalIdentityId && item.provider === 'zulip' && item.realmId === realmId &&
      item.providerUserId === zulipUserId && item.status === 'active'
    ))
    return externalIdentityFromEndpoint(endpoint)
  }

  async listExternalIdentitiesForUser(userId) {
    return [...this.state.endpoints.values()]
      .filter((endpoint) => endpoint.externalIdentityId && endpoint.provider === 'zulip' && endpoint.userId === userId)
      .map(externalIdentityFromEndpoint)
      .filter(Boolean)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.externalIdentityId.localeCompare(right.externalIdentityId))
  }

  async getExternalIdentityForUpdate(externalIdentityId) {
    return this.getExternalIdentity(externalIdentityId)
  }

  async insertEndpoint(endpoint) {
    if (this.state.endpoints.has(endpoint.humanEndpointId)) throw new Error('fake repository duplicate endpoint')
    this.state.endpoints.set(endpoint.humanEndpointId, copy(endpoint))
  }

  async updateEndpoint(endpoint, expectedRevision) {
    if (this.state.endpoints.get(endpoint.humanEndpointId)?.externalIdentityId) {
      throw new Error('fake repository external identity requires the dedicated update path')
    }
    revisionUpdate(this.state.endpoints, endpoint.humanEndpointId, endpoint, expectedRevision)
  }

  async insertExternalIdentity(identity) {
    if (await this.getExternalIdentity(identity.externalIdentityId) || this.state.endpoints.has(identity.humanEndpointId)) {
      throw new Error('fake repository duplicate external identity')
    }
    const providerConflict = [...this.state.endpoints.values()].some((endpoint) => (
      endpoint.provider === 'zulip' && endpoint.status === 'active' &&
      endpoint.realmId === identity.realmId && endpoint.providerUserId === identity.zulipUserId
    ))
    const userRealmConflict = [...this.state.endpoints.values()].some((endpoint) => (
      endpoint.provider === 'zulip' && endpoint.status === 'active' &&
      endpoint.userId === identity.userId && endpoint.realmId === identity.realmId
    ))
    if (providerConflict || userRealmConflict) throw new Error('fake repository active external identity conflict')
    if (!this.state.users.has(identity.userId)) throw new Error('fake repository external identity User not found')
    this.state.endpoints.set(identity.humanEndpointId, endpointFromExternalIdentity(identity))
  }

  async updateExternalIdentity(identity, expectedRevision) {
    const current = [...this.state.endpoints.values()].find((endpoint) => (
      endpoint.externalIdentityId === identity.externalIdentityId
    ))
    if (!current || current.userId !== identity.userId || current.realmId !== identity.realmId ||
        current.providerUserId !== identity.zulipUserId || current.humanEndpointId !== identity.humanEndpointId) {
      throw new Error('fake repository immutable external identity mismatch')
    }
    revisionUpdate(this.state.endpoints, current.humanEndpointId, endpointFromExternalIdentity(identity), expectedRevision)
  }

  async getAgent(agentId) {
    return copy(this.state.agents.get(agentId) ?? null)
  }

  async getAgentByInstallation(installationId) {
    return copy([...this.state.agents.values()].find((item) => item.installationId === installationId) ?? null)
  }

  async insertAgent(agent) {
    if (this.state.agents.has(agent.agentId)) throw new Error('fake repository duplicate agent')
    if (agent.status === 'active' && !agent.deviceId) throw new Error('fake repository ACTIVE Agent requires Device')
    if (agent.deviceId) {
      const device = this.state.devices.get(agent.deviceId)
      if (!device || device.userId !== agent.ownerUserId) throw new Error('fake repository Agent/Device owner mismatch')
    }
    this.state.agents.set(agent.agentId, copy(agent))
  }

  async updateAgent(agent, expectedRevision) {
    const current = this.state.agents.get(agent.agentId)
    if (agent.status === 'active' && !agent.deviceId) throw new Error('fake repository ACTIVE Agent requires Device')
    if (agent.deviceId) {
      const device = this.state.devices.get(agent.deviceId)
      if (!device || device.userId !== agent.ownerUserId) throw new Error('fake repository Agent/Device owner mismatch')
    }
    revisionUpdate(this.state.agents, agent.agentId, agent, expectedRevision)
    if (current && current.ownerUserId !== agent.ownerUserId) {
      for (const task of this.state.tasks.values()) {
        if (task.assigneeAgentId === agent.agentId && task.assigneeUserId === current.ownerUserId) {
          task.assigneeUserId = agent.ownerUserId
        }
      }
    }
  }

  async insertCredential(credential) {
    if (this.state.credentials.has(credential.credentialId)) throw new Error('fake repository duplicate credential')
    this.state.credentials.set(credential.credentialId, copy(credential))
  }

  async getCredentialByDigest(tokenDigest) {
    return copy([...this.state.credentials.values()].find((item) => item.tokenDigest === tokenDigest) ?? null)
  }

  async revokeCredential(credentialId, revokedAt) {
    const credential = this.state.credentials.get(credentialId)
    if (!credential || credential.revokedAt) return false
    credential.revokedAt = revokedAt
    return true
  }

  async revokeCredentials(kind, subjectId, revokedAt) {
    let updated = 0
    for (const credential of this.state.credentials.values()) {
      const matches = credential.kind === kind && (
        kind === 'user' ? credential.subjectUserId === subjectId : credential.subjectAgentId === subjectId
      )
      if (matches && !credential.revokedAt) {
        credential.revokedAt = revokedAt
        updated += 1
      }
    }
    return updated
  }

  async revokeAgentCredentialsForDevice(deviceId, revokedAt) {
    const agentIds = new Set([...this.state.agents.values()]
      .filter((agent) => agent.deviceId === deviceId)
      .map((agent) => agent.agentId))
    let updated = 0
    for (const credential of this.state.credentials.values()) {
      if (credential.kind === 'agent_device' && credential.subjectAgentId &&
          agentIds.has(credential.subjectAgentId) && !credential.revokedAt) {
        credential.revokedAt = revokedAt
        updated += 1
      }
    }
    return updated
  }

  async getParticipant(userId) {
    return copy(this.state.participants.get(userId) ?? null)
  }

  async listEndpointsForUser(userId) {
    return copy([...this.state.endpoints.values()].filter((item) => item.userId === userId))
  }

  async listAgentsForUser(userId) {
    return copy([...this.state.agents.values()].filter((item) => item.ownerUserId === userId))
  }

  async listAgentsForDevice(deviceId) {
    return copy([...this.state.agents.values()].filter((item) => item.deviceId === deviceId))
  }

  async getAgentCapabilityProfile(agentId) {
    return copy(this.state.capabilityProfiles.get(agentId) ?? null)
  }

  async upsertAgentCapabilityProfile(profile, expectedRevision) {
    const current = this.state.capabilityProfiles.get(profile.agentId)
    if (expectedRevision === null) {
      if (current) throw new Error('fake repository duplicate capability profile')
    } else if (!current || current.revision !== expectedRevision) {
      throw new Error('fake repository capability profile revision conflict')
    }
    this.state.capabilityProfiles.set(profile.agentId, copy(profile))
  }

  async deleteAgentCapabilityProfile(agentId) {
    this.state.capabilityProfiles.delete(agentId)
  }

  async upsertParticipant(participant, expectedRevision) {
    const current = this.state.participants.get(participant.userId)
    if (expectedRevision === null) {
      if (current) throw new Error('fake repository duplicate participant')
    } else if (!current || current.revision !== expectedRevision) {
      throw new Error('fake repository participant revision conflict')
    }
    this.state.participants.set(participant.userId, copy(participant))
  }

  async getProjection(projectionId) {
    return copy(this.state.projections.get(projectionId) ?? null)
  }

  async getProjectionByLocator(provider, realmId, containerId, topicId) {
    return copy([...this.state.projections.values()].find((item) => (
      item.locator.provider === provider &&
      item.locator.realmId === realmId &&
      item.locator.containerId === containerId &&
      item.locator.topicId === topicId
    )) ?? null)
  }

  async listProjectionsForOwner(userId) {
    return copy([...this.state.projections.values()].filter((item) => item.ownerUserId === userId))
  }

  async insertProjection(projection) {
    if (this.state.projections.has(projection.projectionId)) throw new Error('fake repository duplicate projection')
    this.state.projections.set(projection.projectionId, copy(projection))
  }

  async updateProjection(projection, expectedRevision) {
    revisionUpdate(this.state.projections, projection.projectionId, projection, expectedRevision)
  }

  async getProjectEndpointBinding(projectId) {
    return copy(this.state.projectEndpointBindings.get(projectId) ?? null)
  }

  async getProjectBindingByLocator(provider, realmId, containerId, topicId) {
    return copy([...this.state.projectEndpointBindings.values()].find((item) => (
      item.locator.provider === provider &&
      item.locator.realmId === realmId &&
      item.locator.containerId === containerId &&
      item.locator.topicId === topicId
    )) ?? null)
  }

  async upsertProjectEndpointBinding(binding, expectedRevision) {
    const current = this.state.projectEndpointBindings.get(binding.projectId)
    if (expectedRevision === null) {
      if (current) throw new Error('fake repository duplicate project endpoint binding')
    } else if (!current || current.revision !== expectedRevision) {
      throw new Error('fake repository project endpoint revision conflict')
    }
    this.state.projectEndpointBindings.set(binding.projectId, copy(binding))
  }

  async getProjectInputByProviderMessage(endpointId, providerMessageId) {
    return copy([...this.state.projectInputs.values()].find((item) => (
      item.sourceHumanEndpointId === endpointId && item.providerMessageId === providerMessageId
    )) ?? null)
  }

  async insertProjectInput(input) {
    const sequence = [...this.state.projectInputs.values()].filter((item) => item.projectId === input.projectId).length + 1
    const stored = { ...copy(input), sequence }
    this.state.projectInputs.set(stored.projectInputId, stored)
    return copy(stored)
  }

  async getHumanRequest(humanRequestId) {
    return copy(this.state.humanRequests.get(humanRequestId) ?? null)
  }

  async getHumanRequestForUpdate(humanRequestId) {
    return this.getHumanRequest(humanRequestId)
  }

  async listPendingHumanRequestsForTaskForUpdate(taskId) {
    return copy([...this.state.humanRequests.values()]
      .filter((request) => request.taskId === taskId && request.status === 'pending')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.humanRequestId.localeCompare(right.humanRequestId)))
  }

  async insertHumanRequest(request) {
    if (this.state.humanRequests.has(request.humanRequestId)) throw new Error('fake repository duplicate human request')
    this.state.humanRequests.set(request.humanRequestId, copy(request))
  }

  async updateHumanRequest(request, expectedRevision) {
    revisionUpdate(this.state.humanRequests, request.humanRequestId, request, expectedRevision)
  }

  async getHumanAnswerForRequest(humanRequestId) {
    return copy([...this.state.humanAnswers.values()].find((item) => item.humanRequestId === humanRequestId) ?? null)
  }

  async listHumanRequestsForProject(projectId) {
    return copy([...this.state.humanRequests.values()].filter((item) => item.projectId === projectId))
  }

  async listHumanAnswersForProject(projectId) {
    return copy([...this.state.humanAnswers.values()].filter((item) => item.projectId === projectId))
  }

  async insertHumanAnswer(answer) {
    if (this.state.humanAnswers.has(answer.humanAnswerId)) throw new Error('fake repository duplicate human answer')
    this.state.humanAnswers.set(answer.humanAnswerId, copy(answer))
  }

  async getActionConfirmation(confirmationId) {
    return copy(this.state.actionConfirmations.get(confirmationId) ?? null)
  }

  async getActionConfirmationForUpdate(confirmationId) {
    return this.getActionConfirmation(confirmationId)
  }

  async listApprovedActionConfirmationsForProjectForUpdate(projectId) {
    return copy([...this.state.actionConfirmations.values()]
      .filter((confirmation) => confirmation.projectId === projectId && confirmation.status === 'approved')
      .sort((left, right) => left.confirmationId.localeCompare(right.confirmationId)))
  }

  async insertActionConfirmation(confirmation) {
    if (this.state.actionConfirmations.has(confirmation.confirmationId)) {
      throw new Error('fake repository duplicate action confirmation')
    }
    this.state.actionConfirmations.set(confirmation.confirmationId, copy(confirmation))
  }

  async updateActionConfirmation(confirmation) {
    const current = this.state.actionConfirmations.get(confirmation.confirmationId)
    if (!current) throw new Error('fake repository missing action confirmation')
    if (current.status !== 'approved') throw new Error('fake repository terminal action confirmation is immutable')
    this.state.actionConfirmations.set(confirmation.confirmationId, copy(confirmation))
  }

  async getProject(projectId) {
    return copy(this.state.projects.get(projectId) ?? null)
  }

  async insertProject(project, members) {
    if (this.state.projects.has(project.projectId)) throw new Error('fake repository duplicate project')
    this.state.projects.set(project.projectId, copy(project))
    for (const member of members) this.state.projectMembers.set(`${member.projectId}:${member.userId}`, copy(member))
  }

  async updateProject(project, expectedRevision) {
    revisionUpdate(this.state.projects, project.projectId, project, expectedRevision)
  }

  async getProjectMember(projectId, userId) {
    return copy(this.state.projectMembers.get(`${projectId}:${userId}`) ?? null)
  }

  async listProjectMembers(projectId) {
    return copy([...this.state.projectMembers.values()].filter((item) => item.projectId === projectId))
  }

  async countProjectTasks(projectId, coordinationRound) {
    return [...this.state.tasks.values()].filter((item) => (
      item.projectId === projectId && (coordinationRound === undefined || item.coordinationRound === coordinationRound)
    )).length
  }

  async countOpenProjectTasks(projectId) {
    const closed = new Set(['rejected', 'completed', 'failed', 'cancelled'])
    return [...this.state.tasks.values()].filter((item) => (
      item.projectId === projectId && !closed.has(item.status)
    )).length
  }

  async listActiveProjectsForCoordinator(agentId) {
    return copy([...this.state.projects.values()].filter((item) => (
      item.coordinatorAgentId === agentId && item.status === 'active'
    )))
  }

  async listOpenTasksForAgent(agentId) {
    const closed = new Set(['rejected', 'completed', 'failed', 'cancelled'])
    return copy([...this.state.tasks.values()].filter((item) => item.assigneeAgentId === agentId && !closed.has(item.status)))
  }

  async getTask(taskId) {
    return copy(this.state.tasks.get(taskId) ?? null)
  }

  async listProjectTasks(projectId) {
    return copy([...this.state.tasks.values()].filter((item) => item.projectId === projectId))
  }

  async getProjectForUpdate(projectId) {
    return copy(this.state.projects.get(projectId) ?? null)
  }

  async getAgentForUpdate(agentId) {
    return copy(this.state.agents.get(agentId) ?? null)
  }

  async getTaskForUpdate(taskId) {
    return copy(this.state.tasks.get(taskId) ?? null)
  }

  async insertTask(task) {
    if (this.state.tasks.has(task.taskId)) throw new Error('fake repository duplicate task')
    this.state.tasks.set(task.taskId, copy(task))
  }

  async updateTask(task, expectedRevision) {
    revisionUpdate(this.state.tasks, task.taskId, task, expectedRevision)
  }

  async getProjectRecord(projectRecordId) {
    return copy(this.state.projectRecords.get(projectRecordId) ?? null)
  }

  async listProjectRecords(projectId, acceptedOnly) {
    return copy([...this.state.projectRecords.values()].filter((item) => (
      item.projectId === projectId && (!acceptedOnly || item.status === 'accepted')
    )))
  }

  async getTaskResultForExecution(taskId, executionId) {
    return copy([...this.state.projectRecords.values()].find((item) => (
      item.kind === 'task_result' && item.sourceTaskId === taskId && item.sourceExecutionId === executionId
    )) ?? null)
  }

  async getTaskResultForExecutionForUpdate(taskId, executionId) {
    return this.getTaskResultForExecution(taskId, executionId)
  }

  async insertProjectRecord(record) {
    if (this.state.projectRecords.has(record.projectRecordId)) throw new Error('fake repository duplicate record')
    this.state.projectRecords.set(record.projectRecordId, copy(record))
  }

  async updateProjectRecord(record, expectedRevision) {
    revisionUpdate(this.state.projectRecords, record.projectRecordId, record, expectedRevision)
  }

  async getResourceRef(resourceRefId) {
    return copy(this.state.resourceRefs.get(resourceRefId) ?? null)
  }

  async insertResourceRef(resource) {
    if (this.state.resourceRefs.has(resource.resourceRefId)) throw new Error('fake repository duplicate ResourceRef')
    this.state.resourceRefs.set(resource.resourceRefId, copy(resource))
  }

  async updateResourceRef(resource, expectedRevision) {
    revisionUpdate(this.state.resourceRefs, resource.resourceRefId, resource, expectedRevision)
  }

  async appendInbox(message) {
    const key = recipientKey(message.recipient)
    const inbox = this.state.inboxes.get(key) ?? []
    const cursor = this.state.inboxCursors.get(key) ?? {
      recipient: copy(message.recipient),
      nextSequence: 1,
      ackedSequence: 0,
      updatedAt: message.createdAt
    }
    const stored = { disposition: 'active', ...copy(message), sequence: cursor.nextSequence }
    inbox.push(stored)
    this.state.inboxes.set(key, inbox)
    this.state.inboxCursors.set(key, {
      ...cursor,
      nextSequence: stored.sequence + 1,
      updatedAt: message.createdAt
    })
    return copy(stored)
  }

  async pullInbox(recipient, afterSequence, limit, now) {
    return copy((this.state.inboxes.get(recipientKey(recipient)) ?? [])
      .filter((item) => item.sequence > afterSequence &&
        (item.expiresAt > now || item.disposition === 'superseded'))
      .slice(0, limit))
  }

  async getInboxCursor(recipient) {
    return copy(this.state.inboxCursors.get(recipientKey(recipient)) ?? null)
  }


  async getInboxMessage(recipient, sequence) {
    return copy((this.state.inboxes.get(recipientKey(recipient)) ?? [])
      .find((item) => item.sequence === sequence) ?? null)
  }

  async getInboxMessageById(recipient, messageId) {
    return copy((this.state.inboxes.get(recipientKey(recipient)) ?? [])
      .find((item) => item.messageId === messageId) ?? null)
  }

  async supersedeCoordinatorInbox(projectId, recipientAgentId, supersededAt) {
    const key = recipientKey({ kind: 'agent', id: recipientAgentId })
    const cursor = this.state.inboxCursors.get(key)
    const changed = []
    const coordinatorTypes = new Set(['task.updated', 'project_record.submitted', 'project.input.received',
      'project.endpoint.updated', 'project.started', 'human.answer.received'])
    for (const message of this.state.inboxes.get(key) ?? []) {
      if (message.sequence <= (cursor?.ackedSequence ?? 0) || message.disposition === 'superseded') continue
      const messageProjectId = message.payload?.projectId ?? message.payload?.answer?.projectId
      if (messageProjectId !== projectId || !coordinatorTypes.has(message.messageType)) continue
      message.disposition = 'superseded'
      message.supersededAt = supersededAt
      changed.push(copy(message))
    }
    return changed
  }

  async ackInbox(recipient, throughSequence, updatedAt) {
    const key = recipientKey(recipient)
    const inbox = this.state.inboxes.get(key) ?? []
    const current = this.state.inboxCursors.get(key)
    const latestSequence = inbox.at(-1)?.sequence ?? 0
    const currentAck = current?.ackedSequence ?? 0
    if (throughSequence > currentAck) {
      const target = inbox.find((item) => item.sequence === throughSequence)
      if (!target) throw new Error('fake repository inbox message not found')
      for (let sequence = currentAck + 1; sequence < throughSequence; sequence += 1) {
        const skipped = inbox.find((item) => item.sequence === sequence)
        if (!skipped || skipped.disposition !== 'superseded') {
          throw new Error('fake repository inbox ack gap')
        }
      }
    }
    const cursor = {
      recipient: copy(recipient),
      nextSequence: latestSequence + 1,
      ackedSequence: Math.max(currentAck, Math.min(throughSequence, latestSequence)),
      updatedAt
    }
    this.state.inboxCursors.set(key, cursor)
    return copy(cursor)
  }

  async getReceipt(actorKey, idempotencyKey) {
    return copy(this.state.receipts.get(`${actorKey}:${idempotencyKey}`) ?? null)
  }

  async insertReceipt(receipt) {
    const key = `${receipt.actorKey}:${receipt.idempotencyKey}`
    if (this.state.receipts.has(key)) throw new Error('fake repository duplicate receipt')
    this.state.receipts.set(key, copy(receipt))
  }

  async insertAudit(event) {
    this.state.auditEvents.push(copy(event))
  }

  async pruneExpired(now) {
    let inboxMessages = 0
    let receipts = 0
    let challenges = 0
    let humanRequests = 0
    for (const enrollment of this.state.deviceEnrollments.values()) {
      if (enrollment.status === 'pending' && enrollment.expiresAt <= now) {
        enrollment.status = 'expired'
        enrollment.revision += 1
        enrollment.updatedAt = now
      }
    }
    for (const request of this.state.zulipBindingRequests.values()) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired'
        request.revision += 1
        request.updatedAt = now
      }
    }
    for (const request of this.state.humanRequests.values()) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired'
        request.revision += 1
        request.updatedAt = now
        humanRequests += 1
      }
    }
    for (const confirmation of this.state.actionConfirmations.values()) {
      if (confirmation.status === 'approved' && confirmation.expiresAt <= now) {
        confirmation.status = 'superseded'
        confirmation.updatedAt = now
      }
    }
    for (const [key, inbox] of this.state.inboxes) {
      const acked = this.state.inboxCursors.get(key)?.ackedSequence ?? 0
      const retained = []
      for (const item of inbox) {
        if (item.expiresAt <= now && item.sequence <= acked) {
          inboxMessages += 1
          continue
        }
        if (item.expiresAt <= now && item.disposition !== 'superseded') {
          item.disposition = 'superseded'
          item.supersededAt = now
        }
        retained.push(item)
      }
      this.state.inboxes.set(key, retained)
    }
    for (const [key, receipt] of this.state.receipts) {
      if (receipt.expiresAt <= now) {
        this.state.receipts.delete(key)
        receipts += 1
      }
    }
    for (const [key, challenge] of this.state.challenges) {
      if (challenge.expiresAt <= now) {
        this.state.challenges.delete(key)
        challenges += 1
      }
    }
    return { inboxMessages, receipts, challenges, humanRequests }
  }

  async close() {
    this.closed = true
  }
}

export function createFakeAdapters(options = {}) {
  return {
    clock: options.clock ?? new FakeClock(),
    repository: options.repository ?? new FakeCollaborationRepository(),
    notifier: options.notifier ?? new FakeInboxNotifier(),
    provider: options.provider ?? new FakeHumanProvider(),
    runtime: options.runtime ?? new FakeAgentRuntime(),
    agentExecution: options.agentExecution ?? new FakeAgentExecutionHost(),
    agentThreads: options.agentThreads ?? new FakeAgentThreadsHost(),
    projectionOutbox: options.projectionOutbox ?? new FakeProjectionOutbox(),
    stateBackend: options.stateBackend ?? new FakeCollaborationStateBackend(),
    capabilityHost: options.capabilityHost ?? new FakeCapabilityHost()
  }
}
