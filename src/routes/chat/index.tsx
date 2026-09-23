import { createFileRoute, redirect } from '@tanstack/react-router'
import { ChatRouteLoading } from '../../screens/chat/chat-route-loading'
import { readLastAgent } from '../../screens/chat/last-session'
import { fetchAgents } from '../../lib/agent-api'

/**
 * Resolve which agent `/chat` should open.
 * Prefer: last used → first online → first in registry.
 * Never invent a product-specific id like `orchestrator` — if the registry is
 * empty the route still needs a param, so fall back to Hermes `default` profile
 * (vanilla single-home installs), not a swarm worker name.
 */
async function resolveDefaultAgentId(): Promise<string> {
  const lastAgent = readLastAgent()
  if (lastAgent) return lastAgent
  try {
    const data = await fetchAgents()
    const firstOnline = data.agents.find((a) => a.status === 'online')
    if (firstOnline) return firstOnline.agentId
    if (data.agents.length > 0) return data.agents[0].agentId
  } catch {
    // Registry unavailable — keep last-agent if any, else vanilla default.
  }
  return lastAgent || 'default'
}

export const Route = createFileRoute('/chat/')({
  ssr: false,
  pendingComponent: ChatRouteLoading,
  beforeLoad: async () => {
    const agentId = await resolveDefaultAgentId()
    throw redirect({
      to: '/chat/agent/$agentId',
      params: { agentId },
      replace: true,
    })
  },
  component: function ChatIndexRoute() {
    return <ChatRouteLoading />
  },
})
