'use client'

import { useEffect, useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  AlertCircleIcon,
  ArrowUp01Icon,
  Download01Icon,
  RefreshIcon,
  ViewOffIcon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  DialogRoot,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type EnvCheckResult = {
  agentId: string
  name: string
  command: string
  currentVersion: string | null
  latestVersion: string | null
  installed: boolean
  installedButBroken: boolean
  detail: string | null
  envType: string
}

type EnvActionResult = {
  ok: boolean
  agentId: string
  action: 'install' | 'update'
  message: string
  command: string
  output: string
  exitCode: number | null
}

export type LocalEnvCheckSectionProps = {
  /** Agent id that matches an entry in local-env-check.ts (e.g. 'codex-impl'). */
  agentId: string
}

function parseSemver(v: string): number[] | null {
  const core = v.split('+')[0].split('-')[0]
  const parts = core.split('.').map((p) => parseInt(p, 10))
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null
  return parts.slice(0, 3)
}

function isUpdateAvailable(
  current: string | null,
  latest: string | null,
): boolean {
  if (!current || !latest) return false
  const cv = parseSemver(current)
  const lv = parseSemver(latest)
  if (!cv || !lv) return false
  for (let i = 0; i < 3; i += 1) {
    if (cv[i] !== lv[i]) return lv[i] > cv[i]
  }
  return false
}

function formatEnvTypeLabel(envType: string): string {
  switch (envType.toLowerCase()) {
    case 'windows':
      return 'Win'
    case 'macos':
      return 'macOS'
    case 'linux':
      return 'Linux'
    case 'wsl':
      return 'WSL'
    default:
      return envType.toUpperCase()
  }
}

function getAgentInitials(name: string, command: string): string {
  const source = name || command || '??'
  const parts = source.split(/[\s-_]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).slice(0, 2).toLowerCase()
  }
  return source.slice(0, 2).toLowerCase()
}

export function LocalEnvCheckSection({
  agentId,
}: LocalEnvCheckSectionProps) {
  const [result, setResult] = useState<EnvCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<EnvActionResult | null>(null)
  const [sudoPassword, setSudoPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [needsSudo, setNeedsSudo] = useState(false)

  const fetchCheck = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/env-check`)
      const data = (await res.json()) as {
        ok?: boolean
        result?: EnvCheckResult
        error?: string
      }
      if (!res.ok || !data.ok || !data.result) {
        setError(data.error || 'Failed to load environment check')
        setResult(null)
      } else {
        setResult(data.result)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
      setResult(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    void fetchCheck()
  }, [agentId])

  const canUpgrade = useMemo(
    () =>
      isUpdateAvailable(
        result?.currentVersion ?? null,
        result?.latestVersion ?? null,
      ),
    [result],
  )

  const runAction = async (
    action: 'install' | 'update',
    useSudo: boolean,
  ) => {
    setActionLoading(true)
    setActionResult(null)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/env-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          useSudo,
          sudoPassword: useSudo ? sudoPassword : undefined,
        }),
      })
      const data = (await res.json()) as EnvActionResult | { error?: string }
      if (!res.ok || !('ok' in data)) {
        setError(
          ('error' in data && data.error) ||
            `Action ${action} failed with status ${res.status}`,
        )
      } else {
        setActionResult(data as EnvActionResult)
        if ((data as EnvActionResult).ok) {
          await fetchCheck()
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    }
    setActionLoading(false)
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }

  const initials = useMemo(
    () => getAgentInitials(result?.name ?? '', result?.command ?? agentId),
    [result, agentId],
  )

  const statusBadge = useMemo(() => {
    if (loading) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-neutral-500/10 px-2 py-0.5 text-xs text-neutral-400">
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.5} />
          检查中
        </span>
      )
    }
    if (!result) return null
    if (canUpgrade) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
          <HugeiconsIcon icon={ArrowUp01Icon} size={12} strokeWidth={1.5} />
          可升级
        </span>
      )
    }
    if (result.installedButBroken) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
          <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.5} />
          异常
        </span>
      )
    }
    if (!result.installed) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
          <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.5} />
          未安装
        </span>
      )
    }
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-400">
        {formatEnvTypeLabel(result.envType)}
      </span>
    )
  }, [loading, result, canUpgrade])

  const actionButton = useMemo(() => {
    const triggerButton = (
      <Button
        size="sm"
        disabled={actionLoading || !result}
        className={cn(
          'h-8 gap-1.5 rounded-lg px-3 text-xs',
          canUpgrade
            ? 'bg-blue-600 text-white hover:bg-blue-700'
            : !result || result.installedButBroken || !result.installed
              ? 'border-neutral-600 bg-neutral-800 text-neutral-100 hover:bg-neutral-700'
              : 'border-primary-200 bg-primary-50 text-primary-900 hover:bg-primary-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700',
        )}
      >
        <HugeiconsIcon
          icon={
            canUpgrade
              ? ArrowUp01Icon
              : !result || result.installedButBroken || !result.installed
                ? Download01Icon
                : RefreshIcon
          }
          size={14}
          strokeWidth={1.5}
          className={cn(actionLoading && 'animate-spin')}
        />
        {actionLoading
          ? '执行中'
          : canUpgrade
            ? '升级'
            : !result || result.installedButBroken || !result.installed
              ? '安装'
              : '刷新'}
      </Button>
    )

    if (!result || loading) {
      return (
        <Button
          size="sm"
          disabled={loading}
          onClick={() => void fetchCheck()}
          className="h-8 gap-1.5 rounded-lg bg-blue-600 px-3 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={14}
            strokeWidth={1.5}
            className={cn(loading && 'animate-spin')}
          />
          刷新
        </Button>
      )
    }

    if (canUpgrade || !result.installed || result.installedButBroken) {
      return (
        <DialogRoot>
          <DialogTrigger render={triggerButton} />
          <DialogContent>
            <div className="p-4">
              <DialogTitle>
                {canUpgrade ? '升级' : '安装'} {result.name}
              </DialogTitle>
              <DialogDescription className="mt-1">
                即将运行命令：系统会尝试使用当前 PATH 中的 npm 进行
                {canUpgrade ? '升级' : '安装'}。
              </DialogDescription>

              <div className="mt-4 space-y-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={needsSudo}
                    onChange={(e) => setNeedsSudo(e.target.checked)}
                    className="size-4 rounded border-neutral-600"
                  />
                  使用 sudo（在 Linux/macOS 上需要提权时选择）
                </label>
                {needsSudo && (
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      value={sudoPassword}
                      onChange={(e) => setSudoPassword(e.target.value)}
                      placeholder="sudo 密码"
                      className="h-9 w-full pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200"
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      <HugeiconsIcon
                        icon={showPassword ? ViewOffIcon : ViewIcon}
                        size={16}
                        strokeWidth={1.5}
                      />
                    </button>
                  </div>
                )}
              </div>

              {actionResult && (
                <div
                  className={cn(
                    'mt-4 max-h-40 overflow-auto rounded-lg border p-2 text-[11px] font-mono',
                    actionResult.ok
                      ? 'border-green-500/20 bg-green-500/10 text-green-300'
                      : 'border-red-500/20 bg-red-500/10 text-red-300',
                  )}
                >
                  <p className="font-medium">{actionResult.message}</p>
                  {actionResult.output && (
                    <pre className="mt-1 whitespace-pre-wrap">
                      {actionResult.output}
                    </pre>
                  )}
                </div>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <DialogClose>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-lg px-3 text-xs"
                  >
                    取消
                  </Button>
                </DialogClose>
                <Button
                  size="sm"
                  disabled={actionLoading || (needsSudo && sudoPassword.length === 0)}
                  onClick={() =>
                    void runAction(
                      canUpgrade ? 'update' : 'install',
                      needsSudo,
                    )
                  }
                  className="h-8 rounded-lg bg-blue-600 px-3 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {actionLoading ? '执行中' : '确认'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </DialogRoot>
      )
    }

    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => void fetchCheck()}
        className="h-8 gap-1.5 rounded-lg border-primary-200 bg-primary-50 px-3 text-xs text-primary-900 hover:bg-primary-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
      >
        <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.5} />
        刷新
      </Button>
    )
  }, [
    loading,
    result,
    canUpgrade,
    actionLoading,
    actionResult,
    sudoPassword,
    showPassword,
    needsSudo,
  ])

  return (
    <div className="rounded-xl border px-4 py-3 shadow-sm" style={cardStyle}>
      <div className="mb-4 flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-xs font-bold text-neutral-100">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-semibold">{result?.command ?? agentId}</p>
              <p className="text-xs" style={mutedStyle}>{result?.name ?? agentId}</p>
            </div>
            {statusBadge}
          </div>
          <div className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-0.5 text-xs">
            <span style={mutedStyle}>Agent ID</span>
            <span className="font-mono text-primary-700 dark:text-neutral-300">{agentId}</span>
            <span style={mutedStyle}>Command</span>
            <span className="font-mono text-primary-700 dark:text-neutral-300">{result?.command ?? '-'}</span>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span style={mutedStyle}>当前版本</span>
          <span className="font-medium">
            {result?.currentVersion ?? (
              <span className="text-neutral-400">未安装</span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span style={mutedStyle}>最新版本</span>
          <span className="font-medium">
            {result?.latestVersion ?? (
              <span className="text-neutral-400">-</span>
            )}
          </span>
        </div>
      </div>

      {result?.detail && (
        <p className="mt-2 text-[11px] text-amber-400">{result.detail}</p>
      )}

      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}

      <div className="mt-3 flex justify-end">{actionButton}</div>
    </div>
  )
}
