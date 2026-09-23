'use client'

import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useProfiles } from '../hooks/use-profiles'
import { AgentStatusDot } from './agent-status-dot'
import type { AgentWithStatus } from '@/lib/agent-types'
import type { UnifiedAgentStatus } from '@/lib/agent-status'
import { SettingsDialog } from '@/components/settings-dialog'
import { AgentIdentityAvatar } from '@/components/avatars'
import {
  countAgentsByProvider,
  normalizeAgentAvatarProvider,
} from '@/lib/agent-avatar'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agent-store'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import {
  AGENT_PROVIDER_BADGE_LABELS,
  providerIdForAgentRuntime,
  providerStatusBadge,
  type AgentProviderStatusDto,
} from '@/lib/managed-agent-runtime/provider-status'
import { useAgentProviderStatus } from '../hooks/use-provider-status'


function agentSubtitle(
  agent: AgentWithStatus,
  profile?: { model?: string; provider?: string },
  unifiedStatus?: UnifiedAgentStatus,
): string {
  if (unifiedStatus === 'needsSetup') {
    return 'No model configured'
  }
  if (agent.runtime === 'hermes' && profile) {
    const model = profile.model?.trim()
    const provider = profile.provider?.trim()
    return (
      [model, provider].filter(Boolean).join(' · ') ||
      agentRuntimeLabel(agent.runtime)
    )
  }
  return agentRuntimeLabel(agent.runtime)
}

function providerStatusToDot(
  entry: AgentProviderStatusDto | undefined,
): { status: UnifiedAgentStatus; title: string } | null {
  if (!entry) return null
  const badge = providerStatusBadge(entry)
  const label = AGENT_PROVIDER_BADGE_LABELS[badge]
  switch (badge) {
    case 'ready':
      return {
        status: 'active',
        title: entry.version ? `${label} ${entry.version}` : label,
      }
    case 'update-available':
      return { status: 'needsSetup', title: label }
    case 'not-installed':
    case 'unknown':
      return { status: 'error', title: label }
    default:
      return null
  }
}

/** Convert legacy AgentStatus to the unified status used for rendering. */
function toUnifiedStatus(
  agent: AgentWithStatus,
  profile?: { model?: string; provider?: string },
): UnifiedAgentStatus {
  // The server already factors in needsSetup via runtime snapshot, but the
  // snapshot is only available for hermes profiles. Re-check config.yaml here
  // so non-Hermes adapters and orphan profiles also surface setup issues.
  if (agent.runtime === 'hermes' && agent.runtimeConfig.profile) {
    const hasModel = Boolean(profile?.model?.trim())
    if (!hasModel) return 'needsSetup'
  }

  const status = agent.status
  switch (status) {
    case 'busy':
      return 'active'
    case 'idle':
    case 'online':
      return 'idle'
    case 'blocked':
      return agent.statusSnapshot?.needsHuman ? 'blocked' : 'error'
    case 'offline':
      return 'offline'
    default:
      return 'offline'
  }
}

function AgentListItem({
  agent,
  providerSiblingCount,
  isActive,
  onSelect,
  onOpenSettings,
  onOpenRuntimes,
  providerStatusEntry,
}: {
  agent: AgentWithStatus
  providerSiblingCount: number
  isActive: boolean
  onSelect: (agentId: string) => void
  onOpenSettings: (agentId: string) => void
  onOpenRuntimes: (providerId: string) => void
  providerStatusEntry: AgentProviderStatusDto | undefined
}) {
  const { profiles } = useProfiles()
  const profile = useMemo(() => {
    if (agent.runtime !== 'hermes') return undefined
    const targetProfileName = agent.runtimeConfig.profile ?? agent.agentId
    return profiles.find((p) => p.name === targetProfileName)
  }, [agent, profiles])
  const providerDot = providerStatusToDot(providerStatusEntry)
  const upgradeProvider =
    providerStatusBadge(providerStatusEntry) === 'update-available'
      ? providerStatusEntry?.provider
      : null

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
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onOpenSettings(agent.agentId)
        }}
        className="shrink-0 rounded-full transition-colors hover:bg-primary-300/60"
        title="Agent settings"
      >
        <AgentIdentityAvatar
          name={agent.name}
          runtime={agent.runtime}
          providerSiblingCount={providerSiblingCount}
          size={36}
        />
      </button>
      <button
        type="button"
        className={cn(
          'shrink-0 rounded-md',
          upgradeProvider && 'hover:bg-primary-300/60',
        )}
        title={
          upgradeProvider
            ? `${providerDot?.title ?? '需升级'} — 打开 Runtimes`
            : providerDot?.title
        }
        onClick={(event) => {
          if (!upgradeProvider) return
          event.stopPropagation()
          onOpenRuntimes(upgradeProvider)
        }}
      >
        <AgentStatusDot
          status={agent.status}
          needsSetup={toUnifiedStatus(agent, profile) === 'needsSetup'}
          {...providerDot}
        />
      </button>
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
          {agentSubtitle(agent, profile, toUnifiedStatus(agent, profile))}
        </p>
      </div>
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
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null)
  const providerStatusQuery = useAgentProviderStatus()
  const navigate = useNavigate()

  const providerStatusById = useMemo(() => {
    const map = new Map<string, AgentProviderStatusDto>()
    for (const entry of providerStatusQuery.data?.providers ?? []) {
      map.set(entry.provider, entry)
    }
    return map
  }, [providerStatusQuery.data])

  const handleSelect = useCallback(
    (agentId: string) => {
      // Sidebar passes onSelect (navigate + restore last session). Do not
      // setActiveAgentId here — that clears activeSessionId and races the
      // URL ?session= restore into a blank "New Chat".
      if (onSelect) {
        onSelect(agentId)
        return
      }
      storeSetActiveAgentId(agentId)
    },
    [onSelect, storeSetActiveAgentId],
  )

  const handleOpenRuntimes = useCallback(
    (providerId: string) => {
      void navigate({
        to: '/settings',
        search: { section: 'runtimes', provider: providerId },
      })
    },
    [navigate],
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
      // Active/busy agents before idle, idle before offline.
      const priority = (status: AgentWithStatus['status']) => {
        if (status === 'busy') return 0
        if (status === 'online' || status === 'idle') return 1
        return 2
      }
      const aPriority = priority(a.status)
      const bPriority = priority(b.status)
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.name.localeCompare(b.name)
    })
    return next
  }, [agents])

  const providerSiblingCounts = useMemo(
    () => countAgentsByProvider(sortedAgents),
    [sortedAgents],
  )

  const listContent = (
    <>
      {sortedAgents.length === 0 ? (
        <p className="px-3 py-4 text-sm text-primary-500 dark:text-primary-400">
          No agents configured.
        </p>
      ) : (
        <div className="space-y-0.5">
          {sortedAgents.map((agent) => {
            const providerId =
              providerIdForAgentRuntime(agent.runtime) ??
              (agent.runtime === 'hermes'
                ? 'hermes'
                : agent.runtime === 'deepseek-harness'
                  ? 'deepseek-harness'
                  : null)
            return (
              <AgentListItem
                key={agent.agentId}
                agent={agent}
                providerSiblingCount={
                  providerSiblingCounts.get(
                    normalizeAgentAvatarProvider(agent.runtime),
                  ) ?? 1
                }
                isActive={agent.agentId === activeAgentId}
                onSelect={handleSelect}
                onOpenSettings={setSettingsAgentId}
                onOpenRuntimes={handleOpenRuntimes}
                providerStatusEntry={
                  providerId ? providerStatusById.get(providerId) : undefined
                }
              />
            )
          })}
        </div>
      )}
    </>
  )

  const settingsDialog = (
    <SettingsDialog
      open={settingsAgentId !== null}
      onOpenChange={(open) => {
        if (!open) setSettingsAgentId(null)
      }}
      agentId={settingsAgentId ?? undefined}
      initialSection="claude"
    />
  )

  if (!renderContainer) {
    return (
      <>
        {listContent}
        {settingsDialog}
      </>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-primary-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-primary-500 dark:border-primary-800 dark:text-primary-400">
        Agents
      </div>
      <div className="flex-1 overflow-y-auto p-2">{listContent}</div>
      {settingsDialog}
    </div>
  )
}
