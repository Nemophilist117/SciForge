import type {
  InboxRecipient,
  StoredAgent,
  StoredAgentCapabilityProfile,
  StoredActionConfirmation,
  StoredAuditEvent,
  StoredChallenge,
  StoredCredential,
  StoredDevice,
  StoredDeviceEnrollment,
  StoredEndpoint,
  StoredExternalIdentity,
  StoredInboxCursor,
  StoredInboxMessage,
  StoredParticipant,
  StoredProject,
  StoredProjectEndpointBinding,
  StoredProjectInput,
  StoredProjectMember,
  StoredProjectRecord,
  StoredResourceRef,
  StoredProjection,
  StoredReceipt,
  StoredTask,
  StoredUser,
  StoredOidcIdentity,
  StoredZulipBindingRequest,
  StoredHumanRequest,
  StoredHumanAnswer
} from './model.js'

export interface CollaborationReadRepository {
  getUser(userId: string): Promise<StoredUser | null>
  getOidcIdentity(identityId: string): Promise<StoredOidcIdentity | null>
  getOidcIdentityByIssuerSubject(issuer: string, subject: string): Promise<StoredOidcIdentity | null>
  getDeviceEnrollment(enrollmentId: string): Promise<StoredDeviceEnrollment | null>
  getDevice(deviceId: string): Promise<StoredDevice | null>
  getDeviceByInstallation(installationId: string): Promise<StoredDevice | null>
  listDevicesForUser(userId: string): Promise<StoredDevice[]>
  getZulipBindingRequest(bindingRequestId: string): Promise<StoredZulipBindingRequest | null>
  getZulipBindingRequestByCodeDigest(codeDigest: string): Promise<StoredZulipBindingRequest | null>
  getZulipBindingRequestByProviderEvent(providerEventId: string): Promise<StoredZulipBindingRequest | null>
  getExternalIdentity(externalIdentityId: string): Promise<StoredExternalIdentity | null>
  getExternalIdentityByProviderIdentity(realmId: string, zulipUserId: string): Promise<StoredExternalIdentity | null>
  listExternalIdentitiesForUser(userId: string): Promise<StoredExternalIdentity[]>
  getEndpoint(humanEndpointId: string): Promise<StoredEndpoint | null>
  getEndpointByProviderIdentity(provider: string, realmId: string, providerUserId: string): Promise<StoredEndpoint | null>
  getAgent(agentId: string): Promise<StoredAgent | null>
  getAgentByInstallation(installationId: string): Promise<StoredAgent | null>
  getParticipant(userId: string): Promise<StoredParticipant | null>
  listEndpointsForUser(userId: string): Promise<StoredEndpoint[]>
  listAgentsForUser(userId: string): Promise<StoredAgent[]>
  listAgentsForDevice(deviceId: string): Promise<StoredAgent[]>
  getAgentCapabilityProfile(agentId: string): Promise<StoredAgentCapabilityProfile | null>
  getProjection(projectionId: string): Promise<StoredProjection | null>
  getProjectionByLocator(provider: string, realmId: string, containerId: string, topicId: string): Promise<StoredProjection | null>
  listProjectionsForOwner(userId: string): Promise<StoredProjection[]>
  getProjectEndpointBinding(projectId: string): Promise<StoredProjectEndpointBinding | null>
  getProjectEndpointBindingById(projectEndpointBindingId: string): Promise<StoredProjectEndpointBinding | null>
  getProjectBindingByLocator(provider: string, realmId: string, containerId: string, topicId: string): Promise<StoredProjectEndpointBinding | null>
  getProjectInputByProviderMessage(endpointId: string, providerMessageId: string): Promise<StoredProjectInput | null>
  getHumanRequest(humanRequestId: string): Promise<StoredHumanRequest | null>
  getHumanAnswerForRequest(humanRequestId: string): Promise<StoredHumanAnswer | null>
  listHumanRequestsForProject(projectId: string): Promise<StoredHumanRequest[]>
  listHumanAnswersForProject(projectId: string): Promise<StoredHumanAnswer[]>
  getProject(projectId: string): Promise<StoredProject | null>
  listActiveProjectsForCoordinator(agentId: string): Promise<StoredProject[]>
  getProjectMember(projectId: string, userId: string): Promise<StoredProjectMember | null>
  listProjectMembers(projectId: string): Promise<StoredProjectMember[]>
  countProjectTasks(projectId: string, coordinationRound?: number): Promise<number>
  countOpenProjectTasks(projectId: string): Promise<number>
  listOpenTasksForAgent(agentId: string): Promise<StoredTask[]>
  getTask(taskId: string): Promise<StoredTask | null>
  listProjectTasks(projectId: string): Promise<StoredTask[]>
  getProjectRecord(projectRecordId: string): Promise<StoredProjectRecord | null>
  getTaskResultForExecution(taskId: string, executionId: string): Promise<StoredProjectRecord | null>
  listProjectRecords(projectId: string, acceptedOnly: boolean): Promise<StoredProjectRecord[]>
  getResourceRef(resourceRefId: string): Promise<StoredResourceRef | null>
  getCredentialByDigest(tokenDigest: string): Promise<StoredCredential | null>
  getReceipt(actorKey: string, idempotencyKey: string): Promise<StoredReceipt | null>
  getReceiptById(receiptId: string): Promise<StoredReceipt | null>
  getInboxCursor(recipient: InboxRecipient): Promise<StoredInboxCursor | null>
  getInboxMessage(recipient: InboxRecipient, sequence: number): Promise<StoredInboxMessage | null>
  getInboxMessageById(recipient: InboxRecipient, messageId: string): Promise<StoredInboxMessage | null>
  pullInbox(recipient: InboxRecipient, afterSequence: number, limit: number, now: string): Promise<StoredInboxMessage[]>
  getActionConfirmation(confirmationId: string): Promise<StoredActionConfirmation | null>
}

export interface CollaborationTransaction extends CollaborationReadRepository {
  lockIdempotency(actorKey: string, idempotencyKey: string): Promise<void>
  lockOidcIdentity(issuer: string, subject: string): Promise<void>
  lockZulipBindingIdentity(userId: string, realmId: string, zulipUserId: string): Promise<void>
  getUserForUpdate(userId: string): Promise<StoredUser | null>
  getOidcIdentityForUpdate(identityId: string): Promise<StoredOidcIdentity | null>
  getOidcIdentityByIssuerSubjectForUpdate(issuer: string, subject: string): Promise<StoredOidcIdentity | null>
  getDeviceEnrollmentForUpdate(enrollmentId: string): Promise<StoredDeviceEnrollment | null>
  getDeviceForUpdate(deviceId: string): Promise<StoredDevice | null>
  getZulipBindingRequestForUpdate(bindingRequestId: string): Promise<StoredZulipBindingRequest | null>
  getZulipBindingRequestByCodeDigestForUpdate(codeDigest: string): Promise<StoredZulipBindingRequest | null>
  getExternalIdentityForUpdate(externalIdentityId: string): Promise<StoredExternalIdentity | null>
  getProjectForUpdate(projectId: string): Promise<StoredProject | null>
  getAgentForUpdate(agentId: string): Promise<StoredAgent | null>
  getTaskForUpdate(taskId: string): Promise<StoredTask | null>
  getHumanRequestForUpdate(humanRequestId: string): Promise<StoredHumanRequest | null>
  getTaskResultForExecutionForUpdate(taskId: string, executionId: string): Promise<StoredProjectRecord | null>
  getActionConfirmationForUpdate(confirmationId: string): Promise<StoredActionConfirmation | null>
  listApprovedActionConfirmationsForProjectForUpdate(projectId: string): Promise<StoredActionConfirmation[]>
  listPendingHumanRequestsForTaskForUpdate(taskId: string): Promise<StoredHumanRequest[]>
  insertUser(user: StoredUser): Promise<void>
  updateUser(user: StoredUser, expectedRevision: number): Promise<void>
  insertOidcIdentity(identity: StoredOidcIdentity): Promise<void>
  updateOidcIdentity(identity: StoredOidcIdentity, expectedRevision: number): Promise<void>
  insertDeviceEnrollment(enrollment: StoredDeviceEnrollment): Promise<void>
  consumeDeviceEnrollment(enrollmentId: string, consumedAt: string, expectedRevision: number): Promise<boolean>
  insertDevice(device: StoredDevice): Promise<void>
  updateDevice(device: StoredDevice, expectedRevision: number): Promise<void>
  insertZulipBindingRequest(request: StoredZulipBindingRequest): Promise<void>
  updateZulipBindingRequest(request: StoredZulipBindingRequest, expectedRevision: number): Promise<void>
  expirePendingZulipBindingRequests(userId: string, realmUrl: string, expiredAt: string): Promise<number>
  insertExternalIdentity(identity: StoredExternalIdentity): Promise<void>
  updateExternalIdentity(identity: StoredExternalIdentity, expectedRevision: number): Promise<void>
  insertChallenge(challenge: StoredChallenge): Promise<void>
  getChallenge(challengeId: string): Promise<StoredChallenge | null>
  getChallengeByCodeDigest(challengeDigest: string): Promise<StoredChallenge | null>
  getChallengeByPollDigest(pollSecretDigest: string): Promise<StoredChallenge | null>
  verifyChallenge(challengeId: string, userId: string, humanEndpointId: string, verifiedAt: string): Promise<boolean>
  consumeChallenge(challengeId: string, consumedAt: string): Promise<boolean>
  insertEndpoint(endpoint: StoredEndpoint): Promise<void>
  updateEndpoint(endpoint: StoredEndpoint, expectedRevision: number): Promise<void>
  insertAgent(agent: StoredAgent): Promise<void>
  updateAgent(agent: StoredAgent, expectedRevision: number): Promise<void>
  upsertAgentCapabilityProfile(profile: StoredAgentCapabilityProfile, expectedRevision: number | null): Promise<void>
  deleteAgentCapabilityProfile(agentId: string): Promise<void>
  insertCredential(credential: StoredCredential): Promise<void>
  revokeCredential(credentialId: string, revokedAt: string): Promise<boolean>
  revokeCredentials(kind: StoredCredential['kind'], subjectId: string, revokedAt: string): Promise<number>
  revokeAgentCredentialsForDevice(deviceId: string, revokedAt: string): Promise<number>
  upsertParticipant(participant: StoredParticipant, expectedRevision: number | null): Promise<void>
  insertProjection(projection: StoredProjection): Promise<void>
  updateProjection(projection: StoredProjection, expectedRevision: number): Promise<void>
  upsertProjectEndpointBinding(binding: StoredProjectEndpointBinding, expectedRevision: number | null): Promise<void>
  insertProjectInput(input: Omit<StoredProjectInput, 'sequence'>): Promise<StoredProjectInput>
  insertHumanRequest(request: StoredHumanRequest): Promise<void>
  updateHumanRequest(request: StoredHumanRequest, expectedRevision: number): Promise<void>
  insertHumanAnswer(answer: StoredHumanAnswer): Promise<void>
  insertActionConfirmation(confirmation: StoredActionConfirmation): Promise<void>
  updateActionConfirmation(confirmation: StoredActionConfirmation): Promise<void>
  insertProject(project: StoredProject, members: StoredProjectMember[]): Promise<void>
  updateProject(project: StoredProject, expectedRevision: number): Promise<void>
  insertTask(task: StoredTask): Promise<void>
  updateTask(task: StoredTask, expectedRevision: number): Promise<void>
  insertProjectRecord(record: StoredProjectRecord): Promise<void>
  updateProjectRecord(record: StoredProjectRecord, expectedRevision: number): Promise<void>
  insertResourceRef(resource: StoredResourceRef): Promise<void>
  updateResourceRef(resource: StoredResourceRef, expectedRevision: number): Promise<void>
  supersedeCoordinatorInbox(projectId: string, recipientAgentId: string, supersededAt: string): Promise<StoredInboxMessage[]>
  appendInbox(message: Omit<StoredInboxMessage, 'sequence' | 'disposition'>): Promise<StoredInboxMessage>
  ackInbox(recipient: InboxRecipient, throughSequence: number, updatedAt: string): Promise<StoredInboxCursor>
  insertReceipt(receipt: StoredReceipt): Promise<void>
  insertAudit(event: StoredAuditEvent): Promise<void>
}

export interface CollaborationRepository extends CollaborationReadRepository {
  transaction<T>(work: (tx: CollaborationTransaction) => Promise<T>): Promise<T>
  pruneExpired(now: string): Promise<{ inboxMessages: number; receipts: number; challenges: number; humanRequests: number }>
  close(): Promise<void>
}
