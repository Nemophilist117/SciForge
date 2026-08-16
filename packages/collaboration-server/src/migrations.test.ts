import { describe, expect, it } from 'vitest'

import { isCollaborationDatabaseReady } from './migrations.js'
import type { SqlPool } from './postgres.js'

const REQUIRED_TABLES = [
  'agent_nodes', 'audit_events', 'credentials', 'human_answers', 'human_endpoint_bindings',
  'human_endpoint_challenges', 'human_requests', 'inbox_cursors', 'inbox_messages',
  'participant_profiles', 'project_endpoint_bindings', 'project_input_cursors', 'project_inputs',
  'project_members', 'project_records', 'projects', 'provider_deliveries', 'provider_diagnostics',
  'provider_event_claims', 'provider_event_cursors', 'receipts', 'remote_session_projections',
  'resource_refs', 'schema_migrations', 'tasks', 'user_principals'
] as const

const REQUIRED_COLUMN_TYPES = {
  resource_refs: {
    resource_ref_id: 'text', project_id: 'text', task_id: 'text', task_revision: 'bigint',
    created_by_user_id: 'text', created_by_agent_id: 'text', provider: 'text', external_id: 'text',
    kind: 'text', name: 'text', open_url: 'text', provider_version: 'text', status: 'text',
    invalidated_at: 'timestamp with time zone', revision: 'bigint',
    created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone'
  },
  tasks: {
    task_id: 'text', project_id: 'text', status: 'text', progress_percent: 'integer',
    progress_summary: 'text', progress_reported_at: 'timestamp with time zone', result_summary: 'text',
    failure_summary: 'text', safe_failure_code: 'text', revision: 'bigint'
  }
} as const

const REQUIRED_CONSTRAINTS = {
  resource_refs: [
    'resource_refs_open_url_safe',
    'resource_refs_provenance_complete',
    'resource_refs_status_timestamp_consistent'
  ],
  tasks: [
    'tasks_progress_percent_range',
    'tasks_progress_summary_length',
    'tasks_progress_complete',
    'tasks_result_summary_state',
    'tasks_safe_failure_code_format',
    'tasks_safe_failure_code_state'
  ]
} as const

type TableRow = { table_name: unknown }
type ColumnRow = { table_name: unknown; column_name: unknown; data_type: unknown }
type ConstraintRow = { table_name: unknown; constraint_name: unknown }

type ReadyState = {
  versions?: unknown[]
  tables?: TableRow[]
  columns?: ColumnRow[]
  constraints?: ConstraintRow[]
  failQuery?: 'versions' | 'tables' | 'columns' | 'constraints'
}

describe('collaboration database readiness', () => {
  it('accepts only the complete current migration and schema manifest', async () => {
    await expect(isCollaborationDatabaseReady(poolFor())).resolves.toBe(true)
  })

  it.each([
    { label: 'a missing migration', versions: [1, 3] },
    { label: 'an extra future migration', versions: [1, 2, 3, 4] },
    { label: 'a duplicate migration marker', versions: [1, 2, 2, 3] },
    { label: 'a malformed migration marker', versions: [1, 2, 'not-a-version'] }
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

  it.each(['versions', 'tables', 'columns', 'constraints'] as const)(
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
        const rows = (state.versions ?? [1, 2, 3]).map((version) => ({ version }))
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
  return Object.entries(REQUIRED_CONSTRAINTS).flatMap(([tableName, constraintNames]) => (
    constraintNames.map((constraintName) => ({ table_name: tableName, constraint_name: constraintName }))
  ))
}
