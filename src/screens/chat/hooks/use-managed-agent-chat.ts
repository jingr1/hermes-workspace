'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { clearManagedSessionMessages, fetchSessionsForAgent } from '@/lib/agent-api'
import { useAgentStore } from '@/stores/agent-store'
import { PENDING_SESSION_MODEL_KEY, useSessionModelStore } from '@/stores/session-model-store'
import type { AgentActivityInteraction } from '../../../../packages/agent-activity-core/src/types'
import type { AgentSessionEngine } from '../../../../packages/agent-activity-core/src/index'
import { writeLastSession } from '../last-session'
import type { ChatMessage } from '../types'
import { mapManagedAgentActivitySnapshot } from '../lib/managed-agent-activity-mapper'
import { managedPromptContentFromAttachments } from '@/server/agent-runtime/agorax-managed-prompt-content'
import {
  createManagedAgentCommandPort,
  createManagedAgentEngine,
  hydrateManagedAgentEngine,
  managedAgentTargetId,
  selectManagedAgentChatState,
  subscribeManagedAgentEngine,
} from '../lib/managed-agent-engine'

type ComposerAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  dataUrl?: string
  previewUrl?: string
  kind?: 'image' | 'file' | 'audio'
}

export type ManagedAgentChat = {
  activeSessionId: string
  messages: Array<ChatMessage>
  isStreaming: boolean
  activeToolCalls: Array<{ id: string; name: string; phase: string; args?: unknown }>
  interactions: Array<AgentActivityInteraction>
  error: string | null
  activeTitle: string
  submit: (text: string, attachments: Array<ComposerAttachment>, options?: { effort?: string }) => Promise<void>
  abort: () => void
  clearMessages: () => void
  startNewSession: () => void
  respondToInteraction: (input: { turnId: string; requestId: string; optionId: string }) => Promise<void>
}

export function useManagedAgentChat({
  agentId,
  sessionId,
  onSessionResolved,
}: {
  agentId: string
  sessionId: string | null
  onSessionResolved?: (payload: { sessionKey: string; friendlyId: string }) => void
}): ManagedAgentChat {
  const [stableNewSessionId] = useState(() => `new-${Date.now()}`)
  const activeSessionId = sessionId ?? stableNewSessionId
  const setActiveSessionId = useAgentStore((state) => state.setActiveSessionId)
  const setSessions = useAgentStore((state) => state.setSessions)
  const selectedModel = useSessionModelStore((state) => state.models[activeSessionId])
  const transferModel = useSessionModelStore((state) => state.transferModel)
  const getStoredModel = useSessionModelStore((state) => state.getModel)
  const [error, setError] = useState<string | null>(null)
  const engineRef = useRef<AgentSessionEngine | null>(null)
  const canonicalSessionIdRef = useRef<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const engineDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const displaySessionIdRef = useRef(activeSessionId)
  const subscribedSessionIdRef = useRef<string | null>(null)
  const activityHandlerRef = useRef<(agentSessionId: string) => void>(() => undefined)
  displaySessionIdRef.current = activeSessionId

  if (!engineRef.current) {
    let engine: AgentSessionEngine
    const commandPort = createManagedAgentCommandPort(
      agentId,
      (detail) => {
        canonicalSessionIdRef.current = detail.session.agentSessionId
        hydrateManagedAgentEngine(engine, detail)
        activityHandlerRef.current(detail.session.agentSessionId)
      },
      {
        displaySessionId: () => displaySessionIdRef.current,
      },
    )
    engine = createManagedAgentEngine({ workspaceId: 'default', commandPort })
    engineRef.current = engine
  }
  const engine = engineRef.current
  const engineSnapshot = useSyncExternalStore(
    (listener) => subscribeManagedAgentEngine(engine, listener),
    () => engine.getSnapshot(),
    () => engine.getSnapshot(),
  )
  const chatState = selectManagedAgentChatState(engineSnapshot, canonicalSessionIdRef.current)

  const refreshActivity = useCallback(async (displaySessionId: string) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/activity/${encodeURIComponent(displaySessionId)}`)
    if (!response.ok) return
    const detail = mapManagedAgentActivitySnapshot(await response.json())
    if (!detail) throw new Error('Managed Agent returned an invalid activity snapshot')
    canonicalSessionIdRef.current = detail.session.agentSessionId
    hydrateManagedAgentEngine(engine, detail)
    activityHandlerRef.current(detail.session.agentSessionId)
  }, [agentId, engine])

  useEffect(() => {
    setError(null)
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    subscribedSessionIdRef.current = null
    if (activeSessionId.startsWith('new-')) return
    void refreshActivity(activeSessionId).catch((reason) => setError(String(reason)))
    onSessionResolved?.({ sessionKey: activeSessionId, friendlyId: activeSessionId })
  }, [activeSessionId, onSessionResolved, refreshActivity])

  useEffect(() => {
    if (engineDisposeTimerRef.current) {
      clearTimeout(engineDisposeTimerRef.current)
      engineDisposeTimerRef.current = null
    }
    return () => {
      eventSourceRef.current?.close()
      // Strict Mode runs a development-only cleanup/setup pair. Deferring the
      // disposal lets the immediately following setup retain the same Engine;
      // a real unmount leaves the timer intact and releases it.
      engineDisposeTimerRef.current = setTimeout(() => engine.dispose(), 0)
    }
  }, [engine])

  const refreshSessionList = useCallback(async () => {
    try { setSessions(agentId, (await fetchSessionsForAgent(agentId)).sessions) } catch { /* sidebar retries */ }
  }, [agentId, setSessions])

  const attachEventRelay = useCallback((agentSessionId: string, displaySessionId: string) => {
    if (subscribedSessionIdRef.current === agentSessionId && eventSourceRef.current) return
    eventSourceRef.current?.close()
    const source = new EventSource(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(agentSessionId)}/events`)
    eventSourceRef.current = source
    subscribedSessionIdRef.current = agentSessionId
    source.onmessage = () => void refreshActivity(displaySessionId).catch((reason) => setError(String(reason)))
    source.onerror = () => {
      source.close()
      eventSourceRef.current = null
      subscribedSessionIdRef.current = null
      void refreshActivity(displaySessionId).finally(() => void refreshSessionList())
    }
  }, [agentId, refreshActivity, refreshSessionList])
  activityHandlerRef.current = (agentSessionId) =>
    attachEventRelay(agentSessionId, displaySessionIdRef.current)

  const submit = useCallback(async (
    text: string,
    attachments: Array<ComposerAttachment>,
    options?: { effort?: string },
  ) => {
    if (!text.trim() && attachments.length === 0) return
    setError(null)
    try {
      const promptContent = managedPromptContentFromAttachments({ text, attachments })
      if (!canonicalSessionIdRef.current) {
        const displaySessionId = activeSessionId.startsWith('new-') ? crypto.randomUUID() : activeSessionId
        const canonicalSessionId = crypto.randomUUID()
        if (activeSessionId.startsWith('new-')) {
          setActiveSessionId(displaySessionId)
          writeLastSession(displaySessionId, agentId)
          transferModel(activeSessionId, displaySessionId)
          if (!getStoredModel(displaySessionId)) transferModel(PENDING_SESSION_MODEL_KEY, displaySessionId)
        }
        displaySessionIdRef.current = displaySessionId
        const accepted = engine.activateSession({
          mode: 'new',
          agentSessionId: canonicalSessionId,
          agentTargetId: managedAgentTargetId(agentId),
          clientSubmitId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          initialTurnExpected: true,
          initialContent: promptContent,
          initialDisplayPrompt: text,
          settings: {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(options?.effort ? { reasoningEffort: options.effort } : {}),
          },
        })
        if (!accepted) throw new Error('Managed Agent activation was not accepted')
      } else {
        engine.submitPrompt({
          agentSessionId: canonicalSessionIdRef.current,
          clientSubmitId: crypto.randomUUID(),
          content: promptContent,
          displayPrompt: text,
          routing: 'auto',
        })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    }
  }, [activeSessionId, agentId, engine, getStoredModel, selectedModel, setActiveSessionId, transferModel])

  const abort = useCallback(() => {
    const agentSessionId = canonicalSessionIdRef.current
    if (agentSessionId) engine.stopSession({ agentSessionId })
  }, [engine])

  const respondToInteraction = useCallback(async (input: { turnId: string; requestId: string; optionId: string }) => {
    const agentSessionId = canonicalSessionIdRef.current
    if (!agentSessionId || !engine.submitInteractionResponse({ agentSessionId, ...input })) {
      throw new Error('Interaction response was not accepted')
    }
  }, [engine])

  const clearMessages = useCallback(() => {
    if (!activeSessionId.startsWith('new-')) void clearManagedSessionMessages(agentId, activeSessionId)
    engine.dispatch({ type: 'session/removed', agentSessionId: canonicalSessionIdRef.current ?? '' })
    canonicalSessionIdRef.current = null
  }, [activeSessionId, agentId, engine])

  const startNewSession = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    subscribedSessionIdRef.current = null
    canonicalSessionIdRef.current = null
    setError(null)
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const activeTitle = useMemo(() => {
    const firstUser = chatState.messages.find((message) => message.role === 'user')
    const text = firstUser?.content?.find((part) => part.type === 'text')
    return text?.type === 'text' && text.text ? text.text.slice(0, 40) : 'Chat'
  }, [chatState.messages])

  return {
    activeSessionId,
    messages: chatState.messages,
    isStreaming: chatState.isStreaming,
    activeToolCalls: chatState.activeToolCalls,
    interactions: [...chatState.interactions],
    error,
    activeTitle,
    submit,
    abort,
    clearMessages,
    startNewSession,
    respondToInteraction,
  }
}