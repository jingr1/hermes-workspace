import { openSqliteDatabase } from '../sqlite-helper'
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'

export type TokenUsageRecord = {
  id: string
  run_id: string | null
  task_id: string | null
  agent_id: string | null
  project_id: string | null
  runtime: string | null
  model: string | null
  input: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  reasoning: number | null
  cost_estimate: number | null
  at: number
}

export type TokenUsageInput = Omit<TokenUsageRecord, 'id' | 'at'>

function dbPath(): string {
  ensureCollabDb()
  return getCollabDbPath()
}

export function recordTokenUsage(input: TokenUsageInput): TokenUsageRecord {
  const record: TokenUsageRecord = {
    ...input,
    id: createCollabId('tu'),
    at: Date.now(),
  }
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO token_usage
        (id, run_id, task_id, agent_id, project_id, runtime, model,
         input, output, cache_read, cache_write, reasoning, cost_estimate, at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.run_id ?? null,
      record.task_id ?? null,
      record.agent_id ?? null,
      record.project_id ?? null,
      record.runtime ?? null,
      record.model ?? null,
      record.input ?? null,
      record.output ?? null,
      record.cache_read ?? null,
      record.cache_write ?? null,
      record.reasoning ?? null,
      record.cost_estimate ?? null,
      record.at,
    )
  } finally {
    db.close()
  }
  return record
}

export function getUsageForRun(runId: string): TokenUsageRecord[] {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    return db
      .prepare(
        'SELECT * FROM token_usage WHERE run_id = ? ORDER BY at DESC',
      )
      .all(runId) as TokenUsageRecord[]
  } finally {
    db.close()
  }
}

export function getUsageForTask(taskId: string): TokenUsageRecord[] {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    return db
      .prepare(
        'SELECT * FROM token_usage WHERE task_id = ? ORDER BY at DESC',
      )
      .all(taskId) as TokenUsageRecord[]
  } finally {
    db.close()
  }
}

export function getUsageForProject(
  projectId: string,
  opts?: { from?: number; to?: number },
): TokenUsageRecord[] {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    if (opts?.from != null && opts?.to != null) {
      return db
        .prepare(
          'SELECT * FROM token_usage WHERE project_id = ? AND at >= ? AND at <= ? ORDER BY at DESC',
        )
        .all(projectId, opts.from, opts.to) as TokenUsageRecord[]
    }
    return db
      .prepare(
        'SELECT * FROM token_usage WHERE project_id = ? ORDER BY at DESC',
      )
      .all(projectId) as TokenUsageRecord[]
  } finally {
    db.close()
  }
}

export function aggregateUsage(
  records: TokenUsageRecord[],
): {
  input: number
  output: number
  cache_read: number
  cache_write: number
  reasoning: number
  totalTokens: number
  costEstimate: number
  count: number
} {
  const result = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    totalTokens: 0,
    costEstimate: 0,
    count: 0,
  }
  for (const r of records) {
    if (r.input == null && r.output == null && r.cost_estimate == null) {
      continue
    }
    result.input += r.input ?? 0
    result.output += r.output ?? 0
    result.cache_read += r.cache_read ?? 0
    result.cache_write += r.cache_write ?? 0
    result.reasoning += r.reasoning ?? 0
    result.totalTokens +=
      (r.input ?? 0) +
      (r.output ?? 0) +
      (r.cache_read ?? 0) +
      (r.cache_write ?? 0) +
      (r.reasoning ?? 0)
    result.costEstimate += r.cost_estimate ?? 0
    result.count += 1
  }
  return result
}

export function getMonthlyRange(): { from: number; to: number } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1
  return { from: start, to: end }
}
