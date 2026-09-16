import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  agoraxAgentTargetIdForBackend,
  AgoraxManagedAgentHttpClient,
} from './agorax-managed-agent-http-client'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

describe('AgoraxManagedAgentHttpClient', () => {
  it('maps the selected backends to Tutti target ids', () => {
    expect(agoraxAgentTargetIdForBackend('claude-code')).toBe('local:claude-code')
    expect(agoraxAgentTargetIdForBackend('codex')).toBe('local:codex')
    expect(agoraxAgentTargetIdForBackend('cursor')).toBe('local:cursor')
    expect(agoraxAgentTargetIdForBackend('opencode')).toBe('local:opencode')
    expect(agoraxAgentTargetIdForBackend('kimi')).toBe('extension:kimi-code')
  })

  it('probes enabled targets and fail-closes missing targets', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          agents: [
            { id: 'local:cursor', enabled: true },
            { id: 'extension:kimi-code', enabled: false },
          ],
        }),
        { status: 200 },
      ),
    )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120/',
      workspaceId: 'workspace-1',
      fetchImpl,
    })

    await expect(client.probe('cursor')).resolves.toEqual({
      available: true,
      detail: 'Agorax managed target local:cursor is ready',
    })
    await expect(client.probe('kimi')).resolves.toEqual({
      available: false,
      detail: 'Agorax managed target extension:kimi-code is disabled',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9120/v1/agent-targets',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('uses canonical workspace session endpoints for create and input', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ session: { id: 'session-1' } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { id: 'session-1' } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: 'turn', turnId: 'turn-1' }), {
          status: 200,
        }),
      )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace/1',
      fetchImpl,
    })

    await client.createSession({
      backend: 'cursor',
      agentSessionId: 'session-1',
      clientSubmitId: 'submit-1',
      content: 'hello',
    })
    await client.sendInput('session-1', {
      clientSubmitId: 'submit-2',
      content: 'continue',
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions/session-1/input',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('binds a display run to the canonical session returned by Tutti', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          session: { id: 'canonical-session', activeTurnId: 'turn-1' },
        }),
        { status: 201 },
      ),
    )
    const root = await mkdtemp(path.join(tmpdir(), 'agorax-managed-http-'))
    const store = new AgoraxManagedRunStore(root)
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl,
    })

    await client.createSessionForRun({
      runId: 'display-run-1',
      runStore: store,
      session: {
        backend: 'codex',
        agentSessionId: 'requested-session',
        clientSubmitId: 'submit-1',
        content: 'hello',
      },
    })

    try {
      await expect(store.get('display-run-1')).resolves.toMatchObject({
        agentSessionId: 'canonical-session',
        turnId: 'turn-1',
        backend: 'codex',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})