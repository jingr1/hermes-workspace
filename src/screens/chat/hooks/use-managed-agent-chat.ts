'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { clearManagedSessionMessages, fetchSessionsForAgent } from '@/lib/agent-api'
import { useAgentStore } from '@/stores/agent-store'
import { PENDING_SESSION_MODEL_KEY, useSessionModelStore } from '@/stores/session-model-store'
import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivitySessionDetailSnapshot,
  AgentSessionEngine,
  EngineEffectOptions,
  EngineExtensionCommand,
  EngineScheduler,
  EngineTypedCommandPort,
  InteractionResponseState,
  SessionReconcileCommand,
} from '@agorax/agent-activity-core'
import {
  canonicalInteractionKey,
  createAgentActivitySessionReconcileExecutor,
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineInteractionResponse,
  selectEngineInteractionsForSession,
  selectEngineQueuedPrompts,
  selectEngineSession,
  selectEngineSubmitAvailability,
  selectSessionIsSubmitting,
} from '@agorax/agent-activity-core'
import { writeLastSession } from '../last-session'
import type { ChatMessage } from '../types'
import {
  createManagedAgentCommandPort,
  createManagedAgentEngine,
  hydrateManagedAgentEngine,
  hydrateManagedAgentSessionDetail,
  managedAgentTargetId,
  selectManagedAgentChatState,
  subscribeManagedAgentEngine,
} from '../lib/managed-agent-engine'
import { managedPromptContentFromAttachments } from '@/lib/managed-agent-runtime/prompt-content'
import {
  createManagedAgentEventBridge,
  type ManagedAgentActivityEventPayload,
  type ManagedAgentEventBridge,
} from '@/lib/managed-agent-runtime/event-bridge'
import { createManagedAgentSessionReconcilePort } from '@/lib/managed-agent-runtime/reconcile-port'

type ComposerAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  dataUrl?: string
  previewUrl?: string
  kind?: 'image' | 'file' | 'audio'
}

export type ManagedAgentComposerState = {
  /**
   * Engine-owned submit admission. `available` before the canonical session
   * exists (first message activates); `blocked` carries `blockedReason`.
   */
  availability: 'available' | 'blocked'
  blockedReason: string | null
  /** A submit is in flight (send command not yet settled). */
  isSubmitting: boolean
  /** Follow-ups held in the prompt queue while a turn runs. */
  queuedCount: number
  /**
   * Capability projection from the engine session snapshot. `null` means the
   * runtime has not reported capabilities — display "unknown", never invent.
   */
  capabilities: AgentActivitySession['capabilities']
}

export type ManagedAgentInteractionResponseInput = {
  turnId: string
  requestId: string
  action?: string
  optionId?: string
  payload?: Record<string, unknown>
}

export type ManagedAgentChat = {
  activeSessionId: string
  messages: Array<ChatMessage>
  isStreaming: boolean
  activeToolCalls: Array<{ id: string; name: string; phase: string; args?: unknown }>
  interactions: Array<AgentActivityInteraction>
  /**
   * Engine response-tracking state per interaction, keyed by
   * canonicalInteractionKey. Drives per-card submitting/failed settlement;
   * answered/superseded come from the canonical interaction itself.
   */
  interactionResponses: Record<
    string,
    Pick<InteractionResponseState, 'status' | 'errorMessage'> | undefined
  >
  error: string | null
  activeTitle: string
  composer: ManagedAgentComposerState
  submit: (text: string, attachments: Array<ComposerAttachment>, options?: { effort?: string }) => Promise<void>
  abort: () => void
  clearMessages: () => void
  startNewSession: () => void
  respondToInteraction: (input: ManagedAgentInteractionResponseInput) => Promise<void>
}

interface ManagedAgentChatRuntime {
  displaySessionId: string
  workspaceId: string
  engine: AgentSessionEngine
  coordinator: ReturnType<typeof createAgentActivityWorkspaceEventCoordinator>
  bridge: ManagedAgentEventBridge
  executeSessionReconcile(
    command: SessionReconcileCommand,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
}

const EMPTY_CHAT_STATE = {
  messages: [] as Array<ChatMessage>,
  activeTurn: null,
  isStreaming: false,
  error: null as string | null,
  interactions: [] as Array<AgentActivityInteraction>,
  activeToolCalls: [] as Array<{ id: string; name: string; phase: string; args?: unknown }>,
}

function createWindowScheduler(): EngineScheduler {
  return {
    schedule(delayMs, task) {
      const timer = window.setTimeout(task, delayMs)
      return { cancel: () => window.clearTimeout(timer) }
    },
  }
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
  const [engine, setEngine] = useState<AgentSessionEngine | null>(null)
  const runtimeRef = useRef<ManagedAgentChatRuntime | null>(null)
  const runtimeCreationRef = useRef<{
    displaySessionId: string
    promise: Promise<ManagedAgentChatRuntime>
    dispose(): void
  } | null>(null)
  const engineDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canonicalSessionIdRef = useRef<string | null>(null)
  const displaySessionIdRef = useRef(activeSessionId)
  const preserveCanonicalForDisplaySessionRef = useRef<string | null>(null)
  const pendingDisplaySessionIdRef = useRef<string | null>(null)
  const activityGenerationRef = useRef(0)
  displaySessionIdRef.current = activeSessionId

  const reconcileCurrentSession = useCallback(() => {
    const runtime = runtimeRef.current
    const canonicalSessionId = canonicalSessionIdRef.current
    if (!runtime || !canonicalSessionId) return
    runtime.engine.dispatch({
      agentSessionId: canonicalSessionId,
      needsMessages: true,
      needsState: true,
      type: 'session/reconcileRequested',
      workspaceId: runtime.workspaceId,
    })
  }, [])

  const executeExtensionCommand = useCallback(
    async (command: EngineExtensionCommand, options?: EngineEffectOptions) => {
      if (command.type === 'session/reconcile') {
        const runtime = runtimeRef.current
        if (!runtime) throw new Error('Managed Agent runtime is not ready')
        return runtime.executeSessionReconcile(command, { signal: options?.signal })
      }
      if (command.type === 'engine/reconcileWorkspace') {
        reconcileCurrentSession()
        return
      }
      throw new Error(`Unsupported Managed Agent command: ${command.type}`)
    },
    [reconcileCurrentSession],
  )

  const refreshSessionList = useCallback(async () => {
    try { setSessions(agentId, (await fetchSessionsForAgent(agentId)).sessions) } catch { /* sidebar retries */ }
  }, [agentId, setSessions])

  const commandPortRef = useRef<EngineTypedCommandPort | null>(null)
  if (!commandPortRef.current) {
    commandPortRef.current = createManagedAgentCommandPort(
      agentId,
      (detail) => {
        const runtime = runtimeRef.current
        if (!runtime) return
        canonicalSessionIdRef.current = detail.session.agentSessionId
        hydrateManagedAgentEngine(runtime.engine, detail)
        const pendingDisplaySessionId = pendingDisplaySessionIdRef.current
        if (pendingDisplaySessionId) {
          pendingDisplaySessionIdRef.current = null
          preserveCanonicalForDisplaySessionRef.current = pendingDisplaySessionId
          setActiveSessionId(pendingDisplaySessionId)
          writeLastSession(pendingDisplaySessionId, agentId)
        }
        void refreshSessionList()
      },
      {
        displaySessionId: () => displaySessionIdRef.current,
        executeExtensionCommand,
      },
    )
  }

  const reconcilePortRef = useRef(createManagedAgentSessionReconcilePort({
    agentId,
    resolveDisplaySessionId: (agentSessionId) =>
      agentSessionId === canonicalSessionIdRef.current
        ? displaySessionIdRef.current
        : agentSessionId,
  }))

  const ensureRuntime = useCallback((displaySessionId: string, generation: number): Promise<ManagedAgentChatRuntime> => {
    const existing = runtimeCreationRef.current
    if (existing) {
      if (existing.displaySessionId === displaySessionId) return existing.promise
      existing.dispose()
      runtimeCreationRef.current = null
    }
    let resolvePromise!: (runtime: ManagedAgentChatRuntime) => void
    const promise = new Promise<ManagedAgentChatRuntime>((resolve) => {
      resolvePromise = resolve
    })
    const bridge = createManagedAgentEventBridge({
      agentId,
      displaySessionId,
      onConnected: (workspaceId) => {
        if (runtimeRef.current) {
          // SSE (re)connect after the first one: events are hints only, so a
          // reconnect means frames may have been missed — reconnect + reconcile.
          runtimeRef.current.engine.dispatch({
            status: 'connected',
            type: 'engine/connectionChanged',
            workspaceId,
          })
          runtimeRef.current.coordinator.eventStreamConnectionChanged({
            prioritySessionIds: canonicalSessionIdRef.current
              ? [canonicalSessionIdRef.current]
              : [],
            status: 'connected',
          })
          reconcileCurrentSession()
          return
        }
        const scheduler = createWindowScheduler()
        const engine = createManagedAgentEngine({
          workspaceId,
          commandPort: commandPortRef.current!,
        })
        const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
        const coordinator = createAgentActivityWorkspaceEventCoordinator({
          engine,
          notificationScheduler: scheduler,
          readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
          workspaceId,
        })
        const executor = createAgentActivitySessionReconcileExecutor({
          childMessageHydration: 'requested_session',
          engine,
          isSessionDeleted: (agentSessionId) => coordinator.isSessionDeleted(agentSessionId),
          port: reconcilePortRef.current,
          reconcileAuthoritativeHistory: (agentSessionId, messages, turns) =>
            coordinator.reconcileAuthoritativeHistory(agentSessionId, messages, turns),
          reconcileOptimisticMessages: (agentSessionId) =>
            coordinator.reconcileMessages(agentSessionId),
          workspaceId,
        })
        const runtime: ManagedAgentChatRuntime = {
          bridge,
          coordinator,
          displaySessionId,
          engine,
          executeSessionReconcile: (command, options) => executor.execute(command, options),
          workspaceId,
        }
        runtimeRef.current = runtime
        engine.dispatch({
          status: 'connected',
          type: 'engine/connectionChanged',
          workspaceId,
        })
        coordinator.eventStreamConnectionChanged({ status: 'connected' })
        if (generation === activityGenerationRef.current) setEngine(engine)
        resolvePromise(runtime)
      },
      onActivity: (payload: ManagedAgentActivityEventPayload) => {
        const runtime = runtimeRef.current
        if (!runtime || runtime.bridge !== bridge) return
        runtime.coordinator.ingestEvent(payload)
      },
      onMalformedActivity: () => reconcileCurrentSession(),
      onReconnectRequested: () => reconcileCurrentSession(),
      onTransportDisconnected: () => {
        const runtime = runtimeRef.current
        if (!runtime || runtime.bridge !== bridge) return
        runtime.engine.dispatch({
          status: 'disconnected',
          type: 'engine/connectionChanged',
          workspaceId: runtime.workspaceId,
        })
        runtime.coordinator.eventStreamConnectionChanged({ status: 'disconnected' })
      },
    })
    runtimeCreationRef.current = {
      displaySessionId,
      promise,
      dispose: () => bridge.dispose(),
    }
    return promise
  }, [agentId, reconcileCurrentSession])

  const fetchSessionDetail = useCallback(async (displaySessionId: string): Promise<AgentActivitySessionDetailSnapshot> => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(displaySessionId)}/detail`)
    if (!response.ok) throw new Error(`Managed Agent session detail failed: ${response.status}`)
    const body = await response.json().catch(() => null) as { detail?: AgentActivitySessionDetailSnapshot } | null
    if (!body?.detail?.session?.agentSessionId) {
      throw new Error('Managed Agent session detail returned an invalid snapshot')
    }
    return body.detail
  }, [agentId])

  // Attaches to an existing display session: identity comes from the SSE
  // `connected` frame, the first detail snapshot hydrates session/turn state,
  // and one reconcile pass hydrates message history through the afterVersion
  // paginated messages route.
  const attachToSession = useCallback(async (displaySessionId: string, generation: number) => {
    const runtime = await ensureRuntime(displaySessionId, generation)
    if (generation !== activityGenerationRef.current) return
    if (canonicalSessionIdRef.current) return // already attached (e.g. activation)
    const detail = await fetchSessionDetail(displaySessionId)
    if (generation !== activityGenerationRef.current) return
    canonicalSessionIdRef.current = detail.session.agentSessionId
    hydrateManagedAgentSessionDetail(runtime.engine, detail)
    reconcileCurrentSession()
    void refreshSessionList()
  }, [ensureRuntime, fetchSessionDetail, reconcileCurrentSession, refreshSessionList])

  useEffect(() => {
    const generation = activityGenerationRef.current + 1
    activityGenerationRef.current = generation
    setError(null)
    if (engineDisposeTimerRef.current) {
      clearTimeout(engineDisposeTimerRef.current)
      engineDisposeTimerRef.current = null
    }
    const previousRuntime = runtimeRef.current
    const preserveCanonical =
      preserveCanonicalForDisplaySessionRef.current === activeSessionId
    preserveCanonicalForDisplaySessionRef.current = null
    if (previousRuntime && previousRuntime.displaySessionId !== activeSessionId) {
      runtimeRef.current = null
      previousRuntime.bridge.dispose()
      previousRuntime.coordinator.dispose()
      previousRuntime.engine.dispose()
      if (!preserveCanonical) canonicalSessionIdRef.current = null
      setEngine(null)
    } else if (previousRuntime && !preserveCanonical && canonicalSessionIdRef.current) {
      previousRuntime.engine.dispatch({
        type: 'session/removed',
        agentSessionId: canonicalSessionIdRef.current,
      })
      canonicalSessionIdRef.current = null
    }
    const pendingCreation = runtimeCreationRef.current
    if (pendingCreation && pendingCreation.displaySessionId !== activeSessionId) {
      pendingCreation.dispose()
      runtimeCreationRef.current = null
    }
    if (activeSessionId.startsWith('new-')) return
    displaySessionIdRef.current = activeSessionId
    void attachToSession(activeSessionId, generation).catch((reason) => {
      if (generation === activityGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })
    onSessionResolved?.({ sessionKey: activeSessionId, friendlyId: activeSessionId })
  }, [activeSessionId, attachToSession, onSessionResolved])

  // Real unmount: defer disposal so a Strict Mode remount can adopt the live
  // runtime (same displaySessionId) without losing the SSE bridge.
  useEffect(() => {
    return () => {
      const runtime = runtimeRef.current
      if (!runtime) return
      engineDisposeTimerRef.current = setTimeout(() => {
        runtime.bridge.dispose()
        runtime.coordinator.dispose()
        runtime.engine.dispose()
      }, 0)
    }
  }, [])

  const engineSnapshot = useSyncExternalStore(
    useCallback(
      (listener) => (engine ? subscribeManagedAgentEngine(engine, listener) : () => undefined),
      [engine],
    ),
    () => engine?.getSnapshot() ?? null,
    () => engine?.getSnapshot() ?? null,
  )
  const chatState = engineSnapshot
    ? selectManagedAgentChatState(engineSnapshot, canonicalSessionIdRef.current)
    : EMPTY_CHAT_STATE

  // Per-interaction response settlement, straight from the engine's
  // interactionResponsesById — the panel joins these with the canonical
  // interactions (canonical status wins for answered/superseded).
  const interactionResponses = useMemo(() => {
    const result: ManagedAgentChat['interactionResponses'] = {}
    const agentSessionId = canonicalSessionIdRef.current
    if (!engineSnapshot || !agentSessionId) return result
    for (const interaction of selectEngineInteractionsForSession(
      engineSnapshot,
      agentSessionId,
    )) {
      result[
        canonicalInteractionKey(
          agentSessionId,
          interaction.turnId,
          interaction.requestId,
        )
      ] = selectEngineInteractionResponse(
        engineSnapshot,
        agentSessionId,
        interaction.turnId,
        interaction.requestId,
      ) ?? undefined
    }
    return result
  }, [engineSnapshot])

  // Composer contract comes from engine selectors, not local heuristics:
  // submit admission (blocked while the runtime reports unavailable or a
  // pending interaction holds the session), in-flight submit, and the prompt
  // queue depth for the queued-count badge.
  const composer: ManagedAgentComposerState = useMemo(() => {
    if (!engineSnapshot) {
      return {
        availability: 'available',
        blockedReason: null,
        isSubmitting: false,
        queuedCount: 0,
        capabilities: null,
      }
    }
    const agentSessionId = canonicalSessionIdRef.current
    const availability = selectEngineSubmitAvailability(engineSnapshot, agentSessionId)
    return {
      availability: availability?.state ?? 'available',
      blockedReason: availability?.reason ?? null,
      isSubmitting: agentSessionId ? selectSessionIsSubmitting(engineSnapshot, agentSessionId) : false,
      queuedCount: agentSessionId ? selectEngineQueuedPrompts(engineSnapshot, agentSessionId).length : 0,
      capabilities: agentSessionId
        ? selectEngineSession(engineSnapshot, agentSessionId)?.capabilities ?? null
        : null,
    }
  }, [engineSnapshot])

  const submit = useCallback(async (
    text: string,
    attachments: Array<ComposerAttachment>,
    options?: { effort?: string },
  ) => {
    if (!text.trim() && attachments.length === 0) return
    setError(null)
    try {
      const promptContent = managedPromptContentFromAttachments({ text, attachments })
      const generation = activityGenerationRef.current
      let runtime = runtimeRef.current
      if (!canonicalSessionIdRef.current) {
        const displaySessionId = activeSessionId.startsWith('new-') ? crypto.randomUUID() : activeSessionId
        const canonicalSessionId = crypto.randomUUID()
        if (activeSessionId.startsWith('new-')) {
          transferModel(activeSessionId, displaySessionId)
          if (!getStoredModel(displaySessionId)) transferModel(PENDING_SESSION_MODEL_KEY, displaySessionId)
          pendingDisplaySessionIdRef.current = displaySessionId
        }
        displaySessionIdRef.current = displaySessionId
        runtime = await ensureRuntime(displaySessionId, generation)
        if (generation !== activityGenerationRef.current) {
          throw new Error('Managed Agent session changed before activation')
        }
        const accepted = runtime.engine.activateSession({
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
        if (!runtime) runtime = await ensureRuntime(displaySessionIdRef.current, generation)
        runtime.engine.submitPrompt({
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
  }, [activeSessionId, agentId, ensureRuntime, getStoredModel, selectedModel, transferModel])

  const abort = useCallback(() => {
    const agentSessionId = canonicalSessionIdRef.current
    if (agentSessionId) runtimeRef.current?.engine.stopSession({ agentSessionId })
  }, [])

  const respondToInteraction = useCallback(async (input: ManagedAgentInteractionResponseInput) => {
    const agentSessionId = canonicalSessionIdRef.current
    const runtime = runtimeRef.current
    if (!runtime || !agentSessionId || !runtime.engine.submitInteractionResponse({ agentSessionId, ...input })) {
      throw new Error('Interaction response was not accepted')
    }
  }, [])

  const clearMessages = useCallback(() => {
    if (!activeSessionId.startsWith('new-')) void clearManagedSessionMessages(agentId, activeSessionId)
    const canonicalSessionId = canonicalSessionIdRef.current
    if (canonicalSessionId) {
      runtimeRef.current?.engine.dispatch({ type: 'session/removed', agentSessionId: canonicalSessionId })
    }
    canonicalSessionIdRef.current = null
  }, [activeSessionId, agentId])

  const startNewSession = useCallback(() => {
    pendingDisplaySessionIdRef.current = null
    preserveCanonicalForDisplaySessionRef.current = null
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
    interactionResponses,
    error: error ?? chatState.error,
    activeTitle,
    composer,
    submit,
    abort,
    clearMessages,
    startNewSession,
    respondToInteraction,
  }
}
