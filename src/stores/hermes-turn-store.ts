/**
 * Hermes 1:1 turn-phase owner (Engine-shaped).
 *
 * Applies hermesSseToActivityEvents and keeps activeTurn.phase per session so
 * UI can selectTurnBusy from one place. Full AgentSessionEngine hydrate is the
 * next step; this store is the Phase-C bridge that already speaks turn_update.
 */

import { create } from 'zustand'
import {
  createHermesActivityAdapterState,
  hermesSseToActivityEvents,
  type HermesActivityAdapterState,
  type HermesSseEventName,
} from '@/lib/hermes-activity-adapter'
import { selectTurnBusy, type TurnPhase } from '@/lib/turn-activity'

export type HermesTurnSnapshot = {
  turnId: string
  phase: TurnPhase
  runId: string | null
  adapter: HermesActivityAdapterState
  /** Owner marked busy before first SSE started (send accepted). */
  pendingBusy: boolean
}

type HermesTurnStore = {
  bySession: Map<string, HermesTurnSnapshot>
  beginTurn: (input: {
    sessionKey: string
    turnId: string
    workspaceId?: string
  }) => void
  applySse: (input: {
    sessionKey: string
    workspaceId?: string
    event: HermesSseEventName
    data: Record<string, unknown>
  }) => void
  settleTurn: (sessionKey: string, phase?: 'settled') => void
  clearSession: (sessionKey: string) => void
  getSnapshot: (sessionKey: string) => HermesTurnSnapshot | null
}

const DEFAULT_WORKSPACE = 'default'

function cloneMap(
  source: Map<string, HermesTurnSnapshot>,
): Map<string, HermesTurnSnapshot> {
  return new Map(source)
}

export const useHermesTurnStore = create<HermesTurnStore>((set, get) => ({
  bySession: new Map(),

  beginTurn({ sessionKey, turnId }) {
    if (!sessionKey) return
    set((state) => {
      const bySession = cloneMap(state.bySession)
      bySession.set(sessionKey, {
        turnId,
        phase: 'running',
        runId: null,
        adapter: createHermesActivityAdapterState(),
        pendingBusy: true,
      })
      return { bySession }
    })
  },

  applySse({ sessionKey, workspaceId, event, data }) {
    if (!sessionKey) return
    const current = get().bySession.get(sessionKey)
    if (!current) return

    const ctx = {
      workspaceId: workspaceId?.trim() || DEFAULT_WORKSPACE,
      agentSessionId: sessionKey,
      turnId: current.turnId,
      runId: current.runId,
    }
    const { state: nextAdapter, events } = hermesSseToActivityEvents(
      ctx,
      current.adapter,
      event,
      data,
    )

    let phase = current.phase
    let runId = current.runId
    let pendingBusy = current.pendingBusy

    for (const activityEvent of events) {
      if (activityEvent.eventType !== 'turn_update') continue
      const turn = (
        activityEvent.data as {
          turn?: { phase?: string; turnId?: string }
          activeTurnId?: string | null
        }
      ).turn
      const nextPhase = turn?.phase
      if (typeof nextPhase === 'string' && nextPhase.trim()) {
        phase = nextPhase
      }
      if (phase !== 'settled') pendingBusy = false
      const payloadRun =
        typeof data.runId === 'string'
          ? data.runId
          : typeof data.run_id === 'string'
            ? data.run_id
            : null
      if (payloadRun) runId = payloadRun
      if (nextAdapter.runId) runId = nextAdapter.runId
    }

    // started without turn_update race: still clear pending once stream is live
    if (event === 'started') {
      pendingBusy = false
      if (phase === 'settled') phase = 'running'
      const payloadRun =
        typeof data.runId === 'string'
          ? data.runId
          : typeof data.run_id === 'string'
            ? data.run_id
            : null
      if (payloadRun) runId = payloadRun
    }

    set((state) => {
      const bySession = cloneMap(state.bySession)
      bySession.set(sessionKey, {
        turnId: current.turnId,
        phase,
        runId,
        adapter: nextAdapter,
        pendingBusy,
      })
      return { bySession }
    })
  },

  settleTurn(sessionKey) {
    if (!sessionKey) return
    // Drop the snapshot so the next send's transitional waiting/sending can
    // light turnBusy before beginTurn runs (settled phase would block them).
    set((state) => {
      if (!state.bySession.has(sessionKey)) return state
      const bySession = cloneMap(state.bySession)
      bySession.delete(sessionKey)
      return { bySession }
    })
  },

  clearSession(sessionKey) {
    if (!sessionKey) return
    set((state) => {
      if (!state.bySession.has(sessionKey)) return state
      const bySession = cloneMap(state.bySession)
      bySession.delete(sessionKey)
      return { bySession }
    })
  },

  getSnapshot(sessionKey) {
    return get().bySession.get(sessionKey) ?? null
  },
}))

/** Selector input for Hermes chat owner → selectTurnBusy. */
export function hermesTurnBusySource(
  sessionKey: string | null | undefined,
  transitional?: {
    streaming?: boolean
    waitingForResponse?: boolean
    sending?: boolean
    hasPendingGeneration?: boolean
  },
): Parameters<typeof selectTurnBusy>[0] {
  const snap = sessionKey
    ? useHermesTurnStore.getState().getSnapshot(sessionKey)
    : null
  if (snap) {
    return {
      phase: snap.phase,
      hasActiveTurn: snap.phase !== 'settled' || snap.pendingBusy,
      streaming: transitional?.streaming,
      waitingForResponse: transitional?.waitingForResponse,
      sending: transitional?.sending,
      hasPendingGeneration: transitional?.hasPendingGeneration,
    }
  }
  return {
    hasActiveTurn: false,
    streaming: transitional?.streaming,
    waitingForResponse: transitional?.waitingForResponse,
    sending: transitional?.sending,
    hasPendingGeneration: transitional?.hasPendingGeneration,
  }
}

export function selectHermesTurnBusy(
  sessionKey: string | null | undefined,
  transitional?: {
    streaming?: boolean
    waitingForResponse?: boolean
    sending?: boolean
    hasPendingGeneration?: boolean
  },
): boolean {
  return selectTurnBusy(hermesTurnBusySource(sessionKey, transitional))
}
