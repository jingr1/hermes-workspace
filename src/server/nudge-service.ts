import { publishChatEvent } from './chat-event-bus'
import { requestHumanAttention } from './group-chat/pending-turns'

export type NudgeReason =
  | 'rate_limit_reset'
  | 'work_sync_lost'
  | 'progress_stalled'

export type NudgeTarget = {
  agentId: string
  roomId?: string
  taskId?: string
  assignmentId?: string
  runtime?: string
  deliveryPath: 'mcp_control' | 'tmux'
}

export type NudgeRecord = {
  id: string
  agentId: string
  assignmentId?: string
  reason: NudgeReason
  sentAt: number
}

const NUDGE_COOLDOWN_MS = 15 * 60 * 1000
const MAX_NUDGES_PER_ASSIGNMENT = 3
const WORK_SYNC_TIMEOUT_MS = 5 * 60 * 1000
const PROGRESS_STALL_MS = 5 * 60 * 1000

const sentNudges: NudgeRecord[] = []

export function recordNudgeSent(
  agentId: string,
  reason: NudgeReason,
  assignmentId?: string,
): void {
  sentNudges.push({
    id: `${agentId}_${Date.now()}`,
    agentId,
    assignmentId,
    reason,
    sentAt: Date.now(),
  })
}

export function recentNudgeCount(
  agentId: string,
  sinceMs: number = NUDGE_COOLDOWN_MS,
): number {
  const cutoff = Date.now() - sinceMs
  return sentNudges.filter(
    (n) => n.agentId === agentId && n.sentAt >= cutoff,
  ).length
}

export function assignmentNudgeCount(assignmentId: string | undefined): number {
  if (!assignmentId) return 0
  return sentNudges.filter((n) => n.assignmentId === assignmentId).length
}

export function clearNudgeHistory(): void {
  sentNudges.length = 0
}

export type NudgeInput = {
  agentId: string
  assignmentId?: string
  roomId?: string
  taskId?: string
  reason: NudgeReason
  context: {
    rateLimitResetAt?: number
    lastWorkSyncReportAt?: number
    lastStdoutAt?: number
    lastToolCallAt?: number
  }
  message?: string
}

export function evaluateNudge(input: NudgeInput): {
  shouldNudge: boolean
  reason: string
} {
  if (recentNudgeCount(input.agentId) > 0) {
    return { shouldNudge: false, reason: 'agent cooldown' }
  }
  if (assignmentNudgeCount(input.assignmentId) >= MAX_NUDGES_PER_ASSIGNMENT) {
    return { shouldNudge: false, reason: 'assignment nudge limit reached' }
  }

  const now = Date.now()

  if (input.reason === 'rate_limit_reset') {
    const resetAt = input.context.rateLimitResetAt ?? 0
    if (resetAt > 0 && now >= resetAt) {
      return { shouldNudge: true, reason: 'rate limit cooldown ended' }
    }
    return { shouldNudge: false, reason: 'rate limit not yet reset' }
  }

  if (input.reason === 'work_sync_lost') {
    const lastReport = input.context.lastWorkSyncReportAt ?? 0
    if (lastReport > 0 && now - lastReport > WORK_SYNC_TIMEOUT_MS) {
      return { shouldNudge: true, reason: 'work sync lost' }
    }
    return { shouldNudge: false, reason: 'work sync recent' }
  }

  if (input.reason === 'progress_stalled') {
    const lastActivity = Math.max(
      input.context.lastStdoutAt ?? 0,
      input.context.lastToolCallAt ?? 0,
    )
    if (lastActivity > 0 && now - lastActivity > PROGRESS_STALL_MS) {
      return { shouldNudge: true, reason: 'progress stalled' }
    }
    return { shouldNudge: false, reason: 'progress recent' }
  }

  return { shouldNudge: false, reason: 'unknown reason' }
}

export function dispatchNudge(input: NudgeInput): {
  sent: boolean
  escalated: boolean
  reason: string
} {
  if (assignmentNudgeCount(input.assignmentId) >= MAX_NUDGES_PER_ASSIGNMENT) {
    escalateToHuman(input)
    return { sent: false, escalated: true, reason: 'escalated to human' }
  }

  const { shouldNudge, reason } = evaluateNudge(input)
  if (!shouldNudge) {
    return { sent: false, escalated: false, reason }
  }

  recordNudgeSent(input.agentId, input.reason, input.assignmentId)

  const text = input.message ?? `Nudge: ${reason}`

  publishChatEvent('agent_nudge', {
    agentId: input.agentId,
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    roomId: input.roomId,
    reason: input.reason,
    message: text,
  })

  return { sent: true, escalated: false, reason }
}

function escalateToHuman(input: NudgeInput): void {
  if (!input.roomId) return
  requestHumanAttention({
    room_id: input.roomId,
    task_id: input.taskId ?? null,
    requested_by: input.agentId,
    kind: 'blocked',
    reason: `Agent ${input.agentId} stuck after 3 nudges on assignment ${input.assignmentId ?? input.taskId}`,
    options: [
      { id: 'continue', label: 'Continue', replyText: 'Continue' },
      { id: 'reassign', label: 'Reassign', replyText: 'Reassign' },
    ],
    source: 'nudge_escalation',
  })
}
