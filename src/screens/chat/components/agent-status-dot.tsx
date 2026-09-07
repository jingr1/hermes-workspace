import type { AgentStatus } from '@/lib/agent-types'
import type { UnifiedAgentStatus } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'

const LEGACY_STATUS_STYLES: Record<AgentStatus, string> = {
  // Legacy AgentStatus names mapped to the unified color scheme:
  // active = green, idle = blue/cyan, offline = gray, blocked/error = red.
  busy: 'bg-emerald-500',
  idle: 'bg-sky-400',
  online: 'bg-sky-400',
  offline: 'bg-primary-300 dark:bg-primary-600',
  blocked: 'bg-red-500',
  unknown: 'bg-primary-300 dark:bg-primary-600',
}

const UNIFIED_STATUS_STYLES: Record<UnifiedAgentStatus, string> = {
  active: 'bg-emerald-500',
  idle: 'bg-sky-400',
  offline: 'bg-primary-300 dark:bg-primary-600',
  blocked: 'bg-red-500',
  error: 'bg-red-500',
  needsSetup: 'bg-amber-400',
}

export function AgentStatusDot({
  status,
  className,
  needsSetup,
}: {
  status: AgentStatus | UnifiedAgentStatus
  className?: string
  needsSetup?: boolean
}) {
  const style =
    UNIFIED_STATUS_STYLES[status as UnifiedAgentStatus] ??
    LEGACY_STATUS_STYLES[status as AgentStatus] ??
    LEGACY_STATUS_STYLES.unknown

  return (
    <span
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        needsSetup ? 'bg-amber-400' : style,
        className,
      )}
      title={needsSetup ? 'needs setup' : status}
    />
  )
}
