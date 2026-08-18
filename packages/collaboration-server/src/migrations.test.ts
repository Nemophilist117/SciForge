import { describe, expect, it } from 'vitest'

import { isCollaborationDatabaseReady } from './migrations.js'
import type { SqlPool } from './postgres.js'

const REQUIRED_TABLES = [
  'action_confirmations', 'agent_capability_profiles', 'agent_nodes', 'audit_events', 'credentials',
  'device_enrollments', 'devices', 'human_answers', 'human_endpoint_bindings',
  'human_endpoint_challenges', 'human_requests', 'inbox_cursors', 'inbox_messages',
  'oidc_identities', 'participant_profiles', 'project_endpoint_bindings', 'project_input_cursors', 'project_inputs',
  'project_members', 'project_records', 'projects', 'provider_deliveries', 'provider_diagnostics',
  'provider_event_claims', 'provider_event_cursors', 'receipts', 'remote_session_projections',
  'resource_refs', 'schema_migrations', 'tasks', 'user_principals', 'zulip_binding_requests'
] as const

const REQUIRED_COLUMN_TYPES = {
  action_confirmations: {
    confirmation_id: 'text', human_request_id: 'text', project_id: 'text', target_user_id: 'text',
    coordinator_agent_id: 'text', action: 'jsonb', action_digest: 'bytea', status: 'text',
    approved_at: 'timestamp with time zone', expires_at: 'timestamp with time zone',
    consumed_at: 'timestamp with time zone', consumed_by_actor_key: 'text', consumed_operation: 'text',
    created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone'
  },
  agent_capability_profiles: {
    agent_id: 'text', owner_user_id: 'text', node_type: 'text', os_family: 'text',
    os_architecture: 'text', os_version: 'text', runtime_ids: 'jsonb', capabilities: 'jsonb', gpu: 'jsonb',
    vpn_access_ids: 'jsonb', slurm_cluster_ids: 'jsonb', accessible_resource_ref_ids: 'jsonb',
    result_return_policy: 'jsonb', reported_at: 'timestamp with time zone',
    expires_at: 'timestamp with time zone', revision: 'bigint', created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  },
  agent_nodes: { device_id: 'text' },
  device_enrollments: {
    enrollment_id: 'text', user_id: 'text', installation_id: 'text', nonce_digest: 'bytea', status: 'text',
    revision: 'bigint', expires_at: 'timestamp with time zone', consumed_at: 'timestamp with time zone',
    created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone'
  },
  devices: {
    device_id: 'text', user_id: 'text', installation_id: 'text', display_name: 'text', platform: 'jsonb',
    public_key_jwk: 'jsonb', capability_summary: 'jsonb', status: 'text', revision: 'bigint',
    created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone',
    revoked_at: 'timestamp with time zone'
  },
  human_endpoint_bindings: {
    external_identity_id: 'text', realm_url: 'text', created_at: 'timestamp with time zone'
  },
  human_answers: {
    task_id: 'text', execution_id: 'text', decision: 'text', confirmation_id: 'text'
  },
  human_requests: {
    source_kind: 'text', task_id: 'text', execution_id: 'text', source_inbox_message_id: 'text',
    confirmable_action: 'jsonb'
  },
  inbox_messages: {
    disposition: 'text', superseded_at: 'timestamp with time zone', superseded_by_message_id: 'text'
  },
  oidc_identities: {
    identity_id: 'text', user_id: 'text', issuer: 'text', subject: 'text', email_at_link_time: 'text',
    status: 'text', revision: 'bigint', created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone', revoked_at: 'timestamp with time zone'
  },
  project_records: {
    status: 'text', source_execution_id: 'text', criterion_evidence: 'jsonb',
    resource_ref_ids: 'jsonb', log_summary: 'text'
  },
  resource_refs: {
    resource_ref_id: 'text', project_id: 'text', task_id: 'text', execution_id: 'text', task_revision: 'bigint',
    created_by_user_id: 'text', created_by_agent_id: 'text', provider: 'text', external_id: 'text',
    kind: 'text', name: 'text', open_url: 'text', provider_version: 'text', status: 'text',
    status_reason_code: 'text', unavailable_at: 'timestamp with time zone', revoked_at: 'timestamp with time zone',
    invalidated_at: 'timestamp with time zone', revision: 'bigint',
    created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone'
  },
  tasks: {
    task_id: 'text', project_id: 'text', execution_id: 'text', result_record_id: 'text',
    assignee_user_id: 'text', completion_criteria: 'jsonb', required_capabilities: 'jsonb',
    resource_ref_ids: 'jsonb', authorization_requirements: 'jsonb', status: 'text', progress_percent: 'integer',
    progress_summary: 'text', progress_reported_at: 'timestamp with time zone', result_summary: 'text',
    failure_summary: 'text', safe_failure_code: 'text', safe_failure_summary: 'text', revision: 'bigint'
  },
  zulip_binding_requests: {
    binding_request_id: 'text', user_id: 'text', realm_url: 'text', code_digest: 'bytea', status: 'text',
    revision: 'bigint', expires_at: 'timestamp with time zone', confirmed_at: 'timestamp with time zone',
    external_identity_id: 'text', service_actor_id: 'text', provider_event_id: 'text',
    created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone'
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
    'device_enrollments_status_valid', 'device_enrollments_consumption_state',
    'device_enrollments_revision_valid', 'device_enrollments_times'
  ],
  devices: [
    'devices_display_name_valid', 'devices_platform_shape', 'devices_public_key_shape',
    'devices_capability_summary_shape', 'devices_status_valid', 'devices_status_timestamps',
    'devices_revision_valid', 'devices_times'
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
    'oidc_identities_identity_shape', 'oidc_identities_status_valid', 'oidc_identities_status_timestamps',
    'oidc_identities_revision_valid', 'oidc_identities_times'
  ],
  project_records: [
    'project_records_status_valid',
    'project_records_execution_provenance',
    'project_records_structured_result_shape'
  ],
  resource_refs: [
    'resource_refs_open_url_safe',
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
    'zulip_binding_requests_status_valid', 'zulip_binding_requests_confirmation_state',
    'zulip_binding_requests_revision_valid', 'zulip_binding_requests_times'
  ]
} as const

const REQUIRED_RELATIONAL_CONSTRAINTS = {
  agent_capability_profiles: ['agent_capability_profiles_owner_fk'],
  agent_nodes: ['agent_nodes_identity_owner_unique', 'agent_nodes_device_owner_fk'],
  device_enrollments: ['device_enrollments_nonce_digest_unique', 'device_enrollments_user_fk'],
  devices: ['devices_installation_unique', 'devices_identity_owner_unique', 'devices_user_fk'],
  human_endpoint_bindings: ['human_endpoint_bindings_external_identity_unique'],
  human_answers: ['human_answers_confirmation_fk'],
  oidc_identities: ['oidc_identities_issuer_subject_unique', 'oidc_identities_identity_owner_unique',
    'oidc_identities_user_fk'],
  tasks: ['tasks_assignee_owner_fk', 'tasks_result_record_fk'],
  zulip_binding_requests: ['zulip_binding_requests_code_digest_unique',
    'zulip_binding_requests_provider_event_unique', 'zulip_binding_requests_external_identity_fk',
    'zulip_binding_requests_user_fk']
} as const

const REQUIRED_FOREIGN_KEY_ACTIONS = {
  agent_capability_profiles: {
    agent_capability_profiles_owner_fk: { update_action: 'NO ACTION', delete_action: 'CASCADE' }
  },
  agent_nodes: {
    agent_nodes_device_owner_fk: { update_action: 'NO ACTION', delete_action: 'RESTRICT' }
  },
  device_enrollments: {
    device_enrollments_user_fk: { update_action: 'NO ACTION', delete_action: 'NO ACTION' }
  },
  devices: {
    devices_user_fk: { update_action: 'NO ACTION', delete_action: 'NO ACTION' }
  },
  oidc_identities: {
    oidc_identities_user_fk: { update_action: 'NO ACTION', delete_action: 'NO ACTION' }
  },
  tasks: {
    tasks_assignee_owner_fk: { update_action: 'CASCADE', delete_action: 'NO ACTION' }
  },
  zulip_binding_requests: {
    zulip_binding_requests_external_identity_fk: { update_action: 'NO ACTION', delete_action: 'NO ACTION' },
    zulip_binding_requests_user_fk: { update_action: 'NO ACTION', delete_action: 'NO ACTION' }
  }
} as const

const REQUIRED_INDEXES = {
  agent_nodes: ['agent_nodes_device_id'],
  device_enrollments: ['device_enrollments_owner_installation'],
  human_endpoint_bindings: ['human_endpoint_bindings_other_provider_identity_active_unique',
    'human_endpoint_bindings_zulip_provider_identity_active_unique',
    'human_endpoint_bindings_zulip_user_realm_active_unique'],
  project_records: ['project_records_task_result_execution_unique'],
  tasks: ['tasks_execution_id_unique', 'tasks_result_record_unique'],
  zulip_binding_requests: ['zulip_binding_requests_pending_user_realm_unique']
} as const

type TableRow = { table_name: unknown }
type ColumnRow = { table_name: unknown; column_name: unknown; data_type: unknown }
type ConstraintRow = {
  table_name: unknown
  constraint_name: unknown
  update_action?: unknown
  delete_action?: unknown
}
type IndexRow = { table_name: unknown; index_name: unknown }

type ReadyState = {
  versions?: unknown[]
  tables?: TableRow[]
  columns?: ColumnRow[]
  constraints?: ConstraintRow[]
  indexes?: IndexRow[]
  failQuery?: 'versions' | 'tables' | 'columns' | 'constraints' | 'indexes'
}

describe('collaboration database readiness', () => {
  it('accepts only the complete current migration and schema manifest', async () => {
    await expect(isCollaborationDatabaseReady(poolFor())).resolves.toBe(true)
  })

  it.each([
    { label: 'a missing migration', versions: [1, 2, 3, 5] },
    { label: 'an extra future migration', versions: [1, 2, 3, 4, 5, 6] },
    { label: 'a duplicate migration marker', versions: [1, 2, 3, 4, 4, 5] },
    { label: 'a malformed migration marker', versions: [1, 2, 3, 4, 'not-a-version'] }
  ])('rejects $label', async ({ versions }) => {
    await expect(isCollaborationDatabaseReady(poolFor({ versions }))).resolves.toBe(false)
  })

  it('rejects a missing collaboration table', async () => {
    const tables = requiredTableRows().filter((row) => row.table_name !== 'human_answers')
    await expect(isCollaborationDatabaseReady(poolFor({ tables }))).resolves.toBe(false)
  })

  it('rejects an unexpected collaboration table', async () => {
    const tables = [...requiredTableRows(), { table_name: 'private_future_state' }]
      .sort((left, right) => String(left.table_name).localeCompare(String(right.table_name)))
    await expect(isCollaborationDatabaseReady(poolFor({ tables }))).resolves.toBe(false)
  })

  it.each(requiredColumnRows())('rejects missing $table_name.$column_name', async ({ table_name, column_name }) => {
    const columns = requiredColumnRows().filter((row) => (
      row.table_name !== table_name || row.column_name !== column_name
    ))
    await expect(isCollaborationDatabaseReady(poolFor({ columns }))).resolves.toBe(false)
  })

  it.each(requiredColumnRows())(
    'rejects the wrong data type for $table_name.$column_name',
    async ({ table_name, column_name }) => {
      const columns = requiredColumnRows().map((row) => (
        row.table_name === table_name && row.column_name === column_name
          ? { ...row, data_type: 'wrong type' }
          : row
      ))
      await expect(isCollaborationDatabaseReady(poolFor({ columns }))).resolves.toBe(false)
    }
  )

  it.each(requiredConstraintRows())(
    'rejects missing $table_name constraint $constraint_name',
    async ({ table_name, constraint_name }) => {
      const constraints = requiredConstraintRows().filter((row) => (
        row.table_name !== table_name || row.constraint_name !== constraint_name
      ))
      await expect(isCollaborationDatabaseReady(poolFor({ constraints }))).resolves.toBe(false)
    }
  )

  it.each([
    { tableName: 'tasks', constraintName: 'tasks_assignee_owner_fk', updateAction: 'NO ACTION' },
    { tableName: 'agent_capability_profiles', constraintName: 'agent_capability_profiles_owner_fk', updateAction: 'CASCADE' }
  ])('rejects unsafe $tableName.$constraintName update action', async ({ tableName, constraintName, updateAction }) => {
    const constraints = requiredConstraintRows().map((row) => (
      row.table_name === tableName && row.constraint_name === constraintName
        ? { ...row, update_action: updateAction }
        : row
    ))
    await expect(isCollaborationDatabaseReady(poolFor({ constraints }))).resolves.toBe(false)
  })

  it.each(requiredIndexRows())(
    'rejects missing $table_name index $index_name',
    async ({ table_name, index_name }) => {
      const indexes = requiredIndexRows().filter((row) => (
        row.table_name !== table_name || row.index_name !== index_name
      ))
      await expect(isCollaborationDatabaseReady(poolFor({ indexes }))).resolves.toBe(false)
    }
  )

  it.each(['versions', 'tables', 'columns', 'constraints', 'indexes'] as const)(
    'returns false without exposing a %s query or permission error',
    async (failQuery) => {
      await expect(isCollaborationDatabaseReady(poolFor({ failQuery }))).resolves.toBe(false)
    }
  )
})

function poolFor(state: ReadyState = {}): SqlPool {
  return {
    query: async (text) => {
      if (text.includes('schema_migrations')) {
        if (state.failQuery === 'versions') throw new Error('private migration query detail')
        const rows = (state.versions ?? [1, 2, 3, 4, 5]).map((version) => ({ version }))
        return { rows, rowCount: rows.length }
      }
      if (text.includes('information_schema.tables')) {
        if (state.failQuery === 'tables') throw new Error('private table permission detail')
        const rows = state.tables ?? requiredTableRows()
        return { rows, rowCount: rows.length }
      }
      if (text.includes('information_schema.columns')) {
        if (state.failQuery === 'columns') throw new Error('private column permission detail')
        const rows = state.columns ?? requiredColumnRows()
        return { rows, rowCount: rows.length }
      }
      if (text.includes('pg_catalog.pg_constraint')) {
        if (state.failQuery === 'constraints') throw new Error('private constraint permission detail')
        const rows = state.constraints ?? requiredConstraintRows()
        return { rows, rowCount: rows.length }
      }
      if (text.includes('pg_catalog.pg_indexes')) {
        if (state.failQuery === 'indexes') throw new Error('private index permission detail')
        const rows = state.indexes ?? requiredIndexRows()
        return { rows, rowCount: rows.length }
      }
      throw new Error('Unexpected readiness query')
    },
    connect: async () => { throw new Error('Readiness must not open a transaction') },
    end: async () => undefined
  }
}

function requiredTableRows(): TableRow[] {
  return REQUIRED_TABLES.map((tableName) => ({ table_name: tableName }))
}

function requiredColumnRows(): ColumnRow[] {
  return Object.entries(REQUIRED_COLUMN_TYPES).flatMap(([tableName, columns]) => (
    Object.entries(columns).map(([columnName, dataType]) => ({
      table_name: tableName,
      column_name: columnName,
      data_type: dataType
    }))
  ))
}

function requiredConstraintRows(): ConstraintRow[] {
  return [REQUIRED_CONSTRAINTS, REQUIRED_RELATIONAL_CONSTRAINTS].flatMap((manifest) => (
    Object.entries(manifest).flatMap(([tableName, constraintNames]) => (
      constraintNames.map((constraintName) => {
        const actions = tableName in REQUIRED_FOREIGN_KEY_ACTIONS
          ? REQUIRED_FOREIGN_KEY_ACTIONS[tableName as keyof typeof REQUIRED_FOREIGN_KEY_ACTIONS][
              constraintName as keyof (typeof REQUIRED_FOREIGN_KEY_ACTIONS)[keyof typeof REQUIRED_FOREIGN_KEY_ACTIONS]
            ]
          : undefined
        return { table_name: tableName, constraint_name: constraintName, ...actions }
      })
    ))
  ))
}

function requiredIndexRows(): IndexRow[] {
  return Object.entries(REQUIRED_INDEXES).flatMap(([tableName, indexNames]) => (
    indexNames.map((indexName) => ({ table_name: tableName, index_name: indexName }))
  ))
}
