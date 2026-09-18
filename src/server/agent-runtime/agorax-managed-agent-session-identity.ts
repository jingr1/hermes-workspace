import type { AgoraxManagedAgentBackend } from './agorax-managed-agent-bridge'
import { isAgoraxManagedAgentBackend } from './agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'
import { getAgentRuntimeRouter } from './router'

export type AgoraxManagedSessionIdentity =
  | { ok: true; backend: AgoraxManagedAgentBackend; agentSessionId: string }
  | { ok: false; status: number; error: string }

/**
 * Resolves an Agorax display session id to the canonical daemon agentSessionId
 * for a managed-backend agent declaration. Mirrors the lookup the legacy
 * activity route uses: the display-session binding wins when its backend
 * matches the declaration, then the raw id is tried as a run id, and the
 * display id itself is the last-resort canonical id (daemon-native sessions).
 */
export async function resolveAgoraxManagedSessionIdentity(input: {
  agentId: string
  sessionId: string
  runStore?: AgoraxManagedRunStore
}): Promise<AgoraxManagedSessionIdentity> {
  const agentId = input.agentId.trim()
  const sessionId = input.sessionId.trim()
  if (!agentId || !sessionId) {
    return { ok: false, status: 400, error: 'agentId and sessionId are required' }
  }
  const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
  if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
    return { ok: false, status: 404, error: 'Managed Agent is unavailable' }
  }
  const runStore = input.runStore ?? new AgoraxManagedRunStore()
  const displayBinding = await runStore.getByDisplaySession(sessionId)
  const binding =
    displayBinding?.backend === declaration.runtime
      ? displayBinding
      : await runStore.get(sessionId)
  const agentSessionId =
    binding?.backend === declaration.runtime ? binding.agentSessionId : sessionId
  return { ok: true, backend: declaration.runtime, agentSessionId }
}
