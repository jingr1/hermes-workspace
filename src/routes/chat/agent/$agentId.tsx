import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Suspense, lazy, useEffect, useState } from 'react'
import { z } from 'zod'
import { ChatRouteLoading } from '../../../screens/chat/chat-route-loading'
import { useAgentStore } from '../../../stores/agent-store'
import { fetchAgents } from '../../../lib/agent-api'
import { ErrorBoundary } from '@/components/error-boundary'
import { resolveSessionForProfile } from '../../../screens/chat/last-session'
import { chatQueryKeys } from '../../../screens/chat/chat-queries'
import type { SessionMeta } from '../../../screens/chat/types'
import { useQueryClient } from '@tanstack/react-query'

const loadAgentWorkspace = () =>
  import('../../../screens/chat/agent-workspace').then((module) => ({
    default: module.AgentWorkspace,
  }))

const AgentWorkspace = lazy(loadAgentWorkspace)

const chatAgentSearchSchema = z.object({
  session: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/chat/agent/$agentId')({
  component: ChatAgentRoute,
  pendingComponent: ChatRouteLoading,
  ssr: false,
  validateSearch: chatAgentSearchSchema,
  errorComponent: function ChatAgentError({ error, reset }) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center bg-primary-50">
        <div className="max-w-md">
          <div className="mb-4 text-5xl">💬</div>
          <h2 className="text-xl font-semibold text-primary-900 mb-3">
            Agent Workspace Error
          </h2>
          <p className="text-sm text-primary-600 mb-6">
            {error instanceof Error
              ? error.message
              : 'Failed to load agent workspace'}
          </p>
          <button
            onClick={reset}
            className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  },
})

function ChatAgentRoute() {
  const params = Route.useParams()
  const search = useSearch({ from: Route.id })
  const navigate = useNavigate({ from: Route.id })
  const queryClient = useQueryClient()
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  const setActiveAgentId = useAgentStore((s) => s.setActiveAgentId)
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  const [seeded, setSeeded] = useState(false)

  // Seed agents once, then keep activeAgentId in sync with the URL agent param.
  // Do NOT re-run this when only ?session= changes — clearing the session on
  // agent switch used to re-apply the *old* URL agentId and wipe the click.
  useEffect(() => {
    let cancelled = false

    const resolveSessionForAgent = (id: string): string | null => {
      const fromUrl = search.session?.trim()
      if (fromUrl && fromUrl !== 'new') return fromUrl

      const agent = useAgentStore
        .getState()
        .agents.find((entry) => entry.agentId === id)
      if (!agent || agent.runtime !== 'hermes') return null

      const profile = agent.runtimeConfig.profile ?? agent.agentId
      const cached = queryClient.getQueryData<Array<SessionMeta>>(
        chatQueryKeys.sessionsForProfile(profile),
      )
      const resolved = resolveSessionForProfile(cached, profile, {
        sessionsLoaded: cached !== undefined,
      })
      return resolved === 'new' ? null : resolved
    }

    const applyAgent = () => {
      if (cancelled) return
      const sessionId = resolveSessionForAgent(agentId)
      setActiveAgentId(agentId || null, { sessionId })
      setSeeded(true)
    }

    if (useAgentStore.getState().agents.length === 0) {
      fetchAgents()
        .then((data) => {
          if (cancelled) return
          useAgentStore.getState().setAgents(data.agents)
          applyAgent()
        })
        .catch(() => applyAgent())
    } else {
      applyAgent()
    }

    return () => {
      cancelled = true
    }
    // Only re-run on agentId. Session-only URL changes use the effect below;
    // putting search.session here would restore "last session" and undo New Chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [agentId, queryClient, setActiveAgentId])

  // Apply session from the URL when present (e.g. picking a session in-sidebar
  // without changing agent). Agent switches set session atomically above.
  useEffect(() => {
    if (search.session) {
      setActiveSessionId(search.session)
    }
  }, [search.session, setActiveSessionId])

  // Keep the URL in sync with the active session selection.
  useEffect(() => {
    return useAgentStore.subscribe((state) => {
      const currentSession = state.activeSessionId
      if (currentSession && currentSession !== search.session) {
        void navigate({
          search: { session: currentSession },
          replace: true,
        })
      }
      if (!currentSession && search.session) {
        void navigate({
          search: {},
          replace: true,
        })
      }
    })
  }, [navigate, search.session])

  if (!seeded) {
    return <ChatRouteLoading />
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<ChatRouteLoading />}>
        <AgentWorkspace />
      </Suspense>
    </ErrorBoundary>
  )
}
