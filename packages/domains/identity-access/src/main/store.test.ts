import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CloudPrincipalStateService } from './cloud-principal-state.js'
import { IdentityService } from './service.js'
import { IdentityStore, IdentityStoreOpenError } from './store.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sciforge-identity-'))
  roots.push(root)
  return root
}

describe('IdentityStore', () => {
  it('persists only the monotonic Principal authorization revision', () => {
    const root = temporaryRoot()
    const store = IdentityStore.open(root)
    expect(store.state()).toEqual({ identityVersion: 0 })
    expect(store.advanceIdentityVersion()).toEqual({ identityVersion: 1 })
    store.close()

    const reopened = IdentityStore.open(root)
    expect(reopened.state()).toEqual({ identityVersion: 1 })
    reopened.close()
  })

  it('destructively migrates the legacy Local Account schema without retaining account data', () => {
    const root = temporaryRoot()
    const directory = join(root, 'identity-access')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'identity.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE accounts (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cloud_user_id TEXT NULL,
        cloud_oidc_identity_id TEXT NULL,
        cloud_issuer TEXT NULL,
        cloud_subject TEXT NULL,
        cloud_device_id TEXT NULL,
        cloud_device_status TEXT NULL
      );
      CREATE TABLE identity_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        current_user_id TEXT NULL REFERENCES accounts(user_id),
        identity_version INTEGER NOT NULL,
        first_prompt_dismissed INTEGER NOT NULL
      );
      INSERT INTO accounts (
        user_id, username, username_key, created_at, updated_at,
        cloud_user_id, cloud_oidc_identity_id, cloud_issuer, cloud_subject
      ) VALUES (
        'legacy-local-user', 'Legacy', 'legacy', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 'usr_CloudUser000001', 'oid_CloudIdent0001',
        'https://login-test.sciforge.cn/realms/SciForge', 'keycloak-subject-a'
      );
      INSERT INTO identity_state VALUES (1, 'legacy-local-user', 7, 1);
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const migrated = IdentityStore.open(root)
    expect(migrated.state()).toEqual({ identityVersion: 7 })
    migrated.close()

    const inspected = new DatabaseSync(path)
    expect(inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all()).toEqual([{ name: 'identity_state' }])
    expect(Number(Object.values(inspected.prepare('PRAGMA user_version').get()!)[0])).toBe(3)
    inspected.close()
  })

  it('fails closed before the authorization revision exceeds the safe integer bound', () => {
    const store = IdentityStore.open(temporaryRoot())
    store.setIdentityVersion(Number.MAX_SAFE_INTEGER)
    expect(() => store.advanceIdentityVersion()).toThrow(RangeError)
    expect(store.state()).toEqual({ identityVersion: Number.MAX_SAFE_INTEGER })
    expect(() => store.setIdentityVersion(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    store.close()
  })

  it('classifies corruption without replacing the original database', () => {
    const root = temporaryRoot()
    const store = IdentityStore.open(root)
    const path = store.databasePath
    store.close()
    const handle = openSync(path, 'r+')
    writeSync(handle, Buffer.alloc(200, 0xff), 0, 200, 4_096)
    closeSync(handle)
    const original = readFileSync(path)

    expect(() => IdentityStore.open(root)).toThrowError(IdentityStoreOpenError)
    try {
      IdentityStore.open(root)
    } catch (error) {
      expect((error as IdentityStoreOpenError).reason).toBe('integrity-failed')
    }
    expect(readFileSync(path)).toEqual(original)
  })

  it('classifies unsupported migrations without modifying the database', () => {
    const root = temporaryRoot()
    const store = IdentityStore.open(root)
    const path = store.databasePath
    store.close()
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()
    const original = readFileSync(path)

    try {
      IdentityStore.open(root)
      throw new Error('Expected migration failure.')
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityStoreOpenError)
      expect((error as IdentityStoreOpenError).reason).toBe('migration-failed')
    }
    expect(readFileSync(path)).toEqual(original)
  })
})

describe('Cloud-only Principal state', () => {
  it('publishes null until one Keycloak User has an ACTIVE cloud Device', () => {
    const root = temporaryRoot()
    const principal = new IdentityService(root)
    const state = new CloudPrincipalStateService(root)
    const snapshots: ReturnType<IdentityService['snapshot']>[] = []
    principal.subscribe((snapshot) => snapshots.push(snapshot))

    expect(principal.current()).toBeUndefined()
    state.setAuthenticatedCloudUser('usr_CloudUser000001')
    expect(principal.current()).toBeUndefined()

    state.linkDevice('usr_CloudUser000001', 'dev_CloudDevice0001', 'active')
    expect(principal.current()).toEqual({
      authority: 'sciforge-cloud',
      subject: 'usr_CloudUser000001',
      assurance: 'cloud-authenticated',
      deviceId: 'dev_CloudDevice0001',
      identityVersion: 2
    })

    state.clearActiveDevice()
    expect(principal.current()).toBeUndefined()
    state.linkDevice('usr_CloudUser000001', 'dev_CloudDevice0001', 'active')
    state.linkDevice('usr_CloudUser000001', 'dev_CloudDevice0001', 'revoked')
    expect(principal.current()).toBeUndefined()
    expect(snapshots.every((snapshot, index) => (
      index === 0 || snapshot.identityVersion > snapshots[index - 1]!.identityVersion
    ))).toBe(true)

    state.close()
    principal.close()
  })

  it('restores persisted revision but never invents cloud authority after restart', () => {
    const root = temporaryRoot()
    const principal = new IdentityService(root)
    const state = new CloudPrincipalStateService(root)
    state.setAuthenticatedCloudUser('usr_CloudUser000001')
    state.linkDevice('usr_CloudUser000001', 'dev_CloudDevice0001', 'active')
    expect(principal.current()?.assurance).toBe('cloud-authenticated')
    state.close()
    principal.close()

    const restarted = new IdentityService(root)
    expect(restarted.snapshot()).toEqual({ identityVersion: 3, principal: null })
    restarted.close()
  })

  it('fails closed if removal of active Device authority cannot persist', () => {
    const root = temporaryRoot()
    const principal = new IdentityService(root)
    const state = new CloudPrincipalStateService(root)
    state.setAuthenticatedCloudUser('usr_CloudUser000001')
    state.linkDevice('usr_CloudUser000001', 'dev_CloudDevice0001', 'active')
    const before = principal.snapshot()
    const snapshots: ReturnType<IdentityService['snapshot']>[] = []
    principal.subscribe((snapshot) => snapshots.push(snapshot))
    vi.spyOn(IdentityStore.prototype, 'advanceIdentityVersion')
      .mockImplementationOnce(() => { throw new Error('simulated revision write failure') })

    expect(() => state.clearActiveDevice()).toThrow('simulated revision write failure')
    expect(principal.current()).toBeUndefined()
    expect(snapshots.at(-1)).toEqual({
      identityVersion: before.identityVersion + 1,
      principal: null
    })

    state.close()
    principal.close()
  })
})
