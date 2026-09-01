'use client'

import { useCallback, useMemo } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Settings01Icon } from '@hugeicons/core-free-icons'
import { useNavigate } from '@tanstack/react-router'
import { useProfiles } from '../hooks/use-profiles'
import { AgentStatusDot } from './agent-status-dot'
import type { AgentRuntime, AgentWithStatus } from '@/lib/agent-types'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agent-store'

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'deepseek-harness': 'DeepSeek',
  opencode: 'OpenCode',
}

function runtimeLabel(runtime: AgentRuntime): string {
  return (RUNTIME_LABELS as Record<string, string>)[runtime] ?? runtime
}

function agentSubtitle(
  agent: AgentWithStatus,
  profile?: { model?: string; provider?: string },
): string {
  if (agent.runtime === 'hermes' && profile) {
    const model = profile.model?.trim()
    const provider = profile.provider?.trim()
    return [model, provider].filter(Boolean).join(' · ') || runtimeLabel(agent.runtime)
  }
  return runtimeLabel(agent.runtime)
}

function AgentListItem({
  agent,
  isActive,
  onSelect,
}: {
  agent: AgentWithStatus
  isActive: boolean
  onSelect: (agentId: string) => void
}) {
  const navigate = useNavigate()
  const { profiles } = useProfiles()
  const profile = useMemo(() => {
    if (agent.runtime !== 'hermes') return undefined
    const targetProfileName = agent.runtimeConfig.profile ?? agent.agentId
    return profiles.find((p) => p.name === targetProfileName)
  }, [agent, profiles])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(agent.agentId)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(agent.agentId)
        }
      }}
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer outline-none',
        'hover:bg-primary-200',
        isActive && 'bg-primary-200',
      )}
    >
      <AgentStatusDot status={agent.status} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-sm font-medium',
            isActive ? 'text-accent-500' : 'text-primary-900',
          )}
        >
          {agent.name}
        </p>
        <p className="truncate text-xs text-primary-500">
          {agentSubtitle(agent, profile)}
        </p>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          void navigate({ to: '/settings/agents/$agentId', params: { agentId: agent.agentId } })
        }}
        className={cn(
          'shrink-0 rounded-md p-1.5 opacity-0 transition-opacity',
          'text-primary-600 hover:bg-primary-300/60 hover:text-primary-800',
          'group-hover:opacity-100 focus:opacity-100',
          'dark:text-primary-300 dark:hover:bg-primary-700 dark:hover:text-primary-100',
        )}
        title="Agent settings"
      >
        <HugeiconsIcon icon={Settings01Icon} size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

export function AgentList({
  onSelect,
  renderContainer = true,
}: {
  onSelect?: (agentId: string) => void
  renderContainer?: boolean
}) {
  const agents = useAgentStore((state) => state.agents)
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const storeSetActiveAgentId = useAgentStore((state) => state.setActiveAgentId)

  const handleSelect = useCallback(
    (agentId: string) => {
      storeSetActiveAgentId(agentId)
      onSelect?.(agentId)
    },
    [onSelect, storeSetActiveAgentId],
  )

  const sortedAgents = useMemo(() => {
    const next = [...agents]
    next.sort((a, b) => {
      // Default Hermes profile always at the top.
      if (a.agentId === 'default' && b.agentId !== 'default') return -1
      if (b.agentId === 'default' && a.agentId !== 'default') return 1
      // Group Hermes agents together before non-Hermes runtimes.
      if (a.runtime === 'hermes' && b.runtime !== 'hermes') return -1
      if (a.runtime !== 'hermes' && b.runtime === 'hermes') return 1
      // Online/busy agents before offline ones within each group.
      const aPriority = a.status === 'online' || a.status === 'busy' ? 0 : 1
      const bPriority = b.status === 'online' || b.status === 'busy' ? 0 : 1
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.name.localeCompare(b.name)
    })
    return next
  }, [agents])

  const listContent = (
    <>
      {sortedAgents.length === 0 ? (
        <p className="px-3 py-4 text-sm text-primary-500 dark:text-primary-400">
          No agents configured.
        </p>
      ) : (
        <div className="space-y-0.5">
          {sortedAgents.map((agent) => (
            <AgentListItem
              key={agent.agentId}
              agent={agent}
              isActive={agent.agentId === activeAgentId}
              onSelect={handleSelect}
            />
          ))}
        </div>
      )}
    </>
  )

  if (!renderContainer) {
    return listContent
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-primary-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-primary-500 dark:border-primary-800 dark:text-primary-400">
        Agents
      </div>
      <div className="flex-1 overflow-y-auto p-2">{listContent}</div>
    </div>
  )
}
