/**
 * HTTP fallback when the managed-agent WS misses a terminal turn_update.
 *
 * Group-chat drain normally ends on WS `run_exited`. When the daemon settles
 * the turn but the terminal frame is dropped/rejected, drain would otherwise
 * sit until the soft timeout and report "empty reply". GET .../activity is the
 * authoritative aggregate — use it to recover assistant text or turn errors.
 */
import { assistantTextFromActivityMessage } from './agorax-managed-agent-events'
import { AgoraxManagedAgentHttpClient } from './agorax-managed-agent-http-client'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

export type ReconciledManagedRun = {
  settled: boolean
  text: string
  error: string | null
  outcome: string | null
  exitCode: number | null
}

export type ReconcileManagedRunActivity = (
  runId: string,
) => Promise<ReconciledManagedRun | null>

function clientFromEnv(): AgoraxManagedAgentHttpClient | null {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

/**
 * Pull the latest settled turn facts for a display runId.
 * Returns null when env/binding/activity is unavailable (fail closed: caller
 * keeps the WS/timeout path).
 */
export async function reconcileManagedRunActivity(
  runId: string,
  deps?: {
    runStore?: AgoraxManagedRunStore
    client?: AgoraxManagedAgentHttpClient | null
  },
): Promise<ReconciledManagedRun | null> {
  const client = deps?.client !== undefined ? deps.client : clientFromEnv()
  if (!client) return null
  const runStore = deps?.runStore ?? new AgoraxManagedRunStore()
  const binding = await runStore.get(runId)
  if (!binding?.agentSessionId) return null

  try {
    const detail = await client.getSessionDetail(binding.agentSessionId)
    const turn =
      detail.session.latestTurn ??
      detail.turns
        .slice()
        .sort((a, b) => b.updatedAtUnixMs - a.updatedAtUnixMs)[0] ??
      null
    if (!turn || turn.phase !== 'settled') {
      return {
        settled: false,
        text: '',
        error: null,
        outcome: null,
        exitCode: null,
      }
    }

    let text = ''
    for (const message of detail.messages) {
      if (turn.turnId && message.turnId && message.turnId !== turn.turnId) {
        continue
      }
      const snap = assistantTextFromActivityMessage(message)
      if (snap) text = snap
    }

    const error = turn.error?.message?.trim() || null
    const outcome = turn.outcome ?? null
    const exitCode =
      outcome === 'completed' ? 0 : outcome == null ? null : 1

    return { settled: true, text, error, outcome, exitCode }
  } catch {
    return null
  }
}
