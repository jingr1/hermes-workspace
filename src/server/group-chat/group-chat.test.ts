import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'group-chat-test-'))
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
  const mentionRouting = await import('./mention-routing')
  const autoHandoff = await import('./auto-handoff')
  const eventBus = await import('../chat-event-bus')
  return {
    roomStore,
    participants,
    pendingTurns,
    mentionRouting,
    autoHandoff,
    eventBus,
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

describe('group-chat core', () => {
  it('creates and lists rooms', async () => {
    const { roomStore } = await loadModule()
    const room = roomStore.createRoom({ title: 'P4 Test' })
    expect(room.title).toBe('P4 Test')
    const rooms = roomStore.listRooms()
    expect(rooms.some((r) => r.id === room.id)).toBe(true)
  })

  it('adds and lists participants', async () => {
    const { roomStore, participants } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const human = participants.addParticipant(
      room.id,
      {
        kind: 'human',
        participant_id: 'human:owner',
        display_name: 'Owner',
        mention_name: 'me',
        description: null,
        runtime: null,
      },
      { isOwner: true },
    )
    const agent = participants.addParticipant(room.id, {
      kind: 'agent',
      participant_id: 'dev',
      display_name: 'Developer',
      mention_name: 'dev',
      description: null,
      runtime: 'hermes',
    })
    const list = participants.getParticipants(room.id)
    expect(list).toHaveLength(2)
    expect(list.map((p) => p.mention_name)).toContain('me')
    expect(list.map((p) => p.mention_name)).toContain('dev')
    expect(human.is_owner).toBe(1)
    expect(agent.runtime).toBe('hermes')
  })

  it('inserts and lists messages', async () => {
    const { roomStore } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const msg = roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'human',
      sender_participant_id: 'human:owner',
      sender_name: 'Owner',
      content: 'Hello',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: null,
      run_id: null,
      task_id: null,
    })
    expect(msg.room_id).toBe(room.id)
    const messages = roomStore.listRoomMessages(room.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Hello')
  })

  it('parses agent and @all mentions', async () => {
    const { roomStore, participants, mentionRouting } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    participants.addParticipant(room.id, {
      kind: 'agent',
      participant_id: 'dev',
      display_name: 'Developer',
      mention_name: 'dev',
      description: null,
      runtime: 'hermes',
    })
    const parsed = mentionRouting.parseMentions('Hey @dev and @all', [
      ...participants.getParticipants(room.id),
    ])
    expect(parsed.mentions).toHaveLength(2)
    expect(parsed.mentions[0].type).toBe('agent')
    expect(parsed.mentions[1].type).toBe('all')
  })

  it('routes @human to owner participant', async () => {
    const { roomStore, participants, mentionRouting } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    participants.addParticipant(
      room.id,
      {
        kind: 'human',
        participant_id: 'human:owner',
        display_name: 'Owner',
        mention_name: 'me',
        description: null,
        runtime: null,
      },
      { isOwner: true },
    )
    const parsed = mentionRouting.parseMentions('Please @human check this', [], {
      ownerParticipantId: 'human:owner',
    })
    expect(parsed.mentions).toHaveLength(1)
    const m = parsed.mentions[0]
    expect(m.type).toBe('human')
    if (m.type !== 'human') throw new Error('unexpected')
    expect(m.participantId).toBe('human:owner')
  })

  it('creates pending turns and answers them', async () => {
    const { roomStore, pendingTurns } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const turn = pendingTurns.createPendingTurn({
      room_id: room.id,
      requested_by: 'dev',
      target_participant_id: 'human:owner',
      kind: 'needs_input',
      reason: 'Need decision',
      options: [{ id: 'yes', label: 'Yes', replyText: 'Yes, proceed' }],
    })
    expect(turn.status).toBe('pending')

    const msg = roomStore.insertRoomMessage({
      room_id: room.id,
      sender_kind: 'human',
      sender_participant_id: 'human:owner',
      sender_name: 'Owner',
      content: 'Yes, proceed',
      mentions: [],
      mention_depth: 0,
      auto_handoff: 0,
      task_refs: [],
      answers_pending_turn_id: turn.id,
      run_id: null,
      task_id: null,
    })

    const answered = pendingTurns.answerPendingTurn(turn.id, msg.id)
    expect(answered?.status).toBe('answered')
    expect(answered?.answered_message_id).toBe(msg.id)
  })

  it('requests human attention through unified helper', async () => {
    const { roomStore, pendingTurns } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const events: string[] = []
    vi.spyOn((await import('../chat-event-bus')), 'publishChatEvent').mockImplementation((event: string) => {
      events.push(event)
      return undefined as any
    })
    const turn = pendingTurns.requestHumanAttention({
      room_id: room.id,
      requested_by: 'agent:claude',
      target_participant_id: 'human:owner',
      kind: 'blocked',
      reason: 'Which API key should I use?',
      options: [{ id: 'test', label: 'Test key', replyText: 'Use test key' }],
      source: 'checkpoint',
    })
    expect(turn.status).toBe('pending')
    expect(events).toContain('human_attention')
    expect(turn.reason).toBe('Which API key should I use?')
    const list = pendingTurns.getPendingTurns({ roomId: room.id, status: 'pending' })
    expect(list).toHaveLength(1)
  })

  it('expires stale pending turns', async () => {
    const { roomStore, pendingTurns } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const turn = pendingTurns.createPendingTurn({
      room_id: room.id,
      requested_by: 'dev',
      target_participant_id: 'human:owner',
      kind: 'needs_input',
      reason: 'Need decision',
      options: [],
    })
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    const expired = pendingTurns.expireStalePendingTurns()
    expect(expired.some((t) => t.id === turn.id)).toBe(true)
    const fetched = pendingTurns.getPendingTurn(turn.id)
    expect(fetched?.status).toBe('expired')
  })

  it('dispatches auto-handoff to next agent', async () => {
    const { roomStore, participants, autoHandoff } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    participants.addParticipant(room.id, {
      kind: 'agent',
      participant_id: 'reviewer',
      display_name: 'Reviewer',
      mention_name: 'reviewer',
      description: null,
      runtime: 'claude-code',
    })
    const events: string[] = []
    vi.spyOn((await import('../chat-event-bus')), 'publishChatEvent').mockImplementation((event: string) => {
      events.push(event)
      return undefined as any
    })
    await autoHandoff.dispatchAutoHandoff({
      roomId: room.id,
      toAgentId: 'reviewer',
      summary: 'Done',
      nextAction: 'Please review',
      filesChanged: ['src/foo.ts'],
    })
    const messages = roomStore.listRoomMessages(room.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('@reviewer')
    expect(messages[0].auto_handoff).toBe(1)
    expect(events).toContain('auto_handoff')
  })

  it('dispatches auto-handoff to human as pending turn', async () => {
    const { roomStore, participants, autoHandoff, pendingTurns } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    participants.addParticipant(
      room.id,
      {
        kind: 'human',
        participant_id: 'human:owner',
        display_name: 'Owner',
        mention_name: 'me',
        description: null,
        runtime: null,
      },
      { isOwner: true },
    )
    vi.spyOn((await import('../chat-event-bus')), 'publishChatEvent').mockImplementation(() => undefined as any)
    await autoHandoff.dispatchAutoHandoff({
      roomId: room.id,
      toHumanId: 'human:owner',
      summary: 'Blocked',
      nextAction: 'Pick option',
    })
    const turns = pendingTurns.getPendingTurns({ roomId: room.id, status: 'pending' })
    expect(turns).toHaveLength(1)
    expect(turns[0].target_participant_id).toBe('human:owner')
  })

  it('marks pipeline complete when no next recipient', async () => {
    const { roomStore, autoHandoff } = await loadModule()
    const room = roomStore.createRoom({ title: 'Room' })
    const events: string[] = []
    vi.spyOn((await import('../chat-event-bus')), 'publishChatEvent').mockImplementation((event: string) => {
      events.push(event)
      return undefined as any
    })
    await autoHandoff.dispatchAutoHandoff({
      roomId: room.id,
      summary: 'All done',
      nextAction: '',
    })
    const messages = roomStore.listRoomMessages(room.id)
    expect(messages[0].content).toContain('Pipeline complete')
    expect(events).toContain('pipeline_complete')
  })
})
