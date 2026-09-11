import type { ReactNode } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  BrainIcon,
  CodeIcon,
  PuzzleIcon,
  TelegramIcon,
} from '@hugeicons/core-free-icons'
import { ClaudeCodeMark } from '@/components/avatars/claude-code-mark'
import { CodexMark } from '@/components/avatars/codex-mark'

export type AgentChatSuggestion = {
  label: string
  prompt: string
  icon: unknown
}

export type AgentChatBrand = {
  id: string
  label: string
  title: string
  tagline: string
  /** Avatar image URL (Hermes portrait). Mutually exclusive with avatarNode. */
  avatarSrc?: string
  avatarAlt?: string
  /** Custom avatar node (e.g. Claude Code mark). */
  avatarNode?: ReactNode
  suggestions: Array<AgentChatSuggestion>
  /**
   * Optional status line resolver. Sync string or async fetcher.
   * ChatEmptyState will call this on mount.
   */
  resolveStatusLine?: () => string | Promise<string>
}

const HERMES_SUGGESTIONS: Array<AgentChatSuggestion> = [
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

const CLAUDE_CODE_SUGGESTIONS: Array<AgentChatSuggestion> = [
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

const CODEX_SUGGESTIONS: Array<AgentChatSuggestion> = [
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

export const HERMES_CHAT_BRAND: AgentChatBrand = {
  id: 'hermes',
  label: 'Hermes Workspace',
  title: 'Begin a session',
  tagline: 'Agent chat · live tools · memory · full observability',
  avatarSrc: '/claude-avatar.webp',
  avatarAlt: 'Hermes Agent',
  suggestions: HERMES_SUGGESTIONS,
  resolveStatusLine: async () => {
    try {
      const res = await fetch('/api/profiles/list?light=1')
      const data = (await res.json()) as {
        profiles?: Array<{ name: string; model?: string; active?: boolean }>
      }
      const active = data.profiles?.find((p) => p.active)
      if (!active) return ''
      return active.model ? `${active.name} · ${active.model}` : active.name
    } catch {
      return ''
    }
  },
}

export const CLAUDE_CODE_CHAT_BRAND: AgentChatBrand = {
  id: 'claude-code',
  label: 'Claude Code',
  title: 'Start coding',
  tagline: 'Local CLI · MCP tools · ~/.claude/settings.json',
  avatarAlt: 'Claude Code',
  avatarNode: (
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
  ),
  suggestions: CLAUDE_CODE_SUGGESTIONS,
  resolveStatusLine: async () => {
    try {
      const res = await fetch('/api/agents/claude-code/models')
      const data = (await res.json()) as {
        currentModel?: string
        currentProvider?: string
      }
      const model =
        typeof data.currentModel === 'string' ? data.currentModel.trim() : ''
      const provider =
        typeof data.currentProvider === 'string'
          ? data.currentProvider.trim()
          : ''
      if (model && provider) return `${provider} · ${model}`
      if (model) return model
      return 'Claude Code'
    } catch {
      return 'Claude Code'
    }
  },
}

export const CODEX_CHAT_BRAND: AgentChatBrand = {
  id: 'codex',
  label: 'Codex',
  title: 'Start coding',
  tagline: 'OpenAI Codex CLI · MCP tools · ~/.codex/config.toml',
  avatarAlt: 'Codex',
  avatarNode: (
    <div
      className="relative flex size-20 items-center justify-center rounded-md"
      style={{
        border: '1px solid var(--theme-border)',
        padding: '4px',
        background: 'var(--theme-card)',
      }}
    >
      <CodexMark size={72} className="rounded-[10px]" />
    </div>
  ),
  suggestions: CODEX_SUGGESTIONS,
  resolveStatusLine: async () => {
    try {
      const res = await fetch('/api/agents/codex-impl/models')
      const data = (await res.json()) as {
        currentModel?: string
        currentProvider?: string
      }
      const model =
        typeof data.currentModel === 'string' ? data.currentModel.trim() : ''
      const provider =
        typeof data.currentProvider === 'string'
          ? data.currentProvider.trim()
          : ''
      if (model && provider) return `${provider} · ${model}`
      if (model) return model
      return 'Codex'
    } catch {
      return 'Codex'
    }
  },
}
