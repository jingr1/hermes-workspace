/**
 * Phase D: dual-subscribe Engine + coordinator overlay for Hermes 1:1.
 * turnBusy / open-turn messages come only from selectHermesChatState.
 */

import { useMemo, useRef, useSyncExternalStore } from 'react'
import { selectSessionIsSubmitting } from '@agorax/agent-activity-core'
import {
  getHermesChatRuntime,
  selectHermesChatState,
} from '@/stores/hermes-chat-runtime'

export function useHermesEngineChatState(input: {
  workspaceId: string
  agentSessionId: string | null
  profileName?: string | null
  /** UI optimistic sending — OR'd with Engine selectSessionIsSubmitting. */
  isSubmitting?: boolean
}) {
  const workspaceId = input.workspaceId.trim() || 'default'
  const runtime = getHermesChatRuntime(workspaceId, {
    profileName: input.profileName,
  })

  const engineSnapshot = useSyncExternalStore(
    (listener) => runtime.engine.subscribe(listener),
    () => runtime.engine.getSnapshot(),
    () => runtime.engine.getSnapshot(),
  )

  const overlayEpochRef = useRef(0)
  const overlayEpoch = useSyncExternalStore(
    (listener) =>
      runtime.coordinator.subscribe(() => {
        overlayEpochRef.current += 1
        listener()
      }),
    () => overlayEpochRef.current,
    () => overlayEpochRef.current,
  )

  const agentSessionId = input.agentSessionId?.trim() || null

  const chatState = useMemo(() => {
    void overlayEpoch
    const sessionMessages = agentSessionId
      ? runtime.coordinator.project(runtime.projectSnapshot(engineSnapshot))
          .sessionMessagesById[agentSessionId]
      : undefined
    const engineSubmitting = agentSessionId
      ? selectSessionIsSubmitting(engineSnapshot, agentSessionId)
      : false
    return selectHermesChatState(engineSnapshot, agentSessionId, {
      sessionMessages,
      isSubmitting: input.isSubmitting === true || engineSubmitting,
    })
  }, [
    engineSnapshot,
    overlayEpoch,
    runtime,
    agentSessionId,
    input.isSubmitting,
  ])

  return { runtime, chatState, engineSnapshot, overlayEpoch }
}
