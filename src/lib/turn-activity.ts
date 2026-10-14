/**
 * agorax turn activity projection.
 *
 * Single busy authority: turn phase (or a transitional equivalent).
 * Content (thinking / tools) only changes what the host shows — never whether
 * the host mounts while the turn is busy.
 */

import type { TuiToolSection } from '@/screens/chat/components/tui-activity-card'

export type TurnPhase = 'running' | 'waiting' | 'settling' | 'settled' | string

export type TurnBusySource = {
  /** Canonical: Engine activeTurn.phase. */
  phase?: TurnPhase | null
  /** True when there is an active (non-settled) turn id. */
  hasActiveTurn?: boolean
  /**
   * Transitional Hermes signals collapsed into one owner-side input.
   * Prefer phase/hasActiveTurn; these exist only until send-stream → Engine.
   */
  streaming?: boolean
  waitingForResponse?: boolean
  sending?: boolean
  hasPendingGeneration?: boolean
}

export type TurnActivityStatusLabel = 'thinking' | 'working' | 'activity'

export type TurnActivityVM = {
  turnBusy: boolean
  /** Whether the host must mount (busy OR archived content). */
  shouldMount: boolean
  statusLabel: TurnActivityStatusLabel
  thinkingText: string
  toolSections: Array<TuiToolSection>
}

export type ProjectTurnActivityInput = {
  turnBusy: boolean
  thinkingText?: string | null
  toolSections?: ReadonlyArray<TuiToolSection>
}

/**
 * Unique busy predicate. UI must not re-derive busy from content presence.
 */
function transitionalBusy(source: TurnBusySource): boolean {
  return Boolean(
    source.streaming ||
      source.waitingForResponse ||
      source.sending ||
      source.hasPendingGeneration,
  )
}

export function selectTurnBusy(source: TurnBusySource): boolean {
  if (typeof source.phase === 'string' && source.phase.trim()) {
    if (source.phase !== 'settled') return true
    // Settled phase can briefly overlap finishStream before waiting clears —
    // keep the host up through that handoff via transitional signals.
    return transitionalBusy(source)
  }
  if (source.hasActiveTurn === true) return true
  if (source.hasActiveTurn === false && source.phase == null) {
    // Explicit idle from Engine (no active turn) — still allow pre-accept gap.
    return transitionalBusy(source)
  }
  return transitionalBusy(source)
}

/**
 * Project the single TurnActivityHost view model.
 * Busy with no content still mounts — host decides avatar vs card chrome.
 */
export function projectTurnActivity(
  input: ProjectTurnActivityInput,
): TurnActivityVM {
  const thinkingText = (input.thinkingText ?? '').trim()
  const toolSections = [...(input.toolSections ?? [])]
  const hasTools = toolSections.length > 0
  const hasThinking = thinkingText.length > 0
  const turnBusy = input.turnBusy === true
  const shouldMount = turnBusy || hasThinking || hasTools

  let statusLabel: TurnActivityStatusLabel = 'activity'
  if (turnBusy) {
    statusLabel = hasTools ? 'working' : 'thinking'
  }

  return {
    turnBusy,
    shouldMount,
    statusLabel,
    thinkingText,
    toolSections,
  }
}
