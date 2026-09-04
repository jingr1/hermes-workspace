import { PixelAvatar } from '@/components/agent-swarm/pixel-avatar'
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getInitials, getMemberColor } from '../lib/avatar-utils'

type MemberAvatarProps = {
  id: string
  name: string
  kind: 'human' | 'agent' | 'system'
  status?: 'idle' | 'thinking' | 'running' | 'complete' | 'failed'
  size?: number
  className?: string
}

export function MemberAvatar({
  id,
  name,
  kind,
  status = 'idle',
  size = 32,
  className,
}: MemberAvatarProps) {
  if (kind === 'human') {
    return (
      <TooltipProvider>
        <TooltipRoot>
          <TooltipTrigger type="button" className={className}>
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
          </TooltipTrigger>
          <TooltipContent side="top">{name} (you)</TooltipContent>
        </TooltipRoot>
      </TooltipProvider>
    )
  }

  const color = getMemberColor(id, name)

  return (
    <TooltipProvider>
      <TooltipRoot>
        <TooltipTrigger type="button" className={className}>
          <div className="relative">
            <PixelAvatar
              color={color}
              accentColor={color}
              size={size}
              status={status}
              expression={status === 'thinking' ? 'focused' : 'neutral'}
            />
            <span
              className="absolute -bottom-0.5 -right-0.5 block rounded-full border-2 border-[var(--theme-bg)]"
              style={{
                width: Math.max(8, size * 0.25),
                height: Math.max(8, size * 0.25),
                background:
                  status === 'thinking'
                    ? '#f59e0b'
                    : status === 'failed'
                      ? '#ef4444'
                      : '#22c55e',
              }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{name}</TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  )
}
