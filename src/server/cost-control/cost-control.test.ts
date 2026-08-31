import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'cost-control-test-'))
  vi.doMock('../claude-paths', () => ({
    getClaudeRoot: () => tempRoot,
    getHermesRoot: () => tempRoot,
    getLocalBinDir: () => join(tempRoot, '.local', 'bin'),
    getWorkspaceHermesHome: () => tempRoot,
    getProfileHermesHome: (id: string) => join(tempRoot, 'profiles', id),
  }))
  const tokenUsage = await import('./token-usage')
  const budgets = await import('./budgets')
  return { tokenUsage, budgets }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('../claude-paths')
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
})

describe('cost-control', () => {
  it('records and aggregates token usage', async () => {
    const { tokenUsage } = await loadModule()
    tokenUsage.recordTokenUsage({
      run_id: 'run-1',
      task_id: 'task-1',
      agent_id: 'claude',
      project_id: 'proj-a',
      runtime: 'claude-code',
      model: 'claude-sonnet',
      input: 1000,
      output: 500,
      cache_read: 200,
      cache_write: 100,
      reasoning: 50,
      cost_estimate: 0.012,
    })
    tokenUsage.recordTokenUsage({
      run_id: 'run-2',
      task_id: 'task-2',
      agent_id: 'claude',
      project_id: 'proj-a',
      runtime: 'claude-code',
      model: 'claude-sonnet',
      input: 2000,
      output: 1000,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      cost_estimate: 0.02,
    })
    const agg = tokenUsage.aggregateUsage(tokenUsage.getUsageForProject('proj-a'))
    expect(agg.totalTokens).toBe(4850)
    expect(agg.costEstimate).toBeCloseTo(0.032, 3)
  })

  it('warns at 80% of token budget and hard-stops at 100%', async () => {
    const { tokenUsage, budgets } = await loadModule()
    budgets.upsertBudget({
      scope: 'project',
      scope_id: 'proj-a',
      period: 'month',
      limit_tokens: 1000,
      limit_cost: null,
      warn_ratio: 0.8,
    })
    tokenUsage.recordTokenUsage({
      run_id: 'run-1',
      task_id: 'task-1',
      agent_id: 'claude',
      project_id: 'proj-a',
      runtime: 'claude-code',
      model: 'claude-sonnet',
      input: 700,
      output: 100,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      cost_estimate: 0.01,
    })
    const warn = budgets.checkBudgetGate({ projectId: 'proj-a' })
    expect(warn.state).toBe('warn')

    tokenUsage.recordTokenUsage({
      run_id: 'run-2',
      task_id: 'task-1',
      agent_id: 'claude',
      project_id: 'proj-a',
      runtime: 'claude-code',
      model: 'claude-sonnet',
      input: 400,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      cost_estimate: 0.005,
    })
    const stop = budgets.checkBudgetGate({ projectId: 'proj-a' })
    expect(stop.state).toBe('hard_stop')
  })

  it('skips null usage records in aggregation', async () => {
    const { tokenUsage, budgets } = await loadModule()
    budgets.upsertBudget({
      scope: 'task',
      scope_id: 'task-1',
      period: 'month',
      limit_tokens: null,
      limit_cost: 1,
      warn_ratio: 0.8,
    })
    tokenUsage.recordTokenUsage({
      run_id: 'run-1',
      task_id: 'task-1',
      agent_id: 'claude',
      project_id: 'proj-a',
      runtime: 'claude-code',
      model: 'claude-sonnet',
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      reasoning: null,
      cost_estimate: null,
    })
    const gate = budgets.checkBudgetGate({ taskId: 'task-1' })
    expect(gate.state).toBe('ok')
    expect(gate.consumedTokens).toBe(0)
  })
})
