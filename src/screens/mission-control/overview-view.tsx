'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  AlertIcon,
  CheckListIcon,
  CpuIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import type { AgentStatusEntry, TaskSummary } from '@/lib/mission-control-api'
import { fetchAgentsStatus, fetchTasks } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'

const AGENTS_QUERY_KEY = ['mission-control', 'agents'] as const
const TASKS_QUERY_KEY = ['mission-control', 'tasks'] as const

function useMissionControlData() {
  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: fetchAgentsStatus,
    refetchInterval: 30_000,
  })
  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    refetchInterval: 30_000,
  })
  return { agentsQuery, tasksQuery }
}

function RuntimeBadge({ runtime }: { runtime: AgentStatusEntry['runtime'] }) {
  const colors: Record<AgentStatusEntry['runtime'], string> = {
    hermes: 'bg-violet-500/10 text-violet-700 border-violet-400/40',
    'claude-code': 'bg-amber-500/10 text-amber-700 border-amber-400/40',
    codex: 'bg-blue-500/10 text-blue-700 border-blue-400/40',
    'deepseek-harness':
      'bg-emerald-500/10 text-emerald-700 border-emerald-400/40',
  }
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        colors[runtime],
      )}
    >
      {runtime}
    </span>
  )
}

function StateDot({
  state,
  needsHuman,
}: {
  state: string
  needsHuman: boolean
}) {
  let color = 'bg-slate-400'
  if (needsHuman) color = 'bg-red-500'
  else if (state === 'executing' || state === 'running')
    color = 'bg-emerald-500'
  else if (state === 'blocked') color = 'bg-red-400'
  else if (state === 'idle') color = 'bg-blue-400'
  return <span className={cn('h-2 w-2 rounded-full', color)} />
}

function KpiCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string
  value: number
  tone: 'slate' | 'emerald' | 'amber' | 'rose'
  icon: typeof CpuIcon
}) {
  const toneClasses = {
    slate: 'border-slate-400/30 bg-slate-500/5',
    emerald: 'border-emerald-400/30 bg-emerald-500/5',
    amber: 'border-amber-400/30 bg-amber-500/5',
    rose: 'border-rose-400/30 bg-rose-500/5',
  }
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border p-3',
        toneClasses[tone],
      )}
    >
      <HugeiconsIcon icon={icon} size={20} className="opacity-80" />
      <div>
        <div className="text-xl font-semibold leading-none">{value}</div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--theme-muted)]">
          {label}
        </div>
      </div>
    </div>
  )
}

function AgentCard({
  agent,
  onClick,
}: {
  agent: AgentStatusEntry
  onClick?: () => void
}) {
  const status = agent.status
  const currentTask = status?.currentTask ?? 'Idle'
  const elapsed = useMemo(() => {
    if (!status?.updatedAt) return ''
    const minutes = Math.floor((Date.now() - status.updatedAt) / 60_000)
    if (minutes < 1) return '<1m'
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }, [status?.updatedAt])

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-2 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-3 text-left transition-colors hover:border-[var(--theme-accent)] hover:bg-[var(--theme-hover)]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StateDot
            state={status?.state ?? 'idle'}
            needsHuman={status?.needsHuman ?? false}
          />
          <span className="text-sm font-medium">{agent.agentId}</span>
        </div>
        <RuntimeBadge runtime={agent.runtime} />
      </div>
      <div className="text-xs text-[var(--theme-text)] line-clamp-2">
        {currentTask}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-[var(--theme-muted)]">
        {status && (
          <>
            <span className="capitalize">{status.state}</span>
            {elapsed && <span>· {elapsed}</span>}
            {status.checkpointStatus && status.checkpointStatus !== 'none' && (
              <span>· {status.checkpointStatus}</span>
            )}
          </>
        )}
      </div>
    </button>
  )
}

function TaskProgress({ tasks }: { tasks: Array<TaskSummary> }) {
  const byLane = useMemo(() => {
    const map: Record<string, number> = {
      backlog: 0,
      todo: 0,
      ready: 0,
      running: 0,
      review: 0,
      blocked: 0,
      done: 0,
    }
    for (const t of tasks) {
      const lane = t.derivedLane ?? t.lane
      map[lane] = (map[lane] ?? 0) + 1
    }
    return map
  }, [tasks])

  const lanes: Array<{ key: string; label: string; color: string }> = [
    { key: 'backlog', label: 'Backlog', color: '#6b7280' },
    { key: 'todo', label: 'Ready', color: '#3b82f6' },
    { key: 'running', label: 'Running', color: '#f97316' },
    { key: 'review', label: 'Review', color: '#a855f7' },
    { key: 'blocked', label: 'Blocked', color: '#ef4444' },
    { key: 'done', label: 'Done', color: '#22c55e' },
  ]

  const total = tasks.length

  return (
    <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
        Task Progress
      </h3>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-[var(--theme-hover)]">
        {lanes.map((lane) => {
          const count = byLane[lane.key] ?? 0
          const pct = total > 0 ? (count / total) * 100 : 0
          return (
            <div
              key={lane.key}
              style={{ width: `${pct}%`, background: lane.color }}
              title={`${lane.label}: ${count}`}
              className="h-full transition-all"
            />
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[10px]">
        {lanes.map((lane) => (
          <div key={lane.key} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: lane.color }}
            />
            <span className="text-[var(--theme-muted)]">{lane.label}</span>
            <span className="font-medium">{byLane[lane.key] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function OverviewView({
  onSelectTask,
}: {
  onSelectTask: (taskId: string) => void
}) {
  const { agentsQuery, tasksQuery } = useMissionControlData()
  const agents = agentsQuery.data?.agents ?? []
  const tasks = tasksQuery.data?.tasks ?? []

  const stats = useMemo(() => {
    const online = agents.filter((a) => a.probe.available).length
    const running = agents.filter(
      (a) => a.status?.state === 'executing' || a.status?.state === 'running',
    ).length
    const blocked = agents.filter(
      (a) => a.status?.needsHuman || a.status?.state === 'blocked',
    ).length
    const pendingHuman = agents.filter((a) => a.status?.needsHuman).length
    const doneToday = 0 // TODO: derive from task completedAt once API exposes it
    return { online, running, blocked, pendingHuman, doneToday }
  }, [agents])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 pb-24 sm:p-6">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            label="Online agents"
            value={stats.online}
            tone="emerald"
            icon={CpuIcon}
          />
          <KpiCard
            label="Executing"
            value={stats.running}
            tone="amber"
            icon={CheckListIcon}
          />
          <KpiCard
            label="Blocked"
            value={stats.blocked}
            tone="rose"
            icon={AlertIcon}
          />
          <KpiCard
            label="Pending human"
            value={stats.pendingHuman}
            tone="amber"
            icon={AlertIcon}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Agent wall */}
          <section className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Agents</h2>
              <button
                type="button"
                onClick={() => agentsQuery.refetch()}
                className="rounded p-1 hover:bg-[var(--theme-hover)]"
                title="Refresh"
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={14}
                  className="text-[var(--theme-muted)]"
                />
              </button>
            </div>
            {agentsQuery.isLoading ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-24 animate-pulse rounded-xl bg-[var(--theme-hover)]"
                  />
                ))}
              </div>
            ) : agents.length === 0 ? (
              <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-6 text-center text-sm text-[var(--theme-muted)]">
                No agents declared. Add them to agents.yaml.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {agents.map((agent) => (
                  <AgentCard key={agent.agentId} agent={agent} />
                ))}
              </div>
            )}
          </section>

          {/* Right column */}
          <section className="space-y-5">
            <TaskProgress tasks={tasks} />
            <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                Recent Tasks
              </h3>
              <div className="mt-3 space-y-2">
                {tasks.slice(0, 6).map((task) => (
                  <button
                    key={task.cardId}
                    type="button"
                    onClick={() => onSelectTask(task.cardId)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg p-2 text-left hover:bg-[var(--theme-hover)]"
                  >
                    <span className="truncate text-xs font-medium">
                      {task.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--theme-muted)]">
                      {task.progress}%
                    </span>
                  </button>
                ))}
                {tasks.length === 0 && (
                  <p className="text-xs text-[var(--theme-muted)]">
                    No tasks yet.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
