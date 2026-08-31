'use client'

import { useState } from 'react'
import { OverviewView } from './overview-view'
import { BoardView } from './board-view'
import { PipelineView } from './pipeline-view'
import { cn } from '@/lib/utils'

export type MissionControlTab = 'overview' | 'board' | 'pipeline'

type MissionControlLayoutProps = {
  activeTab: MissionControlTab
  onTabChange: (tab: MissionControlTab) => void
  initialTaskId?: string
}

const TABS: Array<{ id: MissionControlTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'board', label: 'Board' },
  { id: 'pipeline', label: 'Pipeline' },
]

export function MissionControlLayout({
  activeTab,
  onTabChange,
  initialTaskId,
}: MissionControlLayoutProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    initialTaskId ?? null,
  )

  return (
    <div className="flex h-full flex-col bg-[var(--theme-bg)] text-[var(--theme-text)]">
      {/* Header + Tabs */}
      <header className="shrink-0 border-b border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Mission Control</h1>
            <p className="text-xs text-[var(--theme-muted)]">
              Multi-agent runtime status, board, and pipeline drill-down.
            </p>
          </div>
          <nav className="flex rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] p-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === tab.id
                    ? 'bg-[var(--theme-accent)] text-white'
                    : 'text-[var(--theme-muted)] hover:text-[var(--theme-text)]',
                )}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Tab content */}
      <main className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'overview' && (
          <OverviewView
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId)
              onTabChange('pipeline')
            }}
          />
        )}
        {activeTab === 'board' && (
          <BoardView
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId)
              onTabChange('pipeline')
            }}
          />
        )}
        {activeTab === 'pipeline' && (
          <PipelineView
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />
        )}
      </main>
    </div>
  )
}
