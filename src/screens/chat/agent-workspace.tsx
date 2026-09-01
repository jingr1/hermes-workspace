'use client'

import { ChatWorkspace } from './components/chat-workspace'
import { useAgentWorkspace } from './hooks/use-agent-workspace'

export function AgentWorkspace() {
  useAgentWorkspace()

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ChatWorkspace />
    </div>
  )
}
