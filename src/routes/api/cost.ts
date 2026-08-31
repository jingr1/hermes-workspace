import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  aggregateUsage,
  getMonthlyRange,
  getUsageForProject,
} from '../../server/cost-control/token-usage'
import { listBudgets, checkBudgetGate } from '../../server/cost-control/budgets'

export const Route = createFileRoute('/api/cost')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const url = new URL(request.url)
        const projectId = url.searchParams.get('projectId') ?? undefined
        const taskId = url.searchParams.get('taskId') ?? undefined
        const runId = url.searchParams.get('runId') ?? undefined
        const scope = (url.searchParams.get('scope') as
          | 'run'
          | 'task'
          | 'project'
          | 'global') ?? 'project'

        const { from, to } = getMonthlyRange()
        const budgets = listBudgets()
        let records = projectId
          ? getUsageForProject(projectId, { from, to })
          : []

        // Provide a project grouping if no specific filter
        const projectTotals: Record<
          string,
          { tokens: number; cost: number; runs: number }
        > = {}
        for (const r of records) {
          const pid = r.project_id || 'unknown'
          const bucket = projectTotals[pid] ?? { tokens: 0, cost: 0, runs: 0 }
          bucket.tokens +=
            (r.input ?? 0) +
            (r.output ?? 0) +
            (r.cache_read ?? 0) +
            (r.cache_write ?? 0) +
            (r.reasoning ?? 0)
          bucket.cost += r.cost_estimate ?? 0
          bucket.runs += 1
          projectTotals[pid] = bucket
        }

        const topProjects = Object.entries(projectTotals)
          .map(([id, agg]) => ({ id, ...agg }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5)

        const gate = checkBudgetGate({
          runId,
          taskId,
          projectId,
          period: 'month',
        })
        const total = aggregateUsage(records)

        return json({
          ok: true,
          scope,
          period: { from, to },
          total,
          topProjects,
          budgets,
          gate: {
            state: gate.state,
            reason: gate.reason,
            consumedTokens: gate.consumedTokens,
            consumedCost: gate.consumedCost,
          },
        })
      },
    },
  },
})
