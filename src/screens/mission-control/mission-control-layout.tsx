'use client'

import { BoardView } from './board-view'
import { PipelineView } from './pipeline-view'
import { CreateTaskButton } from './components/create-task-button'

type MissionsLayoutProps = {
  selectedTaskId: string | null
  onSelectTask: (taskId: string | null) => void
}

export function MissionsLayout({
  selectedTaskId,
  onSelectTask,
}: MissionsLayoutProps) {
  const showPipeline = Boolean(selectedTaskId)

  return (
    <div className="flex h-full flex-col bg-[var(--theme-bg)] text-[var(--theme-text)]">
      <header className="shrink-0 border-b border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Missions</h1>
            <p className="text-xs text-[var(--theme-muted)]">
              {showPipeline
                ? 'Pipeline drill-down for the selected task.'
                : 'Task board and pipeline progress.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {showPipeline ? (
              <button
                type="button"
                onClick={() => onSelectTask(null)}
                className="rounded-md border border-[var(--theme-border)] px-3 py-1.5 text-xs font-medium text-[var(--theme-muted)] transition-colors hover:bg-[var(--theme-hover)] hover:text-[var(--theme-text)]"
              >
                Back to Board
              </button>
            ) : null}
            <CreateTaskButton />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {showPipeline ? (
          <PipelineView
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        ) : (
          <BoardView onSelectTask={onSelectTask} />
        )}
      </main>
    </div>
  )
}

/** @deprecated Use MissionsLayout. Kept for any residual imports. */
export const MissionControlLayout = MissionsLayout
export type MissionControlTab = 'board' | 'pipeline'
