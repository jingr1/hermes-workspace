import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Suspense, lazy, useEffect, useState } from 'react'
import { z } from 'zod'
import { ChatRouteLoading } from '../../../screens/chat/chat-route-loading'
import { useAgentStore } from '../../../stores/agent-store'
import { fetchAgents } from '../../../lib/agent-api'
import { ErrorBoundary } from '@/components/error-boundary'

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
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  const setActiveAgentId = useAgentStore((s) => s.setActiveAgentId)
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  const [seeded, setSeeded] = useState(false)

  // Seed the agent store if it is empty, then set the active agent/session.
  // Wait for seeding to finish before rendering AgentWorkspace so that
  // useAgentWorkspace does not race with this route and pick a different
  // default agent (e.g. orchestrator) from the URL target agent.
  useEffect(() => {
    const applyAgent = () => {
      setActiveAgentId(agentId || null)
      if (search.session) {
        setActiveSessionId(search.session)
      }
      setSeeded(true)
    }

    if (useAgentStore.getState().agents.length === 0) {
      fetchAgents()
        .then((data) => {
          useAgentStore.getState().setAgents(data.agents)
          applyAgent()
        })
        .catch(() => applyAgent())
    } else {
      applyAgent()
    }
  }, [agentId, search.session, setActiveAgentId, setActiveSessionId])

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
