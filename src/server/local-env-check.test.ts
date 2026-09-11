import { describe, expect, it } from 'vitest'
import { checkLocalEnvForAgent } from './local-env-check'

describe('local-env-check', () => {
  it('detects codex if installed', async () => {
    const result = await checkLocalEnvForAgent('codex-impl')
    expect(result).not.toBeNull()
    expect(result?.agentId).toBe('codex-impl')
    expect(result?.name).toBe('Codex')
    expect(result?.command).toBe('codex')
    expect(result?.installed).toBe(true)
    expect(result?.currentVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(result?.latestVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(result?.envType).toBe('linux')
  })

  it('detects claude code if installed', async () => {
    const result = await checkLocalEnvForAgent('cc-impl')
    expect(result).not.toBeNull()
    expect(result?.agentId).toBe('cc-impl')
    expect(result?.name).toBe('Claude Code')
    expect(result?.command).toBe('claude')
    expect(result?.installed).toBe(true)
    expect(result?.currentVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(result?.latestVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('returns null for unsupported agents', async () => {
    const result = await checkLocalEnvForAgent('not-an-agent')
    expect(result).toBeNull()
  })
})
