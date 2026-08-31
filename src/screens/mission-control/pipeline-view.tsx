'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import {
  fetchMissionPipeline,
  fetchAgentStatuses,
  type MissionPipeline,
  type AgentStatus,
} from '@/lib/mission-control-api'
import { useCollabStream } from '@/hooks/use-collab-stream'

const PIPELINE_QUERY_KEY = ['mission-control', 'pipeline'] as const
const AGENTS_QUERY_KEY = ['mission-control', 'agents-status'] as const

function usePipeline(missionId: string | null | undefined) {
  return useQuery({
    queryKey: [...PIPELINE_QUERY_KEY, missionId],
    queryFn: () =>
      missionId ? fetchMissionPipeline(missionId) : Promise.resolve(null),
    enabled: Boolean(missionId),
    refetchInterval: 30_000,
  })
}

function useAgentStatusesWithLive() {
  const query = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: fetchAgentStatuses,
    refetchInterval: 30_000,
  })
  const [live, setLive] = useState<AgentStatus[] | null>(null)

  useCollabStream({
    scope: 'global',
    onEvent: (evt) => {
      if (evt.event !== 'agent_status') return
      const agents = Array.isArray(evt.data.agents)
        ? (evt.data.agents as AgentStatus[])
        : []
      setLive((prev) => {
        const base = prev ?? query.data?.agents ?? []
        const next = new Map(base.map((a) => [a.agentId, a]))
        for (const a of agents) next.set(a.agentId, a)
        return Array.from(next.values())
      })
    },
  })

  return live ?? query.data?.agents ?? []
}

function stageColor(state: string): string {
  switch (state) {
    case 'done':
    case 'checkpointed':
      return 'bg-emerald-500'
    case 'dispatched':
    case 'executing':
      return 'bg-amber-500'
    case 'blocked':
    case 'needs_input':
      return 'bg-rose-500'
    case 'reviewing':
      return 'bg-violet-500'
    default:
      return 'bg-[var(--theme-text-muted)]'
  }
}

export function PipelineView() {
  const search = useSearch({ from: '/mission-control' })
  const taskId =
    typeof search.taskId === 'string' ? search.taskId : undefined

  // If no taskId selected, render a selector helper.
  if (!taskId) {
    return <NoTaskSelected />
  }

  return <PipelineForTask taskId={taskId} />
}

function NoTaskSelected() {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center text-[var(--theme-text-muted)]">
      <p className="text-sm">Select a task from the Board tab to view its pipeline.</p>
    </div>
  )
}

function PipelineForTask({ taskId }: { taskId: string }) {
  const { data: pipeline, isLoading } = usePipeline(taskId)
  const agents = useAgentStatusesWithLive()

  if (isLoading) {
    return <div className="text-sm text-[var(--theme-text-muted)]">Loading…</div>
  }

  if (!pipeline) {
    return (
      <div className="text-sm text-[var(--theme-text-muted)]">
        No pipeline found for this task.
      </div>
    )
  }

  const currentStageIndex = useMemo(() => {
    const idx = pipeline.stages.findIndex(
      (s) => s.state === 'dispatched' || s.state === 'executing',
    )
    return idx >= 0 ? idx : pipeline.stages.length
  }, [pipeline])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{pipeline.title}</h2>
          <p className="text-xs text-[var(--theme-text-muted)]">
            Mission {pipeline.missionId} · {pipeline.state}
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h3 className="text-xs font-medium text-[var(--theme-text-muted)] uppercase tracking-wide">
          Stages
        </h3>
        <div className="relative flex items-start gap-2 overflow-x-auto pb-2">
          {pipeline.stages.map((stage, idx) => {
            const agent = agents.find((a) => a.agentId === stage.agent)
            const isCurrent = idx === currentStageIndex
            return (
              <div
                key={stage.key}
                className={cn(
                  'relative shrink-0 w-44 rounded-lg border p-3',
                  isCurrent
                    ? 'border-[var(--theme-accent)] bg-[var(--theme-accent)]/5'
                    : 'border-[var(--theme-border)] bg-[var(--theme-card)]',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn('size-2 rounded-full', stageColor(stage.state))} />
                  <span className="text-xs font-medium truncate">{stage.key}</span>
                </div>
                <div className="mt-1 text-[10px] text-[var(--theme-text-muted)]">
                  {agent?.displayName || stage.agent}
                </div>
                {stage.reviewRequired && (
                  <div className="mt-2 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 inline-block">
                    Review required
                  </div>
                )}
                {(stage.state === 'blocked' || stage.state === 'needs_input') && (
                  <div className="mt-2 text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 inline-block">
                    Blocked
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-medium text-[var(--theme-text-muted)] uppercase tracking-wide">
          Timeline
        </h3>
        <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-3">
          <div className="text-xs text-[var(--theme-text-muted)]">
            Stage timeline and run history will be wired to task_runs in P4.
          </div>
        </div>
      </section>
    </div>
  )
}
