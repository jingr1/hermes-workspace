import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { MemberAvatar } from './components/member-avatar'
import { MemberRoster } from './components/member-roster'
import { MentionPicker } from './components/mention-picker'
import { PendingTurnCard } from './components/pending-turn-card'
import { getMemberColor } from './lib/avatar-utils'
import type {
  PendingTurn,
  Room,
  RoomMessage,
  RoomParticipant,
} from '@/lib/group-chat-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'
import {
  answerPendingTurn,
  addParticipant as apiAddParticipant,
  removeParticipant as apiRemoveParticipant,
  sendMessage as apiSendMessage,
  dismissPendingTurn,
  listAvailableAgents,
  listMessages,
  listParticipants,
  listPendingTurns,
} from '@/lib/group-chat-api'
import { useGroupChatEvents } from '@/lib/use-group-chat-events'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function RoomsScreen() {
  const { roomId } = useParams({ from: '/group-chat/$roomId' })
  const navigate = useNavigate()
  const [activeRoom, setActiveRoom] = useState<Room | null>(null)
  const [messages, setMessages] = useState<Array<RoomMessage>>([])
  const [participants, setParticipants] = useState<Array<RoomParticipant>>([])
  const [pendingTurns, setPendingTurns] = useState<Array<PendingTurn>>([])
  const [input, setInput] = useState('')
  const [availableAgents, setAvailableAgents] = useState<
    Array<{ id: string; displayName: string }>
  >([])
  const [loading, setLoading] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const { events } = useGroupChatEvents(roomId)

  useEffect(() => {
    listAvailableAgents().then((res) => setAvailableAgents(res.agents))
  }, [])

  useEffect(() => {
    if (!roomId) {
      setActiveRoom(null)
      setMessages([])
      setParticipants([])
      setPendingTurns([])
      return
    }
    setLoading(true)
    Promise.all([
      listMessages(roomId),
      listParticipants(roomId),
      listPendingTurns(roomId),
    ])
      .then(([msgRes, partRes, ptRes]) => {
        setActiveRoom(msgRes.room)
        setMessages(msgRes.messages)
        setParticipants(partRes.participants)
        setPendingTurns(ptRes.pendingTurns)
      })
      .finally(() => setLoading(false))
  }, [roomId])

  // Subscribe to server-sent events for this room. We consume only the most
  // recent event per render tick to avoid effect storms.
  const lastEvent = useMemo(() => {
    return events.length > 0 ? events[events.length - 1] : undefined
  }, [events])

  useEffect(() => {
    if (!roomId || !lastEvent) return
    if (
      lastEvent.event === 'group_chat_reply' ||
      lastEvent.event === 'group_chat_message'
    ) {
      listMessages(roomId).then((res) => {
        setMessages(res.messages)
        setActiveRoom(res.room)
      })
    }
    if (
      lastEvent.event === 'group_chat_human_attention' ||
      lastEvent.event === 'group_chat_human_answered' ||
      lastEvent.event === 'group_chat_human_dismissed'
    ) {
      listPendingTurns(roomId).then((res) => setPendingTurns(res.pendingTurns))
    }
    if (lastEvent.event === 'group_chat_turn_started') {
      setStatusText(`• ${String(lastEvent.data.member ?? '')} is thinking...`)
    } else if (lastEvent.event === 'group_chat_settled') {
      setStatusText('Group settled')
    } else if (lastEvent.event === 'group_chat_capped') {
      setStatusText('Cap reached')
    } else if (lastEvent.event === 'group_chat_turn_ended') {
      setStatusText(null)
    }
  }, [lastEvent, roomId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleAddAgent(agentId: string) {
    if (!roomId) return
    await apiAddParticipant(roomId, {
      participantId: agentId,
      kind: 'agent',
    })
    const res = await listParticipants(roomId)
    setParticipants(res.participants)
  }

  async function handleRemoveParticipant(participantId: string) {
    if (!roomId) return
    await apiRemoveParticipant(roomId, participantId)
    const res = await listParticipants(roomId)
    setParticipants(res.participants)
  }

  async function handleSend() {
    if (!roomId || !input.trim()) return
    const content = input.trim()
    setInput('')
    const res = await apiSendMessage(roomId, { content })
    setMessages((prev) => [...prev, res.message])
    setActiveRoom(res.room)
  }

  async function handleAnswerTurn(turnId: string, answerText: string) {
    if (!roomId) return
    const res = await answerPendingTurn(roomId, turnId, { answerText })
    setMessages((prev) => [...prev, res.message])
    setPendingTurns((prev) => prev.filter((t) => t.id !== turnId))
  }

  async function handleDismissTurn(turnId: string) {
    if (!roomId) return
    await dismissPendingTurn(roomId, turnId)
    setPendingTurns((prev) => prev.filter((t) => t.id !== turnId))
  }

  if (!roomId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        Select a room from the sidebar.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col min-w-0 bg-[var(--theme-bg)]">
      {activeRoom ? (
        <>
          <header
            className="px-4 py-3 border-b flex items-center justify-between"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <div className="flex items-center gap-3">
              <div>
                <h1 className="font-semibold">{activeRoom.title}</h1>
                <div className="text-xs opacity-70 flex items-center gap-2">
                  {participants.length} members
                  {statusText && (
                    <span className="text-amber-400">{statusText}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <MemberRoster
                participants={participants}
                onRemove={handleRemoveParticipant}
              />
              <MenuRoot>
                <MenuTrigger type="button" className="inline-flex">
                  <Button size="sm" variant="secondary">
                    + Agent
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {availableAgents.map((agent) => (
                    <MenuItem
                      key={agent.id}
                      onClick={() => handleAddAgent(agent.id)}
                    >
                      {agent.displayName}
                    </MenuItem>
                  ))}
                </MenuContent>
              </MenuRoot>
            </div>
          </header>

          {pendingTurns.length > 0 && (
            <div
              className="px-4 py-3 border-b"
              style={{
                borderColor: 'var(--theme-border)',
                background: 'rgba(245,158,11,0.06)',
              }}
            >
              <div className="text-xs font-semibold uppercase tracking-wider opacity-70 mb-2">
                Human Gate
              </div>
              {pendingTurns.map((turn) => (
                <PendingTurnCard
                  key={turn.id}
                  turn={turn}
                  participants={participants}
                  onAnswer={handleAnswerTurn}
                  onDismiss={handleDismissTurn}
                />
              ))}
            </div>
          )}

          <div className="flex-1 overflow-auto p-4 space-y-4">
            {loading ? (
              <div className="text-muted-foreground">Loading...</div>
            ) : (
              messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  participants={participants}
                />
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <div
            className="p-3 border-t flex gap-2 relative"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <MentionPicker
              value={input}
              onChange={setInput}
              onSubmit={handleSend}
              participants={participants}
              placeholder="Message... Use @name to mention"
              aria-label="Group chat message"
            />
            <Button onClick={handleSend}>Send</Button>
          </div>
        </>
      ) : (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          {loading ? 'Loading...' : 'Room not found.'}
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  message,
  participants,
}: {
  message: RoomMessage
  participants: Array<RoomParticipant>
}) {
  const sender = useMemo(
    () =>
      participants.find(
        (p) => p.participantId === message.senderParticipantId,
      ),
    [participants, message.senderParticipantId],
  )
  const color = sender
    ? getMemberColor(sender.participantId, sender.displayName)
    : message.senderKind === 'system'
      ? '#64748b'
      : '#1A2340'
  const isHuman = message.senderKind === 'human'

  return (
    <div
      className={cn('flex gap-3', isHuman ? 'flex-row-reverse' : 'flex-row')}
    >
      <MemberAvatar
        id={message.senderParticipantId ?? 'system'}
        name={message.senderName}
        kind={message.senderKind}
        status="idle"
        size={36}
      />
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-4 py-2.5 shadow-sm',
          isHuman ? 'rounded-br-md' : 'rounded-bl-md',
        )}
        style={{
          background: isHuman ? '#1A2340' : color + '20',
          color: isHuman ? '#E6EAF2' : 'var(--theme-text)',
          borderLeft: isHuman ? undefined : `4px solid ${color}`,
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold opacity-90">
            {message.senderName}
          </span>
          <span className="text-[10px] opacity-60">
            {formatTime(message.createdAt)}
          </span>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    </div>
  )
}
