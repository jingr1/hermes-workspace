import { describe, expect, it, vi } from 'vitest'
import { handleAgentsStatus } from './agents/status'

describe('GET /api/agents/status', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await handleAgentsStatus(new Request('http://localhost/api/agents/status'), {
      isAuthenticated: () => false,
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('returns agent snapshot when authenticated', async () => {
    const res = await handleAgentsStatus(new Request('http://localhost/api/agents/status'), {
      isAuthenticated: () => true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.agents)).toBe(true)
    expect(typeof body.onlineCount).toBe('number')
    expect(typeof body.executingCount).toBe('number')
    expect(typeof body.blockedCount).toBe('number')
  })
})
