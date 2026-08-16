import { readFile } from 'node:fs/promises'

import type { SqlPool } from './postgres.js'

export const COLLABORATION_SCHEMA_VERSION = 3

const COLLABORATION_MIGRATIONS = [
  '0001_collaboration_schema.sql',
  '0002_resource_refs.sql',
  '0003_task_progress.sql'
] as const

const REQUIRED_MIGRATION_VERSIONS = [1, 2, 3] as const

const REQUIRED_TABLES = [
  'agent_nodes',
  'audit_events',
  'credentials',
  'human_answers',
  'human_endpoint_bindings',
  'human_endpoint_challenges',
  'human_requests',
  'inbox_cursors',
  'inbox_messages',
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
  'user_principals'
] as const

const REQUIRED_COLUMN_TYPES = {
  resource_refs: {
    resource_ref_id: 'text',
    project_id: 'text',
    task_id: 'text',
    task_revision: 'bigint',
    created_by_user_id: 'text',
    created_by_agent_id: 'text',
    provider: 'text',
    external_id: 'text',
    kind: 'text',
    name: 'text',
    open_url: 'text',
    provider_version: 'text',
    status: 'text',
    invalidated_at: 'timestamp with time zone',
    revision: 'bigint',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone'
  },
  tasks: {
    task_id: 'text',
    project_id: 'text',
    status: 'text',
    progress_percent: 'integer',
    progress_summary: 'text',
    progress_reported_at: 'timestamp with time zone',
    result_summary: 'text',
    failure_summary: 'text',
    safe_failure_code: 'text',
    revision: 'bigint'
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

    const constraints = await pool.query<{ table_name: unknown; constraint_name: unknown }>(
      `SELECT relation.relname AS table_name, constraint_record.conname AS constraint_name
       FROM pg_catalog.pg_constraint AS constraint_record
       JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1
         AND relation.relname = ANY($2::text[])
         AND constraint_record.contype = 'c'
         AND constraint_record.convalidated`,
      ['sciforge_collaboration', Object.keys(REQUIRED_CONSTRAINTS)]
    )
    const presentConstraints = new Set(constraints.rows.map((row) => (
      `${String(row.table_name)}.${String(row.constraint_name)}`
    )))
    return hasRequiredNames(presentConstraints, REQUIRED_CONSTRAINTS)
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
