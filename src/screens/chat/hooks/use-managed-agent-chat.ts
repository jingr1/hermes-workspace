'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  externalChatMessageStorageKey,
  upsertExternalChatSession,
} from '@/lib/external-chat-sessions'
import { useAgentStore } from '@/stores/agent-store'
import {
  PENDING_SESSION_MODEL_KEY,
  useSessionModelStore,
} from '@/stores/session-model-store'
import type { ChatMessage, ChatAttachment } from '../types'

type ComposerAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  dataUrl?: string
  previewUrl?: string
  kind?: 'image' | 'file' | 'audio'
}

type ExternalChatEvent =
  | { type: 'connected'; runId: string; agentId: string; sessionId: string }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'thinking'; runId: string; text: string }
  | {
      type: 'tool'
      runId: string
      phase: 'start' | 'end'
      name: string
      args?: unknown
    }
  | { type: 'run_exited'; runId: string; exitCode: number | null }
  | { type: 'error'; runId: string; message: string }
  | { type: 'heartbeat'; timestamp: number }
  | { type: 'run_started'; runId: string; agentId: string }

function storageKey(agentId: string, sessionId: string): string {
  return externalChatMessageStorageKey(agentId, sessionId)
}

function loadMessages(agentId: string, sessionId: string): Array<ChatMessage> {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(agentId, sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<ChatMessage>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveMessages(
  agentId: string,
  sessionId: string,
  messages: Array<ChatMessage>,
): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      storageKey(agentId, sessionId),
      JSON.stringify(messages),
    )
  } catch {
    // ignore quota errors
  }
}

function clearMessages(agentId: string, sessionId: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(storageKey(agentId, sessionId))
  } catch {
    // ignore
  }
}

function makeUserMessage(
  text: string,
  attachments: Array<ComposerAttachment>,
): ChatMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: attachments.map(
      (att): ChatAttachment => ({
        id: att.id,
        name: att.name,
        contentType: att.contentType,
        size: att.size,
        dataUrl: att.dataUrl,
        previewUrl: att.previewUrl,
      }),
    ),
    timestamp: Date.now(),
  }
}

function makeAssistantMessage(text: string): ChatMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

function parseSSEDataLine(
  line: string,
  eventName: string,
): ExternalChatEvent | null {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null
  const json = trimmed.slice(5).trim()
  if (json === '') return null
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    const type = String(parsed.type ?? eventName ?? '')
    switch (type) {
      case 'connected':
        return {
          type: 'connected',
          runId: String(parsed.runId ?? ''),
          agentId: String(parsed.agentId ?? ''),
          sessionId: String(parsed.sessionId ?? ''),
        }
      case 'text_delta':
        return {
          type: 'text_delta',
          runId: String(parsed.runId ?? ''),
          text: String(parsed.text ?? ''),
        }
      case 'thinking':
        return {
          type: 'thinking',
          runId: String(parsed.runId ?? ''),
          text: String(parsed.text ?? ''),
        }
      case 'tool':
        return {
          type: 'tool',
          runId: String(parsed.runId ?? ''),
          phase: String(parsed.phase ?? '') as 'start' | 'end',
          name: String(parsed.name ?? ''),
          args: parsed.args,
        }
      case 'run_exited':
        return {
          type: 'run_exited',
          runId: String(parsed.runId ?? ''),
          exitCode:
            typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
        }
      case 'error':
        return {
          type: 'error',
          runId: String(parsed.runId ?? ''),
          message: String(parsed.message ?? ''),
        }
      case 'heartbeat':
        return {
          type: 'heartbeat',
          timestamp: Number(parsed.timestamp ?? Date.now()),
        }
      case 'run_started':
        return null
      default:
        return null
    }
  } catch {
    return null
  }
}

export type ManagedAgentChat = {
  activeSessionId: string
  messages: Array<ChatMessage>
  isStreaming: boolean
  error: string | null
  activeTitle: string
  submit: (text: string, attachments: Array<ComposerAttachment>) => Promise<void>
  abort: () => void
  clearMessages: () => void
  startNewSession: () => void
}

/**
 * Managed (non-Hermes) chat transport: localStorage messages + SSE to
 * POST /api/agents/:agentId/chat. Includes the `new-*` → uuid promotion race
 * fix (skipNextSessionLoadRef).
 */
export function useManagedAgentChat({
  agentId,
  sessionId,
  onSessionResolved,
}: {
  agentId: string
  sessionId: string | null
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
}): ManagedAgentChat {
  const [stableNewSessionId] = useState(() => `new-${Date.now()}`)
  const activeSessionId = sessionId ?? stableNewSessionId
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  const upsertSession = useAgentStore((s) => s.upsertSession)

  const [messages, setMessages] = useState<Array<ChatMessage>>(() =>
    loadMessages(agentId, activeSessionId),
  )
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const streamingMessageRef = useRef<ChatMessage | null>(null)
  // When promoting `new-*` → real uuid, keep in-memory messages; a reload from
  // localStorage would drop the streaming assistant bubble and silently eat
  // every text_delta (CLI finishes, UI stays empty).
  const skipNextSessionLoadRef = useRef(false)

  const selectedModel = useSessionModelStore((s) => s.models[activeSessionId])
  const transferModel = useSessionModelStore((s) => s.transferModel)
  const getStoredModel = useSessionModelStore((s) => s.getModel)

  useEffect(() => {
    if (skipNextSessionLoadRef.current) {
      skipNextSessionLoadRef.current = false
      return
    }
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    streamingMessageRef.current = null
    setIsStreaming(false)
    setError(null)
    setMessages(loadMessages(agentId, activeSessionId))
  }, [agentId, activeSessionId])

  useEffect(() => {
    saveMessages(agentId, activeSessionId, messages)
    const session = upsertExternalChatSession({
      agentId,
      sessionId: activeSessionId,
      messages,
    })
    if (session) upsertSession(agentId, session)
  }, [agentId, activeSessionId, messages, upsertSession])

  useEffect(() => {
    if (activeSessionId.startsWith('new-')) return
    onSessionResolved?.({
      sessionKey: activeSessionId,
      friendlyId: activeSessionId,
    })
  }, [activeSessionId, onSessionResolved])

  const historyForPrompt = useMemo(() => {
    return messages
      .filter(
        (m): m is ChatMessage & { role: 'user' | 'assistant' | 'system' } =>
          m.role === 'user' || m.role === 'assistant' || m.role === 'system',
      )
      .map((m) => {
        const textParts = m.content
          ?.map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
          .join('')
        const text = typeof textParts === 'string' ? textParts.trim() : ''
        return { role: m.role, content: text }
      })
      .filter((m) => m.content.length > 0)
      .slice(-20)
  }, [messages])

  const appendStreamingText = useCallback((chunk: string) => {
    setMessages((prev) => {
      let idx = streamingMessageRef.current
        ? prev.indexOf(streamingMessageRef.current)
        : -1
      if (idx < 0) {
        for (let i = prev.length - 1; i >= 0; i -= 1) {
          if (prev[i]?.role === 'assistant') {
            idx = i
            break
          }
        }
      }
      if (idx < 0) {
        const created = makeAssistantMessage(chunk)
        streamingMessageRef.current = created
        return [...prev, created]
      }
      const next = [...prev]
      const current = next[idx]!
      const existing =
        current.content?.[0]?.type === 'text'
          ? (current.content[0].text ?? '')
          : ''
      next[idx] = {
        ...current,
        content: [{ type: 'text', text: existing + chunk }],
      }
      streamingMessageRef.current = next[idx]
      return next
    })
  }, [])

  const finalizeStreamingMessage = useCallback(() => {
    streamingMessageRef.current = null
  }, [])

  const startExternalChat = useCallback(
    async (
      resolvedAgentId: string,
      resolvedSessionId: string,
      text: string,
      history: Array<{ role: string; content: string }>,
      model?: string,
    ) => {
      setIsStreaming(true)
      setError(null)
      const assistantMessage = makeAssistantMessage('')
      streamingMessageRef.current = assistantMessage
      setMessages((prev) => [...prev, assistantMessage])

      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller

      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(resolvedAgentId)}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              sessionId: resolvedSessionId,
              history,
              ...(model ? { model } : {}),
            }),
            signal: controller.signal,
          },
        )

        if (!res.ok) {
          const body = await res.text()
          let parsed: { error?: string } = {}
          try {
            parsed = JSON.parse(body) as { error?: string }
          } catch {
            /* ignore */
          }
          throw new Error(parsed.error || `HTTP ${res.status}`)
        }

        const reader = res.body?.getReader()
        if (!reader) throw new Error('No response stream')

        const decoder = new TextDecoder()
        let buffer = ''
        let currentEventName = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trimEnd()
            if (trimmed.startsWith('event:')) {
              currentEventName = trimmed.slice(6).trim()
              continue
            }
            const event = parseSSEDataLine(trimmed, currentEventName)
            if (!event) continue
            currentEventName = ''
            if (event.type === 'text_delta') {
              appendStreamingText(event.text)
            } else if (event.type === 'thinking') {
              appendStreamingText(`\n[thinking]\n${event.text}\n[/thinking]\n`)
            } else if (event.type === 'tool') {
              appendStreamingText(`\n[tool:${event.name}:${event.phase}]\n`)
            } else if (event.type === 'error') {
              if (event.message.trim()) {
                setError(event.message)
              }
            } else if (event.type === 'run_exited') {
              finalizeStreamingMessage()
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message === 'AbortError' || controller.signal.aborted) return
        setError(message)
        setMessages((prev) => {
          if (!streamingMessageRef.current) return prev
          const idx = prev.indexOf(streamingMessageRef.current)
          if (idx < 0) return prev
          const next = [...prev]
          const current = next[idx]!
          const existingText =
            current.content?.[0]?.type === 'text'
              ? (current.content[0].text ?? '')
              : ''
          next[idx] = {
            ...current,
            content: [{ type: 'text', text: existingText }],
            isError: true,
          }
          return next
        })
      } finally {
        setIsStreaming(false)
        streamingMessageRef.current = null
        abortControllerRef.current = null
      }
    },
    [appendStreamingText, finalizeStreamingMessage],
  )

  const submit = useCallback(
    async (text: string, attachments: Array<ComposerAttachment>) => {
      if (!text.trim() && attachments.length === 0) return
      setError(null)

      const userMessage = makeUserMessage(text, attachments)
      setMessages((prev) => [...prev, userMessage])

      let resolvedSessionId = activeSessionId
      let modelForRun = selectedModel
      if (activeSessionId.startsWith('new-')) {
        resolvedSessionId = crypto.randomUUID()
        skipNextSessionLoadRef.current = true
        setActiveSessionId(resolvedSessionId)
        transferModel(activeSessionId, resolvedSessionId)
        if (!getStoredModel(resolvedSessionId)) {
          transferModel(PENDING_SESSION_MODEL_KEY, resolvedSessionId)
        }
        modelForRun =
          getStoredModel(resolvedSessionId) ||
          getStoredModel(activeSessionId) ||
          selectedModel
        const prior = messages
        saveMessages(agentId, resolvedSessionId, [...prior, userMessage])
        const latestHistory = prior
          .filter(
            (
              m,
            ): m is ChatMessage & {
              role: 'user' | 'assistant' | 'system'
            } =>
              m.role === 'user' ||
              m.role === 'assistant' ||
              m.role === 'system',
          )
          .map((m) => {
            const textParts = m.content
              ?.map((part) =>
                part.type === 'text' ? String(part.text ?? '') : '',
              )
              .join('')
            const content =
              typeof textParts === 'string' ? textParts.trim() : ''
            return { role: m.role, content }
          })
          .filter((m) => m.content.length > 0)
          .slice(-20)
        await startExternalChat(
          agentId,
          resolvedSessionId,
          text,
          latestHistory,
          modelForRun,
        )
        return
      }

      await startExternalChat(
        agentId,
        resolvedSessionId,
        text,
        historyForPrompt,
        modelForRun || getStoredModel(resolvedSessionId),
      )
    },
    [
      agentId,
      activeSessionId,
      getStoredModel,
      historyForPrompt,
      messages,
      selectedModel,
      setActiveSessionId,
      startExternalChat,
      transferModel,
    ],
  )

  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
    setIsStreaming(false)
    streamingMessageRef.current = null
  }, [])

  const clearSessionMessages = useCallback(() => {
    abortControllerRef.current?.abort()
    streamingMessageRef.current = null
    setIsStreaming(false)
    setError(null)
    setMessages([])
    clearMessages(agentId, activeSessionId)
  }, [agentId, activeSessionId])

  const startNewSession = useCallback(() => {
    abortControllerRef.current?.abort()
    streamingMessageRef.current = null
    setIsStreaming(false)
    setError(null)
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const activeTitle = useMemo(() => {
    if (activeSessionId.startsWith('new-')) return 'New Chat'
    const firstUser = messages.find((m) => m.role === 'user')
    const firstText = firstUser?.content?.find(
      (p): p is { type: 'text'; text?: string } => p.type === 'text',
    )
    return firstText?.text?.slice(0, 40) || 'Chat'
  }, [activeSessionId, messages])

  return {
    activeSessionId,
    messages,
    isStreaming,
    error,
    activeTitle,
    submit,
    abort,
    clearMessages: clearSessionMessages,
    startNewSession,
  }
}
