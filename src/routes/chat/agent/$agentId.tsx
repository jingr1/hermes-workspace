import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Suspense, lazy, useEffect, useState } from 'react'
import { z } from 'zod'
import { ChatRouteLoading } from '../../../screens/chat/chat-route-loading'
import { useAgentStore } from '../../../stores/agent-store'
import { fetchAgents, fetchSessionsForAgent } from '../../../lib/agent-api'
import { ErrorBoundary } from '@/components/error-boundary'
import { resolveSessionForProfile } from '../../../screens/chat/last-session'
import {
  chatQueryKeys,
  fetchSessions,
} from '../../../screens/chat/chat-queries'
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

    const resolveSessionForAgent = async (
      id: string,
    ): Promise<string | null> => {
      const fromUrl = search.session?.trim()

      const agent = useAgentStore
        .getState()
        .agents.find((entry) => entry.agentId === id)
      if (!agent) return null

      if (agent.runtime === 'hermes') {
        if (fromUrl && fromUrl !== 'new') return fromUrl
        const profile = agent.runtimeConfig.profile ?? agent.agentId
        let sessions = queryClient.getQueryData<Array<SessionMeta>>(
          chatQueryKeys.sessionsForProfile(profile),
        )
        let sessionsLoaded = sessions !== undefined
        if (!sessionsLoaded) {
          try {
            sessions = await fetchSessions(profile)
            if (cancelled) return null
            queryClient.setQueryData(
              chatQueryKeys.sessionsForProfile(profile),
              sessions,
            )
            sessionsLoaded = true
          } catch {
            if (cancelled) return null
            sessions = []
            sessionsLoaded = false
          }
        }
        const resolved = resolveSessionForProfile(sessions, profile, {
          sessionsLoaded,
        })
        return resolved === 'new' ? null : resolved
      }

      // Claude Code / managed: restore from store (SQLite-backed list) or last-session.
      const cached = useAgentStore.getState().sessionsByAgentId.get(id) ?? []
      const knownIds = new Set(cached.map((session) => session.sessionId))
      if (fromUrl && fromUrl !== 'new' && knownIds.has(fromUrl)) return fromUrl
      const local = cached.map((session) => ({
        friendlyId: session.sessionId,
      }))
      const resolved = resolveSessionForProfile(local, id, {
        sessionsLoaded:
          cached.length > 0 ||
          useAgentStore.getState().sessionsByAgentId.has(id),
      })
      return resolved === 'new' ? null : resolved
    }

    const applyAgent = async () => {
      if (cancelled) return
      const agent = useAgentStore
        .getState()
        .agents.find((entry) => entry.agentId === agentId)
      if (
        agent &&
        agent.runtime !== 'hermes' &&
        !useAgentStore.getState().sessionsByAgentId.has(agentId)
      ) {
        try {
          const data = await fetchSessionsForAgent(agentId)
          if (cancelled) return
          useAgentStore.getState().setSessions(agentId, data.sessions)
        } catch {
          if (cancelled) return
          useAgentStore.getState().setSessions(agentId, [])
        }
      }
      const sessionId = await resolveSessionForAgent(agentId)
      if (cancelled) return
      setActiveAgentId(agentId || null, { sessionId })
      setSeeded(true)
    }

    if (useAgentStore.getState().agents.length === 0) {
      fetchAgents()
        .then((data) => {
          if (cancelled) return
          useAgentStore.getState().setAgents(data.agents)
          void applyAgent()
        })
        .catch(() => void applyAgent())
    } else {
      void applyAgent()
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
    return useAgentStore.subscribe((state, prev) => {
      const currentSession = state.activeSessionId
      const agentChanged = state.activeAgentId !== prev.activeAgentId

      if (currentSession && currentSession !== search.session) {
        void navigate({
          search: { session: currentSession },
          replace: true,
        })
        return
      }

      // Only clear ?session= for an intentional New Chat on the same agent.
      // Agent switches briefly null the session before restore — wiping the
      // URL here caused Claude Code to land on blank "New Chat".
      if (!currentSession && search.session && !agentChanged) {
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
