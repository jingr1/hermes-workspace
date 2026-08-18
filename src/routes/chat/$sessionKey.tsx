import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  chatQueryKeys,
  moveHistoryMessages,
  reconcileSessionDraft,
} from '../../screens/chat/chat-queries'
import { writeLastSession } from '../../screens/chat/last-session'
import { ChatRouteLoading } from '../../screens/chat/chat-route-loading'
import { ErrorBoundary } from '@/components/error-boundary'
import { useProfiles } from '../../screens/chat/hooks/use-profiles'

const ChatScreen = lazy(async () => {
  const module = await import('../../screens/chat/chat-screen')
  return { default: module.ChatScreen }
})

export const Route = createFileRoute('/chat/$sessionKey')({
  component: ChatRoute,
  pendingComponent: ChatRouteLoading,
  // Disable SSR to prevent hydration mismatches from async data
  ssr: false,
  errorComponent: function ChatError({ error, reset }) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center bg-primary-50">
        <div className="max-w-md">
          <div className="mb-4 text-5xl">💬</div>
          <h2 className="text-xl font-semibold text-primary-900 mb-3">
            Chat Error
          </h2>
          <p className="text-sm text-primary-600 mb-6">
            {error instanceof Error
              ? error.message
              : 'Failed to load chat session'}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={reset}
              className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={() => {
                if (typeof window !== 'undefined')
                  window.location.href = '/chat'
              }}
              className="px-4 py-2 border border-primary-300 text-primary-700 rounded-lg hover:bg-primary-100 transition-colors"
            >
              Return to Main
            </button>
          </div>
        </div>
      </div>
    )
  },
})

function ChatRoute() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { activeProfileName } = useProfiles()
  const [forcedSession, setForcedSession] = useState<{
    friendlyId: string
    sessionKey: string
  } | null>(null)
  const params = Route.useParams()
  const activeFriendlyId =
    typeof params.sessionKey === 'string' ? params.sessionKey : 'main'
  const isNewChat = activeFriendlyId === 'new'
  const forcedSessionKey =
    forcedSession?.friendlyId === activeFriendlyId
      ? forcedSession.sessionKey
      : undefined

  // Clear history cache when navigating to new chat
  useEffect(() => {
    if (isNewChat) {
      queryClient.removeQueries({ queryKey: ['chat', 'history', 'new', 'new'] })
    }
  }, [isNewChat, queryClient])

  const handleSessionResolved = useCallback(
    function handleSessionResolved(payload: {
      friendlyId: string
      sessionKey: string
    }) {
      const sourceFriendlyId = activeFriendlyId
      const sourceSessionKey = forcedSessionKey ?? activeFriendlyId
      moveHistoryMessages(
        queryClient,
        sourceFriendlyId,
        sourceSessionKey,
        payload.friendlyId,
        payload.sessionKey,
      )
      reconcileSessionDraft(
        queryClient,
        activeProfileName,
        sourceFriendlyId,
        sourceSessionKey,
        payload.friendlyId,
        payload.sessionKey,
      )
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
      setForcedSession({
        friendlyId: payload.friendlyId,
        sessionKey: payload.sessionKey,
      })
      writeLastSession(payload.friendlyId, activeProfileName)
      navigate({
        to: '/chat/$sessionKey',
        params: { sessionKey: payload.friendlyId },
        replace: true,
      })
    },
    [activeFriendlyId, activeProfileName, forcedSessionKey, navigate, queryClient],
  )

  return (
    <ErrorBoundary>
      <Suspense fallback={<ChatRouteLoading />}>
        <ChatScreen
          activeFriendlyId={activeFriendlyId}
          isNewChat={isNewChat}
          forcedSessionKey={forcedSessionKey}
          onSessionResolved={
            isNewChat || activeFriendlyId === 'main'
              ? handleSessionResolved
              : undefined
          }
        />
      </Suspense>
    </ErrorBoundary>
  )
}
