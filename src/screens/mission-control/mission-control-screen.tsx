'use client'

import { useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { OverviewView } from './overview-view'
import { BoardView } from './board-view'
import { PipelineView } from './pipeline-view'

export type MissionControlTab = 'overview' | 'board' | 'pipeline'

export function MissionControlScreen() {
  const search = useSearch({ from: '/mission-control' })
  const initialTab =
    search.tab === 'overview' ||
    search.tab === 'board' ||
    search.tab === 'pipeline'
      ? search.tab
      : 'overview'
  const [tab, setTab] = useState<MissionControlTab>(initialTab)

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--theme-bg)] text-[var(--theme-text)]">
      <header className="shrink-0 px-4 py-3 border-b border-[var(--theme-border)]">
        <h1 className="text-lg font-semibold">Mission Control</h1>
        <p className="text-xs text-[var(--theme-text-muted)]">
          Live agent status, task board, and pipeline progress.
        </p>
      </header>

      <nav className="shrink-0 flex gap-1 px-4 pt-2 border-b border-[var(--theme-border)]">
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'board', label: 'Board' },
          { id: 'pipeline', label: 'Pipeline' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as MissionControlTab)}
            className={cn(
              'px-3 py-1.5 text-sm font-medium border-b-2 transition-colors',
              tab === t.id
                ? 'border-[var(--theme-accent)] text-[var(--theme-accent)]'
                : 'border-transparent text-[var(--theme-text-muted)] hover:text-[var(--theme-text)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 min-h-0 overflow-auto p-4">
        {tab === 'overview' && <OverviewView />}
        {tab === 'board' && <BoardView />}
        {tab === 'pipeline' && <PipelineView />}
      </main>
    </div>
  )
}
