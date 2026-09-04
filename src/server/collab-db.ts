import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { openSqliteDatabase, runSqlite } from './sqlite-helper'
import { getClaudeRoot } from './claude-paths'

/**
 * collab.db — collaboration database for multi-agent workspace extension.
 *
 * Evolution roadmap (P0: do NOT migrate data yet):
 * - Now: mission JSON (swarm-missions.json) is the pipeline source of truth;
 *   collab.db is the source of truth for runs / rooms / tokens. Dual-write is a known liability.
 * - P2a: reconciliation + write ordering makes the liability recoverable, not transactional.
 * - Mid-term (not delivered by this plan): missions / assignments migrate into collab.db,
 *   sharing transactions with task_runs; JSON becomes an export cache or is deleted.
 *
 * schema_migrations table is pre-created for future kanban/collab migrations.
 * No empty missions table is created — an empty table is more misleading than dual sources.
 */

export function getCollabDbPath(): string {
  return path.join(getClaudeRoot(), 'collab.db')
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT,
  task_id TEXT,
  mission_id TEXT,
  workspace_path TEXT,
  owner_participant_id TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS room_participants (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  kind TEXT,              -- human | agent
  participant_id TEXT,    -- agents.yaml agent id, or human:<userId>
  display_name TEXT,
  mention_name TEXT,
  description TEXT,
  profile TEXT,            -- hermes profile name (runtime=hermes)
  runtime TEXT,           -- hermes | claude-code | codex | deepseek-harness
  is_owner INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0,
  joined_at INTEGER,
  removed_at INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_mention
  ON room_participants(room_id, mention_name);

CREATE TABLE IF NOT EXISTS room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  sender_kind TEXT,       -- human | agent | system
  sender_participant_id TEXT,
  sender_name TEXT,
  content TEXT,
  mentions TEXT,          -- JSON Array<{ type: 'human'|'agent'|'all', participantId?: string }>
  mention_depth INTEGER DEFAULT 0,
  auto_handoff INTEGER DEFAULT 0,
  task_refs TEXT,         -- JSON Array<string>
  answers_pending_turn_id TEXT,
  run_id TEXT,
  task_id TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room
  ON room_messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS run_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT,              -- read_only | run_write
  run_id TEXT,
  participant_id TEXT,
  assignment_id TEXT,     -- read_only 时为 NULL
  task_id TEXT,
  room_id TEXT,
  tool_allowlist TEXT,    -- JSON array
  issued_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER DEFAULT 0,
  consumed_at INTEGER,
  consumed_payload_hash TEXT,
  last_response_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_tokens_run
  ON run_tokens(run_id, revoked_at);

CREATE TABLE IF NOT EXISTS pending_turns (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  task_id TEXT,
  assignment_id TEXT,
  requested_by TEXT,
  target_participant_id TEXT,
  message_id TEXT,
  kind TEXT,              -- needs_input | blocked | approval | review
  reason TEXT,
  options TEXT,           -- JSON [{ id, label, replyText }]
  status TEXT,            -- pending | answered | dismissed | expired
  created_at INTEGER,
  answered_at INTEGER,
  answered_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_turns_open
  ON pending_turns(status, created_at);

CREATE TABLE IF NOT EXISTS room_summaries (
  room_id TEXT PRIMARY KEY,
  summary TEXT,
  through_message_id TEXT,
  through_at INTEGER,
  turn_count INTEGER,
  version INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  mission_id TEXT,
  assignment_id TEXT,
  room_id TEXT,
  agent_id TEXT,
  runtime TEXT,
  status TEXT CHECK(status IN ('running','done','blocked','needs_input','failed','cancelled')),
  started_at INTEGER,
  ended_at INTEGER,
  summary TEXT,
  blocker TEXT,
  next_action TEXT,
  log_path TEXT,
  checkpoint_json TEXT,
  project_id TEXT,
  branch TEXT,
  base_ref TEXT,
  head_sha TEXT,
  worktree_path TEXT,
  files_changed TEXT      -- JSON array, repo-relative paths
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task
  ON task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_assignment
  ON task_runs(assignment_id, started_at);
CREATE INDEX IF NOT EXISTS idx_run_tokens_expiry
  ON run_tokens(expires_at);
`,
  },
  {
    version: 2,
    sql: `
-- Idempotent v2: ensure rooms has state column and room_watermarks exists.
-- Use temp-table recreation in case an older rooms table lacks the column.
CREATE TABLE IF NOT EXISTS rooms_new (
  id TEXT PRIMARY KEY,
  title TEXT,
  state TEXT DEFAULT 'active',
  task_id TEXT,
  mission_id TEXT,
  workspace_path TEXT,
  owner_participant_id TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
INSERT OR IGNORE INTO rooms_new (id, title, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at)
  SELECT id, title, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at FROM rooms;
DROP TABLE rooms;
ALTER TABLE rooms_new RENAME TO rooms;

CREATE TABLE IF NOT EXISTS room_watermarks (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (room_id, participant_id)
);
`,
  },
  {
    version: 3,
    sql: `
-- Repair any database where v2's ALTER TABLE failed silently and rooms lacks state.
CREATE TABLE IF NOT EXISTS rooms_new (
  id TEXT PRIMARY KEY,
  title TEXT,
  state TEXT DEFAULT 'active',
  task_id TEXT,
  mission_id TEXT,
  workspace_path TEXT,
  owner_participant_id TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
INSERT OR IGNORE INTO rooms_new (id, title, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at)
  SELECT id, title, task_id, mission_id, workspace_path, owner_participant_id, created_at, updated_at FROM rooms;
DROP TABLE rooms;
ALTER TABLE rooms_new RENAME TO rooms;
`,
  },
  {
    version: 4,
    sql: `
-- Ensure room_watermarks exists even if a previous v2/v3 migration ran without
-- creating it (some dev databases applied v2 before the table was added).
CREATE TABLE IF NOT EXISTS room_watermarks (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (room_id, participant_id)
);
`,
  },
  {
    version: 5,
    sql: `
-- Add profile column to room_participants for per-profile gateway routing.
-- Use temp-table recreation in case a previous partial migration left the
-- table without the column despite a schema_migrations row being written.
CREATE TABLE IF NOT EXISTS room_participants_new (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  kind TEXT,
  participant_id TEXT,
  display_name TEXT,
  mention_name TEXT,
  description TEXT,
  profile TEXT,
  runtime TEXT,
  is_owner INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0,
  joined_at INTEGER,
  removed_at INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO room_participants_new (
  id, room_id, kind, participant_id, display_name, mention_name,
  description, profile, runtime, is_owner, online, joined_at, removed_at
)
  SELECT
    id, room_id, kind, participant_id, display_name, mention_name,
    description, NULL, runtime, is_owner, online, joined_at, removed_at
  FROM room_participants;
DROP TABLE room_participants;
ALTER TABLE room_participants_new RENAME TO room_participants;
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_mention
  ON room_participants(room_id, mention_name);
`,
  },
]

export function ensureCollabDb(dbPath: string = getCollabDbPath()): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openSqliteDatabase(dbPath, false)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    const rows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    const applied = new Set(rows.map((r) => r.version))
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      // Wrap each migration in a transaction so a crash mid-migration can't
      // leave half-applied DDL with a schema_migrations row already written.
      db.exec('BEGIN')
      try {
        db.exec(migration.sql)
        db.prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        ).run(migration.version, Date.now())
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  } finally {
    db.close()
  }
}

export function getCollabDbVersion(dbPath: string = getCollabDbPath()): number {
  if (!fs.existsSync(dbPath)) return 0
  const raw = runSqlite(
    dbPath,
    'SELECT MAX(version) as v FROM schema_migrations',
  )
  const parsed = raw ? (JSON.parse(raw) as Array<{ v: number | null }>) : []
  return parsed[0]?.v ?? 0
}

export function insertCollabRow(
  table: string,
  row: Record<string, unknown>,
  dbPath: string = getCollabDbPath(),
): void {
  const keys = Object.keys(row)
  const values = keys.map((k) => row[k])
  const placeholders = keys.map(() => '?').join(', ')
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
  const db = openSqliteDatabase(dbPath, false)
  try {
    db.prepare(sql).run(...values)
  } finally {
    db.close()
  }
}

export function createCollabId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}
