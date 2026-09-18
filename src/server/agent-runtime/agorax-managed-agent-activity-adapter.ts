import { randomUUID } from 'node:crypto'
import type {
  AgentActivityAdapter,
  AgentActivitySession,
  AgentPromptContentBlock,
} from '@agorax/agent-activity-core'
import {
  AGORAX_MANAGED_AGENT_USER_ID,
  AgoraxManagedAgentHttpClient,
} from './agorax-managed-agent-http-client'
import {
  agentActivitySessionFromDaemonSession,
  agentActivityTurnFromDaemonTurn,
  daemonCreateAgentSessionRequestFromActivity,
  daemonSendAgentSessionInputRequestFromActivity,
  type AgentActivitySessionMappingOptions,
  type DaemonCanonicalSession,
  type DaemonCanonicalTurn,
} from '@agorax/agent-activity-daemon-adapter'

export type AgoraxManagedAgentActivityAdapterOptions = {
  baseUrl: string
  workspaceId: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  /** Fallback user identity for canonical session mapping (daemon rows win). */
  userId?: string
}

/**
 * Core `AgentActivityAdapter` over the embedded Managed Agent daemon.
 *
 * The daemon dialect covers the read/reconcile surface (session list, detail,
 * paged messages) plus session creation, input submission and interaction
 * responses; everything is mapped through `@agorax/agent-activity-daemon-adapter`
 * into canonical core shapes. Daemon surface gaps (composer options, goal
 * control, session delete/rename/pin/fork, Agorax-mode activation) throw
 * explicit errors instead of fabricating data.
 */
export function createAgoraxManagedAgentActivityAdapter(
  options: AgoraxManagedAgentActivityAdapterOptions,
): AgentActivityAdapter {
  const client = new AgoraxManagedAgentHttpClient(options)
  const workspaceId = options.workspaceId.trim()
  const mappingOptions: AgentActivitySessionMappingOptions = {
    currentUserId: options.userId?.trim() || AGORAX_MANAGED_AGENT_USER_ID,
  }

  const assertWorkspace = (inputWorkspaceId: string): void => {
    if (inputWorkspaceId.trim() !== workspaceId) {
      throw new Error(
        `Agorax managed agent daemon adapter is bound to workspace ${JSON.stringify(workspaceId)}, not ${JSON.stringify(inputWorkspaceId)}`,
      )
    }
  }

  const unsupported = (operation: string): Error =>
    new Error(
      `Agorax managed agent daemon does not support ${operation} (no daemon REST endpoint)`,
    )

  const mapCanonicalSession = (
    canonical: DaemonCanonicalSession | null | undefined,
  ): AgentActivitySession => {
    if (!canonical) {
      throw new Error(
        'Agorax managed agent daemon response is missing the canonical session',
      )
    }
    return agentActivitySessionFromDaemonSession(workspaceId, canonical, mappingOptions)
  }

  return {
    async listSessions(input) {
      assertWorkspace(input.workspaceId)
      return { sessions: await client.listSessions({ signal: input.signal }) }
    },

    async listSessionMessages(input) {
      assertWorkspace(input.workspaceId)
      if (input.beforeVersion !== undefined) {
        throw new Error(
          'Agorax managed agent daemon does not support beforeVersion message paging (activity reads ascend from afterVersion only)',
        )
      }
      if (input.order !== undefined && input.order !== 'asc') {
        throw new Error(
          `Agorax managed agent daemon activity reads are ascending only (got order ${JSON.stringify(input.order)})`,
        )
      }
      return client.listSessionMessages(input.agentSessionId, {
        afterVersion: input.afterVersion,
        limit: input.limit,
        signal: input.signal,
      })
    },

    loadComposerOptions() {
      throw unsupported('composer options')
    },

    async createSession(input) {
      assertWorkspace(input.workspaceId)
      const initialContent: AgentPromptContentBlock[] = input.initialContent?.length
        ? [...input.initialContent]
        : input.initialDisplayPrompt?.trim()
          ? [{ type: 'text', text: input.initialDisplayPrompt }]
          : []
      const response = await client.createAgentSessionRequest(
        daemonCreateAgentSessionRequestFromActivity({
          ...input,
          agentSessionId: input.agentSessionId?.trim() || randomUUID(),
          initialContent,
        }),
        { signal: input.signal },
      )
      return mapCanonicalSession(response.Canonical ?? null)
    },

    async sendInput(input) {
      assertWorkspace(input.workspaceId)
      const response = await client.sendAgentSessionInputRequest(
        input.agentSessionId,
        daemonSendAgentSessionInputRequestFromActivity(input),
        { signal: input.signal },
      )
      const turn: DaemonCanonicalTurn | null = response.Turn ?? null
      const turnId = response.TurnID || turn?.TurnID || ''
      if (!turn || !turnId) {
        throw new Error(
          'Agorax managed agent daemon send response is missing the canonical turn',
        )
      }
      return {
        kind: 'turn',
        session: mapCanonicalSession(response.Canonical ?? null),
        turnId,
        turn: agentActivityTurnFromDaemonTurn(turn),
      }
    },

    updateAgoraxModeActivation() {
      throw unsupported('Agorax mode activation updates')
    },

    goalControl() {
      throw unsupported('goal control')
    },

    async submitInteractive(input) {
      assertWorkspace(input.workspaceId)
      const response = await client.respondToInteractionRaw(
        {
          agentSessionId: input.agentSessionId,
          turnId: input.turnId,
          requestId: input.requestId,
          ...(input.action ? { action: input.action } : {}),
          ...(input.optionId ? { optionId: input.optionId } : {}),
          ...(input.payload ? { payload: input.payload } : {}),
        },
        { signal: input.signal },
      )
      return { session: mapCanonicalSession(response.Canonical ?? null) }
    },

    deleteSession() {
      throw unsupported('session deletion')
    },

    deleteSessions() {
      throw unsupported('session deletion')
    },

    renameSession() {
      throw unsupported('session rename')
    },

    setSessionPinned() {
      throw unsupported('session pin')
    },

    forkSession() {
      throw unsupported('session fork')
    },
  }
}
