import { describe, expect, it } from 'vitest'
import { projectTurnActivity, selectTurnBusy } from './turn-activity'

describe('selectTurnBusy', () => {
  it('treats non-settled phase as busy', () => {
    expect(selectTurnBusy({ phase: 'running' })).toBe(true)
    expect(selectTurnBusy({ phase: 'waiting' })).toBe(true)
    expect(selectTurnBusy({ phase: 'settled' })).toBe(false)
  })

  it('keeps settled phase busy while transitional waiting/streaming remains', () => {
    expect(
      selectTurnBusy({ phase: 'settled', waitingForResponse: true }),
    ).toBe(true)
    expect(selectTurnBusy({ phase: 'settled', streaming: true })).toBe(true)
  })

  it('uses hasActiveTurn when phase is absent', () => {
    expect(selectTurnBusy({ hasActiveTurn: true })).toBe(true)
    expect(selectTurnBusy({ hasActiveTurn: false })).toBe(false)
  })

  it('keeps pre-acceptance gap busy via transitional signals', () => {
    expect(
      selectTurnBusy({
        hasActiveTurn: false,
        waitingForResponse: true,
      }),
    ).toBe(true)
    expect(
      selectTurnBusy({
        hasActiveTurn: false,
        sending: true,
      }),
    ).toBe(true)
  })

  it('falls back to transitional signals when Engine fields are unset', () => {
    expect(selectTurnBusy({ streaming: true })).toBe(true)
    expect(selectTurnBusy({ waitingForResponse: true })).toBe(true)
    expect(selectTurnBusy({})).toBe(false)
  })
})

describe('projectTurnActivity', () => {
  it('mounts Thinking with no content while busy', () => {
    const vm = projectTurnActivity({ turnBusy: true })
    expect(vm.shouldMount).toBe(true)
    expect(vm.statusLabel).toBe('thinking')
    expect(vm.thinkingText).toBe('')
    expect(vm.toolSections).toEqual([])
  })

  it('switches to working when tools arrive without unmounting', () => {
    const vm = projectTurnActivity({
      turnBusy: true,
      thinkingText: 'planning',
      toolSections: [
        {
          key: 't1',
          type: 'Read',
          outputText: '',
          state: 'input-available',
        },
      ],
    })
    expect(vm.shouldMount).toBe(true)
    expect(vm.statusLabel).toBe('working')
    expect(vm.thinkingText).toBe('planning')
  })

  it('keeps archived activity mounted after settle', () => {
    const vm = projectTurnActivity({
      turnBusy: false,
      thinkingText: 'done thinking',
    })
    expect(vm.shouldMount).toBe(true)
    expect(vm.statusLabel).toBe('activity')
  })

  it('does not mount when idle and empty', () => {
    const vm = projectTurnActivity({ turnBusy: false })
    expect(vm.shouldMount).toBe(false)
  })
})
