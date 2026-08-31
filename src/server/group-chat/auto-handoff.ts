import { publishChatEvent } from '../chat-event-bus'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import { getParticipants } from './participants'
import { insertRoomMessage } from './room-store'
import { requestHumanAttention } from './pending-turns'

export type AutoHandoffInput = {
  roomId: string
  taskId?: string
  fromAgentId?: string
  toAgentId?: string
  toHumanId?: string
  summary: string
  nextAction: string
  filesChanged?: string[]
  options?: Array<{ id: string; label: string; replyText?: string }>
}

export function resolveAutoHandoffTarget(opts: {
  roomId: string
  fromAgentId?: string
  requiredCapabilities?: string[]
}): {
  kind: 'agent' | 'human' | 'none'
  participantId: string | null
  reason: string
} {
  const participants = getParticipants(opts.roomId)
  const agents = participants
    .filter((p) => p.kind === 'agent' && p.participant_id !== opts.fromAgentId)
    .sort((a, b) => {
      if (a.online === b.online) return 0
      return a.online ? -1 : 1
    })

  if (opts.requiredCapabilities && opts.requiredCapabilities.length > 0) {
    const router = getAgentRuntimeRouter()
    const matching = agents
      .map((p) => {
        const decl = router.registry.byId.get(p.participant_id)
        const caps = decl?.capabilities ?? []
        const missing = opts.requiredCapabilities!.filter(
          (c) => !caps.includes(c),
        )
        return { p, missing }
      })
      .filter((x) => x.missing.length === 0)
    if (matching.length > 0) {
      return {
        kind: 'agent',
        participantId: matching[0].p.participant_id,
        reason: `capability match: ${opts.requiredCapabilities.join(', ')}`,
      }
    }
  }

  const firstOnline = agents.find((p) => p.online)
  if (firstOnline) {
    return {
      kind: 'agent',
      participantId: firstOnline.participant_id,
      reason: 'fallback to next online agent',
    }
  }

  const firstHuman = participants.find((p) => p.kind === 'human')
  if (firstHuman) {
    return {
      kind: 'human',
      participantId: firstHuman.participant_id,
      reason: 'no online agents; route to human',
    }
  }

  return { kind: 'none', participantId: null, reason: 'no participants' }
}

export async function runAutoHandoffForTask(input: {
  roomId: string
  taskId?: string
  fromAgentId?: string
  summary: string
  nextAction: string
  filesChanged?: string[]
  options?: Array<{ id: string; label: string; replyText?: string }>
  requiredCapabilities?: string[]
}): Promise<void> {
  const target = resolveAutoHandoffTarget({
    roomId: input.roomId,
    fromAgentId: input.fromAgentId,
    requiredCapabilities: input.requiredCapabilities,
  })

  await dispatchAutoHandoff({
    roomId: input.roomId,
    taskId: input.taskId,
    fromAgentId: input.fromAgentId,
    toAgentId: target.kind === 'agent' ? target.participantId ?? undefined : undefined,
    toHumanId: target.kind === 'human' ? target.participantId ?? undefined : undefined,
    summary: input.summary,
    nextAction: input.nextAction,
    filesChanged: input.filesChanged,
    options: input.options,
  })
}

export async function dispatchAutoHandoff(input: AutoHandoffInput): Promise<void> {
  const roomId = input.roomId
  const participants = getParticipants(roomId)
  const from = participants.find((p) => p.participant_id === input.fromAgentId)
  const fromName = from?.display_name || input.fromAgentId || 'system'
  const files = input.filesChanged?.length
    ? `\nChanged: ${input.filesChanged.join(', ')}`
    : ''

  if (input.toHumanId) {
    const human = participants.find((p) => p.participant_id === input.toHumanId)
    const mentionName = human?.mention_name || 'human'
    const text = `@${mentionName} ${input.summary}${files ? `\n${files}` : ''}\nNext: ${input.nextAction}`
    const message = insertRoomMessage({
      room_id: roomId,
      sender_kind: 'agent',
      sender_participant_id: input.fromAgentId || 'system',
      sender_name: fromName,
      content: text,
      mentions: [{ type: 'human', participantId: input.toHumanId }],
      mention_depth: 0,
      auto_handoff: 1,
      task_refs: input.taskId ? [input.taskId] : [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: input.taskId || null,
    })

    requestHumanAttention({
      room_id: roomId,
      task_id: input.taskId || null,
      requested_by: input.fromAgentId || 'system',
      target_participant_id: input.toHumanId,
      kind: 'needs_input',
      reason: input.nextAction || input.summary,
      options: input.options ?? [],
      source: 'auto_handoff',
      message_id: message.id,
    })
    return
  }

  if (input.toAgentId) {
    const agent = participants.find((p) => p.participant_id === input.toAgentId)
    const mentionName = agent?.mention_name || input.toAgentId
    const text = `@${mentionName} ${input.summary}${files ? `\n${files}` : ''}\nNext: ${input.nextAction}`
    insertRoomMessage({
      room_id: roomId,
      sender_kind: 'system',
      sender_participant_id: 'system',
      sender_name: 'System',
      content: text,
      mentions: [{ type: 'agent', participantId: input.toAgentId }],
      mention_depth: 0,
      auto_handoff: 1,
      task_refs: input.taskId ? [input.taskId] : [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: input.taskId || null,
    })
    publishChatEvent('auto_handoff', {
      roomId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      taskId: input.taskId,
      summary: input.summary,
    })
    return
  }

  const text = `Pipeline complete. ${input.summary}${files ? `\n${files}` : ''}`
  insertRoomMessage({
    room_id: roomId,
    sender_kind: 'system',
    sender_participant_id: 'system',
    sender_name: 'System',
    content: text,
    mentions: [],
    mention_depth: 0,
    auto_handoff: 0,
    task_refs: input.taskId ? [input.taskId] : [],
    answers_pending_turn_id: null,
    run_id: null,
    task_id: input.taskId || null,
  })
  publishChatEvent('pipeline_complete', {
    roomId,
    taskId: input.taskId,
    summary: input.summary,
  })
}
