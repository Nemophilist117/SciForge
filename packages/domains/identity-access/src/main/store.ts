import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { principalIdentityVersionSchema } from '@sciforge/domain-sdk/principal'

const SCHEMA_VERSION = 3

export type IdentityStoreState = Readonly<{
  identityVersion: number
}>

export type IdentityStoreUnavailableReason =
  | 'open-failed'
  | 'integrity-failed'
  | 'migration-failed'

type StateRow = {
  identity_version: number
}

export class IdentityStoreOpenError extends Error {
  readonly reason: IdentityStoreUnavailableReason

  constructor(reason: IdentityStoreUnavailableReason, cause: unknown) {
    super(`Identity database ${reason}: ${errorMessage(cause)}`, { cause })
    this.name = 'IdentityStoreOpenError'
    this.reason = reason
  }
}

export class IdentityStore {
  readonly databasePath: string
  private closed = false

  private constructor(private readonly database: DatabaseSync, databasePath: string) {
    this.databasePath = databasePath
  }

  static open(userDataDir: string): IdentityStore {
    return IdentityStore.openDatabasePath(join(userDataDir, 'identity-access', 'identity.sqlite'))
  }

  static openDatabasePath(databasePath: string): IdentityStore {
    mkdirSync(dirname(databasePath), { recursive: true })
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(databasePath)
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA journal_mode = DELETE')
    } catch (error) {
      closeQuietly(database)
      throw new IdentityStoreOpenError('open-failed', error)
    }

    try {
      const row = database.prepare('PRAGMA integrity_check').get() as
        | Record<string, unknown>
        | undefined
      if (!row || Object.values(row)[0] !== 'ok') {
        throw new Error('SQLite integrity_check did not return ok.')
      }
    } catch (error) {
      closeQuietly(database)
      throw new IdentityStoreOpenError('integrity-failed', error)
    }

    try {
      migrate(database)
    } catch (error) {
      closeQuietly(database)
      throw new IdentityStoreOpenError('migration-failed', error)
    }
    return new IdentityStore(database, databasePath)
  }

  state(): IdentityStoreState {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT identity_version FROM identity_state WHERE singleton_id = 1
    `).get() as StateRow | undefined
    if (!row) throw new Error('Identity singleton state is missing.')
    return Object.freeze({
      identityVersion: principalIdentityVersionSchema.parse(Number(row.identity_version))
    })
  }

  setIdentityVersion(identityVersion: number): IdentityStoreState {
    this.assertOpen()
    const parsed = principalIdentityVersionSchema.parse(identityVersion)
    this.database.prepare(`
      UPDATE identity_state SET identity_version = ? WHERE singleton_id = 1
    `).run(parsed)
    return this.state()
  }

  advanceIdentityVersion(): IdentityStoreState {
    return this.transaction(() => {
      const current = this.state()
      if (current.identityVersion >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Identity authorization revision is exhausted.')
      }
      this.database.prepare(`
        UPDATE identity_state
        SET identity_version = identity_version + 1
        WHERE singleton_id = 1
      `).run()
      return this.state()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private transaction<T>(operation: () => T): T {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the original operation failure.
      }
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Identity database is closed.')
  }
}

function migrate(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown>
  const version = Number(Object.values(versionRow)[0])
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported Identity schema version ${String(version)}.`)
  }
  if (version === SCHEMA_VERSION) return

  database.exec('BEGIN IMMEDIATE')
  try {
    let identityVersion = 0
    if (version === 1 || version === 2) {
      const legacy = database.prepare(`
        SELECT identity_version FROM identity_state WHERE singleton_id = 1
      `).get() as StateRow | undefined
      if (!legacy) throw new Error('Legacy Identity singleton state is missing.')
      identityVersion = principalIdentityVersionSchema.parse(Number(legacy.identity_version))
      database.exec('DROP TABLE identity_state')
      database.exec('DROP TABLE accounts')
    }

    database.exec(`
      CREATE TABLE identity_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        identity_version INTEGER NOT NULL CHECK (identity_version >= 0)
      )
    `)
    database.prepare(`
      INSERT INTO identity_state (singleton_id, identity_version) VALUES (1, ?)
    `).run(identityVersion)
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the migration failure.
    }
    throw error
  }
}

function closeQuietly(database: DatabaseSync | undefined): void {
  try {
    database?.close()
  } catch {
    // Initialization already failed; the original failure remains authoritative.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
