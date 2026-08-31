import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  getAgentStatuses,
  startAgentStatusWatcher,
} from '../../../server/agent-status-watcher'

/**
 * GET /api/agents/status
 *
 * Returns the current snapshot of all declared agents: Hermes profiles are
 * read from their runtime.json files, CLI adapters are filled in from live
 * events. The response is the initial payload; subscribe to
 * /api/collab-events?scope=global for incremental updates.
 */
export const Route = createFileRoute('/api/agents/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        startAgentStatusWatcher()
        const { agents } = getAgentStatuses()

        return json({
          ok: true,
          agents: agents.map((a) => ({ ...a })),
          onlineCount: agents.filter((a) => a.online).length,
          executingCount: agents.filter(
            (a) => a.state === 'executing' || a.state === 'thinking',
          ).length,
          blockedCount: agents.filter(
            (a) => a.needsHuman || a.state === 'blocked',
          ).length,
        })
      },
    },
  },
})

export async function handleAgentsStatus(
  request: Request,
  deps?: { isAuthenticated?: (r: Request) => boolean },
): Promise<Response> {
  const auth = deps?.isAuthenticated ?? isAuthenticated
  if (!auth(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  startAgentStatusWatcher()
  const { agents } = getAgentStatuses()
  return json({
    ok: true,
    agents: agents.map((a) => ({ ...a })),
    onlineCount: agents.filter((a) => a.online).length,
    executingCount: agents.filter(
      (a) => a.state === 'executing' || a.state === 'thinking',
    ).length,
    blockedCount: agents.filter((a) => a.needsHuman || a.state === 'blocked')
      .length,
  })
}
