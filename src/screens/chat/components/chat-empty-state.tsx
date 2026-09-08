import { HugeiconsIcon } from '@hugeicons/react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import type { AgentChatBrand } from '../agent-chat-brands'
import { HERMES_CHAT_BRAND } from '../agent-chat-brands'

type ChatEmptyStateProps = {
  onSuggestionClick?: (prompt: string) => void
  compact?: boolean
  /** Branding + copy. Defaults to Hermes. */
  brand?: AgentChatBrand
}

export function ChatEmptyState({
  onSuggestionClick,
  compact = false,
  brand = HERMES_CHAT_BRAND,
}: ChatEmptyStateProps) {
  const [statusLine, setStatusLine] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const resolver = brand.resolveStatusLine
    if (!resolver) {
      setStatusLine(null)
      return
    }
    void Promise.resolve(resolver()).then((line) => {
      if (!cancelled) setStatusLine(line?.trim() ? line : null)
    })
    return () => {
      cancelled = true
    }
  }, [brand])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex h-full flex-col items-center justify-center px-4 py-8"
    >
      <div className="flex max-w-xl flex-col items-center text-center">
        <div className="relative mb-6">
          {brand.avatarNode ? (
            brand.avatarNode
          ) : brand.avatarSrc ? (
            <img
              src={brand.avatarSrc}
              alt={brand.avatarAlt ?? brand.label}
              className="relative size-20 rounded-md"
              style={{
                border: '1px solid var(--theme-border)',
                padding: '4px',
                background: 'var(--theme-card)',
              }}
            />
          ) : null}
        </div>

        <p className="micro-label mb-2" style={{ color: 'var(--theme-muted)' }}>
          {brand.label}
        </p>

        <h2
          className="editorial-display text-3xl"
          style={{ color: 'var(--theme-text)' }}
        >
          {brand.title}
        </h2>

        {statusLine && (
          <span
            className="mt-2 text-xs"
            style={{ color: 'var(--theme-accent)' }}
          >
            {statusLine}
          </span>
        )}

        {!compact && (
          <p className="mt-3 text-sm" style={{ color: 'var(--theme-muted)' }}>
            {brand.tagline}
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {brand.suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              onClick={() => onSuggestionClick?.(suggestion.prompt)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium transition-all"
              style={{
                background: 'var(--theme-card)',
                border: '1px solid var(--theme-border)',
                color: 'var(--theme-text)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--theme-card2)'
                e.currentTarget.style.borderColor = 'var(--theme-accent-border)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--theme-card)'
                e.currentTarget.style.borderColor = 'var(--theme-border)'
              }}
            >
              <HugeiconsIcon
                icon={suggestion.icon as any}
                size={14}
                strokeWidth={1.5}
                style={{ color: 'var(--theme-accent)' }}
              />
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
