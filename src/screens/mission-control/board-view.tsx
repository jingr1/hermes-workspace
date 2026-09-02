'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { KanbanLane, TaskSummary } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import { fetchTasks } from '@/lib/mission-control-api'

const LANES: Array<{ id: KanbanLane; label: string }> = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
]

const LANE_COLORS: Record<KanbanLane, string> = {
  backlog: '#6b7280',
  todo: '#3b82f6',
  ready: '#3b82f6',
  running: '#f97316',
  review: '#a855f7',
  blocked: '#ef4444',
  done: '#22c55e',
}

const TASKS_QUERY_KEY = ['mission-control', 'tasks'] as const

export function BoardView({
  onSelectTask,
}: {
  onSelectTask: (taskId: string) => void
}) {
  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    refetchInterval: 30_000,
  })

  const tasks = tasksQuery.data?.tasks ?? []

  const byLane = useMemo(() => {
    const map = new Map<KanbanLane, Array<TaskSummary>>()
    for (const lane of LANES) map.set(lane.id, [])
    for (const task of tasks) {
      const lane =
        (task.derivedLane ?? task.lane) === 'ready'
          ? 'todo'
          : (task.derivedLane ?? task.lane)
      const bucket = map.get(lane) ?? map.get('backlog')!
      bucket.push(task)
    }
    return map
  }, [tasks])

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden p-4">
      <div className="flex h-full min-w-[900px] gap-3">
        {LANES.map((lane) => {
          const laneTasks = byLane.get(lane.id) ?? []
          return (
            <div
              key={lane.id}
              className="flex w-64 flex-col rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)]"
            >
              <div
                className="flex items-center justify-between rounded-t-xl border-b border-[var(--theme-border)] px-3 py-2"
                style={{
                  borderTopWidth: 2,
                  borderTopColor: LANE_COLORS[lane.id],
                }}
              >
                <span className="text-xs font-semibold">{lane.label}</span>
                <span className="text-[10px] text-[var(--theme-muted)]">
                  {laneTasks.length}
                </span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto p-2">
                {laneTasks.map((task) => (
                  <button
                    key={task.cardId}
                    type="button"
                    onClick={() => onSelectTask(task.cardId)}
                    className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3 text-left transition-colors hover:border-[var(--theme-accent)] hover:bg-[var(--theme-hover)]"
                  >
                    <div className="text-xs font-medium">{task.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--theme-muted)]">
                      {task.currentAssignee && (
                        <span>{task.currentAssignee}</span>
                      )}
                      <span>{task.progress}%</span>
                    </div>
                  </button>
                ))}
                {laneTasks.length === 0 && (
                  <div className="py-6 text-center text-[10px] text-[var(--theme-muted)]">
                    No tasks
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
