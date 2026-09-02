import type { AgentSession, AgentWithStatus } from './agent-types'

const API_BASE = '/api/agents'

export async function fetchAgents(): Promise<{
  agents: Array<AgentWithStatus>
}> {
  const res = await fetch(API_BASE)
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to fetch agents: ${res.status} ${text}`)
  }
  return (await res.json()) as { agents: Array<AgentWithStatus> }
}

export async function fetchSessionsForAgent(
  agentId: string,
): Promise<{ sessions: Array<AgentSession> }> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(agentId)}/sessions`)
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to fetch sessions: ${res.status} ${text}`)
  }
  return (await res.json()) as { sessions: Array<AgentSession> }
}

export async function createSessionForAgent(
  agentId: string,
  payload: { title?: string; model?: string } = {},
): Promise<{ sessionId: string }> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(agentId)}/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`Failed to create session: ${res.status} ${text}`)
  }
  return (await res.json()) as { sessionId: string }
}

export function subscribeAgentEvents(
  onMessage: (event: unknown) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource('/api/collab-events?scope=global')
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as unknown
      onMessage(parsed)
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
  source.onerror = () => {
    onError?.(new Error('SSE connection error'))
  }
  return () => source.close()
}
