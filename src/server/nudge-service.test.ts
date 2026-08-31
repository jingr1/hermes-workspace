import { describe, expect, it, vi } from 'vitest'
import {
  assignmentNudgeCount,
  clearNudgeHistory,
  dispatchNudge,
  evaluateNudge,
  recentNudgeCount,
  recordNudgeSent,
} from './nudge-service'

describe('nudge-service', () => {
  it('allows nudge when no recent nudge exists', () => {
    clearNudgeHistory()
    const result = evaluateNudge({
      agentId: 'claude',
      assignmentId: 'a1',
      reason: 'progress_stalled',
      context: { lastStdoutAt: Date.now() - 6 * 60 * 1000 },
    })
    expect(result.shouldNudge).toBe(true)
  })

  it('blocks nudge within cooldown', () => {
    clearNudgeHistory()
    recordNudgeSent('claude', 'progress_stalled', 'a1')
    const result = evaluateNudge({
      agentId: 'claude',
      assignmentId: 'a2',
      reason: 'progress_stalled',
      context: { lastStdoutAt: Date.now() - 6 * 60 * 1000 },
    })
    expect(result.shouldNudge).toBe(false)
  })

  it('escalates to human after 3 nudges on the same assignment', () => {
    clearNudgeHistory()

    for (let i = 0; i < 3; i++) {
      recordNudgeSent('claude', 'progress_stalled', 'a1')
    }

    expect(assignmentNudgeCount('a1')).toBe(3)

    const fourth = dispatchNudge({
      agentId: 'claude',
      assignmentId: 'a1',
      roomId: 'room-1',
      taskId: 'task-1',
      reason: 'progress_stalled',
      context: { lastStdoutAt: Date.now() - 6 * 60 * 1000 },
    })
    expect(fourth.escalated).toBe(true)
  })

  it('detects work sync lost after timeout', () => {
    clearNudgeHistory()
    const result = evaluateNudge({
      agentId: 'claude',
      reason: 'work_sync_lost',
      context: { lastWorkSyncReportAt: Date.now() - 6 * 60 * 1000 },
    })
    expect(result.shouldNudge).toBe(true)
  })

  it('detects rate limit reset when reset time passed', () => {
    clearNudgeHistory()
    const result = evaluateNudge({
      agentId: 'claude',
      reason: 'rate_limit_reset',
      context: { rateLimitResetAt: Date.now() - 1000 },
    })
    expect(result.shouldNudge).toBe(true)
  })
})
