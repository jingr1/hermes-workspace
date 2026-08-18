'use client'

import { ArrowUp02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { memo } from 'react'
import { cn } from '@/lib/utils'
import {
  type ComposerPrimaryAction,
  composerPrimaryActionLabel,
} from '@/screens/chat/lib/composer-primary-action'

function ComposerPrimaryButtonComponent({
  action,
  onSend,
  onStop,
  compact = false,
}: {
  action: ComposerPrimaryAction
  onSend: () => void
  onStop: () => void
  compact?: boolean
}) {
  const isStop = action === 'stop'
  const isDisabled = action === 'disabled'
  const label = composerPrimaryActionLabel(action)
  const sizeClass = compact ? 'size-9' : 'size-[34px]'
  const iconSize = compact ? 18 : 16

  const handleClick = () => {
    if (isDisabled) return
    if (isStop) {
      onStop()
      return
    }
    onSend()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDisabled}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border-0 text-white transition-all duration-150',
        sizeClass,
        isStop
          ? 'bg-red-500 shadow-[0_2px_10px_rgba(0,0,0,0.18)] hover:brightness-110 active:scale-95'
          : 'bg-accent-500 shadow-[0_2px_8px_rgba(0,0,0,0.12)] hover:scale-[1.04] hover:shadow-[0_4px_14px_rgba(0,0,0,0.16)] active:scale-95',
        isDisabled && 'cursor-not-allowed opacity-35 shadow-none hover:scale-100',
      )}
    >
      {isStop ? (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      ) : (
        <HugeiconsIcon icon={ArrowUp02Icon} size={iconSize} strokeWidth={2.5} />
      )}
    </button>
  )
}

export const ComposerPrimaryButton = memo(ComposerPrimaryButtonComponent)
