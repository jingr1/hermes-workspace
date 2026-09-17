import { describe, expect, it } from 'vitest'
import { projectManagedAgentInteraction } from './managed-agent-interactions'

describe('projectManagedAgentInteraction', () => {
  it('preserves exact response ids from a pending canonical interaction', () => {
    expect(
      projectManagedAgentInteraction({
        requestId: 'request-1',
        turnId: 'turn-1',
        kind: 'approval',
        status: 'pending',
        toolName: 'shell',
        input: { title: 'Run command?', description: 'npm test' },
        metadata: { actions: [{ id: 'allow', label: 'Allow' }] },
      }),
    ).toEqual({
      requestId: 'request-1',
      turnId: 'turn-1',
      kind: 'approval',
      title: 'Run command?',
      detail: 'npm test',
      actions: [{ id: 'allow', label: 'Allow' }],
    })
  })

  it('fails closed when no canonical actions are available', () => {
    expect(
      projectManagedAgentInteraction({
        requestId: 'request-1',
        turnId: 'turn-1',
        kind: 'approval',
        status: 'pending',
      }),
    ).toBeNull()
  })
})