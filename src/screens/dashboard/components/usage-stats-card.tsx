import { useUsageSummary } from '../hooks/use-usage-data'
import { cn } from '@/lib/utils'
import { formatTokenCount, formatUsd } from '@/lib/format'

type Props = {
  className?: string
  filters: import('../hooks/use-usage-data').UsageFilters
}

function StatBox({
  label,
  value,
  sub,
  accent = 'var(--theme-accent)',
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div
      className="rounded-xl border p-4 transition-colors hover:bg-[var(--theme-card)]/60"
      style={{ borderColor: 'var(--theme-border)' }}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--theme-muted)]">
        {label}
      </div>
      <div
        className="mt-2 text-2xl font-semibold tabular-nums"
        style={{ color: accent }}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-1 text-xs text-[var(--theme-muted)]">{sub}</div>
      ) : null}
    </div>
  )
}

export function UsageStatsCard({ className, filters }: Props) {
  const { data, isLoading } = useUsageSummary(filters)

  if (isLoading) {
    return (
      <div
        className={cn('h-full rounded-2xl border p-4', className)}
        style={{ borderColor: 'var(--theme-border)' }}
      >
        <div className="text-sm font-medium text-[var(--theme-text)]">
          Usage summary
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl bg-[var(--theme-muted)]/10"
            />
          ))}
        </div>
      </div>
    )
  }

  const cacheHitRate = data ? Math.round((data.cacheHitRate ?? 0) * 100) : 0

  return (
    <div
      className={cn('h-full rounded-2xl border p-4', className)}
      style={{ borderColor: 'var(--theme-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--theme-text)]">
          Usage summary
        </div>
        <div className="text-xs text-[var(--theme-muted)] capitalize">
          {filters.range} / {filters.dataSource ?? 'all'}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatBox
          label="Tokens"
          value={formatTokenCount(data?.realTotalTokens ?? data?.totalTokens ?? 0)}
          sub={`In ${formatTokenCount(data?.totalInputTokens ?? 0)} / Out ${formatTokenCount(data?.totalOutputTokens ?? 0)}`}
        />
        <StatBox
          label="Est. cost"
          value={formatUsd(data?.totalCost ?? data?.estimatedCost ?? '0')}
          sub={`${data?.requestCount ?? data?.totalRequests ?? 0} requests`}
          accent="var(--theme-success)"
        />
        <StatBox
          label="Cache hit"
          value={`${cacheHitRate}%`}
          sub={`Rd ${formatTokenCount(data?.totalCacheReadTokens ?? 0)} / Wr ${formatTokenCount(data?.totalCacheCreationTokens ?? data?.totalCacheWriteTokens ?? 0)}`}
          accent="var(--theme-warning)"
        />
        <StatBox
          label="Savings"
          value={`${cacheHitRate}%`}
          sub="cache hit rate"
          accent="var(--theme-accent-secondary)"
        />
      </div>
    </div>
  )
}
