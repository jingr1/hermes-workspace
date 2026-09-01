'use client'

import { HugeiconsIcon } from '@hugeicons/react'
import { Add01Icon } from '@hugeicons/core-free-icons'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  setActiveProfileOptimistic,
  useProfiles,
} from '../hooks/use-profiles'
import { useRenameSession } from '../hooks/use-rename-session'
import { useDeleteSession } from '../hooks/use-delete-session'
import { chatQueryKeys, fetchHistory, fetchSessions } from '../chat-queries'
import { resolveSessionForProfile, writeLastSession } from '../last-session'
import { SidebarSessions } from './sidebar/sidebar-sessions'
import { SessionDeleteDialog } from './sidebar/session-delete-dialog'
import { AgentList } from './agent-list'
import type { SessionMeta } from '../types'
import { preloadWorkspaceFolders } from '@/components/workspace-folder-picker'
import { requestStreamHandoffIfActive } from '@/lib/stream-handoff-bridge'
import { Button } from '@/components/ui/button'
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@/components/ui/scroll-area'
import { useAgentStore } from '@/stores/agent-store'

type ChatSessionSidebarProps = {
  activeFriendlyId: string
  sessions: Array<SessionMeta>
  sessionsLoading: boolean
  sessionsFetching: boolean
  sessionsError: string | null
  onRetrySessions: () => void
  onNewChat: () => void
  onActiveSessionDelete?: () => void
}

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const AGENTS_MIN_HEIGHT = 220
const SESSION_MIN_HEIGHT = 180

function prefetchSessionHistory(
  queryClient: ReturnType<typeof useQueryClient>,
  profileName: string,
  sessionId: string,
) {
  if (!sessionId || sessionId === 'new') return
  void queryClient.prefetchQuery({
    queryKey: chatQueryKeys.history(sessionId, sessionId),
    queryFn: () =>
      fetchHistory({
        sessionKey: sessionId,
        friendlyId: sessionId,
        profile: profileName,
      }),
    staleTime: 10_000,
  })
}

export const ChatSessionSidebar = memo(function ChatSessionSidebar({
  activeFriendlyId,
  sessions,
  sessionsLoading,
  sessionsFetching,
  sessionsError,
  onRetrySessions,
  onNewChat,
  onActiveSessionDelete,
}: ChatSessionSidebarProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sidebarRef = useRef<HTMLElement | null>(null)
  const { activeProfileName, activateProfile } = useProfiles()
  const agents = useAgentStore((state) => state.agents)
  const activeAgentId = useAgentStore((state) => state.activeAgentId)

  const { renameSession } = useRenameSession()
  const { deleteSession } = useDeleteSession()

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteSessionKey, setDeleteSessionKey] = useState<string | null>(null)
  const [deleteFriendlyId, setDeleteFriendlyId] = useState<string | null>(null)
  const [deleteSessionTitle, setDeleteSessionTitle] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [agentsHeight, setAgentsHeight] = useState(480)

  const handleRename = useCallback(
    (session: SessionMeta, newTitle: string) => {
      void renameSession(session.key, session.friendlyId, newTitle)
    },
    [renameSession],
  )

  const handleOpenDelete = useCallback((session: SessionMeta) => {
    setDeleteSessionKey(session.key)
    setDeleteFriendlyId(session.friendlyId)
    setDeleteSessionTitle(
      session.label ||
        session.title ||
        session.derivedTitle ||
        session.friendlyId,
    )
    setDeleteDialogOpen(true)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (deleteSessionKey && deleteFriendlyId) {
      const isActive = deleteFriendlyId === activeFriendlyId
      if (isActive) {
        onActiveSessionDelete?.()
      }
      void deleteSession(deleteSessionKey, deleteFriendlyId, isActive)
    }
    setDeleteDialogOpen(false)
    setDeleteSessionKey(null)
    setDeleteFriendlyId(null)
  }, [
    activeFriendlyId,
    deleteFriendlyId,
    deleteSession,
    deleteSessionKey,
    onActiveSessionDelete,
  ])

  // Keep the agents bar highlight in sync when the user is on a Hermes chat
  // route where the URL does not carry an agentId.
  useEffect(() => {
    if (activeAgentId) return
    if (!activeProfileName) return
    const matchingHermesAgent = agents.find(
      (agent) =>
        agent.runtime === 'hermes' &&
        (agent.runtimeConfig.profile ?? agent.agentId) === activeProfileName,
    )
    if (matchingHermesAgent) {
      useAgentStore.getState().setActiveAgentId(matchingHermesAgent.agentId)
    }
  }, [activeAgentId, activeProfileName, agents])

  // Prefetch active profile sessions+history immediately; defer other
  // profiles' sessions lists only (no history) so the visible chat's
  // /api/history is not starved by N parallel history reads.
  useEffect(() => {
    if (!activeProfileName) return

    const prefetchSessions = (profileName: string) =>
      queryClient.prefetchQuery({
        queryKey: chatQueryKeys.sessionsForProfile(profileName),
        queryFn: () => fetchSessions(profileName),
        staleTime: 60_000,
      })

    void prefetchSessions(activeProfileName).then(() => {
      const cached = queryClient.getQueryData<Array<SessionMeta>>(
        chatQueryKeys.sessionsForProfile(activeProfileName),
      )
      prefetchSessionHistory(
        queryClient,
        activeProfileName,
        resolveSessionForProfile(cached, activeProfileName),
      )
    })
  }, [activeProfileName, queryClient])

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      const agent = agents.find((a) => a.agentId === agentId)
      if (!agent) return

      if (agent.runtime === 'hermes') {
        const targetProfile = agent.runtimeConfig.profile ?? agent.agentId
        if (targetProfile === activeProfileName) {
          // Already on the right profile; just make sure we land on a chat session.
          navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'new' } })
          return
        }

        void (async () => {
          await requestStreamHandoffIfActive()

          writeLastSession(activeFriendlyId, activeProfileName)
          setActiveProfileOptimistic(queryClient, targetProfile)
          preloadWorkspaceFolders(targetProfile)
          activateProfile(targetProfile)

          let profileSessions = queryClient.getQueryData<Array<SessionMeta>>(
            chatQueryKeys.sessionsForProfile(targetProfile),
          )
          let sessionsLoaded = Boolean(profileSessions)
          if (!profileSessions) {
            try {
              profileSessions = await queryClient.fetchQuery({
                queryKey: chatQueryKeys.sessionsForProfile(targetProfile),
                queryFn: () => fetchSessions(targetProfile),
                staleTime: 60_000,
              })
              sessionsLoaded = true
            } catch {
              profileSessions = []
              sessionsLoaded = true
            }
          }
          const targetSession = resolveSessionForProfile(
            profileSessions,
            targetProfile,
            { sessionsLoaded },
          )
          prefetchSessionHistory(queryClient, targetProfile, targetSession)
          navigate({
            to: '/chat/$sessionKey',
            params: { sessionKey: targetSession },
          })
        })()
        return
      }

      // Non-Hermes agent: switch to the agent workspace route.
      navigate({
        to: '/chat/agent/$agentId',
        params: { agentId: agent.agentId },
      })
    },
    [
      activeFriendlyId,
      activeProfileName,
      activateProfile,
      agents,
      navigate,
      queryClient,
    ],
  )

  const startSidebarResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = sidebarWidth
      const previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'

      const onMove = (moveEvent: MouseEvent) => {
        const nextWidth = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(
            SIDEBAR_MIN_WIDTH,
            startWidth + (moveEvent.clientX - startX),
          ),
        )
        setSidebarWidth(nextWidth)
      }

      const onUp = () => {
        document.body.style.userSelect = previousUserSelect
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [sidebarWidth],
  )

  const startSectionResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startY = event.clientY
      const startHeight = agentsHeight
      const containerHeight =
        sidebarRef.current?.clientHeight ?? window.innerHeight
      const maxHeight = Math.max(
        AGENTS_MIN_HEIGHT,
        containerHeight - SESSION_MIN_HEIGHT - 40,
      )
      const previousUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'

      const onMove = (moveEvent: MouseEvent) => {
        const nextHeight = Math.min(
          maxHeight,
          Math.max(
            AGENTS_MIN_HEIGHT,
            startHeight + (moveEvent.clientY - startY),
          ),
        )
        setAgentsHeight(nextHeight)
      }

      const onUp = () => {
        document.body.style.userSelect = previousUserSelect
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [agentsHeight],
  )

  return (
    <aside
      ref={sidebarRef}
      className="relative flex h-full flex-col border-r border-neutral-200 bg-[var(--theme-sidebar)] dark:border-neutral-800"
      data-tour="chat-session-sidebar"
      style={{ width: `${sidebarWidth}px` }}
    >
      {/* Agents list */}
      <div
        className="flex min-h-0 shrink-0 flex-col"
        style={{ height: `${agentsHeight}px` }}
      >
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
            Agents
          </span>
        </div>
        <ScrollAreaRoot className="min-h-0 flex-1 px-2 pb-2">
          <ScrollAreaViewport>
            <div className="flex flex-col gap-1 pr-2">
              <AgentList renderContainer={false} onSelect={handleSelectAgent} />
            </div>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar orientation="vertical">
            <ScrollAreaThumb />
          </ScrollAreaScrollbar>
        </ScrollAreaRoot>
      </div>

      <div
        className="group relative shrink-0"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize sidebar sections"
        onMouseDown={startSectionResize}
      >
        <div className="h-px bg-neutral-200 dark:bg-neutral-800" />
        <div className="absolute inset-x-0 -top-1.5 -bottom-1.5 cursor-row-resize" />
      </div>

      {/* Session list */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
            Sessions
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6 text-primary-500 hover:bg-primary-200 dark:hover:bg-primary-800"
            onClick={onNewChat}
            title="New session"
          >
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.5} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 px-1">
          <SidebarSessions
            sessions={sessions}
            activeFriendlyId={activeFriendlyId}
            profileName={activeProfileName}
            defaultOpen
            onRename={handleRename}
            onDelete={handleOpenDelete}
            loading={sessionsLoading}
            fetching={sessionsFetching}
            error={sessionsError}
            onRetry={onRetrySessions}
          />
        </div>
      </div>

      <SessionDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        sessionTitle={deleteSessionTitle}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteDialogOpen(false)}
      />

      <div
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize bg-transparent hover:bg-neutral-300/50 dark:hover:bg-neutral-700/50"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar width"
        onMouseDown={startSidebarResize}
      />
    </aside>
  )
})
