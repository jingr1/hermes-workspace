import type { AgentProbeResult } from './types'
import type {
  AgoraxManagedAgentBackend,
} from './agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

export type AgoraxManagedAgentHttpClientOptions = {
  baseUrl: string
  workspaceId: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

export type CreateAgoraxAgentSessionInput = {
  backend: AgoraxManagedAgentBackend
  agentSessionId: string
  clientSubmitId: string
  content: string
  cwd?: string
  model?: string
  title?: string
}

export type SendAgoraxAgentInput = {
  content: string
  clientSubmitId: string
}

type CanonicalSessionProjection = {
  id: string
  activeTurnId: string | null
}

type CanonicalTurnProjection = {
  turnId: string
}

type CreateSessionResponse = {
  session: CanonicalSessionProjection
}

type SendInputResponse = {
  kind: 'turn'
  session: CanonicalSessionProjection
  turnId: string
  turn: CanonicalTurnProjection
}

const BACKEND_TARGET_IDS: Record<AgoraxManagedAgentBackend, string> = {
  'claude-code': 'local:claude-code',
  codex: 'local:codex',
  cursor: 'local:cursor',
  opencode: 'local:opencode',
  kimi: 'extension:kimi-code',
}

export function agoraxAgentTargetIdForBackend(
  backend: AgoraxManagedAgentBackend,
): string {
  return BACKEND_TARGET_IDS[backend]
}

/**
 * Thin Agorax transport client for the embedded Managed Agent daemon API.
 *
 * It returns Tutti's canonical JSON projections without creating an Agorax
 * session store or translating them into the legacy managed-chat schema.
 */
export class AgoraxManagedAgentHttpClient {
  private readonly baseUrl: string
  private readonly workspaceId: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch

  constructor(options: AgoraxManagedAgentHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.workspaceId = options.workspaceId.trim()
    this.headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    }
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async probe(backend: AgoraxManagedAgentBackend): Promise<AgentProbeResult> {
    const response = await this.requestJson<{ agents?: Array<Record<string, unknown>> }>(
      '/v1/agent-targets',
      { method: 'GET' },
    )
    const targetId = agoraxAgentTargetIdForBackend(backend)
    const target = response.agents?.find((candidate) => candidate.id === targetId)
    if (!target) {
      return {
        available: false,
        detail: `Agorax managed target ${targetId} is not registered`,
      }
    }
    if (target.enabled === false) {
      return {
        available: false,
        detail: `Agorax managed target ${targetId} is disabled`,
      }
    }
    return { available: true, detail: `Agorax managed target ${targetId} is ready` }
  }

  async createSession(
    input: CreateAgoraxAgentSessionInput,
  ): Promise<CreateSessionResponse> {
    return this.requestJson<CreateSessionResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions`,
      {
        method: 'POST',
        body: JSON.stringify({
          agentSessionId: input.agentSessionId,
          agentTargetId: agoraxAgentTargetIdForBackend(input.backend),
          clientSubmitId: input.clientSubmitId,
          initialContent: [{ type: 'text', text: input.content }],
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model, modelExplicit: true } : {}),
          ...(input.title ? { title: input.title } : {}),
        }),
      },
    )
  }

  sendInput(
    agentSessionId: string,
    input: SendAgoraxAgentInput,
  ): Promise<SendInputResponse> {
    return this.requestJson<SendInputResponse>(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/input`,
      {
        method: 'POST',
        body: JSON.stringify({
          clientSubmitId: input.clientSubmitId,
          content: [{ type: 'text', text: input.content }],
        }),
      },
    )
  }

  async createSessionForRun(input: {
    runId: string
    session: CreateAgoraxAgentSessionInput
    runStore: AgoraxManagedRunStore
  }): Promise<CreateSessionResponse> {
    const response = await this.createSession(input.session)
    await input.runStore.bind({
      runId: input.runId,
      backend: input.session.backend,
      agentSessionId: response.session.id,
      ...(response.session.activeTurnId
        ? { turnId: response.session.activeTurnId }
        : {}),
    })
    return response
  }

  getSessionDetail(agentSessionId: string): Promise<unknown> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}`,
      { method: 'GET' },
    )
  }

  cancelTurn(agentSessionId: string, turnId: string): Promise<unknown> {
    return this.requestJson(
      `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      { method: 'POST' },
    )
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers,
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      throw new Error(`Agorax Managed Agent request failed: ${response.status} ${path}`)
    }
    return (await response.json()) as T
  }
}