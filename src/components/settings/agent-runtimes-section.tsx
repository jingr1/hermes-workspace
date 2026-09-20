'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowUp01Icon,
  Download01Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  providerStatusBadge,
  type AgentProviderId,
  type AgentProviderStatusDto,
} from '@/lib/managed-agent-runtime/provider-status'
import {
  useAgentProviderStatus,
  useInstallAgentProvider,
  useSetAgentProviderEnabled,
} from '@/screens/chat/hooks/use-provider-status'

const PROVIDER_LABELS: Record<AgentProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  'kimi-code': 'Kimi Code',
}

const PROVIDER_COLORS: Record<AgentProviderId, string> = {
  'claude-code': 'bg-orange-500',
  codex: 'bg-blue-500',
  cursor: 'bg-neutral-500',
  opencode: 'bg-indigo-500',
  'kimi-code': 'bg-emerald-500',
}

function readinessStatus(entry: AgentProviderStatusDto): {
  label: string
  dotClass: string
} {
  if (!entry.installed) {
    return { label: '未安装', dotClass: 'bg-primary-400 dark:bg-primary-500' }
  }
  switch (entry.auth.status) {
    case 'authenticated':
    case 'configured':
      if (entry.registered) {
        return { label: '已连接', dotClass: 'bg-emerald-500' }
      }
      return { label: '已配置', dotClass: 'bg-blue-500' }
    case 'required':
    case 'unknown':
    default:
      return { label: '需要登录', dotClass: 'bg-amber-500' }
  }
}

function providerInitials(providerId: AgentProviderId): string {
  const label = PROVIDER_LABELS[providerId] ?? providerId
  return label.slice(0, 2).toUpperCase()
}

function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // Ignore clipboard errors.
        }
      }}
      className="h-7 px-2.5 text-[11px]"
    >
      {copied ? '已复制' : '复制命令'}
    </Button>
  )
}

function RuntimeRow({
  entry,
  highlighted,
  installingProvider,
  onInstall,
  onSetEnabled,
  togglingProvider,
}: {
  entry: AgentProviderStatusDto
  highlighted: boolean
  installingProvider: AgentProviderId | null
  togglingProvider: AgentProviderId | null
  onInstall: (provider: AgentProviderId, version?: string) => void
  onSetEnabled: (provider: AgentProviderId, enabled: boolean) => void
}) {
  const rowRef = useRef<HTMLTableRowElement>(null)
  const providerId = entry.provider as AgentProviderId
  const label = PROVIDER_LABELS[providerId] ?? providerId
  const badge = providerStatusBadge(entry)
  const { label: statusLabel, dotClass } = readinessStatus(entry)
  const canInstall = badge === 'not-installed' && entry.install?.managedNpm
  const canUpgrade =
    badge === 'update-available' && entry.update.capability === 'supported'
  const manualCommand = entry.install?.displayCommand
  const isInstalling = installingProvider === providerId
  const isToggling = togglingProvider === providerId

  useEffect(() => {
    if (highlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      rowRef.current.focus({ preventScroll: true })
    }
  }, [highlighted])

  return (
    <tr
      ref={rowRef}
      tabIndex={highlighted ? 0 : -1}
      data-provider={providerId}
      className={cn(
        'border-b border-[var(--theme-border)] last:border-b-0 transition-colors',
        highlighted && 'bg-[var(--theme-accent-subtle)]/60',
      )}
    >
      {/* Agent */}
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white',
              PROVIDER_COLORS[providerId] ?? 'bg-primary-500',
            )}
          >
            {providerInitials(providerId)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--theme-text)]">
              {label}
            </p>
            <p className="truncate text-xs text-[var(--theme-muted)]">
              {entry.installed
                ? (entry.version ?? 'Installed')
                : (entry.install?.displayCommand ?? 'Not installed')}
            </p>
          </div>
        </div>
      </td>

      {/* Readiness */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', dotClass)} />
          <span className="whitespace-nowrap text-sm text-[var(--theme-text)]">
            {statusLabel}
          </span>
          {entry.updateAvailable && entry.update.capability === 'supported' && (
            <span className="whitespace-nowrap text-xs text-amber-500">
              · 有更新
            </span>
          )}
        </div>
      </td>

      {/* Enabled */}
      <td className="px-4 py-3 text-center">
        <Switch
          checked={entry.registered}
          disabled={isToggling}
          onCheckedChange={(checked) => onSetEnabled(providerId, checked)}
          aria-label={`${label} enabled`}
        />
      </td>

      {/* Actions */}
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          {canInstall ? (
            <Button
              size="sm"
              disabled={isInstalling}
              onClick={() => onInstall(providerId)}
              className="h-7 gap-1 rounded-lg bg-accent-600 px-2.5 text-[11px] text-white hover:bg-accent-700"
            >
              {isInstalling ? (
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={12}
                  strokeWidth={1.5}
                  className="animate-spin"
                />
              ) : (
                <HugeiconsIcon
                  icon={Download01Icon}
                  size={12}
                  strokeWidth={1.5}
                />
              )}
              {isInstalling ? '安装中…' : '安装'}
            </Button>
          ) : canUpgrade ? (
            <Button
              size="sm"
              disabled={isInstalling}
              onClick={() => onInstall(providerId, 'latest')}
              className="h-7 gap-1 rounded-lg bg-accent-600 px-2.5 text-[11px] text-white hover:bg-accent-700"
            >
              {isInstalling ? (
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={12}
                  strokeWidth={1.5}
                  className="animate-spin"
                />
              ) : (
                <HugeiconsIcon
                  icon={ArrowUp01Icon}
                  size={12}
                  strokeWidth={1.5}
                />
              )}
              {isInstalling ? '升级中…' : '升级'}
            </Button>
          ) : badge === 'not-installed' && manualCommand ? (
            <CopyCommandButton command={manualCommand} />
          ) : badge === 'not-installed' ? (
            <Button
              size="sm"
              variant="outline"
              disabled
              className="h-7 px-2.5 text-[11px]"
            >
              暂不支持
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled
              className="h-7 px-2.5 text-[11px]"
            >
              {statusLabel}
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

export type AgentRuntimesSectionProps = {
  highlightProvider?: string
}

export function AgentRuntimesSection({
  highlightProvider,
}: AgentRuntimesSectionProps) {
  const [autoCheck, setAutoCheck] = useState(true)
  const statusQuery = useAgentProviderStatus({
    refetchInterval: autoCheck ? undefined : false,
  })
  const installMutation = useInstallAgentProvider()
  const enableMutation = useSetAgentProviderEnabled()

  const sorted = useMemo(() => {
    const list = statusQuery.data?.providers ?? []
    return [...list].sort((a, b) => {
      const rank = (entry: AgentProviderStatusDto) => {
        const badge = providerStatusBadge(entry)
        if (badge === 'update-available') return 0
        if (badge === 'not-installed') return 1
        if (badge === 'unknown') return 2
        return 3
      }
      const diff = rank(a) - rank(b)
      if (diff !== 0) return diff
      return (a.provider as string).localeCompare(b.provider as string)
    })
  }, [statusQuery.data?.providers])

  const handleInstall = (provider: AgentProviderId, version?: string) => {
    installMutation.mutate(version ? { provider, version } : { provider })
  }

  const handleSetEnabled = (provider: AgentProviderId, enabled: boolean) => {
    enableMutation.mutate({ provider, enabled })
  }

  return (
    <div className="space-y-4">
      {/* Auto-check header */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <Switch
            checked={autoCheck}
            onCheckedChange={setAutoCheck}
            aria-label="自动检查更新"
          />
          <div>
            <p className="text-sm font-medium text-[var(--theme-text)]">
              自动检查更新
            </p>
            <p className="text-xs text-[var(--theme-muted)]">
              定期检查；只有点击安装/升级后才会执行更新
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={statusQuery.isFetching}
          onClick={() => statusQuery.refetch()}
          className="h-8 gap-1.5 text-xs"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={14}
            strokeWidth={1.5}
            className={cn(statusQuery.isFetching && 'animate-spin')}
          />
          检查更新
        </Button>
      </div>

      {/* Table card */}
      <div className="overflow-hidden rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] shadow-sm">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[35%]" />
            <col className="w-[25%]" />
            <col className="w-[20%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--theme-border)] bg-[var(--theme-panel)] text-xs text-[var(--theme-muted)]">
              <th className="px-4 py-2 text-left font-medium">智能体</th>
              <th className="px-4 py-2 text-left font-medium">就绪状态</th>
              <th className="px-4 py-2 text-center font-medium">启用状态</th>
              <th className="px-4 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {statusQuery.isPending ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-[var(--theme-muted)]"
                >
                  加载中…
                </td>
              </tr>
            ) : statusQuery.error ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center">
                  <p className="text-sm text-[var(--theme-text)]">
                    无法加载运行时状态，请确认 Agorax daemon 正在运行。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => statusQuery.refetch()}
                  >
                    重试
                  </Button>
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-sm text-[var(--theme-muted)]"
                >
                  没有报告任何 managed runtime。
                </td>
              </tr>
            ) : (
              sorted.map((entry) => (
                <RuntimeRow
                  key={entry.provider}
                  entry={entry}
                  highlighted={highlightProvider === entry.provider}
                  installingProvider={
                    installMutation.isPending && installMutation.variables
                      ? installMutation.variables.provider
                      : null
                  }
                  togglingProvider={
                    enableMutation.isPending && enableMutation.variables
                      ? enableMutation.variables.provider
                      : null
                  }
                  onInstall={handleInstall}
                  onSetEnabled={handleSetEnabled}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
