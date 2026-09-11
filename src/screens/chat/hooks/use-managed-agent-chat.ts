'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearManagedSessionMessages,
  fetchManagedSessionDetail,
  fetchSessionsForAgent,
} from '@/lib/agent-api'
import { useAgentStore } from '@/stores/agent-store'
import {
  PENDING_SESSION_MODEL_KEY,
  useSessionModelStore,
} from '@/stores/session-model-store'
import { writeLastSession } from '../last-session'
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
  | { type: 'native_session'; runId: string; sessionId: string }

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

function toChatMessages(
  rows: Array<{
    role: string
    content: unknown
    isError?: boolean
    timestamp?: number
  }>,
): Array<ChatMessage> {
  return rows.map((row) => ({
    role: row.role,
    content: Array.isArray(row.content)
      ? (row.content as ChatMessage['content'])
      : [{ type: 'text', text: String(row.content ?? '') }],
    ...(row.isError ? { isError: true } : {}),
    timestamp: row.timestamp,
  }))
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
      case 'native_session':
        return {
          type: 'native_session',
          runId: String(parsed.runId ?? ''),
          sessionId: String(parsed.sessionId ?? ''),
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
  /** Live tool calls for ThinkingBubble — not written into the message bubble. */
  activeToolCalls: Array<{ id: string; name: string; phase: string; args?: unknown }>
  error: string | null
  activeTitle: string
  submit: (
    text: string,
    attachments: Array<ComposerAttachment>,
    options?: { effort?: string },
  ) => Promise<void>
  abort: () => void
  clearMessages: () => void
  startNewSession: () => void
}

/**
 * Managed (non-Hermes) chat: SQLite transcript on the server + Claude
 * --resume. UI is display + SSE; history is not replayed into the prompt.
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
  const setSessions = useAgentStore((s) => s.setSessions)

  const [messages, setMessages] = useState<Array<ChatMessage>>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeToolCalls, setActiveToolCalls] = useState<
    Array<{ id: string; name: string; phase: string; args?: unknown }>
  >([])
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const streamingMessageRef = useRef<ChatMessage | null>(null)
  // When promoting `new-*` → real uuid, keep in-memory messages; a reload
  // would drop the streaming assistant bubble.
  const skipNextSessionLoadRef = useRef(false)
  const loadGenerationRef = useRef(0)

  const selectedModel = useSessionModelStore((s) => s.models[activeSessionId])
  const transferModel = useSessionModelStore((s) => s.transferModel)
  const getStoredModel = useSessionModelStore((s) => s.getModel)

  const refreshSessionList = useCallback(async () => {
    try {
      const data = await fetchSessionsForAgent(agentId)
      setSessions(agentId, data.sessions)
    } catch {
      // ignore — sidebar can retry
    }
  }, [agentId, setSessions])

  useEffect(() => {
    if (skipNextSessionLoadRef.current) {
      skipNextSessionLoadRef.current = false
      return
    }
    // Detach UI stream only — server keeps the managed run alive.
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeRunIdRef.current = null
    streamingMessageRef.current = null
    setIsStreaming(false)
    setActiveToolCalls([])
    setError(null)

    if (activeSessionId.startsWith('new-')) {
      setMessages([])
      return
    }

    const generation = ++loadGenerationRef.current
    setMessages([])
    void fetchManagedSessionDetail(agentId, activeSessionId)
      .then((detail) => {
        if (loadGenerationRef.current !== generation) return
        setMessages(toChatMessages(detail.messages))
        upsertSession(agentId, detail.session)
      })
      .catch(() => {
        if (loadGenerationRef.current !== generation) return
        setMessages([])
      })
  }, [agentId, activeSessionId, upsertSession])

  useEffect(() => {
    if (activeSessionId.startsWith('new-')) return
    onSessionResolved?.({
      sessionKey: activeSessionId,
      friendlyId: activeSessionId,
    })
  }, [activeSessionId, onSessionResolved])

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
      model?: string,
      effort?: string,
    ) => {
      setIsStreaming(true)
      setActiveToolCalls([])
      setError(null)
      const assistantMessage = makeAssistantMessage('')
      streamingMessageRef.current = assistantMessage
      setMessages((prev) => [...prev, assistantMessage])

      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller
      activeRunIdRef.current = null

      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(resolvedAgentId)}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              sessionId: resolvedSessionId,
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
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
            if (event.type === 'connected') {
              activeRunIdRef.current = event.runId
            } else if (event.type === 'text_delta') {
              appendStreamingText(event.text)
            } else if (event.type === 'thinking') {
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
                if (idx < 0) return prev
                const next = [...prev]
                const current = next[idx]!
                next[idx] = {
                  ...current,
                  __streamingThinking: event.text,
                }
                streamingMessageRef.current = next[idx]
                return next
              })
            } else if (event.type === 'tool') {
              setActiveToolCalls((prev) => {
                if (event.phase === 'start') {
                  return [
                    ...prev,
                    {
                      id: `${event.name}-${Date.now()}-${prev.length}`,
                      name: event.name,
                      phase: 'running',
                      args: event.args,
                    },
                  ]
                }
                const idx = prev.findIndex(
                  (t) => t.name === event.name && t.phase === 'running',
                )
                if (idx < 0) return prev
                const next = [...prev]
                next[idx] = { ...next[idx]!, phase: 'done' }
                return next
              })
            } else if (event.type === 'error') {
              if (event.message.trim()) {
                setError(event.message)
              }
            } else if (event.type === 'run_exited') {
              setActiveToolCalls([])
              finalizeStreamingMessage()
              activeRunIdRef.current = null
              void refreshSessionList()
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
        setActiveToolCalls([])
        streamingMessageRef.current = null
        abortControllerRef.current = null
      }
    },
    [appendStreamingText, finalizeStreamingMessage, refreshSessionList],
  )

  const submit = useCallback(
    async (
      text: string,
      attachments: Array<ComposerAttachment>,
      options?: { effort?: string },
    ) => {
      if (!text.trim() && attachments.length === 0) return
      setError(null)

      const userMessage = makeUserMessage(text, attachments)
      setMessages((prev) => [...prev, userMessage])
      const effortForRun = options?.effort?.trim() || undefined

      let resolvedSessionId = activeSessionId
      let modelForRun = selectedModel
      if (activeSessionId.startsWith('new-')) {
        resolvedSessionId = crypto.randomUUID()
        skipNextSessionLoadRef.current = true
        setActiveSessionId(resolvedSessionId)
        writeLastSession(resolvedSessionId, agentId)
        transferModel(activeSessionId, resolvedSessionId)
        if (!getStoredModel(resolvedSessionId)) {
          transferModel(PENDING_SESSION_MODEL_KEY, resolvedSessionId)
        }
        modelForRun =
          getStoredModel(resolvedSessionId) ||
          getStoredModel(activeSessionId) ||
          selectedModel
        await startExternalChat(
          agentId,
          resolvedSessionId,
          text,
          modelForRun,
          effortForRun,
        )
        return
      }

      await startExternalChat(
        agentId,
        resolvedSessionId,
        text,
        modelForRun || getStoredModel(resolvedSessionId),
        effortForRun,
      )
    },
    [
      agentId,
      activeSessionId,
      getStoredModel,
      selectedModel,
      setActiveSessionId,
      startExternalChat,
      transferModel,
    ],
  )

  const abort = useCallback(() => {
    const runId = activeRunIdRef.current
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeRunIdRef.current = null
    setIsStreaming(false)
    streamingMessageRef.current = null
    // Explicit Stop — kill the managed process (unlike session switch detach).
    if (runId) {
      void fetch(
        `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/interrupt`,
        { method: 'POST' },
      ).catch(() => undefined)
    }
  }, [agentId])

  const clearSessionMessages = useCallback(() => {
    abort()
    setError(null)
    setMessages([])
    if (!activeSessionId.startsWith('new-')) {
      void clearManagedSessionMessages(agentId, activeSessionId)
    }
  }, [abort, agentId, activeSessionId])

  const startNewSession = useCallback(() => {
    // New chat: detach UI only; leave any background run to finish+persist.
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeRunIdRef.current = null
    streamingMessageRef.current = null
    setIsStreaming(false)
    setError(null)
    setMessages([])
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
    activeToolCalls,
    error,
    activeTitle,
    submit,
    abort,
    clearMessages: clearSessionMessages,
    startNewSession,
  }
}
