'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChatComposer } from './chat-composer'
import { ChatMessageList } from './chat-message-list'
import { ChatHeader } from './chat-header'
import { ChatEmptyState } from './chat-empty-state'
import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
} from '@/components/prompt-kit/chat-container'
import { cn } from '@/lib/utils'
import {
  externalChatMessageStorageKey,
  upsertExternalChatSession,
} from '@/lib/external-chat-sessions'
import { useAgentStore } from '@/stores/agent-store'
import {
  PENDING_SESSION_MODEL_KEY,
  useSessionModelStore,
} from '@/stores/session-model-store'
import { FileExplorerSidebar } from '@/components/file-explorer'
import { AssistantAvatarProvider } from '@/components/avatars'
import { useChatMobile } from '../hooks/use-chat-mobile'
import type { ChatMessage, ChatAttachment } from '../types'
import type { AgentWithStatus } from '@/lib/agent-types'

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

export function ClaudeCodeChatShell({
  agent,
  sessionId,
  onSessionResolved,
}: {
  agent: AgentWithStatus
  sessionId: string | null
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
}) {
  const [stableNewSessionId] = useState(() => `new-${Date.now()}`)
  const activeSessionId = sessionId ?? stableNewSessionId
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  const upsertSession = useAgentStore((s) => s.upsertSession)
  const queryClient = useQueryClient()
  const { isMobile } = useChatMobile(queryClient)
  // Claude Code is a coding agent: keep the workspace file panel open by default.
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < 768
  })
  const toggleFileExplorer = useCallback(() => {
    setFileExplorerCollapsed((prev) => !prev)
  }, [])

  const [messages, setMessages] = useState<Array<ChatMessage>>(() =>
    loadMessages(agent.agentId, activeSessionId),
  )
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const streamingMessageRef = useRef<ChatMessage | null>(null)

  // Must use the exact same key as ChatComposer (sessionKey={activeSessionId}).
  // Do NOT map `new-*` → PENDING_SESSION_MODEL_KEY — that desyncs the picker
  // selection from what we send on /chat (user picks Sonnet, run still uses
  // settings default haiku/Kimi).
  const selectedModel = useSessionModelStore(
    (s) => s.models[activeSessionId],
  )
  const transferModel = useSessionModelStore((s) => s.transferModel)
  const getStoredModel = useSessionModelStore((s) => s.getModel)

  useEffect(() => {
    setMessages(loadMessages(agent.agentId, activeSessionId))
  }, [agent.agentId, activeSessionId])

  useEffect(() => {
    saveMessages(agent.agentId, activeSessionId, messages)
    const session = upsertExternalChatSession({
      agentId: agent.agentId,
      sessionId: activeSessionId,
      messages,
    })
    if (session) upsertSession(agent.agentId, session)
  }, [agent.agentId, activeSessionId, messages, upsertSession])

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
      if (!streamingMessageRef.current) return prev
      const idx = prev.indexOf(streamingMessageRef.current)
      if (idx < 0) return prev
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
      agentId: string,
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
          `/api/agents/${encodeURIComponent(agentId)}/chat`,
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
              // Soft diagnostic — keep the stream open; hard failures still
              // arrive as run_exited / HTTP errors.
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

  const handleSubmit = useCallback(
    async (text: string, attachments: Array<ComposerAttachment>) => {
      if (!text.trim() && attachments.length === 0) return
      setError(null)

      const userMessage = makeUserMessage(text, attachments)
      setMessages((prev) => [...prev, userMessage])

      let resolvedSessionId = activeSessionId
      let modelForRun = selectedModel
      if (activeSessionId.startsWith('new-')) {
        resolvedSessionId = crypto.randomUUID()
        setActiveSessionId(resolvedSessionId)
        // Move the picker selection from the draft key onto the real session.
        transferModel(activeSessionId, resolvedSessionId)
        // Also migrate a PENDING pick if one exists (Hermes-style drafts).
        if (!getStoredModel(resolvedSessionId)) {
          transferModel(PENDING_SESSION_MODEL_KEY, resolvedSessionId)
        }
        modelForRun =
          getStoredModel(resolvedSessionId) ||
          getStoredModel(activeSessionId) ||
          selectedModel
        const current = loadMessages(agent.agentId, activeSessionId)
        saveMessages(agent.agentId, resolvedSessionId, [
          ...current,
          userMessage,
        ])
        // historyForPrompt is stale in this closure because it was computed
        // before the new user message. Use the latest messages for the prompt.
        const latestHistory = [...current, userMessage]
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
          agent.agentId,
          resolvedSessionId,
          text,
          latestHistory,
          modelForRun,
        )
        return
      }

      await startExternalChat(
        agent.agentId,
        resolvedSessionId,
        text,
        historyForPrompt,
        modelForRun || getStoredModel(resolvedSessionId),
      )
    },
    [
      agent.agentId,
      activeSessionId,
      getStoredModel,
      historyForPrompt,
      selectedModel,
      setActiveSessionId,
      startExternalChat,
      transferModel,
    ],
  )

  const handleAbort = useCallback(() => {
    abortControllerRef.current?.abort()
    setIsStreaming(false)
    streamingMessageRef.current = null
  }, [])

  const activeTitle = useMemo(() => {
    if (activeSessionId.startsWith('new-')) return 'New Chat'
    const firstUser = messages.find((m) => m.role === 'user')
    const firstText = firstUser?.content?.find(
      (p): p is { type: 'text'; text?: string } => p.type === 'text',
    )
    return firstText?.text?.slice(0, 40) || 'Chat'
  }, [activeSessionId, messages])

  const handleInsertFileReference = useCallback((_reference: string) => {
    // Claude Code composer currently does not expose an insert-text handle.
    // The reference is ignored for now; it can be wired later if needed.
  }, [])

  return (
    <AssistantAvatarProvider
      value={{ src: '/claude-code-mark.svg', alt: 'Claude Code' }}
    >
      <div
        className="relative flex h-full min-w-0 flex-col overflow-hidden"
        style={{ background: 'var(--theme-bg)' }}
      >
        <div
          className={cn(
            'flex-1 min-h-0 overflow-hidden',
            isMobile || fileExplorerCollapsed
              ? 'flex min-h-0 w-full flex-col'
              : 'grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)]',
          )}
        >
          <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ChatHeader
              activeTitle={activeTitle}
              onToggleFileExplorer={toggleFileExplorer}
              fileExplorerCollapsed={fileExplorerCollapsed}
            />
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ChatContainerRoot className="flex-1">
                <ChatContainerContent
                  className={cn(
                    'flex flex-col px-4 py-4',
                    messages.length === 0 && 'h-full',
                  )}
                >
                  {messages.length === 0 ? (
                    <ChatEmptyState
                      variant="claude-code"
                      compact={isMobile}
                      onSuggestionClick={(prompt) =>
                        void handleSubmit(prompt, [])
                      }
                    />
                  ) : (
                    <ChatMessageList
                      messages={messages}
                      waitingForResponse={isStreaming}
                      researchCard={undefined}
                      loading={false}
                      empty={false}
                      pinToTop={false}
                      pinGroupMinHeight={0}
                      headerHeight={48}
                      sessionKey={activeSessionId}
                    />
                  )}
                  {error && (
                    <div className="my-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                      {error}
                    </div>
                  )}
                  <ChatContainerScrollAnchor />
                </ChatContainerContent>
              </ChatContainerRoot>
              <div className="shrink-0 bg-surface px-4 py-3">
                <ChatComposer
                  onSubmit={(value, atts, _fastMode) =>
                    void handleSubmit(value, atts)
                  }
                  isLoading={isStreaming}
                  disabled={isStreaming}
                  onAbort={handleAbort}
                  sessionKey={activeSessionId}
                  embedded
                  modelsEndpoint="/api/agents/claude-code/models"
                  modelKeyMode="bare"
                  gatewayQueriesEnabled={false}
                />
              </div>
            </div>
          </main>

          {isMobile || fileExplorerCollapsed ? null : (
            <Suspense fallback={null}>
              <FileExplorerSidebar
                collapsed={fileExplorerCollapsed}
                onToggle={toggleFileExplorer}
                onInsertReference={handleInsertFileReference}
                side="right"
                className="min-w-0"
              />
            </Suspense>
          )}
        </div>
      </div>
    </AssistantAvatarProvider>
  )
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
    // Prefer type embedded in the payload; fall back to the SSE `event:` name
    // (older servers only set the latter).
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
