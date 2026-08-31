import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'room-runner-test-'))
  vi.doMock('../claude-paths', () => ({
    getClaudeRoot: () => tempRoot,
    getHermesRoot: () => tempRoot,
    getLocalBinDir: () => join(tempRoot, '.local', 'bin'),
    getWorkspaceHermesHome: () => tempRoot,
    getProfileHermesHome: (id: string) => join(tempRoot, 'profiles', id),
  }))
  const roomStore = await import('./room-store')
  const participants = await import('./participants')
  const pendingTurns = await import('./pending-turns')
  const roomSummaries = await import('./room-summaries')
  const contextProjection = await import('./context-projection')
  const roomRunner = await import('./room-runner')
  return {
    roomStore,
    participants,
    pendingTurns,
    roomSummaries,
    contextProjection,
    roomRunner,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('../claude-paths')
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
})

describe('room-runner / context-projection', () => {
  it('builds context from messages and summary', async () => {
    const { roomStore, roomSummaries, contextProjection } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const msg1 = roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'human',
      sender_participant_id: 'human:owner',
      sender_name: 'Owner',
      content: 'Plan the API.',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: null,
    })
    roomSummaries.generateSummaryFromRoom(room.id)
    vi.advanceTimersByTime(1000)
    roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'agent',
      sender_participant_id: 'dev',
      sender_name: 'Dev',
      content: 'Started implementation.',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: null,
    })

    const ctx = contextProjection.buildRoomContext(room.id)
    expect(ctx.summary).toContain('Plan the API')
    expect(ctx.tail.some((m) => m.content === 'Started implementation.')).toBe(true)
    expect(ctx.totalMessages).toBe(2)
  })

  it('archival coordinate: context only reads after summary through_at', async () => {
    const { roomStore, roomSummaries, contextProjection } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'human',
      sender_participant_id: 'human:owner',
      sender_name: 'Owner',
      content: 'Old message',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: null,
    })
    roomSummaries.generateSummaryFromRoom(room.id)

    const ctx = contextProjection.buildRoomContext(room.id)
    expect(ctx.tail).toHaveLength(0)
    expect(ctx.summary).toContain('Old message')
  })

  it('room runner creates pending turn for @agent mentions', async () => {
    const { roomStore, participants, pendingTurns, roomRunner } = await loadModule()
    const room = roomStore.createRoom({ title: 'Runner Room' })
    participants.addParticipant(room.id, {
      kind: 'human',
      participant_id: 'human:owner',
      display_name: 'Owner',
      mention_name: 'owner',
      description: null,
      runtime: null,
    })
    // Add a managed agent participant (without registry it will still create pending turn for human fallback).
    participants.addParticipant(room.id, {
      kind: 'agent',
      participant_id: 'dev',
      display_name: 'Developer',
      mention_name: 'dev',
      description: null,
      runtime: 'claude-code',
    })
    roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'human',
      sender_participant_id: 'human:owner',
      sender_name: 'Owner',
      content: '@agent:dev please fix this',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: null,
    })

    await roomRunner.tickRoomRunner({ maxPendingPerTick: 10, tickIntervalMs: 0 })
    const open = pendingTurns.getPendingTurns({ roomId: room.id, status: 'pending' })
    expect(open.length).toBeGreaterThan(0)
  })

  it('room runner does not create duplicate pending turns', async () => {
    const { roomStore, participants, pendingTurns, roomRunner } = await loadModule()
    const room = roomStore.createRoom({ title: 'Runner Room' })
    participants.addParticipant(room.id, {
      kind: 'human',
      participant_id: 'human:owner',
      display_name: 'Owner',
      mention_name: 'owner',
      description: null,
      runtime: null,
    })
    roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'human',
      sender_participant_id: 'human:owner',
      sender_name: 'Owner',
      content: '@agent:dev please fix this',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: null,
    })

    await roomRunner.tickRoomRunner({ maxPendingPerTick: 10, tickIntervalMs: 0 })
    const first = pendingTurns.getPendingTurns({ roomId: room.id, status: 'pending' }).length
    await roomRunner.tickRoomRunner({ maxPendingPerTick: 10, tickIntervalMs: 0 })
    const second = pendingTurns.getPendingTurns({ roomId: room.id, status: 'pending' }).length
    expect(second).toBe(first)
  })
})
