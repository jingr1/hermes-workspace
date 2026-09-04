/**
 * Runner state tracking for group chat.
 *
 * Tracks in-flight turns, room epochs, and stranded replies so the runner can
 * avoid double-dispatching a member and can harvest late replies safely.
 */
import { groupMemberKey } from './mention-routing'
import type { GroupMember } from './types'

type MemberTurnState = {
  startedAt: number
  sessionId: string
  memberKey: string
}

type RoomRunnerState = {
  epoch: number
  inFlight: Map<string, MemberTurnState>
  lastRunAt: number
  running: boolean
}

const STATE_KEY = '__group_chat_runner_state__'

function getState(): Map<string, RoomRunnerState> {
  const g = globalThis as Record<string, unknown>
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = new Map<string, RoomRunnerState>()
  }
  return g[STATE_KEY] as Map<string, RoomRunnerState>
}

export function getRoomRunnerState(roomId: string): RoomRunnerState {
  const state = getState()
  if (!state.has(roomId)) {
    state.set(roomId, {
      epoch: 0,
      inFlight: new Map(),
      lastRunAt: 0,
      running: false,
    })
  }
  return state.get(roomId)!
}

export function bumpRoomEpoch(roomId: string): number {
  const rs = getRoomRunnerState(roomId)
  rs.epoch += 1
  return rs.epoch
}

export function getRoomEpoch(roomId: string): number {
  return getRoomRunnerState(roomId).epoch
}

export function isRoomRunning(roomId: string): boolean {
  return getRoomRunnerState(roomId).running
}

export function setRoomRunning(roomId: string, running: boolean): void {
  getRoomRunnerState(roomId).running = running
}

export function setTurnInFlight(
  roomId: string,
  member: GroupMember,
  sessionId: string,
): void {
  const rs = getRoomRunnerState(roomId)
  rs.inFlight.set(groupMemberKey(member), {
    startedAt: Date.now(),
    sessionId,
    memberKey: groupMemberKey(member),
  })
}

export function clearTurnInFlight(
  roomId: string,
  member: GroupMember,
): void {
  const rs = getRoomRunnerState(roomId)
  rs.inFlight.delete(groupMemberKey(member))
}

export function isTurnInFlight(
  roomId: string,
  member: GroupMember,
): boolean {
  const rs = getRoomRunnerState(roomId)
  return rs.inFlight.has(groupMemberKey(member))
}

export function getInFlightMembers(roomId: string): Array<string> {
  return [...getRoomRunnerState(roomId).inFlight.keys()]
}

export function setLastRunAt(roomId: string, at: number): void {
  getRoomRunnerState(roomId).lastRunAt = at
}

export function getLastRunAt(roomId: string): number {
  return getRoomRunnerState(roomId).lastRunAt
}

/**
 * Remove in-flight turns that have exceeded the hard cap.
 */
export function expireStaleInFlight(
  roomId: string,
  hardCapMs: number,
): Array<string> {
  const rs = getRoomRunnerState(roomId)
  const now = Date.now()
  const expired: Array<string> = []
  for (const [key, turn] of rs.inFlight.entries()) {
    if (now - turn.startedAt > hardCapMs) {
      rs.inFlight.delete(key)
      expired.push(key)
    }
  }
  return expired
}
