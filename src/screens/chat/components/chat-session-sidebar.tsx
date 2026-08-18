'use client'

import { HugeiconsIcon } from '@hugeicons/react'
import { Add01Icon, UserGroupIcon } from '@hugeicons/core-free-icons'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useGatewayPoolStatus, useProfiles, setActiveProfileOptimistic } from '../hooks/use-profiles'
import { useRenameSession } from '../hooks/use-rename-session'
import { useDeleteSession } from '../hooks/use-delete-session'
import { chatQueryKeys, fetchHistory, fetchSessions } from '../chat-queries'
import { resolveSessionForProfile, writeLastSession } from '../last-session'
import { SidebarSessions } from './sidebar/sidebar-sessions'
import { SessionDeleteDialog } from './sidebar/session-delete-dialog'
import type { SessionMeta } from '../types'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@/components/ui/scroll-area'

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

function profileMeta(profile: {
  model?: string
  provider?: string
}): string {
  return [profile.model, profile.provider]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' · ')
}

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
  const {
    profiles,
    activeProfileName,
    activateProfile,
    isLoading: profilesLoading,
    isError: profilesError,
  } = useProfiles()
  const gatewayPoolQuery = useGatewayPoolStatus()
  const gatewayByName = useMemo(() => {
    const map = new Map<
      string,
      { state?: string; port?: number }
    >()
    for (const entry of gatewayPoolQuery.data?.gateways ?? []) {
      map.set(entry.profile, entry)
    }
    return map
  }, [gatewayPoolQuery.data?.gateways])

  const { renameSession } = useRenameSession()
  const { deleteSession } = useDeleteSession()

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteSessionKey, setDeleteSessionKey] = useState<string | null>(null)
  const [deleteFriendlyId, setDeleteFriendlyId] = useState<string | null>(null)
  const [deleteSessionTitle, setDeleteSessionTitle] = useState('')

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
      session.label || session.title || session.derivedTitle || session.friendlyId,
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

  const sortedProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => a.name.localeCompare(b.name))
  }, [profiles])

  // Prefetch session lists + first-session history so profile switches paint instantly.
  useEffect(() => {
    for (const profile of profiles) {
      void queryClient
        .prefetchQuery({
          queryKey: chatQueryKeys.sessionsForProfile(profile.name),
          queryFn: () => fetchSessions(profile.name),
          staleTime: 60_000,
        })
        .then(() => {
          const cached = queryClient.getQueryData<Array<SessionMeta>>(
            chatQueryKeys.sessionsForProfile(profile.name),
          )
          prefetchSessionHistory(
            queryClient,
            profile.name,
            resolveSessionForProfile(cached, profile.name),
          )
        })
    }
  }, [profiles, queryClient])

  const handleSelectProfile = useCallback(
    (profileName: string) => {
      if (profileName === activeProfileName) return

      const cached = queryClient.getQueryData<Array<SessionMeta>>(
        chatQueryKeys.sessionsForProfile(profileName),
      )
      writeLastSession(activeFriendlyId, activeProfileName)
      const targetSession = resolveSessionForProfile(cached, profileName)
      setActiveProfileOptimistic(queryClient, profileName)
      prefetchSessionHistory(queryClient, profileName, targetSession)
      navigate({
        to: '/chat/$sessionKey',
        params: { sessionKey: targetSession },
      })

      activateProfile(profileName)

      void queryClient.prefetchQuery({
        queryKey: chatQueryKeys.sessionsForProfile(profileName),
        queryFn: () => fetchSessions(profileName),
        staleTime: 60_000,
      })
    },
    [activateProfile, activeFriendlyId, activeProfileName, queryClient, navigate],
  )

  return (
    <aside
      className="flex h-full w-[260px] flex-col border-r border-primary-200 bg-[var(--theme-sidebar)] dark:border-primary-800"
      data-tour="chat-session-sidebar"
    >
      {/* Profile list */}
      <div className="flex min-h-0 flex-[1.2] flex-col border-b border-primary-200 dark:border-primary-800">
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
            Profiles
          </span>
          <Link
            to="/profiles"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              'size-6 text-primary-500 hover:bg-primary-200 dark:hover:bg-primary-800',
            )}
            title="Manage profiles"
          >
            <HugeiconsIcon icon={UserGroupIcon} size={14} strokeWidth={1.5} />
          </Link>
        </div>

        {profilesLoading && profiles.length === 0 ? (
          <div className="px-3 py-2 text-xs text-primary-500">Loading profiles…</div>
        ) : profilesError ? (
          <div className="px-3 py-2 text-xs text-red-500">Failed to load profiles.</div>
        ) : (
          <ScrollAreaRoot className="min-h-0 flex-1 px-2 pb-2">
            <ScrollAreaViewport>
              <div className="flex flex-col gap-1 pr-2">
                {sortedProfiles.map((profile) => {
                  const isActive = profile.name === activeProfileName
                  const gateway = gatewayByName.get(profile.name)
                  const gatewayHealthy =
                    gateway?.state === 'healthy' ||
                    profile.gatewayState === 'healthy'
                  const gatewayPort = gateway?.port ?? profile.gatewayPort
                  return (
                    <button
                      key={profile.name}
                      type="button"
                      onClick={() => handleSelectProfile(profile.name)}
                      className={cn(
                        'flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors',
                        isActive
                          ? 'bg-accent-500/10 text-accent-500'
                          : 'text-primary-900 hover:bg-primary-200 dark:hover:bg-primary-800',
                      )}
                      title={
                        gatewayHealthy
                          ? `${profile.name} — gateway running${gatewayPort ? ` :${gatewayPort}` : ''}`
                          : `${profile.name} — gateway stopped`
                      }
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <span
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            gatewayHealthy ? 'bg-emerald-400' : 'bg-neutral-500',
                          )}
                          aria-hidden="true"
                        />
                        <span className="truncate">{profile.name}</span>
                        {isActive ? (
                          <span className="shrink-0 text-[9px] text-accent-500">active</span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {profileMeta(profile) ? (
                          <span className="mt-0.5 max-w-[180px] truncate text-[10px] text-primary-500">
                            {profileMeta(profile)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </ScrollAreaViewport>
            <ScrollAreaScrollbar orientation="vertical">
              <ScrollAreaThumb />
            </ScrollAreaScrollbar>
          </ScrollAreaRoot>
        )}
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
    </aside>
  )
})
