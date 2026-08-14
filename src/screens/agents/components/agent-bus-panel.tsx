import { useState } from 'react'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toast'

type CrewMember = {
  id: string
  displayName: string
  gatewayState: string
  processAlive: boolean
  profileFound: boolean
}

type WorkerHealth = {
  workerId: string
  displayName: string
  modelAuthStatus: string
  recentAuthErrors: number
  fallbackActive: boolean
}

type RuntimeEntry = {
  workerId: string
  displayName: string
  state: string
  needsHuman: boolean
  blockedReason: string | null
  currentTask: string | null
  lastOutputAt: number | null
}

export type AgentBusData = {
  crew: Array<CrewMember>
  workers: Array<WorkerHealth>
  entries: Array<RuntimeEntry>
  healthSummary: {
    totalAuthErrors24h?: number
    totalFallbacks24h?: number
    workersUsingFallback?: number
    workersPrimaryAuthFailed?: number
    degraded?: boolean
  }
  lastCheck: number
}

type ActionState =
  | { status: 'idle'; message: string }
  | { status: 'running'; message: string }
  | { status: 'ok'; message: string }
  | { status: 'error'; message: string }

const initialActionState: ActionState = {
  status: 'idle',
  message: 'Safe actions target the live Swarm worker pool.',
}

function formatDate(value?: number | string): string {
  if (!value) return 'no readings'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return 'no readings'
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function relativeTime(value?: number | null): string {
  if (!value) return 'never'
  const diff = Date.now() - value
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number | string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border px-4 py-3',
        tone === 'good' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
        tone === 'warn' && 'border-amber-200 bg-amber-50 text-amber-950',
        tone === 'bad' && 'border-red-200 bg-red-50 text-red-900',
        tone === 'neutral' && 'border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-text)]',
      )}
    >
      <div className="text-2xl font-semibold leading-none">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-[0.08em] opacity-70">
        {label}
      </div>
    </div>
  )
}

export function AgentBusPanel({ data }: { data: AgentBusData }) {
  const [action, setAction] = useState<ActionState>(initialActionState)

  const { crew, workers, entries, healthSummary, lastCheck } = data

  const summary = (() => {
    const swarmCrew = crew.filter((member) => member.id !== 'workspace')
    const total = swarmCrew.length || workers.length
    const online = swarmCrew.filter((member) => member.gatewayState === 'running' && member.processAlive).length
    const down = swarmCrew.filter((member) => member.profileFound && member.gatewayState !== 'running' && !member.processAlive).length
    const noEndpoint = swarmCrew.filter((member) => member.profileFound && member.gatewayState === 'unknown').length
    const nonOperational = workers.filter((worker) => worker.modelAuthStatus !== 'ready').length
    const events = (healthSummary.totalAuthErrors24h ?? 0) + (healthSummary.totalFallbacks24h ?? 0)
    const needsHuman = entries.filter((entry) => entry.needsHuman).length
    return { total, online, down, noEndpoint, nonOperational, events, needsHuman }
  })()

  const issues = workers
    .filter((worker) => worker.modelAuthStatus !== 'ready' || worker.recentAuthErrors > 0 || worker.fallbackActive)
    .map((worker) => ({
      id: worker.workerId,
      name: worker.displayName,
      status: worker.modelAuthStatus,
      authErrors: worker.recentAuthErrors,
      fallback: worker.fallbackActive,
    }))

  const missions = entries
    .filter((entry) => entry.currentTask || entry.state === 'executing' || entry.needsHuman)
    .map((entry) => ({
      id: entry.workerId,
      displayName: entry.displayName,
      state: entry.needsHuman ? 'needs-human' : entry.state,
      currentTask: entry.currentTask,
      lastOutputAt: entry.lastOutputAt,
      needsHuman: entry.needsHuman,
    }))
    .sort((left, right) => (right.lastOutputAt ?? 0) - (left.lastOutputAt ?? 0))

  async function runAction(body: Record<string, unknown>, successMessage: string) {
    setAction({ status: 'running', message: 'Executing safe action...' })
    try {
      const res = await fetch('/api/swarm-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await res.json()) as { ok?: boolean; error?: string; results?: Array<{ ok: boolean; workerId: string; error?: string | null }> }
      if (!res.ok) {
        const detail = payload.error || `HTTP ${res.status}`
        throw new Error(detail)
      }
      const workerResults = payload.results ?? []
      const succeeded = workerResults.filter((r) => r.ok).length
      const failed = workerResults.length - succeeded
      if (failed > 0) {
        const failedWorkers = workerResults.filter((r) => !r.ok)
        const errorLines = failedWorkers.map((r) => `${r.workerId}: ${r.error || 'unknown error'}`)
        setAction({
          status: 'error',
          message: `${succeeded}/${workerResults.length} succeeded, ${failed} failed — ${errorLines.join('; ')}`,
        })
      } else {
        setAction({ status: 'ok', message: successMessage })
      }
    } catch (err) {
      setAction({
        status: 'error',
        message: err instanceof Error ? err.message : 'Action failed',
      })
    }
  }

  return (
    <section className="rounded-3xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 shadow-[0_24px_80px_var(--theme-shadow)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-accent-strong)]">
            Agent Bus
          </p>
          <h2 className="mt-1 text-lg font-semibold text-[var(--theme-text)]">
            Troop Status
          </h2>
          <p className="mt-1 text-sm text-[var(--theme-muted-2)]">
            Live Swarm worker telemetry, health, and pending operational tasks.
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-sm text-[var(--theme-muted)]">
          Last check: {formatDate(lastCheck || undefined)}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <StatTile label="total" value={summary.total} />
        <StatTile label="online" value={summary.online} tone={(summary.online ?? 0) > 0 ? 'good' : 'neutral'} />
        <StatTile label="down" value={summary.down} tone={(summary.down ?? 0) > 0 ? 'bad' : 'good'} />
        <StatTile label="no endpoint" value={summary.noEndpoint} tone={(summary.noEndpoint ?? 0) > 0 ? 'warn' : 'good'} />
        <StatTile label="non op." value={summary.nonOperational} tone={(summary.nonOperational ?? 0) > 0 ? 'warn' : 'good'} />
        <StatTile label="needs human" value={summary.needsHuman} tone={(summary.needsHuman ?? 0) > 0 ? 'warn' : 'good'} />
        <StatTile label="events" value={summary.events} tone={(summary.events ?? 0) > 0 ? 'bad' : 'good'} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">Active Issues</h3>
            <span className="text-xs text-[var(--theme-muted)]">{issues.length} items</span>
          </div>
          <div className="mt-3 space-y-2">
            {issues.length ? (
              issues.map((issue) => (
                <div
                  key={issue.id}
                  className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-[var(--theme-text)]">
                      {issue.name || issue.id}
                    </span>
                    <span className="text-xs text-[var(--theme-muted)]">
                      {issue.fallback ? 'fallback active' : issue.status}
                    </span>
                  </div>
                  {issue.authErrors > 0 ? (
                    <p className="mt-1 text-xs text-[var(--theme-muted)]">
                      {issue.authErrors} auth error{issue.authErrors === 1 ? '' : 's'} in the last 24h
                    </p>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-5 text-sm text-[var(--theme-muted)]">
                All Swarm workers are healthy.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">Recent Missions</h3>
            <span className="text-xs text-[var(--theme-muted)]">{missions.length} active</span>
          </div>
          <div className="mt-3 space-y-2">
            {missions.map((mission) => (
              <div
                key={mission.id}
                className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-[var(--theme-text)]">
                    {mission.displayName}
                  </span>
                  <span className="text-xs text-[var(--theme-muted)]">
                    {mission.needsHuman ? 'needs human' : mission.state}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-[var(--theme-muted)]">
                  {mission.currentTask || 'No active task'}
                </p>
                {mission.lastOutputAt ? (
                  <p className="mt-1 text-[10px] text-[var(--theme-muted)]">
                    Last output {relativeTime(mission.lastOutputAt)}
                  </p>
                ) : null}
              </div>
            ))}
            {!missions.length ? (
              <div className="rounded-xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-5 text-sm text-[var(--theme-muted)]">
                No active missions.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">Safe Actions</h3>
            <p className="mt-1 text-xs text-[var(--theme-muted)]">
              Non-destructive diagnostics against the live Swarm pool.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                runAction(
                  { workerIds: workers.map((w) => w.workerId), prompt: 'Reply with exactly: PING_OK', timeoutSeconds: 60 },
                  `Pinged ${workers.length} worker${workers.length === 1 ? '' : 's'}.`,
                )
              }
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-2 text-sm font-medium text-[var(--theme-text)] transition-colors hover:bg-[var(--theme-card2)]"
            >
              Ping all workers
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/swarm'
              }}
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-2 text-sm font-medium text-[var(--theme-text)] transition-colors hover:bg-[var(--theme-card2)]"
            >
              Open Swarm
            </button>
          </div>
        </div>
        <p
          className={cn(
            'mt-3 text-sm font-medium',
            action.status === 'ok' && 'text-emerald-600 dark:text-emerald-400',
            action.status === 'error' && 'text-red-600 dark:text-red-400',
            action.status === 'running' && 'text-[var(--theme-accent-strong)]',
            action.status === 'idle' && 'text-[var(--theme-muted)]',
          )}
        >
          {action.message}
        </p>
      </div>
    </section>
  )
}
