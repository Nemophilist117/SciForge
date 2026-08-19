import { describe, expect, it } from 'vitest'

import {
  serializePortableResourceReferenceCarrier
} from '@sciforge/collaboration-contracts'
// @ts-expect-error Test-only E contract bridge is runtime-typed by its source package.
import { toPortableContentFileReference } from '../../../test-fixtures/collaboration/e-content-space-portable.mjs'

import { COLLABORATION_SCHEMA_VERSION, runCollaborationMigrations } from './migrations.js'
import type {
  StoredActionConfirmation,
  StoredAgentCapabilityProfile,
  StoredExternalIdentity,
  StoredHumanAnswer,
  StoredHumanRequest,
  StoredInboxMessage,
  StoredOidcIdentity,
  StoredProjectRecord,
  StoredResourceRef,
  StoredTask,
  StoredZulipBindingRequest
} from './model.js'
import {
  createPostgresPool,
  formatPostgresPoolDiagnostic,
  PostgresCollaborationRepository,
  type PostgresPoolDiagnostic,
  type SqlConnection,
  type SqlPool
} from './postgres.js'

describe('PostgreSQL pool diagnostics', () => {
  it.each([
    ['57P01', true],
    ['57P02', true],
    ['57P03', true],
    ['08006', true],
    ['23505', false]
  ] as const)('handles idle-client SQLSTATE %s without exposing the error or client', async (code, retryable) => {
    const sensitiveMarker = `POOL_SECRET_${code}`
    const diagnostics: PostgresPoolDiagnostic[] = []
    const pool = createPostgresPool({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      onPoolDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })
    const eventedPool = pool as SqlPool & {
      emit(event: 'error', error: unknown, client: unknown): boolean
      listenerCount(event: 'error'): number
    }

    expect(eventedPool.listenerCount('error')).toBeGreaterThan(0)
    expect(() => eventedPool.emit('error', Object.assign(new Error(sensitiveMarker), {
      code,
      stack: `stack:${sensitiveMarker}`,
      connectionParameters: { password: sensitiveMarker }
    }), { secretKey: sensitiveMarker })).not.toThrow()

    expect(diagnostics).toEqual([{
      event: 'postgres.pool.idle_client_error',
      postgresCode: code,
      retryable
    }])
    expect(JSON.stringify(diagnostics)).not.toContain(sensitiveMarker)
    await pool.end()
  })

  it('normalizes malformed SQLSTATE values, swallows diagnostic sink failures, and emits safe one-line JSON', async () => {
    const sensitiveMarker = 'POOL_SECRET_MALFORMED'
    const diagnostics: PostgresPoolDiagnostic[] = []
    const pool = createPostgresPool({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      onPoolDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })
    const eventedPool = pool as SqlPool & {
      emit(event: 'error', error: unknown, client: unknown): boolean
    }

    expect(() => eventedPool.emit('error', {
      code: `57P01\n${sensitiveMarker}`,
      message: sensitiveMarker,
      stack: sensitiveMarker
    }, { secretKey: sensitiveMarker })).not.toThrow()
    expect(diagnostics).toEqual([{
      event: 'postgres.pool.idle_client_error',
      postgresCode: 'unknown',
      retryable: false
    }])

    const throwingSinkPool = createPostgresPool({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      onPoolDiagnostic: () => { throw new Error(sensitiveMarker) }
    }) as SqlPool & { emit(event: 'error', error: unknown, client: unknown): boolean }
    expect(() => throwingSinkPool.emit('error', { code: '57P01' }, { secretKey: sensitiveMarker })).not.toThrow()

    const noSinkPool = createPostgresPool({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused'
    }) as SqlPool & { emit(event: 'error', error: unknown, client: unknown): boolean }
    expect(() => noSinkPool.emit('error', { code: '57P01' }, { secretKey: sensitiveMarker })).not.toThrow()

    const line = formatPostgresPoolDiagnostic({
      ...diagnostics[0],
      rawError: sensitiveMarker,
      client: { secretKey: sensitiveMarker }
    } as PostgresPoolDiagnostic, new Date('2026-08-17T03:00:00.000Z'))
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({
      occurredAt: '2026-08-17T03:00:00.000Z',
      level: 'error',
      component: 'postgres',
      event: 'postgres.pool.idle_client_error',
      postgresCode: 'unknown',
      retryable: false
    })
    expect(line).not.toContain(sensitiveMarker)
    expect(line).not.toContain('secretKey')
    await pool.end()
    await throwingSinkPool.end()
    await noSinkPool.end()
  })
})

describe('PostgreSQL production transaction path', () => {
  it('atomically materializes pending HumanNeeded expiry with revision and timestamp updates', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        if (text.includes('UPDATE sciforge_collaboration.human_requests')) return { rows: [], rowCount: 2 }
        if (text.includes('DELETE FROM sciforge_collaboration.inbox_messages')) return { rows: [], rowCount: 3 }
        if (text.includes('DELETE FROM sciforge_collaboration.receipts')) return { rows: [], rowCount: 4 }
        if (text.includes('DELETE FROM sciforge_collaboration.human_endpoint_challenges')) {
          return { rows: [], rowCount: 5 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })
    const expiredAt = '2026-08-15T04:00:00.000Z'

    await expect(repository.pruneExpired(expiredAt)).resolves.toEqual({
      inboxMessages: 3, receipts: 4, challenges: 5, humanRequests: 2
    })

    const expiry = queries.find(({ text }) => text.includes('UPDATE sciforge_collaboration.human_requests'))
    const normalized = expiry?.text.replace(/\s+/g, ' ').trim()
    expect(normalized).toContain("SET status='expired',revision=revision+1,updated_at=$1")
    expect(normalized).toContain("WHERE status='pending' AND expires_at<=$1")
    expect(expiry?.values).toEqual([expiredAt])
    const confirmationExpiry = queries.find(({ text }) => text.includes('UPDATE sciforge_collaboration.action_confirmations'))
    const normalizedConfirmationExpiry = confirmationExpiry?.text.replace(/\s+/g, ' ').trim()
    expect(normalizedConfirmationExpiry).toContain("SET status='superseded',updated_at=$1")
    expect(normalizedConfirmationExpiry).toContain("WHERE status='approved' AND expires_at<=$1")
    expect(confirmationExpiry?.values).toEqual([expiredAt])
    const inboxTombstone = queries.find(({ text }) => text.includes('UPDATE sciforge_collaboration.inbox_messages'))
    const inboxDelete = queries.find(({ text }) => text.includes('DELETE FROM sciforge_collaboration.inbox_messages'))
    expect(inboxTombstone?.text.replace(/\s+/gu, ' ')).toContain('message.expires_at<=$1')
    expect(inboxDelete?.text.replace(/\s+/gu, ' ')).toContain('message.expires_at<=$1')
    expect(queries[0]?.text).toBe('BEGIN')
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })

  it('revokes only the selected live credential and reports an already-revoked credential', async () => {
    const writes: Array<{ text: string; values: readonly unknown[] }> = []
    let revokeAttempt = 0
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        writes.push({ text, values })
        if (text.includes('UPDATE sciforge_collaboration.credentials')) {
          revokeAttempt += 1
          return { rows: [], rowCount: revokeAttempt === 1 ? 1 : 0 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })
    const revokedAt = '2026-08-17T03:00:00.000Z'

    await repository.transaction(async (tx) => {
      await expect(tx.revokeCredential('crd_SelectedCredential1', revokedAt)).resolves.toBe(true)
      await expect(tx.revokeCredential('crd_SelectedCredential1', revokedAt)).resolves.toBe(false)
    })

    const revocations = writes.filter(({ text }) => text.includes('UPDATE sciforge_collaboration.credentials'))
    expect(revocations).toHaveLength(2)
    for (const revocation of revocations) {
      expect(revocation.text).toContain('WHERE credential_id=$1 AND revoked_at IS NULL')
      expect(revocation.text).not.toContain('subject_user_id')
      expect(revocation.text).not.toContain('subject_agent_id')
      expect(revocation.values).toEqual(['crd_SelectedCredential1', revokedAt])
    }
  })

  it('runs the ordered collaboration migrations through schema version 6', async () => {
    const migrations: string[] = []
    const pool: SqlPool = {
      query: async (text) => { migrations.push(text); return { rows: [], rowCount: 0 } },
      connect: async () => { throw new Error('Migration runner must not open an application transaction') },
      end: async () => undefined
    }

    await runCollaborationMigrations(pool)

    expect(COLLABORATION_SCHEMA_VERSION).toBe(6)
    expect(migrations).toHaveLength(6)
    expect(migrations[1]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.resource_refs')
    expect(migrations[1]).toContain('created_by_user_id text NOT NULL')
    expect(migrations[1]).toContain('CONSTRAINT resource_refs_open_url_safe')
    expect(migrations[1]).toContain('CONSTRAINT resource_refs_provenance_complete')
    expect(migrations[1]).toContain('CONSTRAINT resource_refs_status_timestamp_consistent')
    expect(migrations[1]).not.toContain('UNIQUE (project_id, provider, external_id)')
    expect(migrations[1]).toContain("open_url ~* '^https://[^/?#@[:space:]]+([/?]|$)'")
    expect(migrations[1]).toContain('VALUES (2)')
    expect(migrations[2]).toContain('ADD COLUMN IF NOT EXISTS progress_percent')
    expect(migrations[2]).toContain('ADD COLUMN IF NOT EXISTS safe_failure_code')
    expect(migrations[2]).toContain("SET safe_failure_code = 'task_failed'")
    expect(migrations[2]).toContain("SET result_summary = 'Legacy task completed before structured result capture.'")
    expect(migrations[2]).toContain('tasks_progress_percent_range')
    expect(migrations[2]).toContain('tasks_progress_summary_length')
    expect(migrations[2]).toContain('tasks_progress_complete')
    expect(migrations[2]).toContain('tasks_result_summary_state')
    expect(migrations[2]).toContain('tasks_safe_failure_code_format')
    expect(migrations[2]).toContain('tasks_safe_failure_code_state')
    expect(migrations[2]).toContain('VALUES (3)')
    expect(migrations[3]).toContain('ADD COLUMN IF NOT EXISTS execution_id text')
    expect(migrations[3]).toContain("'criterionId', 'cri_' || substr(md5(task.task_id")
    expect(migrations[3]).toContain("'text', item.value #>> '{}'")
    expect(migrations[3]).toContain('ADD COLUMN IF NOT EXISTS safe_failure_summary text')
    expect(migrations[3]).toContain('ADD COLUMN IF NOT EXISTS assignee_user_id text')
    expect(migrations[3]).toContain('ADD COLUMN IF NOT EXISTS required_capabilities jsonb')
    expect(migrations[3]).toContain('tasks_assignee_owner_fk')
    expect(migrations[3]).toMatch(/tasks_assignee_owner_fk[\s\S]*?ON UPDATE CASCADE/u)
    expect(migrations[3]).toContain('tasks_coordination_requirements_shape')
    expect(migrations[3]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.agent_capability_profiles')
    expect(migrations[3]).toMatch(/agent_capability_profiles_owner_fk[\s\S]*?ON UPDATE NO ACTION[\s\S]*?ON DELETE CASCADE/u)
    expect(migrations[3]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.action_confirmations')
    expect(migrations[3]).toContain("confirmable_action ? 'projectId'")
    expect(migrations[3]).toContain("confirmable_action->>'projectId' = project_id")
    expect(migrations[3]).toContain("action ? 'projectId'")
    expect(migrations[3]).toContain("action->>'projectId' = project_id")
    expect(migrations[3]).not.toContain("NOT (confirmable_action ? 'projectId')")
    expect(migrations[3]).not.toContain("NOT (action ? 'projectId')")
    expect(migrations[3]).toContain('ADD COLUMN IF NOT EXISTS disposition text NOT NULL')
    expect(migrations[3]).toContain('project_records_task_result_execution_unique')
    expect(migrations[3]).toMatch(
      /WHERE kind = 'task_result'\s+AND status = 'accepted'[\s\S]*?GROUP BY source_task_id, source_execution_id\s+HAVING count\(\*\) > 1[\s\S]*?ERRCODE = 'P0001',\s+MESSAGE = 'migration_0004_multiple_accepted_task_results'/u
    )
    expect(migrations[3]).toMatch(
      /PARTITION BY source_task_id, source_execution_id\s+ORDER BY\s+CASE status\s+WHEN 'accepted' THEN 0\s+WHEN 'candidate' THEN 1\s+ELSE 2\s+END,\s+updated_at DESC,\s+project_record_id ASC/u
    )
    expect(migrations[3]).toMatch(
      /SET status = 'superseded',\s+revision = record\.revision \+ 1,\s+updated_at = CURRENT_TIMESTAMP[\s\S]*?ranked\.canonical_rank > 1/u
    )
    expect(migrations[3]).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS project_records_task_result_execution_unique[\s\S]*?WHERE kind = 'task_result' AND status <> 'superseded';/u
    )
    expect(migrations[3]).toContain("'rec_' || substr(md5(task.task_id || ':schema-v4-result')")
    expect(migrations[3]).toMatch(
      /task\.result_summary,\s*NULL,\s*task\.assignee_agent_id,\s*task\.task_id,\s*task\.execution_id,\s*task\.revision,/u
    )
    expect(migrations[3]).not.toMatch(
      /task\.result_summary,\s*NULL,\s*task\.created_by_agent_id,/u
    )
    expect(migrations[3]).toMatch(
      /FROM sciforge_collaboration\.project_records AS existing\s+WHERE existing\.kind = 'task_result'\s+AND existing\.status <> 'superseded'[\s\S]*?existing\.source_execution_id = task\.execution_id/u
    )
    expect(migrations[3]).toMatch(
      /SET result_record_id = record\.project_record_id[\s\S]*?record\.kind = 'task_result'\s+AND record\.status <> 'superseded'[\s\S]*?record\.source_execution_id = task\.execution_id;/u
    )
    const sourceExecutionBackfillAt = migrations[3].indexOf('SET source_execution_id = task.execution_id')
    const reconciliationAt = migrations[3].indexOf('WITH ranked_task_results AS')
    const canonicalIndexAt = migrations[3]
      .indexOf('CREATE UNIQUE INDEX IF NOT EXISTS project_records_task_result_execution_unique')
    expect(sourceExecutionBackfillAt).toBeGreaterThanOrEqual(0)
    expect(reconciliationAt).toBeGreaterThan(sourceExecutionBackfillAt)
    expect(canonicalIndexAt).toBeGreaterThan(reconciliationAt)
    expect(migrations[3]).toContain('tasks_result_record_state')
    expect(migrations[3]).toContain('VALUES (4)')
    expect(migrations[4]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.oidc_identities')
    expect(migrations[4]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.device_enrollments')
    expect(migrations[4]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.devices')
    expect(migrations[4]).toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.zulip_binding_requests')
    expect(migrations[4]).not.toContain('CREATE TABLE IF NOT EXISTS sciforge_collaboration.external_identities')
    expect(migrations[4]).toContain('human_endpoint_bindings_zulip_provider_identity_active_unique')
    expect(migrations[4]).toContain('human_endpoint_bindings_zulip_user_realm_active_unique')
    expect(migrations[4]).toContain('human_endpoint_bindings_other_provider_identity_active_unique')
    expect(migrations[4]).toContain('agent_nodes_active_device_required')
    expect(migrations[4]).toContain('agent_nodes_device_owner_fk')
    expect(migrations[4]).toContain("credential.kind = 'agent_device'")
    expect(migrations[4]).toContain("agent.status = 'active'")
    expect(migrations[4]).toContain('VALUES (5)')
    expect(migrations[5]).toContain('ADD COLUMN IF NOT EXISTS portable_reference text')
    expect(migrations[5]).toContain('ALTER COLUMN open_url DROP NOT NULL')
    expect(migrations[5]).toContain('resource_refs_portable_reference_safe')
    expect(migrations[5]).toContain("'content-space.file-reference'")
    expect(migrations[5]).toContain('VALUES (6)')
  })

  it('reconciles representative legacy TaskResult fixtures deterministically', () => {
    type LegacyStatus = 'candidate' | 'accepted' | 'rejected'
    type LegacyResult = {
      projectRecordId: string
      status: LegacyStatus
      revision: number
      updatedAt: string
    }
    const migrationAt = '2026-08-18T12:00:00.000Z'
    const priority: Record<LegacyStatus, number> = { accepted: 0, candidate: 1, rejected: 2 }
    const reconcile = (input: readonly LegacyResult[]) => {
      const accepted = input.filter((record) => record.status === 'accepted')
      if (accepted.length > 1) throw new Error('migration_0004_multiple_accepted_task_results')
      const ranked = [...input].sort((left, right) => {
        const statusOrder = priority[left.status] - priority[right.status]
        if (statusOrder !== 0) return statusOrder
        const updatedOrder = right.updatedAt.localeCompare(left.updatedAt)
        return updatedOrder !== 0 ? updatedOrder : left.projectRecordId.localeCompare(right.projectRecordId)
      })
      const canonicalId = ranked[0]?.projectRecordId
      return {
        canonicalId,
        records: input.map((record) => record.projectRecordId === canonicalId
          ? record
          : { ...record, status: 'superseded' as const, revision: record.revision + 1, updatedAt: migrationAt })
      }
    }

    const duplicateCandidates = reconcile([
      { projectRecordId: 'rec_LegacyCandidateOld', status: 'candidate', revision: 2,
        updatedAt: '2026-08-17T12:00:00.000Z' },
      { projectRecordId: 'rec_LegacyCandidateB', status: 'candidate', revision: 4,
        updatedAt: '2026-08-18T12:00:00.000Z' },
      { projectRecordId: 'rec_LegacyCandidateA', status: 'candidate', revision: 5,
        updatedAt: '2026-08-18T12:00:00.000Z' }
    ])
    expect(duplicateCandidates.canonicalId).toBe('rec_LegacyCandidateA')
    expect(duplicateCandidates.records).toContainEqual({
      projectRecordId: 'rec_LegacyCandidateOld', status: 'superseded', revision: 3, updatedAt: migrationAt
    })

    const acceptedWins = reconcile([
      { projectRecordId: 'rec_LegacyAccepted', status: 'accepted', revision: 3,
        updatedAt: '2026-08-16T12:00:00.000Z' },
      { projectRecordId: 'rec_LegacyCandidate', status: 'candidate', revision: 5,
        updatedAt: '2026-08-18T12:00:00.000Z' }
    ])
    expect(acceptedWins.canonicalId).toBe('rec_LegacyAccepted')
    expect(acceptedWins.records.filter(({ status }) => status !== 'superseded')).toHaveLength(1)
    expect(acceptedWins.records.find(({ status }) => status !== 'superseded')?.projectRecordId)
      .toBe(acceptedWins.canonicalId)
    expect(acceptedWins.records.find(({ projectRecordId }) => projectRecordId === 'rec_LegacyCandidate'))
      .toMatchObject({ status: 'superseded', revision: 6, updatedAt: migrationAt })

    expect(() => reconcile([
      { projectRecordId: 'rec_LegacyAcceptedA', status: 'accepted', revision: 1,
        updatedAt: '2026-08-17T12:00:00.000Z' },
      { projectRecordId: 'rec_LegacyAcceptedB', status: 'accepted', revision: 1,
        updatedAt: '2026-08-18T12:00:00.000Z' }
    ])).toThrowError('migration_0004_multiple_accepted_task_results')
  })

  it('maps and revision-guards structured Task progress in PostgreSQL', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const task: StoredTask = {
      taskId: 'tsk_PostgresTask1', projectId: 'prj_PostgresTask1', executionId: 'exe_PostgresTask1',
      assigneeAgentId: 'agt_PostgresWork1', assigneeUserId: 'usr_PostgresWork1',
      createdByAgentId: 'agt_PostgresCoord', title: 'PostgreSQL progress', objective: 'Persist progress.',
      completionCriteria: [{ criterionId: 'cri_PostgresTask1', text: 'Progress is durable' }],
      dependencyTaskIds: [], requiredCapabilities: { capabilityIds: ['local-files'], vpnAccessIds: [],
        slurmClusterIds: [], requiredResourceRefIds: [] }, resourceRefIds: ['rrf_PostgresTask1'],
      authorizationRequirements: [{ id: 'auth_PostgresTask1', kind: 'resource_access',
        targetRefId: 'rrf_PostgresTask1', description: 'Read the cited input.' }],
      status: 'in_progress', retryCount: 0,
      maxRetries: 2, coordinationRound: 1, progress: { percent: 40, summary: 'Input validation complete.',
        reportedAt: at }, revision: 4, createdAt: at, updatedAt: at
    }
    const taskRow = { task_id: task.taskId, project_id: task.projectId, execution_id: task.executionId,
      assignee_agent_id: task.assigneeAgentId, assignee_user_id: task.assigneeUserId,
      created_by_agent_id: task.createdByAgentId,
      title: task.title, objective: task.objective, completion_criteria: task.completionCriteria,
      dependency_task_ids: task.dependencyTaskIds, required_capabilities: task.requiredCapabilities,
      resource_ref_ids: task.resourceRefIds, authorization_requirements: task.authorizationRequirements,
      status: task.status, retry_count: task.retryCount,
      max_retries: task.maxRetries, coordination_round: task.coordinationRound, active_turn_id: null,
      progress_percent: task.progress?.percent, progress_summary: task.progress?.summary,
      progress_reported_at: new Date(at), result_summary: null, result_record_id: null,
      failure_summary: 'legacy private failure text must not escape', safe_failure_code: null,
      safe_failure_summary: null,
      revision: task.revision, created_at: new Date(at), updated_at: new Date(at), completed_at: null }
    const writes: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        writes.push({ text, values })
        return text.includes('FOR UPDATE') ? { rows: [taskRow], rowCount: 1 } : { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const pool: SqlPool = {
      query: async (text) => text.includes('FROM sciforge_collaboration.tasks')
        ? { rows: [taskRow], rowCount: 1 }
        : { rows: [], rowCount: 0 },
      connect: async () => connection,
      end: async () => undefined
    }
    const repository = new PostgresCollaborationRepository(pool)

    await expect(repository.getTask(task.taskId)).resolves.toEqual(task)
    await repository.transaction(async (tx) => {
      await expect(tx.getTaskForUpdate(task.taskId)).resolves.toEqual(task)
      await tx.insertTask(task)
      await tx.updateTask({ ...task, progress: { percent: 60,
        summary: 'Analysis is running.', reportedAt: at }, revision: 5 }, 4)
    })

    expect(writes.find(({ text }) => text.includes('FOR UPDATE'))?.values).toEqual([task.taskId])
    const insert = writes.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.tasks'))
    expect(insert?.values.slice(3, 13)).toEqual([
      task.assigneeAgentId, task.assigneeUserId, task.createdByAgentId, task.title, task.objective,
      JSON.stringify(task.completionCriteria), JSON.stringify(task.dependencyTaskIds),
      JSON.stringify(task.requiredCapabilities), JSON.stringify(task.resourceRefIds),
      JSON.stringify(task.authorizationRequirements)
    ])
    const update = writes.find(({ text }) => text.includes('UPDATE sciforge_collaboration.tasks'))
    expect(update?.text).toContain('progress_percent=$17')
    expect(update?.text).toContain('safe_failure_code=$22')
    expect(update?.text).toContain('safe_failure_summary=$23')
    expect(update?.text).not.toMatch(/(^|[,\s])failure_summary=/u)
    expect(update?.values.slice(16, 19)).toEqual([60, 'Analysis is running.', at])
    expect(update?.values.at(-1)).toBe(4)
  })

  it('maps only the safe Task failure code and never exposes legacy failure text', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const row = {
      task_id: 'tsk_PostgresFail1', project_id: 'prj_PostgresFail1', execution_id: 'exe_PostgresFail1',
      assignee_agent_id: 'agt_PostgresWork1', assignee_user_id: 'usr_PostgresWork1',
      created_by_agent_id: 'agt_PostgresCoord',
      title: 'PostgreSQL failure', objective: 'Persist a safe failure code.',
      completion_criteria: [], dependency_task_ids: [],
      required_capabilities: { capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: [] },
      resource_ref_ids: [], authorization_requirements: [], status: 'failed', retry_count: 0,
      max_retries: 2, coordination_round: 1, active_turn_id: null,
      progress_percent: null, progress_summary: null, progress_reported_at: null,
      result_summary: null, result_record_id: null,
      failure_summary: 'legacy private diagnostic text must remain hidden',
      safe_failure_code: 'worker_failed', safe_failure_summary: 'Worker returned a bounded failure summary.', revision: 2,
      created_at: new Date(at), updated_at: new Date(at), completed_at: new Date(at)
    }
    const pool: SqlPool = {
      query: async () => ({ rows: [row], rowCount: 1 }),
      connect: async () => { throw new Error('Read path must not open a transaction') },
      end: async () => undefined
    }

    const mapped = await new PostgresCollaborationRepository(pool).getTask(row.task_id)

    expect(mapped).toMatchObject({ status: 'failed', safeFailureCode: 'worker_failed',
      safeFailureSummary: 'Worker returned a bounded failure summary.' })
    expect(JSON.stringify(mapped)).not.toContain('legacy private diagnostic')
  })

  it('uses explicit row locking and counts only non-terminal Project Tasks', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const projectRow = {
      project_id: 'prj_PostgresLock1', owner_user_id: 'usr_PostgresOwner1',
      display_name: 'Locked Project', goal: 'Serialize lifecycle transitions.', status: 'active',
      coordinator_agent_id: 'agt_PostgresCoord', max_tasks: 20, max_tasks_per_round: 5,
      max_task_retries: 2, max_coordination_rounds: 3, coordination_round: 1, revision: 4,
      created_at: new Date(at), updated_at: new Date(at)
    }
    const reads: Array<{ text: string; values: readonly unknown[] }> = []
    const writes: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        writes.push({ text, values })
        if (text.includes('FROM sciforge_collaboration.projects') && text.includes('FOR UPDATE')) {
          return { rows: [projectRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const pool: SqlPool = {
      query: async (text, values = []) => {
        reads.push({ text, values })
        return { rows: [{ count: '3' }], rowCount: 1 }
      },
      connect: async () => connection,
      end: async () => undefined
    }
    const repository = new PostgresCollaborationRepository(pool)

    await expect(repository.countOpenProjectTasks(projectRow.project_id)).resolves.toBe(3)
    await repository.transaction(async (tx) => {
      await expect(tx.getProjectForUpdate(projectRow.project_id)).resolves.toMatchObject({
        projectId: projectRow.project_id,
        status: 'active',
        revision: 4
      })
    })

    const count = reads.find(({ text }) => text.includes('count(*)'))
    expect(count?.text).toContain("status IN ('offered','accepted','in_progress','needs_human')")
    expect(count?.values).toEqual([projectRow.project_id])
    const lock = writes.find(({ text }) => text.includes('FROM sciforge_collaboration.projects'))
    expect(lock?.text).toContain('FOR UPDATE')
    expect(lock?.values).toEqual([projectRow.project_id])
  })

  it('locks an Agent row before ownership-sensitive assignment checks', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const agentRow = {
      agent_id: 'agt_PostgresOwnerLock1', installation_id: 'ins_PostgresOwnerLock1',
      owner_user_id: 'usr_PostgresOwnerLock1', display_name: 'Locked Agent', node_type: 'desktop',
      capabilities: ['research.execute'], status: 'active', connection_status: 'online',
      credential_generation: 1, revision: 3, last_seen_at: new Date(at), updated_at: new Date(at), revoked_at: null
    }
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        if (text.includes('FROM sciforge_collaboration.agent_nodes') && text.includes('FOR UPDATE')) {
          return { rows: [agentRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })

    await repository.transaction(async (tx) => {
      await expect(tx.getAgentForUpdate(agentRow.agent_id)).resolves.toMatchObject({
        agentId: agentRow.agent_id,
        ownerUserId: agentRow.owner_user_id,
        revision: agentRow.revision
      })
    })

    const lock = queries.find(({ text }) => text.includes('FROM sciforge_collaboration.agent_nodes'))
    expect(lock?.text).toContain('WHERE agent_id = $1 FOR UPDATE')
    expect(lock?.values).toEqual([agentRow.agent_id])
  })

  it('locks a User row before lifecycle and ownership-sensitive writes', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const userRow = {
      user_id: 'usr_PostgresUserLock1', display_name: 'Locked User', status: 'active', revision: 3,
      created_at: new Date(at), updated_at: new Date(at), revoked_at: null
    }
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        if (text.includes('FROM sciforge_collaboration.user_principals') && text.includes('FOR UPDATE')) {
          return { rows: [userRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })

    await repository.transaction(async (tx) => {
      await expect(tx.getUserForUpdate(userRow.user_id)).resolves.toMatchObject({
        userId: userRow.user_id,
        status: 'active',
        revision: userRow.revision
      })
    })

    const lock = queries.find(({ text }) => text.includes('FROM sciforge_collaboration.user_principals'))
    expect(lock?.text).toContain('WHERE user_id = $1 FOR UPDATE')
    expect(lock?.values).toEqual([userRow.user_id])
  })

  it('locks and revision-cancels every pending HumanNeeded request for a reassigned Task', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const requests: StoredHumanRequest[] = [1, 2].map((index) => ({
      humanRequestId: `hrq_PostgresPending${index}`, projectId: 'prj_PostgresHuman1',
      sourceKind: 'worker', taskId: 'tsk_PostgresHuman1', executionId: 'exe_PostgresHuman1',
      targetUserId: 'usr_PostgresTarget1',
      requestedByAgentId: 'agt_PostgresWorker1', requiredAssurance: 'verified',
      prompt: `Pending question ${index}`, status: 'pending', revision: index,
      expiresAt: '2026-08-15T03:00:00.000Z', createdAt: at, updatedAt: at
    }))
    const rows = requests.map((request) => ({
      human_request_id: request.humanRequestId, project_id: request.projectId, source_kind: request.sourceKind,
      task_id: request.taskId, execution_id: request.executionId, source_inbox_message_id: null,
      target_user_id: request.targetUserId, requested_by_agent_id: request.requestedByAgentId,
      required_assurance: request.requiredAssurance, prompt: request.prompt, status: request.status,
      confirmable_action: null,
      revision: request.revision, expires_at: new Date(request.expiresAt),
      created_at: new Date(request.createdAt), updated_at: new Date(request.updatedAt)
    }))
    const writes: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        writes.push({ text, values })
        if (text.includes('FROM sciforge_collaboration.human_requests') && text.includes('FOR UPDATE')) {
          return { rows, rowCount: rows.length }
        }
        return { rows: [], rowCount: text.includes('UPDATE sciforge_collaboration.human_requests') ? 1 : 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    })

    await repository.transaction(async (tx) => {
      const locked = await tx.listPendingHumanRequestsForTaskForUpdate('tsk_PostgresHuman1')
      expect(locked).toEqual(requests)
      for (const request of locked) {
        await tx.updateHumanRequest({ ...request, status: 'cancelled',
          revision: request.revision + 1, updatedAt: at }, request.revision)
      }
    })

    const lock = writes.find(({ text }) => text.includes('FROM sciforge_collaboration.human_requests'))
    expect(lock?.text).toContain("WHERE task_id=$1 AND status='pending'")
    expect(lock?.text).toContain('ORDER BY created_at,human_request_id FOR UPDATE')
    expect(lock?.values).toEqual(['tsk_PostgresHuman1'])
    const cancellations = writes.filter(({ text }) => text.includes('UPDATE sciforge_collaboration.human_requests'))
    expect(cancellations).toHaveLength(2)
    expect(cancellations.map(({ values }) => values)).toEqual(requests.map((request) => [
      request.humanRequestId, 'cancelled', request.revision + 1, at, request.revision
    ]))
  })

  it('maps and revision-guards ResourceRef metadata in PostgreSQL', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const portableReference = toPortableContentFileReference({
      providerInstanceRef: 'opencontent.postgres',
      fileId: 'postgres-document-42'
    })
    const resource: StoredResourceRef = {
      resourceRefId: 'rrf_Postgres0012', projectId: 'prj_Postgres0012', taskId: 'tsk_Postgres0012',
      executionId: 'exe_Postgres0012', taskRevision: 3, createdByUserId: 'usr_PostgresUser1',
      createdByAgentId: 'agt_PostgresWork1',
      provider: 'opencontent', externalId: 'postgres-document-42', kind: 'content-space.file-reference',
      name: 'PostgreSQL ResourceRef', portableReference,
      version: '1', status: 'available', revision: 1, createdAt: at, updatedAt: at
    }
    const writes: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => { writes.push({ text, values }); return { rows: [], rowCount: 1 } },
      release: () => undefined
    }
    const pool: SqlPool = {
      query: async (text, values = []) => {
        if (text.includes('FROM sciforge_collaboration.resource_refs')) {
          return { rows: [{ resource_ref_id: resource.resourceRefId, project_id: resource.projectId,
            task_id: resource.taskId, execution_id: resource.executionId, task_revision: resource.taskRevision,
            created_by_user_id: resource.createdByUserId, created_by_agent_id: resource.createdByAgentId,
            provider: resource.provider, external_id: resource.externalId,
            kind: resource.kind, name: resource.name, open_url: null,
            portable_reference: serializePortableResourceReferenceCarrier(portableReference),
            provider_version: resource.version,
            status: resource.status, status_reason_code: null, unavailable_at: null, revoked_at: null,
            invalidated_at: null, revision: resource.revision,
            created_at: new Date(at), updated_at: new Date(at) }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => connection,
      end: async () => undefined
    }
    const repository = new PostgresCollaborationRepository(pool)

    await expect(repository.getResourceRef(resource.resourceRefId)).resolves.toEqual(resource)
    await repository.transaction(async (tx) => {
      await tx.insertResourceRef(resource)
      await tx.updateResourceRef({ ...resource, status: 'invalidated', invalidatedAt: at,
        revision: 2, updatedAt: at }, 1)
    })

    const insert = writes.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.resource_refs'))
    const update = writes.find(({ text }) => text.includes('UPDATE sciforge_collaboration.resource_refs'))
    expect(insert?.values).toEqual([resource.resourceRefId, resource.projectId, resource.taskId,
      resource.executionId, resource.taskRevision, resource.createdByUserId, resource.createdByAgentId, resource.provider,
      resource.externalId, resource.kind, resource.name, null,
      serializePortableResourceReferenceCarrier(portableReference), resource.version,
      'available', null, null, null, null, 1, at, at])
    expect(update?.values).toEqual([resource.resourceRefId, 'invalidated', null, null, null, at, 2, at, 1])
  })

  it('maps named ResourceRef check violations to the public validation error', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const resource: StoredResourceRef = {
      resourceRefId: 'rrf_PostgresSafe01', projectId: 'prj_PostgresSafe01',
      createdByUserId: 'usr_PostgresSafe01', provider: 'example-content', externalId: 'safe-document',
      kind: 'shared_document', name: 'Safe document', openUrl: 'https://content.example.invalid/safe-document',
      status: 'available', revision: 1, createdAt: at, updatedAt: at
    }
    const queries: string[] = []
    const connection: SqlConnection = {
      query: async (text) => {
        queries.push(text)
        if (text.includes('INSERT INTO sciforge_collaboration.resource_refs')) {
          throw Object.assign(new Error('private PostgreSQL constraint detail'), {
            code: '23514', constraint: 'resource_refs_open_url_safe'
          })
        }
        return { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const pool: SqlPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    }
    const repository = new PostgresCollaborationRepository(pool)

    await expect(repository.transaction((tx) => tx.insertResourceRef(resource)))
      .rejects.toMatchObject({ code: 'validation_failed' })
    expect(queries.at(-1)).toBe('ROLLBACK')
  })

  it('maps only allowlisted ResourceRef safety checks without exposing database detail', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const resource: StoredResourceRef = {
      resourceRefId: 'rrf_Constraint001', projectId: 'prj_Constraint001',
      createdByUserId: 'usr_Constraint001', provider: 'example-content', externalId: 'document-42',
      kind: 'shared_document', name: 'Constraint test', openUrl: 'https://content.example.invalid/document-42',
      status: 'available', revision: 1, createdAt: at, updatedAt: at
    }
    const repositoryFor = (constraint: string) => new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async (text) => {
          if (text.includes('INSERT INTO sciforge_collaboration.resource_refs')) {
            throw Object.assign(new Error('private database row detail'), {
              code: '23514', constraint, detail: 'open_url contained private material'
            })
          }
          return { rows: [], rowCount: 1 }
        },
        release: () => undefined
      }),
      end: async () => undefined
    })

    const safeError = await repositoryFor('resource_refs_open_url_safe')
      .transaction((tx) => tx.insertResourceRef(resource)).catch((error: unknown) => error)
    expect(safeError).toMatchObject({
      code: 'validation_failed',
      message: 'ResourceRef metadata failed a storage safety constraint.'
    })
    expect(String((safeError as Error).message)).not.toContain('private')

    const reasonError = await repositoryFor('resource_refs_status_reason_format')
      .transaction((tx) => tx.insertResourceRef(resource)).catch((error: unknown) => error)
    expect(reasonError).toMatchObject({ code: 'validation_failed' })

    const unknownError = await repositoryFor('unrelated_table_private_check')
      .transaction((tx) => tx.insertResourceRef(resource)).catch((error: unknown) => error)
    expect(unknownError).toMatchObject({ code: '23514', constraint: 'unrelated_table_private_check' })
    expect(unknownError).not.toMatchObject({ code: 'validation_failed' })
  })

  it('binds inbox expiry before LIMIT using PostgreSQL-compatible parameter types', async () => {
    const captured: Array<{ text: string; values: readonly unknown[] }> = []
    const pool: SqlPool = {
      query: async (text, values = []) => {
        captured.push({ text, values })
        if (text.includes('FROM sciforge_collaboration.inbox_messages')) {
          if (typeof values[3] !== 'string' || !Number.isFinite(new Date(values[3]).valueOf())) {
            throw Object.assign(new Error('invalid input syntax for type timestamp with time zone'), { code: '22007' })
          }
          if (!Number.isSafeInteger(values[4]) || Number(values[4]) < 1) {
            throw Object.assign(new Error('invalid input syntax for type bigint'), { code: '22P02' })
          }
        }
        return { rows: [], rowCount: 0 }
      },
      connect: async () => { throw new Error('read path must not open a transaction') },
      end: async () => undefined
    }
    const repository = new PostgresCollaborationRepository(pool)
    const now = '2026-08-15T02:00:00.000Z'

    await expect(repository.pullInbox({ kind: 'agent', id: 'agn_123456789012' }, 7, 25, now))
      .resolves.toEqual([])

    const query = captured.find(({ text }) => text.includes('FROM sciforge_collaboration.inbox_messages'))
    expect(query?.values).toEqual(['agent', 'agn_123456789012', 7, now, 25])
    expect(query?.text.replace(/\s+/gu, ' ')).toContain("(expires_at > $4 OR disposition = 'superseded')")
  })

  it('maps and revision-guards the bounded Agent capability profile', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const profile: StoredAgentCapabilityProfile = {
      agentId: 'agt_PostgresProfile1', ownerUserId: 'usr_PostgresProfile1',
      nodeType: 'personal_computer', osFamily: 'linux', osArchitecture: 'x64', osVersion: '24.04',
      runtimeIds: ['agent-runtime'], capabilities: [{ capabilityId: 'local-files',
        evidence: { level: 'verified', checkedAt: at } }],
      gpu: [], vpnAccessIds: [], slurmClusterIds: [], accessibleResourceRefIds: [],
      resultReturnPolicy: { summary: true, evidenceRefs: true, resourceRefs: true, logSummary: true,
        fullFileRequiresConfirmation: true, fullLogRequiresConfirmation: true },
      reportedAt: at, expiresAt: '2026-08-15T02:05:00.000Z', revision: 1,
      createdAt: at, updatedAt: at
    }
    const profileRow = {
      agent_id: profile.agentId, owner_user_id: profile.ownerUserId, node_type: profile.nodeType,
      os_family: profile.osFamily, os_architecture: profile.osArchitecture, os_version: profile.osVersion,
      runtime_ids: profile.runtimeIds, capabilities: profile.capabilities, gpu: profile.gpu,
      vpn_access_ids: profile.vpnAccessIds, slurm_cluster_ids: profile.slurmClusterIds,
      accessible_resource_ref_ids: profile.accessibleResourceRefIds,
      result_return_policy: profile.resultReturnPolicy, reported_at: new Date(profile.reportedAt),
      expires_at: new Date(profile.expiresAt), revision: profile.revision,
      created_at: new Date(profile.createdAt), updated_at: new Date(profile.updatedAt)
    }
    const writes: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        writes.push({ text, values })
        return { rows: [], rowCount: text.includes('UPDATE sciforge_collaboration.agent_capability_profiles') ? 1 : 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async (text) => text.includes('agent_capability_profiles')
        ? { rows: [profileRow], rowCount: 1 }
        : { rows: [], rowCount: 0 },
      connect: async () => connection,
      end: async () => undefined
    })

    await expect(repository.getAgentCapabilityProfile(profile.agentId)).resolves.toEqual(profile)
    await repository.transaction(async (tx) => {
      await tx.upsertAgentCapabilityProfile(profile, null)
      await tx.upsertAgentCapabilityProfile({ ...profile, revision: 2 }, 1)
      await tx.deleteAgentCapabilityProfile(profile.agentId)
    })

    const insert = writes.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.agent_capability_profiles'))
    expect(insert?.text).toContain('$13::jsonb')
    expect(insert?.values.slice(6, 13)).toEqual([
      JSON.stringify(profile.runtimeIds), JSON.stringify(profile.capabilities), JSON.stringify(profile.gpu),
      JSON.stringify(profile.vpnAccessIds), JSON.stringify(profile.slurmClusterIds),
      JSON.stringify(profile.accessibleResourceRefIds), JSON.stringify(profile.resultReturnPolicy)
    ])
    const update = writes.find(({ text }) => text.includes('UPDATE sciforge_collaboration.agent_capability_profiles'))
    expect(update?.text).toContain('WHERE agent_id=$1 AND revision=$19')
    expect(update?.values.at(-1)).toBe(1)
    const deletion = writes.find(({ text }) => text.includes('DELETE FROM sciforge_collaboration.agent_capability_profiles'))
    expect(deletion?.values).toEqual([profile.agentId])
  })

  it('maps structured Task results and locks the exact execution result', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const record: StoredProjectRecord = {
      projectRecordId: 'rec_PostgresResult1', projectId: 'prj_PostgresResult1', kind: 'task_result',
      status: 'candidate', summary: 'The bounded result summary.', authorAgentId: 'agt_PostgresWorker1',
      sourceTaskId: 'tsk_PostgresResult1', sourceExecutionId: 'exe_PostgresResult1', sourceRevision: 3,
      criterionEvidence: [{ criterionId: 'cri_PostgresResult1', summary: 'Criterion satisfied.',
        resourceRefIds: ['rrf_PostgresResult1'] }], resourceRefIds: ['rrf_PostgresResult1'],
      logSummary: 'Safe log summary.', revision: 1, createdAt: at, updatedAt: at
    }
    const row = {
      project_record_id: record.projectRecordId, project_id: record.projectId, kind: record.kind,
      status: record.status, summary: record.summary, author_user_id: null,
      author_agent_id: record.authorAgentId, source_task_id: record.sourceTaskId,
      source_execution_id: record.sourceExecutionId, source_revision: record.sourceRevision,
      criterion_evidence: record.criterionEvidence, resource_ref_ids: record.resourceRefIds,
      log_summary: record.logSummary, accepted_by_user_id: null, accepted_by_agent_id: null,
      accepted_at: null, revision: record.revision, created_at: new Date(at), updated_at: new Date(at)
    }
    const reads: Array<{ text: string; values: readonly unknown[] }> = []
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        return text.includes('project_records') && text.includes('FOR UPDATE')
          ? { rows: [row], rowCount: 1 }
          : { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async (text, values = []) => {
        reads.push({ text, values })
        return text.includes('project_records') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
      },
      connect: async () => connection,
      end: async () => undefined
    })

    await expect(repository.getTaskResultForExecution(record.sourceTaskId!, record.sourceExecutionId!))
      .resolves.toEqual(record)
    await repository.transaction(async (tx) => {
      await expect(tx.getTaskResultForExecutionForUpdate(record.sourceTaskId!, record.sourceExecutionId!))
        .resolves.toEqual(record)
      await tx.insertProjectRecord(record)
    })

    const lookup = reads.find(({ text }) => text.includes("kind='task_result'"))
    const lock = queries.find(({ text }) => text.includes('project_records') && text.includes('FOR UPDATE'))
    for (const query of [lookup, lock]) {
      expect(query?.text).toContain("kind='task_result' AND status<>'superseded'")
      expect(query?.text).toContain("ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END")
      expect(query?.text).toContain('updated_at DESC,project_record_id ASC')
      expect(query?.text).toContain('LIMIT 1')
      expect(query?.values).toEqual([record.sourceTaskId, record.sourceExecutionId])
    }
    expect(lock?.values).toEqual([record.sourceTaskId, record.sourceExecutionId])
    const insert = queries.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.project_records'))
    expect(insert?.values.slice(8, 13)).toEqual([
      record.sourceExecutionId, record.sourceRevision, JSON.stringify(record.criterionEvidence),
      JSON.stringify(record.resourceRefIds), record.logSummary
    ])
  })

  it('maps and locks Coordinator HumanNeeded requests and their action confirmation', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const request: StoredHumanRequest = {
      humanRequestId: 'hrq_PostgresCoord01', projectId: 'prj_PostgresCoord01', sourceKind: 'coordinator',
      sourceInboxMessageId: 'ibx_PostgresCoord01', targetUserId: 'usr_PostgresOwner01',
      requestedByAgentId: 'agt_PostgresCoord01', requiredAssurance: 'verified',
      prompt: 'Approve the proposed task?', confirmableAction: { kind: 'tasks.create',
        projectId: 'prj_PostgresCoord01', proposalDigest: 'a'.repeat(64) },
      status: 'pending', revision: 1, expiresAt: '2026-08-15T02:10:00.000Z', createdAt: at, updatedAt: at
    }
    const confirmation: StoredActionConfirmation = {
      confirmationId: 'cnf_PostgresCoord01', humanRequestId: request.humanRequestId,
      projectId: request.projectId, targetUserId: request.targetUserId,
      coordinatorAgentId: request.requestedByAgentId, action: request.confirmableAction!,
      actionDigest: 'b'.repeat(64), status: 'approved', approvedAt: at,
      expiresAt: '2026-08-15T02:05:00.000Z', createdAt: at, updatedAt: at
    }
    const answer: StoredHumanAnswer = {
      humanAnswerId: 'han_PostgresCoord01', humanRequestId: request.humanRequestId,
      projectId: request.projectId, requestRevision: request.revision,
      answeredByUserId: request.targetUserId, answeredFromHumanEndpointId: 'hep_PostgresCoord01',
      assurance: 'verified', answer: 'Approved.', decision: 'approve',
      confirmationId: confirmation.confirmationId, revision: 1, answeredAt: at, createdAt: at, updatedAt: at
    }
    const requestRow = {
      human_request_id: request.humanRequestId, project_id: request.projectId, source_kind: request.sourceKind,
      task_id: null, execution_id: null, source_inbox_message_id: request.sourceInboxMessageId,
      target_user_id: request.targetUserId, requested_by_agent_id: request.requestedByAgentId,
      required_assurance: request.requiredAssurance, prompt: request.prompt,
      confirmable_action: request.confirmableAction, status: request.status, revision: request.revision,
      expires_at: new Date(request.expiresAt), created_at: new Date(at), updated_at: new Date(at)
    }
    const confirmationRow = {
      confirmation_id: confirmation.confirmationId, human_request_id: confirmation.humanRequestId,
      project_id: confirmation.projectId, target_user_id: confirmation.targetUserId,
      coordinator_agent_id: confirmation.coordinatorAgentId, action: confirmation.action,
      action_digest: Buffer.from(confirmation.actionDigest, 'hex'), status: confirmation.status,
      approved_at: new Date(confirmation.approvedAt), expires_at: new Date(confirmation.expiresAt),
      consumed_at: null, consumed_by_actor_key: null, consumed_operation: null,
      created_at: new Date(at), updated_at: new Date(at)
    }
    const answerRow = {
      human_answer_id: answer.humanAnswerId, human_request_id: answer.humanRequestId,
      project_id: answer.projectId, task_id: null, execution_id: null,
      request_revision: answer.requestRevision, answered_by_user_id: answer.answeredByUserId,
      answered_from_human_endpoint_id: answer.answeredFromHumanEndpointId, assurance: answer.assurance,
      answer: answer.answer, decision: answer.decision, confirmation_id: answer.confirmationId,
      revision: answer.revision, answered_at: new Date(at), created_at: new Date(at), updated_at: new Date(at)
    }
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        if (text.includes('human_requests') && text.includes('FOR UPDATE')) return { rows: [requestRow], rowCount: 1 }
        if (text.includes('action_confirmations') && text.includes('FOR UPDATE')) return { rows: [confirmationRow], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async (text) => text.includes('human_requests')
        ? { rows: [requestRow], rowCount: 1 }
        : text.includes('human_answers')
          ? { rows: [answerRow], rowCount: 1 }
          : { rows: [confirmationRow], rowCount: 1 },
      connect: async () => connection,
      end: async () => undefined
    })

    await expect(repository.getHumanRequest(request.humanRequestId)).resolves.toEqual(request)
    await expect(repository.getHumanAnswerForRequest(request.humanRequestId)).resolves.toEqual(answer)
    await expect(repository.getActionConfirmation(confirmation.confirmationId)).resolves.toEqual(confirmation)
    await repository.transaction(async (tx) => {
      await expect(tx.getHumanRequestForUpdate(request.humanRequestId)).resolves.toEqual(request)
      await expect(tx.getActionConfirmationForUpdate(confirmation.confirmationId)).resolves.toEqual(confirmation)
      await expect(tx.listApprovedActionConfirmationsForProjectForUpdate(confirmation.projectId))
        .resolves.toEqual([confirmation])
      await tx.insertHumanRequest(request)
      await tx.insertActionConfirmation(confirmation)
      await tx.insertHumanAnswer(answer)
      await tx.updateActionConfirmation({ ...confirmation, status: 'superseded', updatedAt: '2026-08-15T02:01:00.000Z' })
    })

    expect(queries.filter(({ text }) => text.includes('FOR UPDATE'))).toHaveLength(3)
    const confirmationList = queries.find(({ text }) => text.includes("status='approved'") && text.includes('FOR UPDATE'))
    expect(confirmationList?.text).toContain('ORDER BY confirmation_id FOR UPDATE')
    expect(confirmationList?.values).toEqual([confirmation.projectId])
    const requestInsert = queries.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.human_requests'))
    expect(requestInsert?.values.slice(2, 7)).toEqual([
      'coordinator', null, null, request.sourceInboxMessageId, request.targetUserId
    ])
    const confirmationInsert = queries.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.action_confirmations'))
    expect(confirmationInsert?.values[6]).toEqual(Buffer.from(confirmation.actionDigest, 'hex'))
    const confirmationUpdate = queries.find(({ text }) => text.includes('UPDATE sciforge_collaboration.action_confirmations'))
    expect(confirmationUpdate?.text).toContain("WHERE confirmation_id=$1 AND status='approved'")
    expect(confirmationUpdate?.values.slice(0, 2)).toEqual([confirmation.confirmationId, 'superseded'])
    const answerInsert = queries.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.human_answers'))
    expect(answerInsert?.values.slice(3, 12)).toEqual([
      null, null, answer.requestRevision, answer.answeredByUserId, answer.answeredFromHumanEndpointId,
      answer.assurance, answer.answer, answer.decision, answer.confirmationId
    ])
  })

  it('ACKs only the next active message while allowing superseded tombstone gaps and duplicate ACKs', async () => {
    const recipient = { kind: 'agent' as const, id: 'agt_PostgresInbox01' }
    const at = '2026-08-15T02:00:00.000Z'
    let ackedSequence = 1
    let gapQueries = 0
    let updates = 0
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        if (text.includes('FROM sciforge_collaboration.inbox_cursors') && text.includes('FOR UPDATE')) {
          return { rows: [{ recipient_kind: recipient.kind, recipient_id: recipient.id,
            next_sequence: 5, acked_sequence: ackedSequence, updated_at: new Date(at) }], rowCount: 1 }
        }
        if (text.includes('SELECT sequence FROM sciforge_collaboration.inbox_messages')) {
          return { rows: [{ sequence: values[2] }], rowCount: 1 }
        }
        if (text.includes('count(*) FILTER')) {
          gapQueries += 1
          return { rows: [{ total: '2', active: '0' }], rowCount: 1 }
        }
        if (text.includes('UPDATE sciforge_collaboration.inbox_cursors')) {
          updates += 1
          ackedSequence = Number(values[2])
          return { rows: [{ recipient_kind: recipient.kind, recipient_id: recipient.id,
            next_sequence: 5, acked_sequence: ackedSequence, updated_at: new Date(String(values[3])) }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }), connect: async () => connection, end: async () => undefined
    })

    await repository.transaction(async (tx) => {
      await expect(tx.ackInbox(recipient, 4, at)).resolves.toMatchObject({ ackedSequence: 4 })
      await expect(tx.ackInbox(recipient, 4, at)).resolves.toMatchObject({ ackedSequence: 4 })
    })

    expect(gapQueries).toBe(1)
    expect(updates).toBe(1)
  })

  it('rejects an ACK that jumps over an active Inbox message', async () => {
    const recipient = { kind: 'agent' as const, id: 'agt_PostgresInbox02' }
    const at = '2026-08-15T02:00:00.000Z'
    const connection: SqlConnection = {
      query: async (text) => {
        if (text.includes('inbox_cursors') && text.includes('FOR UPDATE')) {
          return { rows: [{ recipient_kind: recipient.kind, recipient_id: recipient.id,
            next_sequence: 5, acked_sequence: 1, updated_at: new Date(at) }], rowCount: 1 }
        }
        if (text.includes('SELECT sequence FROM sciforge_collaboration.inbox_messages')) {
          return { rows: [{ sequence: 4 }], rowCount: 1 }
        }
        if (text.includes('count(*) FILTER')) return { rows: [{ total: '2', active: '1' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }), connect: async () => connection, end: async () => undefined
    })

    await expect(repository.transaction((tx) => tx.ackInbox(recipient, 4, at)))
      .rejects.toMatchObject({ code: 'inbox_ack_gap', details: { ackedSequence: 1, nextSequence: 5 } })
  })

  it('supersedes only Coordinator-targeted project messages and returns durable tombstones', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const message: StoredInboxMessage = {
      recipient: { kind: 'agent', id: 'agt_PostgresCoord02' }, sequence: 7,
      messageId: 'ibx_PostgresCoord02', messageType: 'task.updated',
      payload: { projectId: 'prj_PostgresCoord02' }, disposition: 'superseded', supersededAt: at,
      createdAt: at, expiresAt: '2026-08-16T02:00:00.000Z'
    }
    let supersedeSql = ''
    let lookupSql = ''
    let lookupValues: readonly unknown[] = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        if (text.includes('message_id=$3')) {
          lookupSql = text
          lookupValues = values
          return { rows: [{ recipient_kind: message.recipient.kind, recipient_id: message.recipient.id,
            sequence: message.sequence, message_id: message.messageId, message_type: message.messageType,
            payload: message.payload, disposition: message.disposition, superseded_at: new Date(at),
            superseded_by_message_id: null, created_at: new Date(at), expires_at: new Date(message.expiresAt) }], rowCount: 1 }
        }
        if (text.includes('WITH changed AS')) {
          supersedeSql = text
          return { rows: [{ recipient_kind: message.recipient.kind, recipient_id: message.recipient.id,
            sequence: message.sequence, message_id: message.messageId, message_type: message.messageType,
            payload: message.payload, disposition: message.disposition, superseded_at: new Date(at),
            superseded_by_message_id: null, created_at: new Date(at), expires_at: new Date(message.expiresAt) }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => undefined
    }
    const repository = new PostgresCollaborationRepository({
      query: async () => ({ rows: [], rowCount: 0 }), connect: async () => connection, end: async () => undefined
    })

    await repository.transaction(async (tx) => {
      await expect(tx.getInboxMessageById(message.recipient, message.messageId)).resolves.toEqual(message)
      await expect(tx.supersedeCoordinatorInbox('prj_PostgresCoord02', message.recipient.id, at))
        .resolves.toEqual([message])
    })

    expect(lookupSql).toContain('recipient_kind=$1 AND recipient_id=$2 AND message_id=$3')
    expect(lookupValues).toEqual([message.recipient.kind, message.recipient.id, message.messageId])
    expect(supersedeSql).toContain("message.payload->'answer'->>'projectId'")

    for (const type of ['task.updated', 'project_record.submitted', 'project.input.received',
      'project.endpoint.updated', 'project.started', 'human.answer.received']) {
      expect(supersedeSql).toContain(`'${type}'`)
    }
    for (const type of ['task.offered', 'task.cancelled']) {
      expect(supersedeSql).not.toContain(`'${type}'`)
    }
  })

  it('uses redacted fixed-width advisory locks for OIDC and both Zulip uniqueness dimensions', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        for (const value of values) {
          if (typeof value === 'string' && value.includes('\u0000')) {
            throw new Error('PostgreSQL text parameters reject NUL bytes.')
          }
        }
        queries.push({ text, values })
        return { rows: [], rowCount: text.startsWith('SELECT * FROM sciforge_collaboration.receipts') ? 0 : 1 }
      },
      release: () => undefined
    }
    const pool: SqlPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
      end: async () => undefined
    }
    const repository = new PostgresCollaborationRepository(pool)
    const issuer = 'https://issuer-sensitive.example.invalid/realms/test'
    const subject = 'subject-sensitive-postgres-test'
    const userId = 'usr_PostgresLockUser01'
    const realmId = 'zulip-realm-sensitive'
    const zulipUserId = 'zulip-user-sensitive'

    await repository.transaction(async (tx) => {
      await tx.lockOidcIdentity(issuer, subject)
      await tx.lockZulipBindingIdentity(userId, realmId, zulipUserId)
    })

    const advisory = queries.filter(({ text }) => text.includes('pg_advisory_xact_lock'))
    expect(advisory).toHaveLength(3)
    const keys = advisory.map(({ values }) => String(values[0]))
    expect(keys).toEqual(keys.map((key) => expect.stringMatching(/^-?[0-9]+$/u)))
    expect(new Set(keys).size).toBe(3)
    expect(BigInt(keys[1]!)).toBeLessThan(BigInt(keys[2]!))
    const serialized = JSON.stringify(advisory)
    for (const sensitive of [issuer, subject, userId, realmId, zulipUserId]) {
      expect(serialized).not.toContain(sensitive)
    }
    expect(serialized).not.toContain('\u0000')
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })

  it('persists OIDC and Zulip binding facts without legacy pairing challenge state', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        return { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const pool: SqlPool = { query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection, end: async () => undefined }
    const repository = new PostgresCollaborationRepository(pool)
    const timestamp = '2026-08-15T02:00:00.000Z'
    const oidcIdentity: StoredOidcIdentity = {
      identityId: 'oid_PostgresIdentity01', userId: 'usr_PostgresIdentity01',
      issuer: 'https://login-test.sciforge.cn/realms/SciForge', subject: 'postgres-identity-subject',
      emailAtLinkTime: 'postgres@example.invalid', status: 'active', revision: 1,
      createdAt: timestamp, updatedAt: timestamp
    }
    const bindingRequest: StoredZulipBindingRequest = {
      bindingRequestId: 'zbr_PostgresBinding01', userId: oidcIdentity.userId,
      realmUrl: 'https://chat-test.example.invalid', codeDigest: 'ab'.repeat(32),
      status: 'pending', revision: 1, expiresAt: '2026-08-15T02:05:00.000Z',
      createdAt: timestamp, updatedAt: timestamp
    }
    const externalIdentity: StoredExternalIdentity = {
      externalIdentityId: 'xid_PostgresBinding01', humanEndpointId: 'hep_PostgresBinding01',
      userId: oidcIdentity.userId, provider: 'zulip', realmUrl: bindingRequest.realmUrl,
      realmId: 'zulip-realm-postgres', zulipUserId: 'zulip-user-postgres',
      status: 'active', revision: 1, verifiedAt: timestamp, createdAt: timestamp, updatedAt: timestamp
    }

    await repository.transaction(async (tx) => {
      await tx.insertOidcIdentity(oidcIdentity)
      await tx.insertZulipBindingRequest(bindingRequest)
      await tx.insertExternalIdentity(externalIdentity)
    })

    const sql = queries.map(({ text }) => text).join('\n')
    expect(sql).toContain('INSERT INTO sciforge_collaboration.oidc_identities')
    expect(sql).toContain('INSERT INTO sciforge_collaboration.zulip_binding_requests')
    expect(sql).toContain('INSERT INTO sciforge_collaboration.human_endpoint_bindings')
    expect(sql).not.toContain('sciforge_collaboration.external_identities')
    expect(sql).not.toContain('INSERT INTO sciforge_collaboration.human_endpoint_challenges')
    expect(sql).not.toContain('INSERT INTO sciforge_collaboration.credentials')
    const requestInsert = queries.find(({ text }) => text.includes('INSERT INTO sciforge_collaboration.zulip_binding_requests'))
    expect(requestInsert?.values[3]).toEqual(Buffer.from(bindingRequest.codeDigest, 'hex'))
    expect(JSON.stringify(requestInsert?.values)).not.toContain('SF-')
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })
})
