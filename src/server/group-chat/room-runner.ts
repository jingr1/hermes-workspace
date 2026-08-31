import { publishChatEvent } from '../chat-event-bus'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import { buildRoomContext } from './context-projection'
import { listRooms } from './room-store'
import { expireStalePendingTurns, getPendingTurns } from './pending-turns'
import { runAutoHandoffForTask } from './auto-handoff'
import { generateSummaryFromRoomWithLlm, getRoomSummary } from './room-summaries'

export type RoomRunnerPolicy = {
  /** Maximum pending turns created per tick. */
  maxPendingPerTick: number
  /** Minimum milliseconds between room-runner ticks. */
  tickIntervalMs: number
  /** Number of new messages since last summary before requesting an LLM summary. */
  summaryThreshold: number
}

const DEFAULT_POLICY: RoomRunnerPolicy = {
  maxPendingPerTick: 10,
  tickIntervalMs: 5000,
  summaryThreshold: 8,
}

let runnerTimer: ReturnType<typeof setInterval> | null = null
let lastTick = 0

export function startRoomRunner(policy: Partial<RoomRunnerPolicy> = {}): void {
  if (runnerTimer) return
  const p = { ...DEFAULT_POLICY, ...policy }
  runnerTimer = setInterval(() => {
    tickRoomRunner(p).catch((err) => {
      console.error('[room-runner] tick failed', err)
    })
  }, p.tickIntervalMs)
}

export function stopRoomRunner(): void {
  if (runnerTimer) {
    clearInterval(runnerTimer)
    runnerTimer = null
  }
}

export function isRoomRunnerRunning(): boolean {
  return runnerTimer != null
}

export async function tickRoomRunner(policy?: Partial<RoomRunnerPolicy>): Promise<void> {
  const now = Date.now()
  const p = { ...DEFAULT_POLICY, ...policy }
  if (now - lastTick < p.tickIntervalMs) return
  lastTick = now

  // P5: expire stale human-attention requests once per tick.
  try {
    const expired = expireStalePendingTurns()
    if (expired.length > 0) {
      for (const turn of expired) {
        publishChatEvent('pending_turn_expired', {
          roomId: turn.room_id,
          pendingTurnId: turn.id,
        })
      }
    }
  } catch (err) {
    console.error('[room-runner] expire stale pending turns failed', err)
  }

  const rooms = listRooms()
  let created = 0

  for (const room of rooms) {
    if (created >= p.maxPendingPerTick) break

    // P4: auto-generate rolling summary when enough new messages have arrived.
    try {
      const summary = getRoomSummary(room.id)
      const ctx = buildRoomContext(room.id)
      const sinceSummary = summary
        ? ctx.totalMessages - summary.turn_count
        : ctx.totalMessages
      if (sinceSummary >= p.summaryThreshold) {
        await generateSummaryFromRoomWithLlm(room.id)
      }
    } catch (err) {
      console.error('[room-runner] auto-summary failed', err)
    }

    const pending = getPendingTurns({ roomId: room.id })
    if (pending.some((t) => t.status === 'pending')) {
      // There is already an open human gate in this room.
      continue
    }

    const ctx = buildRoomContext(room.id)
    const lastMention = findLastMention(ctx.tail)
    if (!lastMention) continue

    const router = getAgentRuntimeRouter()
    const target = router.registry.byId.get(lastMention.agentId)

    // Create a pending turn asking the targeted agent to take the room.
    await runAutoHandoffForTask({
      roomId: room.id,
      taskId: room.task_id ?? undefined,
      fromAgentId: lastMention.fromAgentId,
      summary: `Room "${room.title}" needs attention.`,
      nextAction: 'Please review the latest messages and continue the task.',
      requiredCapabilities: target?.capabilities,
    })
    created += 1
  }
}

function findLastMention(tail: Array<{ senderKind: string; content: string }>): {
  agentId: string
  fromAgentId?: string
} | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i]
    const match = msg.content.match(/@agent:([a-zA-Z0-9_-]+)/)
    if (match) {
      return { agentId: match[1], fromAgentId: msg.senderKind === 'agent' ? undefined : 'system' }
    }
  }
  return null
}

// Publish a heartbeat event so observers can confirm the runner is alive.
export function emitRoomRunnerHeartbeat(): void {
  publishChatEvent('room_runner_heartbeat', {
    at: Date.now(),
    running: isRoomRunnerRunning(),
  })
}
