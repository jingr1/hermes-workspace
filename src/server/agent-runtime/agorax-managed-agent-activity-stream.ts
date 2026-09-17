import type { AgentStreamEvent } from './types'
import {
  agoraxEventsFromManagedActivity,
  type AgoraxManagedAgentActivity,
} from './agorax-managed-agent-events'

type SocketLike = {
  on: (event: string, listener: (...args: Array<unknown>) => void) => void
  close: () => void
}

type ActivityFrame = {
  kind: 'event'
  event: {
    topic: 'agent.activity.updated'
    payload: AgoraxManagedAgentActivity & {
      workspaceId: string
      agentSessionId: string
    }
  }
}

export function parseAgoraxManagedActivityFrame(
  raw: unknown,
  workspaceId: string,
  agentSessionId: string,
): AgoraxManagedAgentActivity | null {
  if (!raw || typeof raw !== 'object') return null
  const frame = raw as Partial<ActivityFrame>
  if (frame.kind !== 'event' || frame.event?.topic !== 'agent.activity.updated') {
    return null
  }
  const payload = frame.event.payload
  if (
    !payload ||
    payload.workspaceId !== workspaceId ||
    payload.agentSessionId !== agentSessionId
  ) {
    return null
  }
  return payload
}

export type AgoraxManagedAgentActivitySocket = {
  onMessage: (listener: (raw: unknown) => void) => void
  onError: (listener: (error: Error) => void) => void
  close: () => void
}

export type AgoraxManagedAgentActivitySocketFactory = (input: {
  url: string
  workspaceId: string
}) => AgoraxManagedAgentActivitySocket

export class AgoraxManagedAgentActivityStream {
  private socket: AgoraxManagedAgentActivitySocket | null = null

  constructor(
    private readonly input: {
      url: string
      workspaceId: string
      agentSessionId: string
      runId: string
      socketFactory: AgoraxManagedAgentActivitySocketFactory
      onEvents: (events: Array<AgentStreamEvent>) => void
      onError?: (error: Error) => void
    },
  ) {}

  connect(): void {
    if (this.socket) return
    const socket = this.input.socketFactory({
      url: this.input.url,
      workspaceId: this.input.workspaceId,
    })
    this.socket = socket
    socket.onMessage((raw) => {
      const activity = parseAgoraxManagedActivityFrame(
        raw,
        this.input.workspaceId,
        this.input.agentSessionId,
      )
      if (!activity) return
      const events = agoraxEventsFromManagedActivity(
        this.input.runId,
        activity,
        this.input.workspaceId,
      )
      if (events.length > 0) this.input.onEvents(events)
    })
    socket.onError((error) => this.input.onError?.(error))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}