import { afterEach, describe, expect, it } from 'vitest'
import {
  isRecentSession,
  setPendingGeneration,
  setRecentSession,
} from './pending-send'

describe('setRecentSession', () => {
  afterEach(() => {
    setPendingGeneration(false)
    setRecentSession('')
  })

  it('keeps a just-created session visible across list refetches', () => {
    const id = 'thread-new-1'
    setRecentSession(id)
    expect(isRecentSession(id)).toBe(true)
    expect(isRecentSession('other')).toBe(false)
  })

  it('expires after the configured window', () => {
    const id = 'thread-new-2'
    setRecentSession(id)
    expect(isRecentSession(id, 0)).toBe(false)
  })
})
