import { beforeEach, describe, expect, it } from 'vitest'
import {
  selectHermesTurnBusy,
  useHermesTurnStore,
} from './hermes-turn-store'

describe('hermes-turn-store', () => {
  beforeEach(() => {
    useHermesTurnStore.setState({ bySession: new Map() })
  })

  it('beginTurn marks the session busy before SSE', () => {
    useHermesTurnStore.getState().beginTurn({
      sessionKey: 'sess-1',
      turnId: 'turn-1',
    })
    expect(selectHermesTurnBusy('sess-1')).toBe(true)
    expect(useHermesTurnStore.getState().getSnapshot('sess-1')?.phase).toBe(
      'running',
    )
  })

  it('applies started/done through hermesSseToActivityEvents phase', () => {
    useHermesTurnStore.getState().beginTurn({
      sessionKey: 'sess-1',
      turnId: 'turn-1',
    })
    useHermesTurnStore.getState().applySse({
      sessionKey: 'sess-1',
      event: 'started',
      data: { runId: 'run-1' },
    })
    expect(selectHermesTurnBusy('sess-1')).toBe(true)

    useHermesTurnStore.getState().applySse({
      sessionKey: 'sess-1',
      event: 'thinking',
      data: { text: 'plan', runId: 'run-1' },
    })
    expect(selectHermesTurnBusy('sess-1')).toBe(true)

    useHermesTurnStore.getState().applySse({
      sessionKey: 'sess-1',
      event: 'done',
      data: { state: 'complete', runId: 'run-1' },
    })
    // done settles phase; finishStream/settleTurn clears the snapshot.
    expect(useHermesTurnStore.getState().getSnapshot('sess-1')?.phase).toBe(
      'settled',
    )
    useHermesTurnStore.getState().settleTurn('sess-1')
    expect(selectHermesTurnBusy('sess-1')).toBe(false)
    expect(useHermesTurnStore.getState().getSnapshot('sess-1')).toBeNull()
  })

  it('keeps transitional busy when no turn snapshot exists yet', () => {
    expect(
      selectHermesTurnBusy(null, { waitingForResponse: true }),
    ).toBe(true)
    expect(selectHermesTurnBusy('missing', { sending: true })).toBe(true)
  })
})
