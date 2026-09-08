/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { ACTIVITY_STALE_MS, deriveUnifiedStatus } from './agent-status'

describe('deriveUnifiedStatus', () => {
  const now = 1_000_000_000_000

  it('returns needsSetup when hasModel is false', () => {
    expect(
      deriveUnifiedStatus({ hasModel: false, probeAvailable: true }, now),
    ).toBe('needsSetup')
  })

  it('returns offline when probe fails even if group-chat online is sticky', () => {
    expect(
      deriveUnifiedStatus(
        {
          hasModel: true,
          probeAvailable: false,
          groupChatOnline: true,
          runtimeState: 'executing',
          runtimeLastOutputAt: now - 60_000,
        },
        now,
      ),
    ).toBe('offline')
  })

  it('returns offline when probe fails even with needsHuman sticky runtime', () => {
    expect(
      deriveUnifiedStatus(
        {
          hasModel: true,
          probeAvailable: false,
          runtimeNeedsHuman: true,
        },
        now,
      ),
    ).toBe('offline')
  })

  it('returns idle when probe succeeds and there is no recent activity', () => {
    expect(
      deriveUnifiedStatus(
        {
          hasModel: true,
          probeAvailable: true,
          runtimeState: 'executing',
          runtimeLastOutputAt: now - ACTIVITY_STALE_MS - 1,
        },
        now,
      ),
    ).toBe('idle')
  })

  it('does not treat stale runtimeState alone as online without probe', () => {
    expect(
      deriveUnifiedStatus(
        {
          hasModel: true,
          runtimeState: 'executing',
          runtimeLastOutputAt: now - ACTIVITY_STALE_MS - 1,
        },
        now,
      ),
    ).toBe('offline')
  })

  it('returns active when recently active and probe ok', () => {
    expect(
      deriveUnifiedStatus(
        {
          hasModel: true,
          probeAvailable: true,
          runtimeState: 'executing',
          runtimeLastOutputAt: now - 1_000,
        },
        now,
      ),
    ).toBe('active')
  })

  it('returns blocked when needsHuman and probe ok', () => {
    expect(
      deriveUnifiedStatus(
        {
          hasModel: true,
          probeAvailable: true,
          runtimeNeedsHuman: true,
        },
        now,
      ),
    ).toBe('blocked')
  })
})
