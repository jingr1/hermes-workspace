import { openSqliteDatabase } from '../sqlite-helper'
import { createCollabId, ensureCollabDb, getCollabDbPath } from '../collab-db'
import { aggregateUsage, getUsageForProject, getUsageForRun, getUsageForTask, type TokenUsageRecord } from './token-usage'

export type BudgetScope = 'run' | 'task' | 'project' | 'global'
export type BudgetPeriod = 'month' | 'total'

export type Budget = {
  id: string
  scope: BudgetScope
  scope_id: string | null
  period: BudgetPeriod
  limit_tokens: number | null
  limit_cost: number | null
  warn_ratio: number
  created_at: number
  updated_at: number
}

export type BudgetInput = Omit<Budget, 'id' | 'created_at' | 'updated_at'>

function dbPath(): string {
  ensureCollabDb()
  return getCollabDbPath()
}

export function upsertBudget(input: BudgetInput): Budget {
  const id = createCollabId('bg')
  const now = Date.now()
  const db = openSqliteDatabase(dbPath(), false)
  try {
    db.prepare(
      `INSERT INTO budgets
        (id, scope, scope_id, period, limit_tokens, limit_cost, warn_ratio, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id, period) DO UPDATE SET
        limit_tokens = excluded.limit_tokens,
        limit_cost = excluded.limit_cost,
        warn_ratio = excluded.warn_ratio,
        updated_at = excluded.updated_at`,
    ).run(
      id,
      input.scope,
      input.scope_id ?? null,
      input.period,
      input.limit_tokens ?? null,
      input.limit_cost ?? null,
      input.warn_ratio,
      now,
      now,
    )
  } finally {
    db.close()
  }
  return getBudget(input.scope, input.scope_id, input.period)!
}

export function getBudget(
  scope: BudgetScope,
  scopeId: string | null | undefined,
  period: BudgetPeriod,
): Budget | null {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    return (
      (
        db
          .prepare(
            'SELECT * FROM budgets WHERE scope = ? AND scope_id IS ? AND period = ?',
          )
          .all(scope, scopeId ?? null, period) as Budget[]
      )[0] ?? null
    )
  } finally {
    db.close()
  }
}

export function listBudgets(): Budget[] {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    return db.prepare('SELECT * FROM budgets ORDER BY scope, scope_id, period').all() as Budget[]
  } finally {
    db.close()
  }
}

export function deleteBudget(
  scope: BudgetScope,
  scopeId: string | null | undefined,
  period: BudgetPeriod,
): boolean {
  const db = openSqliteDatabase(dbPath(), false)
  try {
    const result = db
      .prepare(
        'DELETE FROM budgets WHERE scope = ? AND scope_id IS ? AND period = ?',
      )
      .run(scope, scopeId ?? null, period)
    return result.changes > 0
  } finally {
    db.close()
  }
}

export type BudgetStatus =
  | { state: 'ok' | 'warn' | 'hard_stop'; budget: Budget | null; consumedTokens: number; consumedCost: number; reason: string }

export function checkBudgetGate(opts: {
  runId?: string
  taskId?: string
  projectId?: string
  period?: BudgetPeriod
}): BudgetStatus {
  const period = opts.period ?? 'month'

  // If the budgets table doesn't exist yet (schema not migrated), behave as unlimited.
  try {
    const db = openSqliteDatabase(dbPath(), false)
    try {
      db.prepare('SELECT 1 FROM budgets LIMIT 1').all()
    } finally {
      db.close()
    }
  } catch {
    return {
      state: 'ok',
      budget: null,
      consumedTokens: 0,
      consumedCost: 0,
      reason: 'budgets table not migrated',
    }
  }

  const chain: Array<{ scope: BudgetScope; scopeId: string | null }> = [
    ...(opts.runId ? [{ scope: 'run' as BudgetScope, scopeId: opts.runId }] : []),
    ...(opts.taskId ? [{ scope: 'task' as BudgetScope, scopeId: opts.taskId }] : []),
    ...(opts.projectId ? [{ scope: 'project' as BudgetScope, scopeId: opts.projectId }] : []),
    { scope: 'global' as BudgetScope, scopeId: null },
  ]

  for (const { scope, scopeId } of chain) {
    const budget = getBudget(scope, scopeId, period)
    if (!budget) continue
    if (budget.limit_tokens == null && budget.limit_cost == null) continue

    let records: TokenUsageRecord[] = []
    if (scope === 'run' && scopeId) records = getUsageForRun(scopeId)
    else if (scope === 'task' && scopeId) records = getUsageForTask(scopeId)
    else if (scope === 'project' && scopeId) {
      records =
        period === 'month'
          ? getUsageForProject(scopeId)
          : getUsageForProject(scopeId)
    } else if (scope === 'global') {
      records = []
      // global is too expensive to aggregate here; rely on budget limit_cost only
    }

    const agg = aggregateUsage(records)
    const tokenLimit = budget.limit_tokens ?? Infinity
    const costLimit = budget.limit_cost ?? Infinity
    const warnTokens = tokenLimit * budget.warn_ratio
    const warnCost = costLimit * budget.warn_ratio

    if (
      (budget.limit_tokens != null && agg.totalTokens >= tokenLimit) ||
      (budget.limit_cost != null && agg.costEstimate >= costLimit)
    ) {
      return {
        state: 'hard_stop',
        budget,
        consumedTokens: agg.totalTokens,
        consumedCost: agg.costEstimate,
        reason: `${scope} budget ${period} exceeded`,
      }
    }
    if (
      (budget.limit_tokens != null && agg.totalTokens >= warnTokens) ||
      (budget.limit_cost != null && agg.costEstimate >= warnCost)
    ) {
      return {
        state: 'warn',
        budget,
        consumedTokens: agg.totalTokens,
        consumedCost: agg.costEstimate,
        reason: `${scope} budget ${period} at ${Math.round(budget.warn_ratio * 100)}%`,
      }
    }

    return {
      state: 'ok',
      budget,
      consumedTokens: agg.totalTokens,
      consumedCost: agg.costEstimate,
      reason: `${scope} budget ${period} ok`,
    }
  }

  return {
    state: 'ok',
    budget: null,
    consumedTokens: 0,
    consumedCost: 0,
    reason: 'no budget configured',
  }
}
