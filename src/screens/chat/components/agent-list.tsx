'use client'

import { useCallback, useMemo, useState } from 'react'
import { useProfiles } from '../hooks/use-profiles'
import { AgentStatusDot } from './agent-status-dot'
import type { AgentRuntime, AgentWithStatus } from '@/lib/agent-types'
import type { UnifiedAgentStatus } from '@/lib/agent-status'
import { SettingsDialog } from '@/components/settings-dialog'
import {
  AGENT_ACCENT_COLORS,
  AgentAvatar,
} from '@/screens/gateway/components/agent-avatar'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agent-store'
import { statusLabel } from '@/lib/agent-status'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import {
  AGENT_PROVIDER_BADGE_LABELS,
  providerIdForAgentRuntime,
  providerStatusBadge,
  type AgentProviderBadge,
  type AgentProviderStatusDto,
} from '@/lib/managed-agent-runtime/provider-status'
import {
  useAgentProviderStatus,
  useInstallAgentProvider,
} from '../hooks/use-provider-status'


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

const PROVIDER_BADGE_STYLES: Record<AgentProviderBadge, string> = {
  ready: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'update-available':
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  'not-installed': 'bg-primary-200 text-primary-500 dark:bg-primary-800 dark:text-primary-400',
  unknown: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
}

/**
 * Install/update affordance for one non-Hermes runtime row. Hidden for hermes
 * agents and runtimes the daemon does not detect (e.g. deepseek-harness).
 */
function ProviderRuntimeBadge({
  agent,
  entry,
  installing,
  onInstall,
}: {
  agent: AgentWithStatus
  entry: AgentProviderStatusDto | undefined
  installing: boolean
  onInstall: (
    providerId: NonNullable<ReturnType<typeof providerIdForAgentRuntime>>,
    version?: string,
  ) => void
}) {
  const providerId = providerIdForAgentRuntime(agent.runtime)
  if (!providerId) return null
  const badge = providerStatusBadge(entry)
  const actionable = badge === 'not-installed' || badge === 'update-available'
  const upgrading = badge === 'update-available'
  return (
    <div className="mt-0.5 flex items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
          PROVIDER_BADGE_STYLES[badge],
        )}
      >
        {AGENT_PROVIDER_BADGE_LABELS[badge]}
        {badge === 'ready' && entry?.version ? ` ${entry.version}` : ''}
      </span>
      {actionable ? (
        <button
          type="button"
          disabled={installing}
          onClick={(event) => {
            event.stopPropagation()
            // Upgrades pin "latest" explicitly; plain installs use the
            // daemon's idempotent ensure-present path.
            onInstall(providerId, upgrading ? 'latest' : undefined)
          }}
          className={cn(
            'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
            'bg-accent-500/10 text-accent-600 transition-colors',
            'hover:bg-accent-500/20 disabled:cursor-not-allowed disabled:opacity-50',
            'dark:text-accent-400',
          )}
        >
          {installing ? '安装中…' : upgrading ? '升级' : '安装'}
        </button>
      ) : null}
    </div>
  )
}

function AgentListItem({
  agent,
  index,
  isActive,
  onSelect,
  onOpenSettings,
  providerStatusEntry,
  installingProvider,
  onInstallProvider,
}: {
  agent: AgentWithStatus
  index: number
  isActive: boolean
  onSelect: (agentId: string) => void
  onOpenSettings: (agentId: string) => void
  providerStatusEntry: AgentProviderStatusDto | undefined
  installingProvider: boolean
  onInstallProvider: (
    providerId: NonNullable<ReturnType<typeof providerIdForAgentRuntime>>,
    version?: string,
  ) => void
}) {
  const { profiles } = useProfiles()
  const profile = useMemo(() => {
    if (agent.runtime !== 'hermes') return undefined
    const targetProfileName = agent.runtimeConfig.profile ?? agent.agentId
    return profiles.find((p) => p.name === targetProfileName)
  }, [agent, profiles])
  const accent = AGENT_ACCENT_COLORS[index % AGENT_ACCENT_COLORS.length]

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
        className="shrink-0 rounded-md transition-colors hover:bg-primary-300/60"
        title="Agent settings"
      >
        <div
          className={cn(
            'flex size-8 items-center justify-center overflow-hidden rounded-md',
            accent.avatar,
          )}
        >
          <AgentAvatar index={index} color={accent.hex} size={28} />
        </div>
      </button>
      <AgentStatusDot
        status={agent.status}
        needsSetup={toUnifiedStatus(agent, profile) === 'needsSetup'}
      />
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
        <ProviderRuntimeBadge
          agent={agent}
          entry={providerStatusEntry}
          installing={installingProvider}
          onInstall={onInstallProvider}
        />
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
  const installProviderMutation = useInstallAgentProvider()

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

  const listContent = (
    <>
      {sortedAgents.length === 0 ? (
        <p className="px-3 py-4 text-sm text-primary-500 dark:text-primary-400">
          No agents configured.
        </p>
      ) : (
        <div className="space-y-0.5">
          {sortedAgents.map((agent, index) => {
            const providerId = providerIdForAgentRuntime(agent.runtime)
            return (
              <AgentListItem
                key={agent.agentId}
                agent={agent}
                index={index}
                isActive={agent.agentId === activeAgentId}
                onSelect={handleSelect}
                onOpenSettings={setSettingsAgentId}
                providerStatusEntry={providerId ? providerStatusById.get(providerId) : undefined}
                installingProvider={
                  installProviderMutation.isPending &&
                  installProviderMutation.variables?.provider === providerId
                }
                onInstallProvider={(target, version) =>
                  installProviderMutation.mutate(
                    version ? { provider: target, version } : { provider: target },
                  )
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
