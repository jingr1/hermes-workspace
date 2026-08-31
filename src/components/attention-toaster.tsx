'use client'

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useCollabStream } from '@/hooks/use-collab-stream'
import { toast } from '@/components/ui/toast'
import type { PendingTurn } from '@/lib/rooms-api'
import { fetchPendingTurns } from '@/lib/rooms-api'

type AttentionToast = {
  pendingTurnId: string
  roomId: string
  messageId?: string | null
  requestedBy: string
  kind: string
  reason: string
}

export function AttentionToaster() {
  const navigate = useNavigate()
  const [pending, setPending] = useState<Record<string, AttentionToast>>({})
  const toastedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    fetchPendingTurns({ status: 'pending' })
      .then((turns) => {
        const map: Record<string, AttentionToast> = {}
        for (const t of turns) {
          map[t.id] = {
            pendingTurnId: t.id,
            roomId: t.room_id,
            messageId: t.message_id,
            requestedBy: t.requested_by,
            kind: t.kind,
            reason: t.reason || `${t.kind} needs attention`,
          }
        }
        setPending(map)
      })
      .catch(() => {})
  }, [])

  useCollabStream({
    scope: 'global',
    onEvent: (evt) => {
      if (evt.event === 'human_attention') {
        const data = evt.data as {
          roomId: string
          pendingTurnId: string
          requestedBy?: string
          kind?: string
          reason?: string
          messageId?: string | null
        }
        const toastId = data.pendingTurnId
        setPending((prev) => ({
          ...prev,
          [toastId]: {
            pendingTurnId: data.pendingTurnId,
            roomId: data.roomId,
            messageId: data.messageId ?? null,
            requestedBy: data.requestedBy || 'agent',
            kind: data.kind || 'needs_input',
            reason: data.reason || 'Needs your input',
          },
        }))
      }
      if (
        evt.event === 'pending_turn_answered' ||
        evt.event === 'pending_turn_dismissed'
      ) {
        const data = evt.data as { pendingTurnId: string }
        setPending((prev) => {
          const next = { ...prev }
          delete next[data.pendingTurnId]
          return next
        })
        toastedRef.current.delete(data.pendingTurnId)
      }
    },
  })

  useEffect(() => {
    for (const toastItem of Object.values(pending)) {
      if (toastedRef.current.has(toastItem.pendingTurnId)) continue
      toastedRef.current.add(toastItem.pendingTurnId)
      const roomId = toastItem.roomId
      toast(`${toastItem.requestedBy}: ${toastItem.reason}`.slice(0, 140), {
        type: 'warning',
        duration: 30 * 60 * 1000,
        position: 'bottom-right',
        icon: '⏸️',
        onClick: () => {
          const search: Record<string, string> = { roomId }
          if (toastItem.messageId) search.messageId = toastItem.messageId
          void navigate({ to: '/rooms', search })
        },
      })
    }
  }, [pending, navigate])

  return null
}
