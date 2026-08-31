'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import {
  fetchTasks,
  type ClaudeTask,
  type TaskColumn,
} from '@/lib/tasks-api'

const COLUMNS: TaskColumn[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
]

const COLUMN_TITLES: Record<TaskColumn, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  deleted: 'Deleted',
}

const QUERY_KEY = ['mission-control', 'board-tasks'] as const

export function BoardView() {
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchTasks({ include_done: false }),
    refetchInterval: 30_000,
  })
  const navigate = useNavigate()
  const [selectedColumn, setSelectedColumn] = useState<TaskColumn | null>(null)

  const byColumn = useMemo(() => {
    const map: Record<TaskColumn, ClaudeTask[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      blocked: [],
      done: [],
      deleted: [],
    }
    for (const task of tasks) {
      map[task.column].push(task)
    }
    for (const col of COLUMNS) {
      map[col].sort((a, b) => b.position - a.position)
    }
    return map
  }, [tasks])

  if (isLoading) {
    return <div className="text-sm text-[var(--theme-text-muted)]">Loading…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Task Board</h2>
        <span className="text-xs text-[var(--theme-text-muted)]">
          {tasks.length} active
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {COLUMNS.map((column) => {
          const items = byColumn[column]
          const isSelected = selectedColumn === column
          return (
            <div
              key={column}
              className={cn(
                'rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] flex flex-col min-h-[120px]',
                isSelected && 'ring-1 ring-[var(--theme-accent)]',
              )}
              onClick={() => setSelectedColumn(isSelected ? null : column)}
            >
              <div className="px-3 py-2 border-b border-[var(--theme-border)] flex items-center justify-between">
                <span className="text-xs font-medium">
                  {COLUMN_TITLES[column]}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--theme-hover)] text-[var(--theme-text-muted)]">
                  {items.length}
                </span>
              </div>
              <div className="p-2 flex flex-col gap-2">
                {items.slice(0, 5).map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void navigate({
                        to: '/mission-control',
                        search: { tab: 'pipeline', taskId: task.id },
                      })
                    }}
                    className="text-left text-xs p-2 rounded bg-[var(--theme-hover)] hover:bg-[var(--theme-active)] transition-colors"
                  >
                    <div className="font-medium line-clamp-2">{task.title}</div>
                    {task.assignee && (
                      <div className="text-[10px] text-[var(--theme-text-muted)] mt-1">
                        {task.assignee}
                      </div>
                    )}
                  </button>
                ))}
                {items.length > 5 && (
                  <div className="text-[10px] text-center text-[var(--theme-text-muted)]">
                    +{items.length - 5} more
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
