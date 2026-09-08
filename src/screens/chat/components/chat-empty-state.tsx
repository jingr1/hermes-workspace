import { HugeiconsIcon } from '@hugeicons/react'
import { BrainIcon, CodeIcon, PuzzleIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { ClaudeCodeMark } from '@/components/avatars/claude-code-mark'

type ProfileSummary = {
  name: string
  model?: string
  active?: boolean
}

type SuggestionChip = {
  label: string
  prompt: string
  icon: unknown
}

const HERMES_SUGGESTIONS: Array<SuggestionChip> = [
  {
    label: 'Analyze workspace',
    prompt:
      'Analyze this workspace structure and give me 3 engineering risks. Use tools and keep it concise.',
    icon: CodeIcon,
  },
  {
    label: 'Save a preference',
    prompt:
      'Save this to memory exactly: "For demos, respond in 3 bullets max and put risk first." Then confirm saved.',
    icon: BrainIcon,
  },
  {
    label: 'Create a file',
    prompt: 'Create demo-checklist.md with 5 launch checks for this app.',
    icon: PuzzleIcon,
  },
]

const CLAUDE_CODE_SUGGESTIONS: Array<SuggestionChip> = [
  {
    label: 'Explain this repo',
    prompt:
      'Summarize this repository: what it does, key entry points, and how to run it locally. Keep it concise.',
    icon: CodeIcon,
  },
  {
    label: 'Find a bug',
    prompt:
      'Scan the recent changes and likely hotspots for bugs. List the top 3 risks with file paths.',
    icon: BrainIcon,
  },
  {
    label: 'Write a test',
    prompt:
      'Propose one focused unit test for the riskiest module here, and draft the test file contents.',
    icon: PuzzleIcon,
  },
]

export type ChatEmptyStateVariant = 'hermes' | 'claude-code'

type ChatEmptyStateProps = {
  onSuggestionClick?: (prompt: string) => void
  compact?: boolean
  /** Branding + copy. Hermes keeps profile/gateway chrome; Claude Code uses CLI settings. */
  variant?: ChatEmptyStateVariant
}

export function ChatEmptyState({
  onSuggestionClick,
  compact = false,
  variant = 'hermes',
}: ChatEmptyStateProps) {
  const isClaudeCode = variant === 'claude-code'
  const [statusLine, setStatusLine] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    if (isClaudeCode) {
      fetch('/api/agents/claude-code/models')
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return
          const model =
            typeof data?.currentModel === 'string'
              ? data.currentModel.trim()
              : ''
          const provider =
            typeof data?.currentProvider === 'string'
              ? data.currentProvider.trim()
              : ''
          if (model && provider) setStatusLine(`${provider} · ${model}`)
          else if (model) setStatusLine(model)
          else setStatusLine('Claude Code')
        })
        .catch(() => {
          if (!cancelled) setStatusLine('Claude Code')
        })
      return () => {
        cancelled = true
      }
    }

    fetch('/api/profiles/list?light=1')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const profiles = data?.profiles as Array<ProfileSummary> | undefined
        const active = profiles?.find((p) => p.active)
        if (!active) return
        setStatusLine(
          active.model ? `${active.name} · ${active.model}` : active.name,
        )
      })
      .catch(() => {
        // silently ignore — profile info is cosmetic
      })

    return () => {
      cancelled = true
    }
  }, [isClaudeCode])

  const suggestions = isClaudeCode ? CLAUDE_CODE_SUGGESTIONS : HERMES_SUGGESTIONS

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex h-full flex-col items-center justify-center px-4 py-8"
    >
      <div className="flex max-w-xl flex-col items-center text-center">
        {/* Avatar / mark — Hermes keeps the agent portrait; Claude Code uses a CLI mark */}
        <div className="relative mb-6">
          {isClaudeCode ? (
            <div
              className="relative flex size-20 items-center justify-center rounded-md"
              style={{
                border: '1px solid var(--theme-border)',
                padding: '4px',
                background: 'var(--theme-card)',
              }}
            >
              <ClaudeCodeMark size={72} className="rounded-[10px]" />
            </div>
          ) : (
            <img
              src="/claude-avatar.webp"
              alt="Hermes Agent"
              className="relative size-20 rounded-md"
              style={{
                border: '1px solid var(--theme-border)',
                padding: '4px',
                background: 'var(--theme-card)',
              }}
            />
          )}
        </div>

        {/* Editorial micro-label */}
        <p className="micro-label mb-2" style={{ color: 'var(--theme-muted)' }}>
          {isClaudeCode ? 'Claude Code' : 'Hermes Workspace'}
        </p>

        {/* Editorial display title */}
        <h2
          className="editorial-display text-3xl"
          style={{ color: 'var(--theme-text)' }}
        >
          {isClaudeCode ? 'Start coding' : 'Begin a session'}
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
            {isClaudeCode
              ? 'Local CLI · MCP tools · ~/.claude/settings.json'
              : 'Agent chat · live tools · memory · full observability'}
          </p>
        )}

        {/* Prompt chips */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
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
