import type { AgentStatus } from '@/lib/agent-types'
import { cn } from '@/lib/utils'

const STATUS_STYLES: Record<AgentStatus, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-primary-300 dark:bg-primary-600',
  busy: 'bg-amber-500',
  blocked: 'bg-red-500',
  idle: 'bg-blue-400',
  unknown: 'bg-primary-300 dark:bg-primary-600',
}

export function AgentStatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        (STATUS_STYLES as Record<string, string>)[status] ?? STATUS_STYLES.unknown,
        className,
      )}
      title={status}
    />
  )
}
