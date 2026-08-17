import { describe, expect, it } from 'vitest'

import { digestSecret } from './crypto.js'
import { COLLABORATION_SCHEMA_VERSION, runCollaborationMigrations } from './migrations.js'
import type { StoredHumanRequest, StoredResourceRef, StoredTask } from './model.js'
import {
  createPostgresPool,
  formatPostgresPoolDiagnostic,
  PostgresCollaborationRepository,
  type PostgresPoolDiagnostic,
  type SqlConnection,
  type SqlPool
} from './postgres.js'
import { CollaborationService } from './service.js'

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

  it('runs the ordered ResourceRef and Task progress migrations through schema version 3', async () => {
    const migrations: string[] = []
    const pool: SqlPool = {
      query: async (text) => { migrations.push(text); return { rows: [], rowCount: 0 } },
      connect: async () => { throw new Error('Migration runner must not open an application transaction') },
      end: async () => undefined
    }

    await runCollaborationMigrations(pool)

    expect(COLLABORATION_SCHEMA_VERSION).toBe(3)
    expect(migrations).toHaveLength(3)
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
  })

  it('maps and revision-guards structured Task progress in PostgreSQL', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const task: StoredTask = {
      taskId: 'tsk_PostgresTask1', projectId: 'prj_PostgresTask1', assigneeAgentId: 'agt_PostgresWork1',
      createdByAgentId: 'agt_PostgresCoord', title: 'PostgreSQL progress', objective: 'Persist progress.',
      completionCriteria: ['Progress is durable'], dependencyTaskIds: [], status: 'in_progress', retryCount: 0,
      maxRetries: 2, coordinationRound: 1, progress: { percent: 40, summary: 'Input validation complete.',
        reportedAt: at }, revision: 4, createdAt: at, updatedAt: at
    }
    const taskRow = { task_id: task.taskId, project_id: task.projectId,
      assignee_agent_id: task.assigneeAgentId, created_by_agent_id: task.createdByAgentId,
      title: task.title, objective: task.objective, completion_criteria: task.completionCriteria,
      dependency_task_ids: task.dependencyTaskIds, status: task.status, retry_count: task.retryCount,
      max_retries: task.maxRetries, coordination_round: task.coordinationRound, active_turn_id: null,
      progress_percent: task.progress?.percent, progress_summary: task.progress?.summary,
      progress_reported_at: new Date(at), result_summary: null,
      failure_summary: 'legacy private failure text must not escape', safe_failure_code: null,
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
      await tx.updateTask({ ...task, progress: { percent: 60,
        summary: 'Analysis is running.', reportedAt: at }, revision: 5 }, 4)
    })

    expect(writes.find(({ text }) => text.includes('FOR UPDATE'))?.values).toEqual([task.taskId])
    const update = writes.find(({ text }) => text.includes('UPDATE sciforge_collaboration.tasks'))
    expect(update?.text).toContain('progress_percent=$12')
    expect(update?.text).toContain('safe_failure_code=$16')
    expect(update?.text).not.toContain('failure_summary=')
    expect(update?.values.slice(11, 14)).toEqual([60, 'Analysis is running.', at])
    expect(update?.values.at(-1)).toBe(4)
  })

  it('maps only the safe Task failure code and never exposes legacy failure text', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const row = {
      task_id: 'tsk_PostgresFail1', project_id: 'prj_PostgresFail1',
      assignee_agent_id: 'agt_PostgresWork1', created_by_agent_id: 'agt_PostgresCoord',
      title: 'PostgreSQL failure', objective: 'Persist a safe failure code.',
      completion_criteria: [], dependency_task_ids: [], status: 'failed', retry_count: 0,
      max_retries: 2, coordination_round: 1, active_turn_id: null,
      progress_percent: null, progress_summary: null, progress_reported_at: null,
      result_summary: null, failure_summary: 'legacy private diagnostic text must remain hidden',
      safe_failure_code: 'worker_failed', revision: 2,
      created_at: new Date(at), updated_at: new Date(at), completed_at: new Date(at)
    }
    const pool: SqlPool = {
      query: async () => ({ rows: [row], rowCount: 1 }),
      connect: async () => { throw new Error('Read path must not open a transaction') },
      end: async () => undefined
    }

    const mapped = await new PostgresCollaborationRepository(pool).getTask(row.task_id)

    expect(mapped).toMatchObject({ status: 'failed', safeFailureCode: 'worker_failed' })
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

  it('locks and revision-cancels every pending HumanNeeded request for a reassigned Task', async () => {
    const at = '2026-08-15T02:00:00.000Z'
    const requests: StoredHumanRequest[] = [1, 2].map((index) => ({
      humanRequestId: `hrq_PostgresPending${index}`, projectId: 'prj_PostgresHuman1',
      taskId: 'tsk_PostgresHuman1', targetUserId: 'usr_PostgresTarget1',
      requestedByAgentId: 'agt_PostgresWorker1', requiredAssurance: 'verified',
      prompt: `Pending question ${index}`, status: 'pending', revision: index,
      expiresAt: '2026-08-15T03:00:00.000Z', createdAt: at, updatedAt: at
    }))
    const rows = requests.map((request) => ({
      human_request_id: request.humanRequestId, project_id: request.projectId, task_id: request.taskId,
      target_user_id: request.targetUserId, requested_by_agent_id: request.requestedByAgentId,
      required_assurance: request.requiredAssurance, prompt: request.prompt, status: request.status,
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
    const resource: StoredResourceRef = {
      resourceRefId: 'rrf_Postgres0012', projectId: 'prj_Postgres0012', taskId: 'tsk_Postgres0012',
      taskRevision: 3, createdByUserId: 'usr_PostgresUser1', createdByAgentId: 'agt_PostgresWork1',
      provider: 'example-content', externalId: 'postgres-document-42', kind: 'shared_document',
      name: 'PostgreSQL ResourceRef', openUrl: 'https://content.example.invalid/postgres-document-42',
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
            task_id: resource.taskId, task_revision: resource.taskRevision,
            created_by_user_id: resource.createdByUserId, created_by_agent_id: resource.createdByAgentId,
            provider: resource.provider, external_id: resource.externalId,
            kind: resource.kind, name: resource.name, open_url: resource.openUrl, provider_version: resource.version,
            status: resource.status, invalidated_at: null, revision: resource.revision,
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
      resource.taskRevision, resource.createdByUserId, resource.createdByAgentId, resource.provider,
      resource.externalId, resource.kind, resource.name, resource.openUrl, resource.version,
      'available', null, 1, at, at])
    expect(update?.values).toEqual([resource.resourceRefId, 'invalidated', at, 2, at, 1])
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
  })

  it('begins pairing without sending a NUL-containing advisory lock key', async () => {
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
    const service = new CollaborationService({
      repository: new PostgresCollaborationRepository(pool),
      now: () => new Date('2026-08-15T02:00:00.000Z')
    })

    const begun = await service.beginPairing({
      provider: 'fake-im',
      realmId: 'fake-realm',
      requestedDisplayName: 'PostgreSQL Pairing User',
      idempotencyKey: 'idem_postgres_pairing_begin_01'
    })

    expect(begun).toMatchObject({ type: 'pairing.begun' })
    expect(typeof begun.challengeCode).toBe('string')
    expect(typeof begun.pollSecret).toBe('string')
    const advisory = queries.find(({ text }) => text.includes('pg_advisory_xact_lock'))
    expect(advisory?.values).toHaveLength(1)
    expect(String(advisory?.values[0])).not.toContain('\u0000')
    expect(JSON.parse(String(advisory?.values[0]))).toEqual([
      expect.stringMatching(/^anonymous-pairing:/u),
      'idem_postgres_pairing_begin_01'
    ])
    expect(queries.some(({ text }) => text.includes('INSERT INTO sciforge_collaboration.human_endpoint_challenges'))).toBe(true)
    expect(queries.some(({ text }) => text.includes('INSERT INTO sciforge_collaboration.audit_events'))).toBe(true)
    expect(queries.some(({ text }) => text.includes('INSERT INTO sciforge_collaboration.receipts'))).toBe(true)
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })

  it('audits a pending pairing redeem without inserting a terminal receipt', async () => {
    const pollSecret = ['pairing', 'poll', 'INVALID', 'TEST', 'ONLY', 'x'.repeat(32)].join('_')
    const pollDigest = digestSecret(pollSecret)
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const challengeRow = {
      challenge_id: 'chl_123456789012', requested_user_id: null, provider: 'fake-im', realm_id: 'fake-realm',
      expected_provider_user_id: null, challenge_digest: Buffer.alloc(32, 1),
      poll_secret_digest: Buffer.from(pollDigest, 'hex'), requested_display_name: 'Pending User',
      expires_at: new Date('2026-08-15T02:10:00.000Z'), verified_user_id: null,
      verified_endpoint_id: null, verified_at: null, consumed_at: null,
      created_at: new Date('2026-08-15T02:00:00.000Z')
    }
    const connection: SqlConnection = {
      query: async (text, values = []) => {
        queries.push({ text, values })
        if (text.includes('FROM sciforge_collaboration.receipts')) return { rows: [], rowCount: 0 }
        if (text.includes('WHERE poll_secret_digest=$1')) return { rows: [challengeRow], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      },
      release: () => undefined
    }
    const pool: SqlPool = { query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection, end: async () => undefined }
    const service = new CollaborationService({ repository: new PostgresCollaborationRepository(pool),
      now: () => new Date('2026-08-15T02:00:00.000Z') })

    const pending = await service.redeemPairing({ pollSecret,
      idempotencyKey: 'idem_postgres_pairing_pending_01' })

    expect(pending).toMatchObject({ type: 'pairing.pending', challengeId: challengeRow.challenge_id })
    expect(queries.some(({ text }) => text.includes('INSERT INTO sciforge_collaboration.audit_events'))).toBe(true)
    expect(queries.some(({ text }) => text.includes('INSERT INTO sciforge_collaboration.receipts'))).toBe(false)
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })
})
