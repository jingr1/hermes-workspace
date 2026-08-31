import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishChatEvent } from './chat-event-bus'

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'agent-status-watcher-test-'))
  vi.doMock('./claude-paths', () => ({
    getProfilesDir: () => join(tempRoot, 'profiles'),
    getHermesRoot: () => tempRoot,
    getLocalBinDir: () => join(tempRoot, '.local', 'bin'),
    getWorkspaceHermesHome: () => tempRoot,
    getProfileHermesHome: (id: string) => join(tempRoot, 'profiles', id),
  }))
  vi.doMock('./agent-runtime/agents-config', () => ({
    loadAgentsRegistry: () => ({
      version: 1,
      agents: [
        {
          id: 'developer',
          runtime: 'hermes',
          profile: 'developer',
          execution: 'local',
          capabilities: ['coding'],
          displayName: 'Developer',
        },
        {
          id: 'cc-impl',
          runtime: 'claude-code',
          command: 'claude',
          execution: 'local',
          capabilities: ['coding'],
          displayName: 'Claude Code',
        },
      ],
      byId: new Map([
        [
          'developer',
          {
            id: 'developer',
            runtime: 'hermes',
            profile: 'developer',
            execution: 'local',
            capabilities: ['coding'],
            displayName: 'Developer',
          },
        ],
        [
          'cc-impl',
          {
            id: 'cc-impl',
            runtime: 'claude-code',
            command: 'claude',
            execution: 'local',
            capabilities: ['coding'],
            displayName: 'Claude Code',
          },
        ],
      ]),
      orphanProfiles: [],
    }),
  }))
  const mod = await import('./agent-status-watcher')
  return mod
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.doUnmock('./claude-paths')
  vi.doUnmock('./agent-runtime/agents-config')
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
})

describe('agent-status-watcher', () => {
  it('reports hermes agent from runtime.json', async () => {
    const mod = await loadModule()
    const profileDir = join(tempRoot, 'profiles', 'developer')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'runtime.json'),
      JSON.stringify({
        workerId: 'developer',
        state: 'executing',
        currentTask: 'Implement P3',
        lastOutputAt: Date.now(),
        checkpointStatus: 'in_progress',
      }),
    )

    mod.startAgentStatusWatcher()
    const { agents } = mod.getAgentStatuses()
    const dev = agents.find((a) => a.agentId === 'developer')
    expect(dev).toBeTruthy()
    expect(dev?.state).toBe('executing')
    expect(dev?.currentTask).toBe('Implement P3')
    expect(dev?.online).toBe(true)
    mod.stopAgentStatusWatcher()
  })

  it('marks stale hermes agent offline', async () => {
    const mod = await loadModule()
    const profileDir = join(tempRoot, 'profiles', 'developer')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'runtime.json'),
      JSON.stringify({
        workerId: 'developer',
        state: 'idle',
        lastOutputAt: Date.now() - 10 * 60 * 1000,
        checkpointStatus: 'none',
      }),
    )

    mod.startAgentStatusWatcher()
    const { agents } = mod.getAgentStatuses()
    const dev = agents.find((a) => a.agentId === 'developer')
    expect(dev?.online).toBe(false)
    mod.stopAgentStatusWatcher()
  })

  it('updates status when runtime.json changes', async () => {
    const mod = await loadModule()
    const profileDir = join(tempRoot, 'profiles', 'developer')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'runtime.json'),
      JSON.stringify({
        workerId: 'developer',
        state: 'idle',
        lastOutputAt: Date.now(),
        checkpointStatus: 'none',
      }),
    )

    mod.startAgentStatusWatcher()
    await vi.advanceTimersByTimeAsync(0)

    writeFileSync(
      join(profileDir, 'runtime.json'),
      JSON.stringify({
        workerId: 'developer',
        state: 'executing',
        currentTask: 'Updated',
        lastOutputAt: Date.now(),
        checkpointStatus: 'in_progress',
      }),
    )

    mod.refreshAgentStatuses()
    const { agents } = mod.getAgentStatuses()
    const dev = agents.find((a) => a.agentId === 'developer')
    expect(dev?.state).toBe('executing')
    expect(dev?.currentTask).toBe('Updated')
    mod.stopAgentStatusWatcher()
  })

  it('falls CLI adapters to offline until events arrive', async () => {
    const mod = await loadModule()
    mod.startAgentStatusWatcher()
    const { agents } = mod.getAgentStatuses()
    const cc = agents.find((a) => a.agentId === 'cc-impl')
    expect(cc?.online).toBe(false)
    expect(cc?.runtime).toBe('claude-code')
    mod.stopAgentStatusWatcher()
  })

  it('publishes agent_status event when adapter event arrives', async () => {
    const mod = await loadModule()
    mod.startAgentStatusWatcher()

    publishChatEvent('agent_dispatched', {
      agentId: 'cc-impl',
      state: 'executing',
      currentTask: 'Dispatch run',
      taskId: 'task-1',
      missionId: 'mission-1',
      needsHuman: false,
      checkpointStatus: 'in_progress',
      lastOutputAt: Date.now(),
    })

    await vi.advanceTimersByTimeAsync(500)
    const { agents } = mod.getAgentStatuses()
    const cc = agents.find((a) => a.agentId === 'cc-impl')
    expect(cc?.online).toBe(true)
    expect(cc?.state).toBe('executing')
    expect(cc?.taskId).toBe('task-1')
    mod.stopAgentStatusWatcher()
  })
})
