import { createFileRoute, redirect } from '@tanstack/react-router'
import { ChatRouteLoading } from '../../screens/chat/chat-route-loading'
import { readLastAgent } from '../../screens/chat/last-session'
import { fetchAgents } from '../../lib/agent-api'

async function resolveDefaultAgentId(): Promise<string> {
  const lastAgent = readLastAgent()
  if (lastAgent) return lastAgent
  try {
    const data = await fetchAgents()
    const firstOnline = data.agents.find((a) => a.status === 'online')
    if (firstOnline) return firstOnline.agentId
    if (data.agents.length > 0) return data.agents[0].agentId
    return 'default'
  } catch {
    return 'default'
  }
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
