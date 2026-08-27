'use client'

import { memo, useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatTokens } from '@/lib/format-tokens'

const POLL_MS = 15_000
const RING_RADIUS = 9.75
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

type ContextData = {
  contextPercent: number
  model: string
  maxTokens: number
  usedTokens: number
  thresholdTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitPercent: number | null
}

const EMPTY: ContextData = {
  contextPercent: 0,
  model: '',
  maxTokens: 0,
  usedTokens: 0,
  thresholdTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheHitPercent: null,
}

function computeCacheHitPercent(
  cacheRead: number,
  cacheWrite: number,
  explicit: unknown,
): number | null {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.min(100, Math.max(0, Math.round(explicit)))
  }
  if (cacheRead <= 0 || cacheWrite <= 0) return null
  const promptTotal = cacheRead + cacheWrite
  return Math.min(100, Math.round((cacheRead / promptTotal) * 100))
}

function ContextIndicatorComponent({
  sessionId,
  refreshToken,
}: {
  sessionId?: string
  refreshToken?: string | number
}) {
  const [ctx, setCtx] = useState<ContextData>(EMPTY)
  const [tooltipOpen, setTooltipOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const params = sessionId
        ? `?sessionId=${encodeURIComponent(sessionId)}`
        : ''
      const res = await fetch(`/api/context-usage${params}`)
      if (!res.ok) return
      const data = await res.json()
      if (!data.ok) return

      const maxTokens = Number(data.maxTokens) || 0
      // Server already applies compression.threshold from Hermes config; 0.5
      // matches the Hermes default only as a last-resort client fallback.
      const thresholdTokens =
        Number(data.thresholdTokens) ||
        (maxTokens > 0 ? Math.floor(maxTokens * 0.5) : 0)

      setCtx({
        contextPercent: Number(data.contextPercent) || 0,
        model: typeof data.model === 'string' ? data.model : '',
        maxTokens,
        usedTokens: Number(data.usedTokens) || 0,
        thresholdTokens,
        cacheReadTokens: Number(data.cacheReadTokens) || 0,
        cacheWriteTokens: Number(data.cacheWriteTokens) || 0,
        cacheHitPercent: computeCacheHitPercent(
          Number(data.cacheReadTokens) || 0,
          Number(data.cacheWriteTokens) || 0,
          data.cacheHitPercent,
        ),
      })
    } catch {
      /* ignore */
    }
  }, [sessionId])

  useEffect(() => {
    const boot = window.setTimeout(() => {
      void refresh()
    }, 2500)
    const id = window.setInterval(refresh, POLL_MS)
    return () => {
      window.clearTimeout(boot)
      window.clearInterval(id)
    }
  }, [refresh])

  useEffect(() => {
    if (refreshToken == null) return
    void refresh()
  }, [refresh, refreshToken])

  if (ctx.maxTokens <= 0) return null

  const rawPct = Math.round(ctx.contextPercent)
  const pct = Math.min(100, Math.max(0, rawPct))
  const overflowed = rawPct > 100
  const leftPct = Math.max(0, 100 - pct)
  const ringOffset = RING_CIRCUMFERENCE * (1 - pct / 100)

  const isHigh = pct > 75
  const isMid = pct > 50 && pct <= 75

  const ringStroke = isHigh
    ? 'stroke-red-500'
    : isMid
      ? 'stroke-amber-500'
      : 'stroke-neutral-400 dark:stroke-neutral-500'

  const usageText = overflowed
    ? `Context window: ${rawPct}% used (context exceeded)`
    : `Context window: ${pct}% used (${leftPct}% left)`

  const tokensText = `Context window: ${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.maxTokens)} tokens used`

  const thresholdText =
    ctx.thresholdTokens > 0 && ctx.maxTokens > 0
      ? `Auto-compress at ${formatTokens(ctx.thresholdTokens)} (${Math.round((ctx.thresholdTokens / ctx.maxTokens) * 100)}%)`
      : null

  const cacheText =
    ctx.cacheReadTokens > 0 || ctx.cacheWriteTokens > 0
      ? ctx.cacheHitPercent != null
        ? `Cache: ${ctx.cacheHitPercent}% hit (${formatTokens(ctx.cacheReadTokens)} read / ${formatTokens(ctx.cacheWriteTokens)} write)`
        : `Cache: ${formatTokens(ctx.cacheReadTokens)} read / ${formatTokens(ctx.cacheWriteTokens)} write`
      : null

  const ariaLabel = [usageText, tokensText, thresholdText, cacheText]
    .filter(Boolean)
    .join('. ')

  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      onMouseEnter={() => setTooltipOpen(true)}
      onMouseLeave={() => setTooltipOpen(false)}
      onFocus={() => setTooltipOpen(true)}
      onBlur={() => setTooltipOpen(false)}
    >
      <button
        type="button"
        className={cn(
          'inline-flex size-[34px] items-center justify-center rounded-full border-0 bg-transparent p-0 text-neutral-500 transition-transform hover:-translate-y-px hover:opacity-90 dark:text-neutral-400',
          isHigh && 'text-red-500',
          isMid && 'text-amber-500',
        )}
        aria-label={ariaLabel}
        aria-describedby="ctx-indicator-tooltip"
        onClick={() => setTooltipOpen((open) => !open)}
      >
        <span className="relative flex size-6 items-center justify-center">
          <svg
            className="absolute inset-0 size-6 -rotate-90"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r={RING_RADIUS}
              className="fill-none stroke-neutral-200 stroke-[3] dark:stroke-white/10"
            />
            <circle
              cx="12"
              cy="12"
              r={RING_RADIUS}
              className={cn('fill-none stroke-[3] transition-[stroke-dashoffset] duration-500 ease-out', ringStroke)}
              strokeLinecap="round"
              strokeDasharray={String(RING_CIRCUMFERENCE)}
              strokeDashoffset={String(ringOffset)}
            />
          </svg>
          <span className="relative flex size-[15px] items-center justify-center rounded-full bg-white text-[8px] font-semibold tabular-nums leading-none text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
            {pct > 0 ? String(pct) : '·'}
          </span>
        </span>
      </button>

      <div
        id="ctx-indicator-tooltip"
        role="tooltip"
        className={cn(
          'pointer-events-none absolute bottom-[calc(100%+8px)] right-0 z-50 min-w-[240px] rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-left shadow-lg transition-all duration-150 dark:border-neutral-700 dark:bg-neutral-900',
          tooltipOpen
            ? 'translate-y-0 opacity-100'
            : 'translate-y-1 opacity-0',
        )}
      >
        <div className="mb-1.5 text-[11px] font-semibold text-neutral-900 dark:text-neutral-100">
          Context window
        </div>
        <div className="space-y-0.5 text-[10px] leading-snug text-neutral-600 dark:text-neutral-300">
          <div>{usageText}</div>
          <div>{tokensText}</div>
          {thresholdText ? <div>{thresholdText}</div> : null}
          {cacheText ? <div>{cacheText}</div> : null}
        </div>
        <div
          className="absolute -bottom-1.5 right-3 size-3 rotate-45 border-b border-r border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

export const ContextIndicator = memo(ContextIndicatorComponent)
