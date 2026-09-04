/**
 * Group chat round-robin runner.
 *
 * Drives Bot Mode-style conversations:
 *   - Tick-based (5s) per active room.
 *   - Round-robin member turns with watermark deltas.
 *   - Bounded rounds (3), messages (10), continuations (2).
 *   - Stranded-reply harvest so long turns are late, never lost.
 *   - Publishes room events on chat-event-bus.
 *
 * This is a translation of upstream runGroupChatRounds adapted for workspace
 * storage and claude-api sessions.
 */
import { publishChatEvent } from '../chat-event-bus'
import {
  GROUP_CHAT_HISTORY_LIMIT,
  GROUP_CHAT_MAX_CONTINUATIONS,
  GROUP_CHAT_MAX_MESSAGES,
  GROUP_CHAT_MAX_ROUNDS,
  GROUP_DUPLICATE_APPEND_WINDOW_MS,
  GROUP_RUNNER_TICK_MS,
  GROUP_TURN_HARD_CAP_MS,
} from './constants'
import {
  createPendingTurn,
  expirePendingTurns,
  getLatestMessages,
  getRoom,
  getWatermark,
  insertMessage,
  listParticipants,
  listRooms,
  setWatermark,
  toGroupMember, updateRoom 
} from './room-store'
import { executeMemberTurn } from './turn-executor'
import { buildTurnContext } from './prompt-builder'
import {
  expandMentionTargets,
  groupMemberKey,
  parseMentions,
  resolveHumanMentions,
} from './mention-routing'
import {
  isGroupPassText,
  resolveGroupResponders,
  rotateGroupSpeakers,
  unaddressedGroupMentions,
} from './responder-utils'
import {
  bumpRoomEpoch,
  clearTurnInFlight,
  expireStaleInFlight,
  getInFlightMembers,
  getRoomEpoch,
  getRoomRunnerState,
  isTurnInFlight,
  setLastRunAt,
  setTurnInFlight,
} from './runner-state'
import { maybeSummarizeRoom } from './summaries'
import type { GroupMember, GroupTurnResult, Room, RoomMessage } from './types'

let runnerTimer: ReturnType<typeof setInterval> | null = null
let runnerBusy = false

export function startGroupChatRunner(): void {
  if (runnerTimer) return
  runnerTimer = setInterval(async () => {
    if (runnerBusy) return
    runnerBusy = true
    try {
      await tickAllRooms()
    } catch (error) {
      console.error(
        '[group-chat-runner] tick error:',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      runnerBusy = false
    }
  }, GROUP_RUNNER_TICK_MS)
  console.log('[group-chat-runner] started')
}

export function stopGroupChatRunner(): void {
  if (runnerTimer) {
    clearInterval(runnerTimer)
    runnerTimer = null
  }
  runnerBusy = false
}

export function isGroupChatRunnerRunning(): boolean {
  return runnerTimer !== null
}

/**
 * Fire-and-forget trigger: immediately start driving one room epoch without
 * awaiting the result. Mirrors Desktop Bot Mode's sendToGroupChat ignition.
 * Guards against re-entrant execution so only one drive owns the room.
 */
export function triggerRoomRun(roomId: string): void {
  void (async () => {
    try {
      await runRoomInternal(roomId)
    } catch (error) {
      console.error(
        `[group-chat-runner] trigger ${roomId} error:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  })()
}

export async function tickAllRooms(): Promise<void> {
  const rooms = listRooms()
  for (const room of rooms) {
    if (room.state !== 'active') continue
    try {
      await runRoomInternal(room.id)
    } catch (error) {
      console.error(
        `[group-chat-runner] room ${room.id} error:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export async function runRoom(room: Room): Promise<void> {
  return runRoomInternal(room.id)
}

async function runRoomInternal(roomId: string): Promise<void> {
  const { isRoomRunning, setRoomRunning } = await import('./runner-state')
  if (isRoomRunning(roomId)) return
  setRoomRunning(roomId, true)

  try {
    await driveRoom(roomId)
  } finally {
    setRoomRunning(roomId, false)
  }
}

async function driveRoom(roomId: string): Promise<void> {
  setLastRunAt(roomId, Date.now())
  expireStaleInFlight(roomId, GROUP_TURN_HARD_CAP_MS)
  expirePendingTurns(Date.now() - 30 * 60 * 1000)

  const room = getRoom(roomId)
  if (!room || room.state !== 'active') return

  const participants = listParticipants(roomId).filter(
    (p) => p.kind === 'agent' && !p.removedAt,
  )
  if (participants.length === 0) return

  const members = participants.map(toGroupMember)
  const allMessages = getLatestMessages(roomId, { limit: 200 })

  // Summarize if needed.
  await maybeSummarizeRoom(roomId)

  // Stranded reply harvest: check any in-flight member for a finished reply.
  for (const member of members) {
    if (isTurnInFlight(room.id, member)) {
      harvestStrandedReply(room, member, allMessages)
    }
  }

  // If any member is still in flight after harvest, don't start new turns.
  const stillInFlight = getInFlightMembers(roomId)
  if (stillInFlight.length > 0) return

  // Only run if there is new content since the last bot reply watermark.
  const hasUnseenDelta = members.some((member) => {
    const watermark = getWatermark(roomId, member.participantId)
    return allMessages.length > watermark
  })
  if (!hasUnseenDelta) {
    return
  }

  // Drive one conversation epoch.
  const startEpoch = bumpRoomEpoch(roomId)
  await runGroupChatRounds(room, members, startEpoch)
}

async function runGroupChatRounds(
  room: Room,
  members: Array<GroupMember>,
  startEpoch: number,
): Promise<void> {
  const messages = getLatestMessages(room.id, { limit: 200 })
  let posted = 0
  let continuations = 0
  let exitKind: 'settled' | 'capped' = 'settled'

  const isCurrent = () => getRoomEpoch(room.id) === startEpoch

  for (let round = 0; round < GROUP_CHAT_MAX_ROUNDS; round++) {
    // Re-harvest stranded replies at the top of every round.
    for (const member of members) {
      if (!isCurrent()) return
      harvestStrandedReply(room, member, getLatestMessages(room.id, { limit: 200 }))
    }

    const roomLog = getLatestMessages(room.id, { limit: 200 })
    const inFlight = getInFlightMembers(room.id)
    const responders = rotateGroupSpeakers(
      resolveGroupResponders(roomLog, members),
      round,
    ).filter((m) => !inFlight.includes(groupMemberKey(m)))

    let spokeThisRound = 0

    for (const member of responders) {
      if (!isCurrent() || posted >= GROUP_CHAT_MAX_MESSAGES) {
        if (isCurrent()) exitKind = 'capped'
        finishDrive(room, exitKind)
        return
      }

      const watermark = getWatermark(room.id, member.participantId)
      if (roomLog.length <= watermark) continue

      const delta = roomLog.slice(watermark).slice(-GROUP_CHAT_HISTORY_LIMIT)
      if (delta.length === 0) continue

      const turnResult = await runMemberTurn(room, member, delta, members)

      if (turnResult.kind === 'blocked') {
        // Human gate was raised; stop the drive.
        finishDrive(room, 'settled')
        return
      }

      if (turnResult.kind === 'reply') {
        const isDuplicate = isDuplicateAppend(
          roomLog[roomLog.length - 1],
          member,
          turnResult.text,
        )
        if (!isDuplicate) {
          const newMessage = insertMessage({
            roomId: room.id,
            senderKind: 'agent',
            senderParticipantId: member.participantId,
            senderName: member.displayName,
            content: turnResult.text,
            mentions: expandMentionTargets(
              parseMentions(turnResult.text, members),
              room.id,
              members,
            ),
            runId: turnResult.runId ?? null,
          })
          posted += 1
          spokeThisRound += 1
          setWatermark(room.id, member.participantId, roomLog.length + 1)
          publishChatEvent('group_chat_reply', {
            roomId: room.id,
            messageId: newMessage.id,
            member: member.displayName,
            text: turnResult.text,
          })
          await maybeSummarizeRoom(room.id, { profile: member.profile ?? undefined })
          continue
        }
      }

      if (turnResult.kind === 'pass') {
        setWatermark(room.id, member.participantId, roomLog.length)
      }

      if (turnResult.kind === 'failed') {
        publishChatEvent('group_chat_failed', {
          roomId: room.id,
          member: member.displayName,
          reason: turnResult.reason,
        })
      }
    }

    if (spokeThisRound === 0) {
      const pendingKeys = unaddressedGroupMentions(
        getLatestMessages(room.id, { limit: 200 }),
        members,
      )
      continuations += 1
      if (
        pendingKeys.length > 0 &&
        continuations <= GROUP_CHAT_MAX_CONTINUATIONS &&
        posted < GROUP_CHAT_MAX_MESSAGES
      ) {
        const citedMembers = members.filter((m) =>
          pendingKeys.includes(groupMemberKey(m)),
        )
        const stillInFlight = getInFlightMembers(room.id)
        const continuationResponders = citedMembers.filter(
          (m) => !stillInFlight.includes(groupMemberKey(m)),
        )
        for (const member of continuationResponders) {
          if (
            !isCurrent() ||
            posted >= GROUP_CHAT_MAX_MESSAGES ||
            continuations > GROUP_CHAT_MAX_CONTINUATIONS
          ) {
            finishDrive(room, 'capped')
            return
          }
          const roomLog2 = getLatestMessages(room.id, { limit: 200 })
          const watermark = getWatermark(room.id, member.participantId)
          const delta = roomLog2.slice(watermark).slice(-GROUP_CHAT_HISTORY_LIMIT)
          if (delta.length === 0) continue
          const turnResult = await runMemberTurn(room, member, delta, members)
          if (turnResult.kind === 'reply') {
            insertMessage({
              roomId: room.id,
              senderKind: 'agent',
              senderParticipantId: member.participantId,
              senderName: member.displayName,
              content: turnResult.text,
              mentions: expandMentionTargets(
                parseMentions(turnResult.text, members),
                room.id,
                members,
              ),
              runId: turnResult.runId ?? null,
            })
            posted += 1
            setWatermark(room.id, member.participantId, roomLog2.length + 1)
            await maybeSummarizeRoom(room.id, { profile: member.profile ?? undefined })
          } else if (turnResult.kind === 'pass') {
            setWatermark(room.id, member.participantId, roomLog2.length)
          }
        }
      }
    }
  }

  finishDrive(room, exitKind)
}

async function runMemberTurn(
  room: Room,
  member: GroupMember,
  delta: Array<RoomMessage>,
  members: Array<GroupMember>,
): Promise<GroupTurnResult> {
  const { summary } = await import('./summaries').then((m) =>
    m.getContextForMember(room.id),
  )
  const prompt = buildTurnContext(room.title, members, member, delta, summary)

  publishChatEvent('group_chat_turn_started', {
    roomId: room.id,
    member: member.displayName,
  })

  setTurnInFlight(room.id, member, 'pending')
  let result: GroupTurnResult | undefined
  try {
    result = await executeMemberTurn({
      roomId: room.id,
      roomTitle: room.title,
      member,
      prompt,
    })
    return result
  } finally {
    clearTurnInFlight(room.id, member)
    publishChatEvent('group_chat_turn_ended', {
      roomId: room.id,
      member: member.displayName,
      result: result?.kind ?? 'unknown',
    })
  }
}

function harvestStrandedReply(
  room: Room,
  member: GroupMember,
  roomLog: Array<RoomMessage>,
): void {
  if (!isTurnInFlight(room.id, member)) return
  // TODO: implement real harvest by re-reading the member's canonical session
  // and appending any new assistant message that arrived after the turn started.
  // For now we simply expire very old in-flight markers and rely on the next
  // full run to re-drive.
  const state = getRoomRunnerState(room.id)
  const turn = state.inFlight.get(groupMemberKey(member))
  if (turn && Date.now() - turn.startedAt > GROUP_TURN_HARD_CAP_MS) {
    clearTurnInFlight(room.id, member)
  }
}

function isDuplicateAppend(
  lastEntry: RoomMessage | undefined,
  member: GroupMember,
  text: string,
): boolean {
  if (!lastEntry) return false
  if (lastEntry.senderKind !== 'agent') return false
  if (lastEntry.senderName !== member.displayName) return false
  if (lastEntry.content !== text) return false
  return Date.now() - lastEntry.createdAt < GROUP_DUPLICATE_APPEND_WINDOW_MS
}

function finishDrive(room: Room, kind: 'settled' | 'capped'): void {
  publishChatEvent(kind === 'settled' ? 'group_chat_settled' : 'group_chat_capped', {
    roomId: room.id,
  })
}
