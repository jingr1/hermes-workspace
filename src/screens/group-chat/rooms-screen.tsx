'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import type { PendingTurn, Participant, Room, RoomMessage } from '@/lib/rooms-api'
import {
  addRoomParticipant,
  createRoom,
  dismissPendingTurn,
  fetchPendingTurns,
  fetchRoomDetail,
  fetchRooms,
  sendRoomMessage,
} from '@/lib/rooms-api'
import { useCollabStream } from '@/hooks/use-collab-stream'
import type { AgentStatus } from '@/lib/mission-control-api'
import { fetchAgentStatuses } from '@/lib/mission-control-api'

export function RoomsScreen() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/rooms' })
  const roomId = typeof search.roomId === 'string' ? search.roomId : null
  const highlightMessageId = typeof search.messageId === 'string' ? search.messageId : null

  const [rooms, setRooms] = useState<Room[]>([])
  const [roomPendingCounts, setRoomPendingCounts] = useState<Record<string, number>>({})
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)

  const [showAddAgent, setShowAddAgent] = useState(false)
  const [availableAgents, setAvailableAgents] = useState<AgentStatus[]>([])
  const [addAgentLoading, setAddAgentLoading] = useState(false)
  const [addAgentError, setAddAgentError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const [mentionState, setMentionState] = useState<{
    open: boolean
    query: string
    items: Participant[]
    index: number
    replaceStart: number
    replaceEnd: number
  }>({ open: false, query: '', items: [], index: 0, replaceStart: 0, replaceEnd: 0 })

  const refreshPendingCounts = async () => {
    try {
      const turns = await fetchPendingTurns({ status: 'pending' })
      const counts: Record<string, number> = {}
      for (const t of turns) {
        counts[t.room_id] = (counts[t.room_id] || 0) + 1
      }
      setRoomPendingCounts(counts)
    } catch {}
  }

  useEffect(() => {
    setLoading(true)
    fetchRooms()
      .then(setRooms)
      .finally(() => setLoading(false))
    refreshPendingCounts()
  }, [])

  useEffect(() => {
    if (!roomId) return
    let cancelled = false
    fetchRoomDetail(roomId)
      .then((detail) => {
        if (cancelled) return
        setSelectedRoom(detail.room)
        setMessages(detail.messages)
        setParticipants(detail.participants)
      })
      .catch(() => {})
    fetchPendingTurns({ roomId, status: 'pending' }).then(setPendingTurns)
    return () => {
      cancelled = true
    }
  }, [roomId])

  useCollabStream({
    scope: 'global',
    onEvent: (evt) => {
      if (evt.event === 'room_message' && evt.data.roomId === roomId) {
        if (!roomId) return
        fetchRoomDetail(roomId).then((detail) => {
          setMessages(detail.messages)
          setParticipants(detail.participants)
        })
        fetchPendingTurns({ roomId, status: 'pending' }).then(setPendingTurns)
        refreshPendingCounts()
      }
      if (
        evt.event === 'pending_turn_answered' ||
        evt.event === 'pending_turn_dismissed' ||
        evt.event === 'human_attention'
      ) {
        if (!roomId) return
        fetchPendingTurns({ roomId, status: 'pending' }).then(setPendingTurns)
        refreshPendingCounts()
      }
    },
  })

  useEffect(() => {
    if (!highlightMessageId || !messages.length) return
    const el = document.getElementById(`msg-${highlightMessageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlightMessageId, messages])

  const humans = useMemo(
    () => participants.filter((p) => p.kind === 'human'),
    [participants],
  )
  const agents = useMemo(
    () => participants.filter((p) => p.kind === 'agent'),
    [participants],
  )

  const handleCreate = async () => {
    const title = window.prompt('Room name?')
    if (!title) return
    const room = await createRoom({ title })
    setRooms((prev) => [room, ...prev])
    void navigate({ to: '/rooms', search: { roomId: room.id } })
  }

  const handleSend = async () => {
    if (!roomId || !draft.trim()) return
    const owner = humans.find((p) => p.is_owner) ?? humans[0]
    await sendRoomMessage(roomId, draft, {
      fromParticipantId: owner?.participant_id ?? 'human:owner',
      fromName: owner?.display_name ?? 'Human',
      senderKind: 'human',
    })
    setDraft('')
    setMentionState((s) => ({ ...s, open: false }))
    const detail = await fetchRoomDetail(roomId)
    setMessages(detail.messages)
    setParticipants(detail.participants)
    setPendingTurns(await fetchPendingTurns({ roomId, status: 'pending' }))
  }

  const openAddAgent = async () => {
    setShowAddAgent(true)
    setAddAgentError(null)
    try {
      const data = await fetchAgentStatuses()
      const existing = new Set(participants.map((p) => p.participant_id))
      setAvailableAgents(data.agents.filter((a) => !existing.has(a.agentId)))
    } catch (err) {
      setAddAgentError(err instanceof Error ? err.message : 'Failed to load agents')
      setAvailableAgents([])
    }
  }

  const handleAddAgent = async (agent: AgentStatus) => {
    if (!roomId) return
    setAddAgentLoading(true)
    setAddAgentError(null)
    try {
      await addRoomParticipant(roomId, {
        kind: 'agent',
        participantId: agent.agentId,
        displayName: agent.displayName || agent.agentId,
        mentionName: agent.agentId,
        description: null,
        runtime: agent.runtime,
      })
      await sendRoomMessage(roomId, `@agent:${agent.agentId} joined the room.`, {
        fromParticipantId: 'system',
        fromName: 'System',
        senderKind: 'system',
      })
      const detail = await fetchRoomDetail(roomId)
      setParticipants(detail.participants)
      setMessages(detail.messages)
      setShowAddAgent(false)
    } catch (err) {
      setAddAgentError(err instanceof Error ? err.message : 'Failed to add agent')
    } finally {
      setAddAgentLoading(false)
    }
  }

  const updateMentionSuggestions = (value: string, cursor: number) => {
    const before = value.slice(0, cursor)
    const match = before.match(/@([a-zA-Z0-9:_-]*)$/)
    if (!match) {
      setMentionState((s) => ({ ...s, open: false }))
      return
    }
    const query = match[1].toLowerCase()
    const replaceStart = cursor - match[0].length
    const items = participants.filter((p) => {
      if (p.kind !== 'agent') return false
      const hay = `${p.display_name} ${p.mention_name} ${p.participant_id}`.toLowerCase()
      return hay.includes(query)
    })
    setMentionState({
      open: items.length > 0,
      query,
      items,
      index: 0,
      replaceStart,
      replaceEnd: cursor,
    })
  }

  const insertMention = (participant: Participant) => {
    const input = inputRef.current
    if (!input) return
    const value = draft
    const before = value.slice(0, mentionState.replaceStart)
    const after = value.slice(mentionState.replaceEnd)
    const replacement = `@${participant.mention_name} `
    const next = `${before}${replacement}${after}`
    setDraft(next)
    setMentionState((s) => ({ ...s, open: false }))
    requestAnimationFrame(() => {
      const pos = mentionState.replaceStart + replacement.length
      input.focus()
      input.setSelectionRange(pos, pos)
    })
  }

  const handleInputChange = (value: string) => {
    setDraft(value)
    const input = inputRef.current
    updateMentionSuggestions(value, input?.selectionStart ?? value.length)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!mentionState.open) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSend()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setMentionState((s) => ({
        ...s,
        index: (s.index + 1) % s.items.length,
      }))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMentionState((s) => ({
        ...s,
        index: (s.index - 1 + s.items.length) % s.items.length,
      }))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const item = mentionState.items[mentionState.index]
      if (item) insertMention(item)
    } else if (e.key === 'Escape') {
      setMentionState((s) => ({ ...s, open: false }))
    }
  }

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r border-[var(--theme-border)] bg-[var(--theme-card)] flex flex-col">
        <div className="p-3 border-b border-[var(--theme-border)] flex items-center justify-between">
          <h1 className="font-semibold">Rooms</h1>
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="text-xs px-2 py-1 rounded bg-[var(--theme-accent)] text-white"
          >
            New
          </button>
        </div>
        {loading ? (
          <div className="p-3 text-sm text-[var(--theme-text-muted)]">Loading…</div>
        ) : (
          <div className="flex-1 overflow-auto">
            {rooms
              .slice()
              .sort((a, b) => {
                const awaitingA = (roomPendingCounts[a.id] || 0) > 0 ? 1 : 0
                const awaitingB = (roomPendingCounts[b.id] || 0) > 0 ? 1 : 0
                if (awaitingA !== awaitingB) return awaitingB - awaitingA
                return b.updated_at - a.updated_at
              })
              .map((room) => {
                const pendingCount = roomPendingCounts[room.id] || 0
                return (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() =>
                      void navigate({ to: '/rooms', search: { roomId: room.id } })
                    }
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm hover:bg-[var(--theme-hover)] flex items-center justify-between',
                      room.id === roomId && 'bg-[var(--theme-active)]',
                    )}
                  >
                    <span className="truncate">{room.title || room.id}</span>
                    {pendingCount > 0 && (
                      <span className="ml-2 flex h-2 w-2 rounded-full bg-red-500" />
                    )}
                  </button>
                )
              })}
          </div>
        )}
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {selectedRoom ? (
          <>
            <header className="px-4 py-3 border-b border-[var(--theme-border)] flex items-center justify-between">
              <div>
                <h2 className="font-medium">{selectedRoom.title || selectedRoom.id}</h2>
                <div className="text-xs text-[var(--theme-text-muted)]">
                  {humans.length} human{humans.length === 1 ? '' : 's'} · {agents.length}{' '}
                  agent{agents.length === 1 ? '' : 's'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void openAddAgent()}
                className="text-xs px-2 py-1 rounded bg-[var(--theme-accent)] text-white"
              >
                Add agent
              </button>
            </header>

            {showAddAgent && (
              <section className="px-4 py-3 border-b border-[var(--theme-border)] bg-[var(--theme-hover)]">
                <div className="text-xs font-medium mb-2">Add an agent to this room</div>
                {addAgentError && (
                  <div className="text-xs text-red-500 mb-2">{addAgentError}</div>
                )}
                {availableAgents.length === 0 && !addAgentLoading && !addAgentError ? (
                  <div className="text-xs text-[var(--theme-text-muted)]">
                    No available agents to add.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {availableAgents.map((agent) => (
                      <button
                        key={agent.agentId}
                        type="button"
                        disabled={addAgentLoading}
                        onClick={() => void handleAddAgent(agent)}
                        className="text-xs px-2 py-1 rounded bg-[var(--theme-card)] border border-[var(--theme-border)] hover:bg-[var(--theme-active)] disabled:opacity-50"
                      >
                        {agent.displayName || agent.agentId}
                        {agent.online ? ' · online' : ' · offline'}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddAgent(false)
                      setAddAgentError(null)
                    }}
                    className="text-xs text-[var(--theme-text-muted)]"
                  >
                    Cancel
                  </button>
                </div>
              </section>
            )}

            {pendingTurns.length > 0 && (
              <section className="px-4 py-2 border-b border-[var(--theme-border)] bg-[var(--theme-hover)]">
                <div className="text-xs font-medium mb-2">Pending turns</div>
                {pendingTurns.map((turn) => (
                  <div
                    key={turn.id}
                    className="flex items-start gap-2 text-xs py-1"
                  >
                    <span className="text-[var(--theme-text-muted)]">
                      {turn.reason || turn.kind}
                    </span>
                    <div className="flex gap-1 ml-auto">
                      {turn.options.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() =>
                            void handleAnswer(turn.id, opt.replyText ?? opt.label, roomId!)
                          }
                          className="px-1.5 py-0.5 rounded bg-[var(--theme-card)] border border-[var(--theme-border)]"
                        >
                          {opt.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => void handleDismiss(turn.id)}
                        className="px-1.5 py-0.5 rounded text-[var(--theme-text-muted)]"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={cn(
                    'text-sm scroll-mt-4',
                    msg.sender_kind === 'system' && 'opacity-70 italic',
                    msg.id === highlightMessageId && 'bg-yellow-500/10 rounded -mx-2 px-2',
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-[var(--theme-accent)]">
                      {msg.sender_name || msg.sender_kind}
                    </span>
                    <span className="text-[10px] text-[var(--theme-text-muted)]">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap text-[var(--theme-text)]">
                    {msg.content}
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-[var(--theme-border)] flex gap-2 relative">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onClick={() =>
                  inputRef.current &&
                  updateMentionSuggestions(draft, inputRef.current.selectionStart ?? draft.length)
                }
                placeholder="Type @name to mention…"
                className="flex-1 bg-[var(--theme-card)] border border-[var(--theme-border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--theme-accent)]"
              />
              {mentionState.open && mentionState.items.length > 0 && (
                <div className="absolute left-3 right-[72px] bottom-full mb-1 max-h-40 overflow-auto rounded border border-[var(--theme-border)] bg-[var(--theme-card)] shadow-sm">
                  {mentionState.items.map((p, idx) => (
                    <button
                      key={p.participant_id}
                      type="button"
                      onClick={() => insertMention(p)}
                      className={cn(
                        'w-full text-left px-3 py-2 text-sm hover:bg-[var(--theme-hover)]',
                        idx === mentionState.index && 'bg-[var(--theme-active)]',
                      )}
                    >
                      <span className="font-medium">{p.display_name}</span>
                      <span className="ml-2 text-[var(--theme-text-muted)]">@{p.mention_name}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => void handleSend()}
                className="px-3 py-2 rounded bg-[var(--theme-accent)] text-white text-sm"
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--theme-text-muted)]">
            Select or create a room to start chatting.
          </div>
        )}
      </main>
    </div>
  )

  async function handleAnswer(turnId: string, text: string, roomIdValue: string) {
    await sendRoomMessage(roomIdValue, text, {
      fromParticipantId: humans[0]?.participant_id ?? 'human:owner',
      fromName: humans[0]?.display_name ?? 'Human',
      senderKind: 'human',
      answersPendingTurnId: turnId,
    })
    await fetch(`/api/pending-turns/${turnId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, roomId: roomIdValue }),
    })
    if (roomId) {
      setMessages((await fetchRoomDetail(roomIdValue)).messages)
      setPendingTurns(await fetchPendingTurns({ roomId: roomIdValue, status: 'pending' }))
    }
  }

  async function handleDismiss(turnId: string) {
    await dismissPendingTurn(turnId)
    if (roomId) {
      setPendingTurns(await fetchPendingTurns({ roomId, status: 'pending' }))
    }
  }
}
