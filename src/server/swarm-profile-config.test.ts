import { afterEach, describe, expect, it } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import * as yaml from 'yaml'
import {
  ensureSwarmProfileConfig,
  syncSwarmProfileIdentity,
  syncSwarmProfileModel,
} from './swarm-profile-config'

function makeProfile(initial: Record<string, unknown>): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'swarm-profile-cfg-'))
  writeFileSync(join(dir, 'config.yaml'), yaml.stringify(initial), 'utf8')
  return dir
}

describe('ensureSwarmProfileConfig', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function setupHermesRoot(): string {
    const hermes = mkdtempSync(join(os.tmpdir(), 'swarm-hermes-'))
    tempDirs.push(hermes)
    writeFileSync(join(hermes, 'config.yaml'), 'model: { provider: p, default: d }\n', 'utf8')
    writeFileSync(
      join(hermes, '.env'),
      'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=abcdefghijklmnopqrstuvwxyz12\nAPI_SERVER_PORT=8642\nTOKENX_API_KEY=secret\n',
      'utf8',
    )
    return hermes
  }

  it('copies .env as a real file and strips API_SERVER_PORT', () => {
    const hermes = setupHermesRoot()
    const profile = join(hermes, 'profiles', 'researcher')

    const result = ensureSwarmProfileConfig(profile, { hermesRoot: hermes })

    expect(result.ok).toBe(true)
    expect(result.envCopied).toBe(true)
    const envPath = join(profile, '.env')
    expect(lstatSync(envPath).isSymbolicLink()).toBe(false)
    const raw = readFileSync(envPath, 'utf8')
    expect(raw).toContain('API_SERVER_KEY=abcdefghijklmnopqrstuvwxyz12')
    expect(raw).toContain('TOKENX_API_KEY=secret')
    expect(raw).not.toContain('API_SERVER_PORT=')
  })

  it('replaces a legacy .env symlink with a private copy', () => {
    const hermes = setupHermesRoot()
    const profile = join(hermes, 'profiles', 'writer')
    mkdirSync(profile, { recursive: true })
    symlinkSync(join(hermes, '.env'), join(profile, '.env'))

    const result = ensureSwarmProfileConfig(profile, { hermesRoot: hermes })

    expect(result.ok).toBe(true)
    expect(result.envCopied).toBe(true)
    expect(lstatSync(join(profile, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(profile, '.env'), 'utf8')).not.toContain('API_SERVER_PORT=')
    expect(readFileSync(join(hermes, '.env'), 'utf8')).toContain('API_SERVER_PORT=8642')
  })

  it('does not overwrite an existing private .env', () => {
    const hermes = setupHermesRoot()
    const profile = join(hermes, 'profiles', 'architect')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, '.env'), 'API_SERVER_PORT=8643\nKEEP=1\n', 'utf8')
    writeFileSync(join(profile, 'config.yaml'), 'model: { provider: p, default: d }\n', 'utf8')

    const result = ensureSwarmProfileConfig(profile, { hermesRoot: hermes })

    expect(result.envCopied).toBe(false)
    expect(readFileSync(join(profile, '.env'), 'utf8')).toBe('API_SERVER_PORT=8643\nKEEP=1\n')
  })
})

describe('syncSwarmProfileModel', () => {
  it('returns ok=false when the profile path does not exist', () => {
    const result = syncSwarmProfileModel('/nope/does-not-exist', {
      provider: 'openai-codex',
      default: 'gpt-5.5',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('profile path missing')
    }
  })

  it('returns ok=false when config.yaml does not exist', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'swarm-profile-cfg-'))
    try {
      const result = syncSwarmProfileModel(dir, {
        provider: 'openai-codex',
        default: 'gpt-5.5',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('config.yaml missing')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updates model.provider and model.default when they differ', () => {
    const dir = makeProfile({
      model: { provider: 'openai-codex', default: 'gpt-5.5' },
      providers: {},
    })
    try {
      const result = syncSwarmProfileModel(dir, {
        provider: 'anthropic-oauth',
        default: 'claude-opus-4-7',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.changed).toBe(true)
        expect(result.previous).toEqual({
          provider: 'openai-codex',
          default: 'gpt-5.5',
        })
      }
      const reread = yaml.parse(
        readFileSync(join(dir, 'config.yaml'), 'utf8'),
      ) as { model: { provider: string; default: string } }
      expect(reread.model.provider).toBe('anthropic-oauth')
      expect(reread.model.default).toBe('claude-opus-4-7')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports changed=false when config already matches target', () => {
    const dir = makeProfile({
      model: { provider: 'openai-codex', default: 'gpt-5.5' },
    })
    try {
      const result = syncSwarmProfileModel(dir, {
        provider: 'openai-codex',
        default: 'gpt-5.5',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.changed).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves sibling top-level keys (providers, toolsets, agent)', () => {
    const dir = makeProfile({
      model: { provider: 'openai-codex', default: 'gpt-5.5' },
      providers: { ollama: { api_key: 'ollama' } },
      toolsets: ['file', 'browser'],
      agent: { max_turns: 90 },
    })
    try {
      syncSwarmProfileModel(dir, {
        provider: 'anthropic-oauth',
        default: 'claude-opus-4-7',
      })
      const reread = yaml.parse(
        readFileSync(join(dir, 'config.yaml'), 'utf8'),
      ) as Record<string, unknown>
      expect(reread.providers).toEqual({ ollama: { api_key: 'ollama' } })
      expect(reread.toolsets).toEqual(['file', 'browser'])
      expect(reread.agent).toEqual({ max_turns: 90 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves sibling fields inside model (e.g. model.alternates)', () => {
    const dir = makeProfile({
      model: {
        provider: 'openai-codex',
        default: 'gpt-5.5',
        alternates: ['gpt-5.4'],
      },
    })
    try {
      syncSwarmProfileModel(dir, {
        provider: 'anthropic-oauth',
        default: 'claude-opus-4-7',
      })
      const reread = yaml.parse(
        readFileSync(join(dir, 'config.yaml'), 'utf8'),
      ) as { model: Record<string, unknown> }
      expect(reread.model.provider).toBe('anthropic-oauth')
      expect(reread.model.default).toBe('claude-opus-4-7')
      expect(reread.model.alternates).toEqual(['gpt-5.4'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns ok=false when config.yaml is malformed', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'swarm-profile-cfg-'))
    writeFileSync(join(dir, 'config.yaml'), '::: not yaml :::', 'utf8')
    try {
      const result = syncSwarmProfileModel(dir, {
        provider: 'openai-codex',
        default: 'gpt-5.5',
      })
      expect(result.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('syncSwarmProfileIdentity', () => {
  it('writes profile-local identity with name, role, mission, capabilities, and stable machine ID', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'swarm-profile-id-'))
    try {
      const result = syncSwarmProfileIdentity(dir, {
        id: 'swarm5',
        name: 'Builder',
        role: 'Primary Builder',
        specialty: 'full-stack implementation across Hermes Workspace and Swarm2',
        model: 'GPT-5.5',
        mission: 'Ship focused product slices with tests and clean diffs.',
        skills: ['swarm-ui-worker', 'swarm-worker-core'],
        capabilities: ['code-editing', 'ui-implementation'],
      })

      expect(result.ok).toBe(true)
      const identity = readFileSync(join(dir, 'memory', 'IDENTITY.md'), 'utf8')
      expect(identity).toContain('# IDENTITY.md — Builder')
      expect(identity).toContain('- Name: Builder')
      expect(identity).toContain('- Worker ID: swarm5')
      expect(identity).toContain('- Role: Primary Builder')
      expect(identity).toContain('- Mission: Ship focused product slices with tests and clean diffs.')
      expect(identity).toContain('- Capabilities: code-editing, ui-implementation')
      expect(identity).toContain('The worker ID is a stable machine identifier only')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
