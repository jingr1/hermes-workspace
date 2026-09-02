'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  PipelineStage,
  TaskRun,
  TaskSummary,
} from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import { fetchTaskDetail, fetchTasks } from '@/lib/mission-control-api'

const TASKS_QUERY_KEY = ['mission-control', 'tasks'] as const

function StageBar({
  stages,
  currentStageId,
}: {
  stages: Array<PipelineStage>
  currentStageId: string | null
}) {
  if (stages.length === 0) return null
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2">
      {stages.map((stage, index) => {
        const isCurrent = stage.assignmentId === currentStageId
        const isDone = stage.state === 'done' || stage.state === 'checkpointed'
        const isBlocked =
          stage.state === 'blocked' || stage.state === 'needs_input'
        return (
          <div key={stage.assignmentId} className="flex items-center">
            <div
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
                isCurrent
                  ? 'border-[var(--theme-accent)] bg-[var(--theme-accent)] text-white'
                  : isDone
                    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700'
                    : isBlocked
                      ? 'border-red-400/40 bg-red-500/10 text-red-700'
                      : 'border-[var(--theme-border)] bg-[var(--theme-card)] text-[var(--theme-muted)]',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  isCurrent
                    ? 'bg-white'
                    : isDone
                      ? 'bg-emerald-500'
                      : isBlocked
                        ? 'bg-red-500'
                        : 'bg-slate-400',
                )}
              />
              {stage.stageKey ?? stage.agent}
            </div>
            {index < stages.length - 1 && (
              <div className="mx-1 h-px w-4 bg-[var(--theme-border)]" />
            )}
          </div>
        )
      })}
    </div>
  )
}

function Timeline({
  stages,
  runs,
  events,
}: {
  stages: Array<PipelineStage>
  runs: Array<TaskRun>
  events: Array<{ type: string; at: number; [key: string]: unknown }>
}) {
  const items = useMemo(() => {
    const list: Array<{
      id: string
      kind: 'run' | 'event'
      title: string
      subtitle?: string
      at: number
    }> = []
    for (const run of runs) {
      list.push({
        id: run.id,
        kind: 'run',
        title: `${run.agent_id} · ${run.status}`,
        subtitle: run.summary ?? undefined,
        at: run.started_at ?? 0,
      })
    }
    for (const event of events) {
      list.push({
        id: `${event.type}-${event.at}`,
        kind: 'event',
        title: event.type,
        at: typeof event.at === 'number' ? event.at : 0,
      })
    }
    return list.sort((a, b) => b.at - a.at)
  }, [runs, events])

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-start gap-3 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-3"
        >
          <div
            className={cn(
              'mt-0.5 h-2 w-2 rounded-full',
              item.kind === 'run' ? 'bg-blue-400' : 'bg-slate-400',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{item.title}</div>
            {item.subtitle && (
              <div className="mt-0.5 truncate text-[11px] text-[var(--theme-muted)]">
                {item.subtitle}
              </div>
            )}
          </div>
          <div className="shrink-0 text-[10px] text-[var(--theme-muted)]">
            {item.at ? new Date(item.at).toLocaleTimeString() : ''}
          </div>
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-xs text-[var(--theme-muted)]">No activity yet.</p>
      )}
    </div>
  )
}

export function PipelineView({
  selectedTaskId,
  onSelectTask,
}: {
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
}) {
  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    refetchInterval: 30_000,
  })
  const tasks = tasksQuery.data?.tasks ?? []

  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    selectedTaskId,
  )
  useEffect(() => {
    if (selectedTaskId) setActiveTaskId(selectedTaskId)
  }, [selectedTaskId])

  const activeTask = useMemo(() => {
    if (tasks.length === 0) return null
    return tasks.find((t) => t.cardId === activeTaskId) ?? tasks[0]
  }, [tasks, activeTaskId])

  const detailQuery = useQuery({
    queryKey: ['mission-control', 'task', activeTask?.cardId],
    queryFn: () => fetchTaskDetail(activeTask!.cardId),
    enabled: Boolean(activeTask),
  })

  const detail = detailQuery.data
  const stages = detail?.pipeline?.stages ?? []
  const currentStage: PipelineStage | null =
    stages.find(
      (s) =>
        s.state === 'dispatched' ||
        s.state === 'running' ||
        s.state === 'blocked',
    ) ??
    stages.find((s) => s.state === 'queued') ??
    null

  return (
    <div className="flex h-full min-h-0">
      {/* Task list */}
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-[var(--theme-border)] bg-[var(--theme-card)] p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
          Tasks
        </h2>
        {tasks.map((task) => (
          <button
            key={task.cardId}
            type="button"
            onClick={() => {
              setActiveTaskId(task.cardId)
              onSelectTask(task.cardId)
            }}
            className={cn(
              'mb-1 w-full rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
              activeTask?.cardId === task.cardId
                ? 'bg-[var(--theme-accent)] text-white'
                : 'hover:bg-[var(--theme-hover)]',
            )}
          >
            <div className="truncate font-medium">{task.title}</div>
            <div className="mt-0.5 text-[10px] opacity-80">
              {task.progress}% · {task.derivedLane ?? task.lane}
            </div>
          </button>
        ))}
        {tasks.length === 0 && (
          <p className="text-xs text-[var(--theme-muted)]">No tasks.</p>
        )}
      </aside>

      {/* Detail */}
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
        {activeTask ? (
          <>
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{activeTask.title}</h2>
              <div className="mt-1 flex items-center gap-3 text-xs text-[var(--theme-muted)]">
                <span>进度 {activeTask.progress}%</span>
                <span>状态 {activeTask.derivedLane ?? activeTask.lane}</span>
                {activeTask.currentAssignee && (
                  <span>执行 {activeTask.currentAssignee}</span>
                )}
              </div>
            </div>

            <div className="mb-6 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                Pipeline
              </h3>
              {stages.length > 0 ? (
                <StageBar
                  stages={stages}
                  currentStageId={currentStage?.assignmentId ?? null}
                />
              ) : (
                <p className="text-sm text-[var(--theme-muted)]">
                  此任务未关联 Mission 流水线，暂无 Pipeline。
                </p>
              )}
            </div>

            {currentStage &&
            (currentStage.state === 'blocked' ||
              currentStage.state === 'needs_input') ? (
              <div className="mb-6 rounded-xl border border-red-400/40 bg-red-500/10 p-4 text-red-700">
                <h3 className="text-xs font-semibold uppercase tracking-wide">
                  Blocker
                </h3>
                <p className="mt-1 text-xs">
                  Stage {currentStage.stageKey ?? currentStage.agent} is waiting
                  for input or intervention.
                </p>
              </div>
            ) : null}

            <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                Timeline
              </h3>
              <Timeline
                stages={stages}
                runs={detail?.runs ?? []}
                events={detail?.events ?? []}
              />
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--theme-muted)]">
            Select a task to view its pipeline.
          </div>
        )}
      </section>
    </div>
  )
}
