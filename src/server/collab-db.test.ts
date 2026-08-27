import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureCollabDb, getCollabDbVersion, createCollabId } from './collab-db'

let tempRoot: string

describe('collab-db', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'collab-db-test-'))
  })

  afterEach(() => {
    try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('creates collab.db with schema_migrations and all tables', () => {
    const dbPath = join(tempRoot, 'collab.db')
    ensureCollabDb(dbPath)
    expect(getCollabDbVersion(dbPath)).toBe(1)
  })

  it('is idempotent — running twice does not error or duplicate version', () => {
    const dbPath = join(tempRoot, 'collab.db')
    ensureCollabDb(dbPath)
    ensureCollabDb(dbPath)
    expect(getCollabDbVersion(dbPath)).toBe(1)
  })

  it('creates unique ids with prefix', () => {
    const id1 = createCollabId('run')
    const id2 = createCollabId('run')
    expect(id1).toMatch(/^run_[a-f0-9]{12}$/)
    expect(id2).toMatch(/^run_[a-f0-9]{12}$/)
    expect(id1).not.toBe(id2)
  })
})
