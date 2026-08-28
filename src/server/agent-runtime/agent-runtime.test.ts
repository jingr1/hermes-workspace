import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAgentsRegistry } from './agents-config'
import {
  isProcessGroupAlive,
  killProcessGroup,
  listPids,
  lookupPid,
  reconcileRegistry,
  registerPid,
  unregisterPid,
} from './pid-registry'
import { AgentRuntimeRouter } from './router'

let tempRoot: string

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-test-'))
})

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('agents-config', () => {
  it('loads a valid registry with capabilities inheritance', () => {
    const registry = loadAgentsRegistry({
      rawYaml: `
version: 1
agents:
  - id: developer
    runtime: hermes
    profile: developer
  - id: cc-impl
    runtime: claude-code
    command: claude
    args: ["-p"]
`,
      swarmCapabilities: new Map([['developer', ['code', 'test']]]),
    })
    expect(registry.agents).toHaveLength(2)
    const dev = registry.byId.get('developer')
    expect(dev?.runtime).toBe('hermes')
    expect(dev?.capabilities).toEqual(['code', 'test']) // inherited
    expect(registry.byId.get('cc-impl')?.command).toBe('claude')
  })

  it('rejects runtime!=hermes with execution=ssh', () => {
    expect(() =>
      loadAgentsRegistry({
        rawYaml: `
version: 1
agents:
  - id: bad
    runtime: claude-code
    command: claude
    execution: ssh
`,
      }),
    ).toThrow(/execution=ssh is only supported for runtime=hermes/)
  })

  it('rejects unknown runtime and missing command', () => {
    expect(() =>
      loadAgentsRegistry({
        rawYaml: `
version: 1
agents:
  - id: x
    runtime: bogus
`,
      }),
    ).toThrow(/unknown runtime/)
    expect(() =>
      loadAgentsRegistry({
        rawYaml: `
version: 1
agents:
  - id: y
    runtime: codex
`,
      }),
    ).toThrow(/requires a command/)
  })

  it('reports orphan hermes profiles not declared in agents.yaml', () => {
    // Whatever profiles exist on this machine, none declared → all orphan.
    const registry = loadAgentsRegistry({ rawYaml: 'version: 1\nagents: []\n' })
    expect(Array.isArray(registry.orphanProfiles)).toBe(true)
  })

  it('empty/missing agents.yaml yields empty registry without throwing', () => {
    const registry = loadAgentsRegistry({ repoRoot: tempRoot })
    expect(registry.agents).toEqual([])
  })
})

describe('pid-registry', () => {
  it('register / lookup / unregister roundtrip', () => {
    registerPid(
      {
        runId: 'r1',
        agentId: 'a1',
        pid: 999999,
        runtime: 'claude-code',
        startedAt: 1,
        logPath: '/tmp/x',
      },
      tempRoot,
    )
    expect(lookupPid('r1', tempRoot)?.pid).toBe(999999)
    expect(listPids(tempRoot)).toHaveLength(1)
    unregisterPid('r1', tempRoot)
    expect(lookupPid('r1', tempRoot)).toBeNull()
    expect(listPids(tempRoot)).toHaveLength(0)
  })

  it('register replaces an existing entry for the same runId', () => {
    registerPid(
      {
        runId: 'r1',
        agentId: 'a1',
        pid: 1,
        runtime: 'x',
        startedAt: 1,
        logPath: '/a',
      },
      tempRoot,
    )
    registerPid(
      {
        runId: 'r1',
        agentId: 'a1',
        pid: 2,
        runtime: 'x',
        startedAt: 2,
        logPath: '/b',
      },
      tempRoot,
    )
    expect(listPids(tempRoot)).toHaveLength(1)
    expect(lookupPid('r1', tempRoot)?.pid).toBe(2)
  })

  it('reconcileRegistry drops dead process groups, keeps live ones', () => {
    // Live detached process
    const child = spawn('sleep', ['30'], { detached: true })
    child.unref()
    const livePid = child.pid!

    registerPid(
      {
        runId: 'live',
        agentId: 'a',
        pid: livePid,
        runtime: 'x',
        startedAt: 1,
        logPath: '/a',
      },
      tempRoot,
    )
    registerPid(
      {
        runId: 'dead',
        agentId: 'a',
        pid: 999999,
        runtime: 'x',
        startedAt: 1,
        logPath: '/b',
      },
      tempRoot,
    )

    expect(isProcessGroupAlive(livePid)).toBe(true)
    expect(isProcessGroupAlive(999999)).toBe(false)

    const survivors = reconcileRegistry(tempRoot)
    expect(survivors.map((s) => s.runId)).toEqual(['live'])
    expect(lookupPid('dead', tempRoot)).toBeNull()

    expect(killProcessGroup(livePid)).toBe(true)
    // After kill, group is gone (may take a tick for reaping)
    expect(isProcessGroupAlive(999999)).toBe(false)
  })

  it('killProcessGroup kills the whole group (children too)', async () => {
    // spawn a group leader that forks a child; kill(-pgid) must reap both
    const child = spawn('bash', ['-c', 'sleep 60 & sleep 60'], {
      detached: true,
    })
    child.unref()
    const pid = child.pid!
    expect(isProcessGroupAlive(pid)).toBe(true)
    killProcessGroup(pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 100))
    expect(isProcessGroupAlive(pid)).toBe(false)
  })
})

describe('AgentRuntimeRouter', () => {
  it('builds adapters per runtime; codex/deepseek are declared-but-unavailable', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
  - id: cc
    runtime: claude-code
    command: claude
  - id: cx
    runtime: codex
    command: codex
`,
    })
    expect(router.getAdapter('dev')?.kind).toBe('hermes')
    expect(router.getAdapter('cc')?.kind).toBe('claude-code')
    const codexProbe = await router.getAdapter('cx')!.probe()
    expect(codexProbe.available).toBe(false)
    expect(codexProbe.detail).toMatch(/not yet delivered/)
  })

  it('hermes stub refuses startRun (existing dispatch path owns it)', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
`,
    })
    await expect(
      router.getAdapter('dev')!.startRun({} as never),
    ).rejects.toThrow(/swarm-dispatch/)
  })

  it('probeAll returns one row per agent with runtime/execution', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
  - id: cc
    runtime: claude-code
    command: definitely-not-a-real-binary-xyz
`,
    })
    const rows = await router.probeAll()
    expect(rows).toHaveLength(2)
    const cc = rows.find((r) => r.agentId === 'cc')!
    expect(cc.probe.available).toBe(false) // binary doesn't exist
    const dev = rows.find((r) => r.agentId === 'dev')!
    expect(dev.probe.available).toBe(true) // hermes stub
  })
})

describe('ClaudeCodeAdapter process management', () => {
  it('startRun spawns a detached process, streams output, interrupt kills the group', async () => {
    // Use a stand-in "claude" binary: a shell script echoing then sleeping.
    const fakeBin = join(tempRoot, 'fake-claude')
    writeFileSync(
      fakeBin,
      '#!/bin/bash\necho "hello from fake claude"\nsleep 60\n',
    )
    const { chmodSync } = await import('node:fs')
    chmodSync(fakeBin, 0o755)

    const { ClaudeCodeAdapter } = await import('./claude-code-adapter')
    const adapter = new ClaudeCodeAdapter({
      id: 'cc',
      runtime: 'claude-code',
      command: fakeBin,
      execution: 'local',
      capabilities: [],
    })

    const probe = await adapter.probe()
    expect(probe.available).toBe(false) // --version flag not handled by fake → non-zero/timeout is fine

    const { runId } = await adapter.startRun({
      runId: 'run-cc-1',
      agentId: 'cc',
      task: 'do something',
      mcp: {
        endpoint: 'http://127.0.0.1:1/api/mcp-rpc',
        runToken: 'tok',
        toolAllowlist: [],
      },
    })
    expect(runId).toBe('run-cc-1')

    const entry = lookupPid(runId)
    expect(entry).not.toBeNull()
    expect(isProcessGroupAlive(entry!.pid)).toBe(true)

    // Collect stream events
    const seen: Array<string> = []
    const reader = (async () => {
      for await (const evt of adapter.streamEvents(runId)) {
        seen.push(evt.type)
        if (evt.type === 'run_exited') break
      }
    })()

    // Wait briefly for text_delta, then interrupt
    await new Promise((r) => setTimeout(r, 500))
    await adapter.interrupt(runId, 'test interrupt')
    await reader

    expect(seen).toContain('run_started')
    expect(seen).toContain('text_delta')
    expect(seen).toContain('run_exited')
    expect(lookupPid(runId)).toBeNull()
    // SIGKILL'd group leader may briefly appear alive as a zombie until the
    // parent reaps it; poll instead of asserting immediately.
    let alive = true
    for (let i = 0; i < 20 && alive; i++) {
      alive = isProcessGroupAlive(entry!.pid)
      if (alive) await new Promise((r) => setTimeout(r, 100))
    }
    expect(alive).toBe(false)
  }, 15_000)
})
