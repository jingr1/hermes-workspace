/**
 * Single Tutti-feel activity host for an open (or just-settled) turn.
 *
 * On send: pulsing avatar + Working card immediately (no empty Thinking gap).
 * Once thinking/tools arrive: stop avatar pulse; Working card keeps content.
 */

import { memo, useMemo } from 'react'
import { AssistantAvatar } from '@/components/avatars'
import {
  projectTurnActivity,
  type TurnActivityVM,
} from '@/lib/turn-activity'
import {
  TuiActivityCard,
  type TuiToolSection,
} from './tui-activity-card'

export type TurnActivityHostProps = {
  turnBusy: boolean
  thinkingText?: string | null
  toolSections?: ReadonlyArray<TuiToolSection>
  thinkingElapsedSeconds?: number
  expandAll?: boolean
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
  className?: string
  /** Optional precomputed VM (tests / managed projection). */
  vm?: TurnActivityVM
}

function TurnActivityHostComponent({
  turnBusy,
  thinkingText,
  toolSections = [],
  thinkingElapsedSeconds = 0,
  expandAll,
  formatLabel,
  formatArg,
  className,
  vm: vmProp,
}: TurnActivityHostProps) {
  const vm = useMemo(
    () =>
      vmProp ??
      projectTurnActivity({
        turnBusy,
        thinkingText,
        toolSections,
      }),
    [vmProp, turnBusy, thinkingText, toolSections],
  )

  if (!vm.shouldMount) return null

  const hasContent =
    vm.thinkingText.length > 0 || vm.toolSections.length > 0
  // Pulse only before content; card is up from the first busy frame.
  const showPulsingAvatar = vm.turnBusy && !hasContent

  return (
    <div
      className={className ?? 'flex items-end gap-2'}
      role="status"
      aria-live="polite"
      data-turn-activity-host=""
      data-turn-busy={vm.turnBusy ? 'true' : 'false'}
      data-status-label={vm.statusLabel}
    >
      {showPulsingAvatar ? (
        <div
          className="thinking-avatar-glow inline-flex size-7 shrink-0 items-center justify-center rounded-full"
          aria-label="Working"
        >
          <AssistantAvatar size={28} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <TuiActivityCard
          toolSections={vm.toolSections}
          thinking={vm.thinkingText || null}
          thinkingElapsedSeconds={thinkingElapsedSeconds}
          isStreaming={vm.turnBusy}
          keepMountedWhileBusy
          statusTitle={vm.turnBusy ? '⚡ Working' : 'Activity'}
          expandAll={expandAll}
          formatLabel={formatLabel}
          formatArg={formatArg}
        />
      </div>
    </div>
  )
}

export const TurnActivityHost = memo(TurnActivityHostComponent)
