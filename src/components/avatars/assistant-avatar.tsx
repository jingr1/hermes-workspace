import { memo } from 'react'
import { cn } from '@/lib/utils'
import { useAssistantAvatarConfig } from './assistant-avatar-context'
import { ClaudeCodeMark } from './claude-code-mark'

type AvatarProps = {
  size?: number
  className?: string
  /** Override context / default Hermes portrait (e.g. Claude Code mark). */
  src?: string
  alt?: string
}

const CLAUDE_CODE_MARK_SRC = '/claude-code-mark.svg'

/**
 * Assistant avatar — defaults to Hermes Agent; Claude Code wraps the tree
 * with AssistantAvatarProvider to swap in the CLI mark.
 */
function AssistantAvatarComponent({
  size = 28,
  className,
  src,
  alt,
}: AvatarProps) {
  const fromContext = useAssistantAvatarConfig()
  const resolvedSrc = src ?? fromContext.src
  const resolvedAlt = alt ?? fromContext.alt

  if (resolvedSrc === CLAUDE_CODE_MARK_SRC) {
    return (
      <ClaudeCodeMark
        size={size}
        className={cn('shrink-0 rounded-[20%]', className)}
        title={resolvedAlt}
      />
    )
  }

  return (
    <img
      src={resolvedSrc}
      alt={resolvedAlt}
      className={cn('shrink-0', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.15)),
      }}
    />
  )
}

export const AssistantAvatar = memo(AssistantAvatarComponent)
