import { describe, expect, it } from 'vitest'
import { runAgentEnvAction } from './agent-env-action'

describe('agent-env-action', () => {
  it('updates codex via npm', async () => {
    const result = await runAgentEnvAction({
      agentId: 'codex-impl',
      action: 'update',
    })
    expect(result.ok).toBe(true)
    expect(result.agentId).toBe('codex-impl')
    expect(result.action).toBe('update')
    expect(result.exitCode).toBe(0)
    expect(result.command).toContain('npm')
    expect(result.command).toContain('@openai/codex@latest')
  }, 60_000)

  it('rejects unsupported agents', async () => {
    const result = await runAgentEnvAction({
      agentId: 'not-an-agent',
      action: 'install',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Unsupported agent')
  })
})
