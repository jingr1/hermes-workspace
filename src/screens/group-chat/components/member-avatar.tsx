import { AgentIdentityAvatar } from '@/components/avatars'
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getInitials } from '../lib/avatar-utils'

type MemberAvatarProps = {
  id: string
  name: string
  kind: 'human' | 'agent' | 'system'
  status?: 'idle' | 'thinking' | 'running' | 'complete' | 'failed'
  size?: number
  className?: string
  /** Agent runtime / provider — selects circular base art. */
  runtime?: string
  /** Hermes (and other) roster size; >1 shows two-letter initials. */
  providerSiblingCount?: number
  /** When false, skip the built-in tooltip (parent already provides one). */
  showTooltip?: boolean
}

function AvatarFace({
  name,
  kind,
  size,
  runtime,
  providerSiblingCount,
}: {
  id: string
  name: string
  kind: 'human' | 'agent' | 'system'
  status: 'idle' | 'thinking' | 'running' | 'complete' | 'failed'
  size: number
  runtime?: string
  providerSiblingCount?: number
}) {
  if (kind === 'human') {
    return (
      <div
        className="flex items-center justify-center rounded-full border-2 border-white/10 font-semibold"
        style={{
          width: size,
          height: size,
          background: '#1A2340',
          color: '#E6EAF2',
          fontSize: Math.max(10, size * 0.4),
        }}
      >
        {getInitials(name)}
      </div>
    )
  }

  return (
    <AgentIdentityAvatar
      name={name}
      runtime={runtime ?? 'hermes'}
      providerSiblingCount={providerSiblingCount ?? 1}
      size={size}
    />
  )
}

export function MemberAvatar({
  id,
  name,
  kind,
  status = 'idle',
  size = 32,
  className,
  runtime,
  providerSiblingCount,
  showTooltip = true,
}: MemberAvatarProps) {
  const face = (
    <AvatarFace
      id={id}
      name={name}
      kind={kind}
      status={status}
      size={size}
      runtime={runtime}
      providerSiblingCount={providerSiblingCount}
    />
  )

  if (!showTooltip) {
    return <div className={className}>{face}</div>
  }

  const label = kind === 'human' ? `${name} (you)` : name

  return (
    <TooltipProvider>
      <TooltipRoot>
        <TooltipTrigger type="button" className={className}>
          {face}
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  )
}
