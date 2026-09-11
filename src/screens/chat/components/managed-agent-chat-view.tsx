'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/components/ui/toast'
import { ChatScreen } from '../chat-screen'
import { AgentChatFrame } from './agent-chat-frame'
import { AgentChatMessagePane } from './agent-chat-message-pane'
import { ChatEmptyState } from './chat-empty-state'
import { CLAUDE_CODE_CHAT_BRAND, CODEX_CHAT_BRAND } from '../agent-chat-brands'
import { createClaudeCodeSlashRuntime } from '../slash-commands/claude-code'
import { useExternalAgentSessions } from '../hooks/use-external-agent-sessions'
import { useManagedAgentChat } from '../hooks/use-managed-agent-chat'
import { useChatMobile } from '../hooks/use-chat-mobile'
import { AssistantAvatarProvider } from '@/components/avatars'
import { useQueryClient } from '@tanstack/react-query'
import { CHAT_OPEN_SETTINGS_EVENT } from '../chat-events'
import type { AgentWithStatus } from '@/lib/agent-types'
import type {
  ChatComposerAttachment,
  ChatComposerHelpers,
} from './chat-composer'

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'adaptive'

function thinkingStorageKey(sessionId: string | null): string {
  return `claude-code-thinking-${sessionId && !sessionId.startsWith('new-') ? sessionId : 'new'}`
}

function readStoredThinking(sessionId: string | null): ThinkingLevel {
  if (typeof window === 'undefined') return 'medium'
  try {
    const stored = window.sessionStorage.getItem(thinkingStorageKey(sessionId))
    if (
      stored === 'off' ||
      stored === 'low' ||
      stored === 'medium' ||
      stored === 'high' ||
      stored === 'adaptive'
    ) {
      return stored
    }
  } catch {
    /* ignore */
  }
  return 'medium'
}

function getBrand(agent: AgentWithStatus) {
  if (agent.runtime === 'codex') return CODEX_CHAT_BRAND
  return CLAUDE_CODE_CHAT_BRAND
}

function getModelsEndpoint(agentId: string, runtime: string): string {
  if (runtime === 'codex') return `/api/agents/${encodeURIComponent(agentId)}/models`
  return '/api/agents/claude-code/models'
}

/**
 * Claude Code / Codex (and future managed runtimes) — same ChatScreen shell
 * (session sidebar) + AgentChatFrame (messages / composer / file explorer).
 */
export function ManagedAgentChatView({
  agent,
  sessionId,
}: {
  agent: AgentWithStatus
  sessionId: string | null
}) {
  const sessionController = useExternalAgentSessions(agent.agentId)
  const chat = useManagedAgentChat({
    agentId: agent.agentId,
    sessionId,
  })
  const queryClient = useQueryClient()
  const { isMobile } = useChatMobile(queryClient)
  const openModelPickerRef = useRef<(() => void) | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    readStoredThinking(sessionId),
  )

  useEffect(() => {
    setThinkingLevel(readStoredThinking(sessionId))
  }, [sessionId])

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevel(level)
      try {
        window.sessionStorage.setItem(thinkingStorageKey(sessionId), level)
      } catch {
        /* ignore */
      }
    },
    [sessionId],
  )

  const slashRuntime = useMemo(
    () =>
      createClaudeCodeSlashRuntime({
        onNew: () => {
          chat.startNewSession()
          toast('New chat', { type: 'success' })
        },
        onClear: () => {
          chat.clearMessages()
          toast('Chat cleared', { type: 'success' })
        },
        onModel: () => {
          window.dispatchEvent(
            new CustomEvent(CHAT_OPEN_SETTINGS_EVENT, {
              detail: { section: 'claude' },
            }),
          )
          openModelPickerRef.current?.()
        },
        onHelp: () => {
          toast('Commands: /new, /clear, /model, /help', { type: 'success' })
        },
      }),
    [chat.startNewSession, chat.clearMessages],
  )

  const handleSubmit = useCallback(
    (
      value: string,
      attachments: Array<ChatComposerAttachment>,
      _fastMode: boolean,
      helpers: ChatComposerHelpers,
    ) => {
      // Hermes onSubmit always helpers.reset(); managed must too — composer
      // clearDraft() only drops sessionStorage, not the controlled value.
      helpers.reset()
      void chat.submit(value, attachments, { effort: thinkingLevel })
    },
    [chat, thinkingLevel],
  )

  const activeFriendlyId = sessionController.activeFriendlyId
  const isNewChat =
    !sessionId || sessionId === 'new' || activeFriendlyId === 'new'

  const brand = useMemo(() => getBrand(agent), [agent])
  const modelsEndpoint = useMemo(
    () => getModelsEndpoint(agent.agentId, agent.runtime),
    [agent.agentId, agent.runtime],
  )

  const composerBrand = useMemo(() => {
    if (agent.runtime === 'codex') {
      return {
        label: agent.name || brand.label,
        hint: `Codex · ${agent.name || brand.label} · ~/.codex/config.toml`,
      }
    }
    return {
      label: agent.name || brand.label,
      hint: `Claude Code · ${agent.name || brand.label} · ~/.claude/settings.json`,
    }
  }, [agent, brand])

  return (
    <AssistantAvatarProvider
      value={{
        src: agent.runtime === 'codex' ? '/codex-mark.svg' : '/claude-code-mark.svg',
        alt: brand.label,
      }}
    >
      <ChatScreen
        activeFriendlyId={
          sessionId && !sessionId.startsWith('new-') ? sessionId : 'new'
        }
        isNewChat={isNewChat}
        sessionController={sessionController}
        hermesChrome={false}
        renderMain={
          <AgentChatFrame
            brand={brand}
            activeTitle={chat.activeTitle}
            isMobile={isMobile}
            defaultFileExplorerCollapsed={false}
            fileExplorerStorageKey={`agent-file-explorer:${agent.agentId}`}
            composerChrome="padded"
            composerProps={{
              onSubmit: handleSubmit,
              // Match Hermes: keep composer interactive while streaming so the
              // primary control becomes the red Stop button (via isLoading).
              // No onQueue/onSteer → resolveComposerBusyUi keeps Stop (not Queue).
              isLoading: chat.isStreaming,
              disabled: false,
              onAbort: chat.abort,
              sessionKey: chat.activeSessionId,
              embedded: true,
              modelsEndpoint,
              modelKeyMode: 'bare',
              gatewayQueriesEnabled: false,
              slashRuntime,
              thinkingLevel,
              onThinkingLevelChange: handleThinkingLevelChange,
              runtimeLabel: composerBrand.label,
              runtimeConfigHint: composerBrand.hint,
            }}
            topNotices={
              chat.error ? (
                <div className="my-2 mx-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                  {chat.error}
                </div>
              ) : null
            }
          >
            <AgentChatMessagePane
              messages={chat.messages}
              waitingForResponse={chat.isStreaming}
              activeToolCalls={chat.activeToolCalls}
              sessionKey={chat.activeSessionId}
              emptyState={
                <ChatEmptyState
                  brand={brand}
                  compact={isMobile}
                  onSuggestionClick={(prompt) =>
                    void chat.submit(prompt, [], { effort: thinkingLevel })
                  }
                />
              }
            />
          </AgentChatFrame>
        }
      />
    </AssistantAvatarProvider>
  )
}
