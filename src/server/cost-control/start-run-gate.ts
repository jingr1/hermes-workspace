import { publishChatEvent } from '../chat-event-bus'
import { getRoom, insertRoomMessage } from '../group-chat/room-store'
import { ensureCollabDb } from '../collab-db'
import { checkBudgetGate } from './budgets'

export type StartRunContext = {
  runId: string
  taskId: string
  projectId?: string
  roomId?: string
  agentId?: string
}

export function canStartRun(ctx: StartRunContext): {
  allowed: boolean
  reason: string
  budgetStatus: ReturnType<typeof checkBudgetGate>
} {
  ensureCollabDb()
  const status = checkBudgetGate({
    runId: ctx.runId,
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    period: 'month',
  })

  if (status.state === 'hard_stop') {
    if (ctx.roomId) {
      const room = getRoom(ctx.roomId)
      if (room) {
        insertRoomMessage({
          room_id: room.id,
          sender_kind: 'system',
          sender_participant_id: 'system',
          sender_name: 'System',
          content: `Run blocked: budget limit reached (${status.reason}). ${Math.round(status.consumedTokens).toLocaleString()} tokens / $${status.consumedCost.toFixed(2)} used.`,
          mentions: [],
          mention_depth: 0,
          auto_handoff: 0,
          task_refs: [ctx.taskId],
          answers_pending_turn_id: null,
          run_id: ctx.runId,
          task_id: ctx.taskId,
        })
      }
    }
    publishChatEvent('budget_hard_stop', {
      runId: ctx.runId,
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      reason: status.reason,
      consumedTokens: status.consumedTokens,
      consumedCost: status.consumedCost,
    })
    return { allowed: false, reason: status.reason, budgetStatus: status }
  }

  if (status.state === 'warn') {
    publishChatEvent('budget_warn', {
      runId: ctx.runId,
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      reason: status.reason,
      consumedTokens: status.consumedTokens,
      consumedCost: status.consumedCost,
    })
  }

  return { allowed: true, reason: status.reason, budgetStatus: status }
}
