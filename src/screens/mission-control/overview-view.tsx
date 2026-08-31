'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  CheckListIcon,
  Alert01Icon,
  UserMultipleIcon,
  CpuIcon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import {
  fetchAgentStatuses,
  fetchCostSummary,
  type AgentStatus,
} from '@/lib/mission-control-api'
import { useCollabStream } from '@/hooks/use-collab-stream'

const QUERY_KEY = ['mission-control', 'agents-status'] as const

function useAgentStatuses() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAgentStatuses,
    refetchInterval: 30_000,
  })

  const [liveAgents, setLiveAgents] = useState<AgentStatus[] | null>(null)

  useCollabStream({
    scope: 'global',
    onEvent: (evt) => {
      if (evt.event !== 'agent_status') return
      const agents = Array.isArray(evt.data.agents)
        ? (evt.data.agents as AgentStatus[])
        : []
      setLiveAgents((prev) => {
        const base = prev ?? query.data?.agents ?? []
        const next = new Map(base.map((a) => [a.agentId, a]))
        for (const a of agents) next.set(a.agentId, a)
        return Array.from(next.values())
      })
    },
  })

  const data = useMemo(() => {
    if (liveAgents) return { ...query.data, agents: liveAgents } as ReturnType<typeof fetchAgentStatuses> extends Promise<infer T> ? T : never
    return query.data
  }, [liveAgents, query.data])

  return { ...query, data }
}

function RuntimeBadge({ runtime }: { runtime: AgentStatus['runtime'] }) {
  const label =
    runtime === 'hermes'
      ? 'Hermes'
      : runtime === 'claude-code'
        ? 'Claude Code'
        : runtime === 'codex'
          ? 'Codex'
          : 'DeepSeek'
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--theme-hover)] text-[var(--theme-text-muted)] uppercase tracking-wide">
      {label}
    </span>
  )
}

function StateDot({ state, online }: { state: string; online: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        !online
          ? 'bg-[var(--theme-text-muted)]'
          : state === 'executing' || state === 'thinking'
            ? 'bg-emerald-500 animate-pulse'
            : state === 'blocked' || state === 'needs_input'
              ? 'bg-rose-500'
              : state === 'reviewing'
                ? 'bg-amber-500'
                : 'bg-blue-500',
      )}
    />
  )
}

export function OverviewView() {
  const { data, isLoading } = useAgentStatuses()

  const agents = data?.agents ?? []
  const online = data?.onlineCount ?? 0
  const executing = data?.executingCount ?? 0
  const blocked = data?.blockedCount ?? 0

  const todayCompleted = useMemo(() => {
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    return agents.filter(
      (a) =>
        a.checkpointStatus === 'done' &&
        (a.lastOutputAt ?? 0) > startOfDay,
    ).length
  }, [agents])

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={UserMultipleIcon} label="Online" value={online} />
        <KpiCard icon={CpuIcon} label="Executing" value={executing} />
        <KpiCard icon={Alert01Icon} label="Blocked / Needs human" value={blocked} />
        <KpiCard icon={CheckListIcon} label="Done today" value={todayCompleted} />
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Cost this month</h2>
        <CostCard />
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Agents</h2>
        {isLoading ? (
          <div className="text-sm text-[var(--theme-text-muted)]">Loading…</div>
        ) : agents.length === 0 ? (
          <div className="text-sm text-[var(--theme-text-muted)]">
            No agents declared. Add them to agents.yaml.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map((agent) => (
              <div
                key={agent.agentId}
                className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StateDot state={agent.state} online={agent.online} />
                      <span className="font-medium truncate">
                        {agent.displayName || agent.agentId}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <RuntimeBadge runtime={agent.runtime} />
                      {agent.execution === 'ssh' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400">
                          SSH
                        </span>
                      )}
                      {agent.needsHuman && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400">
                          Needs human
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {agent.currentTask && (
                  <div className="mt-2 text-xs text-[var(--theme-text-muted)] truncate">
                    {agent.currentTask}
                  </div>
                )}
                {agent.capabilities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {agent.capabilities.slice(0, 4).map((cap) => (
                      <span
                        key={cap}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--theme-hover)] text-[var(--theme-text-muted)]"
                      >
                        {cap}
                      </span>
                    ))}
                    {agent.capabilities.length > 4 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--theme-hover)] text-[var(--theme-text-muted)]">
                        +{agent.capabilities.length - 4}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function KpiCard({
  icon,
  label,
  value,
}: {
  icon: typeof UserMultipleIcon
  label: string
  value: number
}) {
  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-3 flex items-center gap-3">
      <div className="p-2 rounded-md bg-[var(--theme-hover)]">
        <HugeiconsIcon icon={icon} size={18} className="text-[var(--theme-accent)]" />
      </div>
      <div>
        <div className="text-2xl font-semibold leading-none">{value}</div>
        <div className="text-xs text-[var(--theme-text-muted)] mt-1">{label}</div>
      </div>
    </div>
  )
}

function CostCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['mission-control', 'cost-summary'],
    queryFn: fetchCostSummary,
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div className="text-sm text-[var(--theme-text-muted)]">Loading…</div>
    )
  }

  const total = data?.total
  const gate = data?.gate

  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-2xl font-semibold leading-none">
            {total ? `${Math.round(total.totalTokens).toLocaleString()}` : '—'}
          </div>
          <div className="text-xs text-[var(--theme-text-muted)] mt-1">
            tokens used
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold leading-none">
            ${total ? total.costEstimate.toFixed(2) : '—'}
          </div>
          <div className="text-xs text-[var(--theme-text-muted)] mt-1">
            estimated cost
          </div>
        </div>
      </div>

      {gate && gate.state !== 'ok' && (
        <div
          className={cn(
            'text-xs px-3 py-2 rounded-md',
            gate.state === 'hard_stop'
              ? 'bg-rose-500/10 text-rose-400'
              : 'bg-amber-500/10 text-amber-400',
          )}
        >
          {gate.reason}
        </div>
      )}

      {data?.topProjects && data.topProjects.length > 0 && (
        <div>
          <div className="text-xs font-medium mb-2">Top projects</div>
          <div className="space-y-1">
            {data.topProjects.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between text-xs"
              >
                <span className="truncate max-w-[60%]">{p.id}</span>
                <span className="text-[var(--theme-text-muted)]">
                  {Math.round(p.tokens).toLocaleString()} tokens
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
