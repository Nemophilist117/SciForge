export type CollaborationErrorCode =
  | 'authentication_required'
  | 'credential_revoked'
  | 'assurance_insufficient'
  | 'permission_denied'
  | 'not_found'
  | 'identity_conflict'
  | 'IDENTITY_ALREADY_BOUND'
  | 'BINDING_CODE_USED'
  | 'BINDING_CODE_EXPIRED'
  | 'ownership_conflict'
  | 'revision_conflict'
  | 'execution_conflict'
  | 'assignee_mismatch'
  | 'coordinator_mismatch'
  | 'confirmation_required'
  | 'confirmation_mismatch'
  | 'resource_unavailable'
  | 'capability_profile_expired'
  | 'inbox_ack_gap'
  | 'recipient_mismatch'
  | 'idempotency_conflict'
  | 'invalid_state_transition'
  | 'budget_exhausted'
  | 'resource_offline'
  | 'request_expired'
  | 'payload_too_large'
  | 'rate_limited'
  | 'validation_failed'
  | 'internal_error'

export class CollaborationServiceError extends Error {
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  auditRecorded = false

  constructor(
    readonly code: CollaborationErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {}
  ) {
    super(message)
    this.name = 'CollaborationServiceError'
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export function fail(
  code: CollaborationErrorCode,
  message: string,
  options?: { retryable?: boolean; details?: Record<string, unknown> }
): never {
  throw new CollaborationServiceError(code, message, options)
}
