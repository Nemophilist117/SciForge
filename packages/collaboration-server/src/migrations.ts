import { readFile } from 'node:fs/promises'

import type { SqlPool } from './postgres.js'

export const COLLABORATION_SCHEMA_VERSION = 6

const COLLABORATION_MIGRATIONS = [
  '0001_collaboration_schema.sql',
  '0002_resource_refs.sql',
  '0003_task_progress.sql',
  '0004_coordination_contract.sql',
  '0005_unified_identity_device_bindings.sql',
  '0006_portable_resource_refs.sql'
] as const

const REQUIRED_MIGRATION_VERSIONS = [1, 2, 3, 4, 5, 6] as const

const REQUIRED_TABLES = [
  'action_confirmations',
  'agent_capability_profiles',
  'agent_nodes',
  'audit_events',
  'credentials',
  'device_enrollments',
  'devices',
  'human_answers',
  'human_endpoint_bindings',
  'human_endpoint_challenges',
  'human_requests',
  'inbox_cursors',
  'inbox_messages',
  'oidc_identities',
  'participant_profiles',
  'project_endpoint_bindings',
  'project_input_cursors',
  'project_inputs',
  'project_members',
  'project_records',
  'projects',
  'provider_deliveries',
  'provider_diagnostics',
  'provider_event_claims',
  'provider_event_cursors',
  'receipts',
  'remote_session_projections',
  'resource_refs',
  'schema_migrations',
  'tasks',
  'user_principals',
  'zulip_binding_requests'
] as const

const REQUIRED_COLUMN_TYPES = {
  action_confirmations: {
    confirmation_id: 'text',
    human_request_id: 'text',
    project_id: 'text',
    target_user_id: 'text',
    coordinator_agent_id: 'text',
    action: 'jsonb',
    action_digest: 'bytea',
    status: 'text',
    approved_at: 'timestamp with time zone',
    expires_at: 'timestamp with time zone',
    consumed_at: 'timestamp with time zone',
    consumed_by_actor_key: 'text',
    consumed_operation: 'text',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  },
  agent_capability_profiles: {
    agent_id: 'text',
    owner_user_id: 'text',
    node_type: 'text',
    os_family: 'text',
    os_architecture: 'text',
    os_version: 'text',
    runtime_ids: 'jsonb',
    capabilities: 'jsonb',
    gpu: 'jsonb',
    vpn_access_ids: 'jsonb',
    slurm_cluster_ids: 'jsonb',
    accessible_resource_ref_ids: 'jsonb',
    result_return_policy: 'jsonb',
    reported_at: 'timestamp with time zone',
    expires_at: 'timestamp with time zone',
    revision: 'bigint',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  },
  agent_nodes: {
    device_id: 'text'
  },
  device_enrollments: {
    enrollment_id: 'text',
    user_id: 'text',
    installation_id: 'text',
    nonce_digest: 'bytea',
    status: 'text',
    revision: 'bigint',
    expires_at: 'timestamp with time zone',
    consumed_at: 'timestamp with time zone',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  },
  devices: {
    device_id: 'text',
    user_id: 'text',
    installation_id: 'text',
    display_name: 'text',
    platform: 'jsonb',
    public_key_jwk: 'jsonb',
    capability_summary: 'jsonb',
    status: 'text',
    revision: 'bigint',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    revoked_at: 'timestamp with time zone'
  },
  human_endpoint_bindings: {
    external_identity_id: 'text',
    realm_url: 'text',
    created_at: 'timestamp with time zone'
  },
  human_answers: {
    task_id: 'text',
    execution_id: 'text',
    decision: 'text',
    confirmation_id: 'text'
  },
  human_requests: {
    source_kind: 'text',
    task_id: 'text',
    execution_id: 'text',
    source_inbox_message_id: 'text',
    confirmable_action: 'jsonb'
  },
  inbox_messages: {
    disposition: 'text',
    superseded_at: 'timestamp with time zone',
    superseded_by_message_id: 'text'
  },
  oidc_identities: {
    identity_id: 'text',
    user_id: 'text',
    issuer: 'text',
    subject: 'text',
    email_at_link_time: 'text',
    status: 'text',
    revision: 'bigint',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    revoked_at: 'timestamp with time zone'
  },
  project_records: {
    status: 'text',
    source_execution_id: 'text',
    criterion_evidence: 'jsonb',
    resource_ref_ids: 'jsonb',
    log_summary: 'text'
  },
  resource_refs: {
    resource_ref_id: 'text',
    project_id: 'text',
    task_id: 'text',
    execution_id: 'text',
    task_revision: 'bigint',
    created_by_user_id: 'text',
    created_by_agent_id: 'text',
    provider: 'text',
    external_id: 'text',
    kind: 'text',
    name: 'text',
    open_url: 'text',
    portable_reference: 'text',
    provider_version: 'text',
    status: 'text',
    status_reason_code: 'text',
    unavailable_at: 'timestamp with time zone',
    revoked_at: 'timestamp with time zone',
    invalidated_at: 'timestamp with time zone',
    revision: 'bigint',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  },
  tasks: {
    task_id: 'text',
    project_id: 'text',
    execution_id: 'text',
    result_record_id: 'text',
    assignee_user_id: 'text',
    completion_criteria: 'jsonb',
    required_capabilities: 'jsonb',
    resource_ref_ids: 'jsonb',
    authorization_requirements: 'jsonb',
    status: 'text',
    progress_percent: 'integer',
    progress_summary: 'text',
    progress_reported_at: 'timestamp with time zone',
    result_summary: 'text',
    failure_summary: 'text',
    safe_failure_code: 'text',
    safe_failure_summary: 'text',
    revision: 'bigint'
  },
  zulip_binding_requests: {
    binding_request_id: 'text',
    user_id: 'text',
    realm_url: 'text',
    code_digest: 'bytea',
    status: 'text',
    revision: 'bigint',
    expires_at: 'timestamp with time zone',
    confirmed_at: 'timestamp with time zone',
    external_identity_id: 'text',
    service_actor_id: 'text',
    provider_event_id: 'text',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  }
} as const

const REQUIRED_CONSTRAINTS = {
  action_confirmations: [
    'action_confirmations_action_shape',
    'action_confirmations_status_valid',
    'action_confirmations_status_timestamps',
    'action_confirmations_times'
  ],
  agent_capability_profiles: [
    'agent_capability_profiles_shape',
    'agent_capability_profiles_times',
    'agent_capability_profiles_revision'
  ],
  agent_nodes: ['agent_nodes_active_device_required'],
  device_enrollments: [
    'device_enrollments_status_valid',
    'device_enrollments_consumption_state',
    'device_enrollments_revision_valid',
    'device_enrollments_times'
  ],
  devices: [
    'devices_display_name_valid',
    'devices_platform_shape',
    'devices_public_key_shape',
    'devices_capability_summary_shape',
    'devices_status_valid',
    'devices_status_timestamps',
    'devices_revision_valid',
    'devices_times'
  ],
  human_endpoint_bindings: ['human_endpoint_bindings_external_identity_shape'],
  human_answers: [
    'human_answers_execution_provenance',
    'human_answers_decision_confirmation_consistent'
  ],
  human_requests: [
    'human_requests_source_valid',
    'human_requests_confirmable_action_shape'
  ],
  inbox_messages: [
    'inbox_messages_disposition_valid',
    'inbox_messages_superseded_timestamp'
  ],
  oidc_identities: [
    'oidc_identities_identity_shape',
    'oidc_identities_status_valid',
    'oidc_identities_status_timestamps',
    'oidc_identities_revision_valid',
    'oidc_identities_times'
  ],
  project_records: [
    'project_records_status_valid',
    'project_records_execution_provenance',
    'project_records_structured_result_shape'
  ],
  resource_refs: [
    'resource_refs_open_url_safe',
    'resource_refs_portable_reference_safe',
    'resource_refs_provenance_complete',
    'resource_refs_status_reason_format',
    'resource_refs_status_timestamp_consistent'
  ],
  tasks: [
    'tasks_execution_id_format',
    'tasks_coordination_requirements_shape',
    'tasks_progress_percent_range',
    'tasks_progress_summary_length',
    'tasks_progress_complete',
    'tasks_result_summary_state',
    'tasks_result_record_state',
    'tasks_safe_failure_code_format',
    'tasks_safe_failure_code_state',
    'tasks_safe_failure_summary_state'
  ],
  zulip_binding_requests: [
    'zulip_binding_requests_status_valid',
    'zulip_binding_requests_confirmation_state',
    'zulip_binding_requests_revision_valid',
    'zulip_binding_requests_times'
  ]
} as const

const REQUIRED_RELATIONAL_CONSTRAINTS = {
  agent_capability_profiles: ['agent_capability_profiles_owner_fk'],
  agent_nodes: ['agent_nodes_identity_owner_unique', 'agent_nodes_device_owner_fk'],
  device_enrollments: ['device_enrollments_nonce_digest_unique', 'device_enrollments_user_fk'],
  devices: ['devices_installation_unique', 'devices_identity_owner_unique', 'devices_user_fk'],
  human_endpoint_bindings: ['human_endpoint_bindings_external_identity_unique'],
  human_answers: ['human_answers_confirmation_fk'],
  oidc_identities: [
    'oidc_identities_issuer_subject_unique',
    'oidc_identities_identity_owner_unique',
    'oidc_identities_user_fk'
  ],
  tasks: ['tasks_assignee_owner_fk', 'tasks_result_record_fk'],
  zulip_binding_requests: [
    'zulip_binding_requests_code_digest_unique',
    'zulip_binding_requests_provider_event_unique',
    'zulip_binding_requests_external_identity_fk',
    'zulip_binding_requests_user_fk'
  ]
} as const

const REQUIRED_FOREIGN_KEY_ACTIONS = {
  agent_capability_profiles: {
    agent_capability_profiles_owner_fk: { updateAction: 'NO ACTION', deleteAction: 'CASCADE' }
  },
  agent_nodes: {
    agent_nodes_device_owner_fk: { updateAction: 'NO ACTION', deleteAction: 'RESTRICT' }
  },
  device_enrollments: {
    device_enrollments_user_fk: { updateAction: 'NO ACTION', deleteAction: 'NO ACTION' }
  },
  devices: {
    devices_user_fk: { updateAction: 'NO ACTION', deleteAction: 'NO ACTION' }
  },
  oidc_identities: {
    oidc_identities_user_fk: { updateAction: 'NO ACTION', deleteAction: 'NO ACTION' }
  },
  tasks: {
    tasks_assignee_owner_fk: { updateAction: 'CASCADE', deleteAction: 'NO ACTION' }
  },
  zulip_binding_requests: {
    zulip_binding_requests_external_identity_fk: { updateAction: 'NO ACTION', deleteAction: 'NO ACTION' },
    zulip_binding_requests_user_fk: { updateAction: 'NO ACTION', deleteAction: 'NO ACTION' }
  }
} as const

const REQUIRED_INDEXES = {
  agent_nodes: ['agent_nodes_device_id'],
  device_enrollments: ['device_enrollments_owner_installation'],
  human_endpoint_bindings: [
    'human_endpoint_bindings_other_provider_identity_active_unique',
    'human_endpoint_bindings_zulip_provider_identity_active_unique',
    'human_endpoint_bindings_zulip_user_realm_active_unique'
  ],
  project_records: ['project_records_task_result_execution_unique'],
  tasks: ['tasks_execution_id_unique', 'tasks_result_record_unique'],
  zulip_binding_requests: ['zulip_binding_requests_pending_user_realm_unique']
} as const

export async function runCollaborationMigrations(pool: SqlPool): Promise<void> {
  for (const filename of COLLABORATION_MIGRATIONS) {
    const migrationUrl = new URL(`../migrations/${filename}`, import.meta.url)
    const sql = await readFile(migrationUrl, 'utf8')
    await pool.query(sql)
  }
}

export async function isCollaborationDatabaseReady(pool: SqlPool): Promise<boolean> {
  try {
    const versions = await pool.query<{ version: unknown }>(
      `SELECT version
       FROM sciforge_collaboration.schema_migrations
       ORDER BY version`
    )
    const actualVersions = versions.rows.map((row) => Number(row.version))
    if (!sameNumbers(actualVersions, REQUIRED_MIGRATION_VERSIONS)) return false

    const tables = await pool.query<{ table_name: unknown }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      ['sciforge_collaboration']
    )
    const actualTables = tables.rows.map((row) => String(row.table_name))
    if (!sameStrings(actualTables, REQUIRED_TABLES)) return false

    const columns = await pool.query<{ table_name: unknown; column_name: unknown; data_type: unknown }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = ANY($2::text[])`,
      ['sciforge_collaboration', Object.keys(REQUIRED_COLUMN_TYPES)]
    )
    const presentColumns = new Set(columns.rows.map((row) => (
      `${String(row.table_name)}.${String(row.column_name)}.${String(row.data_type)}`
    )))
    if (!hasRequiredColumnTypes(presentColumns, REQUIRED_COLUMN_TYPES)) return false

    const constraints = await pool.query<{
      table_name: unknown
      constraint_name: unknown
      update_action: unknown
      delete_action: unknown
    }>(
      `SELECT relation.relname AS table_name, constraint_record.conname AS constraint_name,
              CASE constraint_record.confupdtype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
              END AS update_action,
              CASE constraint_record.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
              END AS delete_action
       FROM pg_catalog.pg_constraint AS constraint_record
       JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1
         AND relation.relname = ANY($2::text[])
         AND constraint_record.contype IN ('c', 'f', 'u')
         AND constraint_record.convalidated`,
      ['sciforge_collaboration', [...new Set([
        ...Object.keys(REQUIRED_CONSTRAINTS),
        ...Object.keys(REQUIRED_RELATIONAL_CONSTRAINTS)
      ])]]
    )
    const presentConstraints = new Set(constraints.rows.map((row) => (
      `${String(row.table_name)}.${String(row.constraint_name)}`
    )))
    if (!hasRequiredNames(presentConstraints, REQUIRED_CONSTRAINTS) ||
        !hasRequiredNames(presentConstraints, REQUIRED_RELATIONAL_CONSTRAINTS)) return false
    const presentForeignKeyActions = new Set(constraints.rows.map((row) => (
      `${String(row.table_name)}.${String(row.constraint_name)}.${String(row.update_action)}.${String(row.delete_action)}`
    )))
    if (!hasRequiredForeignKeyActions(presentForeignKeyActions, REQUIRED_FOREIGN_KEY_ACTIONS)) return false

    const indexes = await pool.query<{ table_name: unknown; index_name: unknown }>(
      `SELECT tablename AS table_name, indexname AS index_name
       FROM pg_catalog.pg_indexes
       WHERE schemaname = $1
         AND tablename = ANY($2::text[])`,
      ['sciforge_collaboration', Object.keys(REQUIRED_INDEXES)]
    )
    const presentIndexes = new Set(indexes.rows.map((row) => (
      `${String(row.table_name)}.${String(row.index_name)}`
    )))
    return hasRequiredNames(presentIndexes, REQUIRED_INDEXES)
  } catch {
    return false
  }
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => (
    Number.isSafeInteger(value) && value === expected[index]
  ))
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function hasRequiredColumnTypes(
  present: ReadonlySet<string>,
  required: Readonly<Record<string, Readonly<Record<string, string>>>>
): boolean {
  return Object.entries(required).every(([relation, columns]) => (
    Object.entries(columns).every(([column, dataType]) => present.has(`${relation}.${column}.${dataType}`))
  ))
}

function hasRequiredNames(
  present: ReadonlySet<string>,
  required: Readonly<Record<string, readonly string[]>>
): boolean {
  return Object.entries(required).every(([relation, names]) => (
    names.every((name) => present.has(`${relation}.${name}`))
  ))
}

function hasRequiredForeignKeyActions(
  present: ReadonlySet<string>,
  required: Readonly<Record<string, Readonly<Record<string, {
    updateAction: string
    deleteAction: string
  }>>>>
): boolean {
  return Object.entries(required).every(([relation, constraints]) => (
    Object.entries(constraints).every(([name, actions]) => (
      present.has(`${relation}.${name}.${actions.updateAction}.${actions.deleteAction}`)
    ))
  ))
}
