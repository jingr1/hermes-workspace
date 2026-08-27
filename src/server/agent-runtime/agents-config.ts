/**
 * agents.yaml loader — runtime declarations for managed agents.
 *
 * agents.yaml describes HOW an agent runtime is launched (command, args,
 * execution locality). swarm.yaml remains the pipeline source of truth
 * (roles, skills, capabilities). When an agent id also exists in swarm.yaml,
 * capabilities are inherited from there unless overridden.
 *
 * Load-time validation (plan «ssh locality 仅限 runtime: hermes»):
 *   runtime !== 'hermes' && execution === 'ssh'  → hard error.
 *   Same when execution is omitted but the profile's terminal.backend
 *   auto-detection yields ssh and runtime is not hermes.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import * as YAML from 'yaml'
import type { AgentRuntimeKind } from './types'

export type AgentExecution = 'local' | 'ssh'

export type AgentDeclaration = {
  id: string
  runtime: AgentRuntimeKind
  /** Hermes profile name (runtime: hermes). */
  profile?: string
  /** CLI command (non-hermes runtimes). */
  command?: string
  args?: Array<string>
  execution: AgentExecution
  capabilities: Array<string>
  mentionName?: string
  displayName?: string
}

export type AgentsRegistry = {
  version: number
  agents: Array<AgentDeclaration>
  /** Ids present in agents.yaml. */
  byId: Map<string, AgentDeclaration>
  /** Orphan hermes profiles discovered on disk but not declared. */
  orphanProfiles: Array<string>
}

const RUNTIMES: ReadonlyArray<AgentRuntimeKind> = ['hermes', 'claude-code', 'codex', 'deepseek-harness']

export function getAgentsYamlPath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), 'agents.yaml')
}

/** Read a hermes profile's terminal.backend for execution auto-detection. */
function detectExecutionFromProfile(profileId: string): AgentExecution | null {
  const configPath = path.join(homedir(), '.hermes', 'profiles', profileId, 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw) as Record<string, unknown> | null
    const backend = (parsed?.terminal as Record<string, unknown> | undefined)?.backend
    if (backend === 'ssh') return 'ssh'
    if (typeof backend === 'string') return 'local'
    return null
  } catch {
    return null
  }
}

function listHermesProfiles(): Array<string> {
  const dir = path.join(homedir(), '.hermes', 'profiles')
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function loadAgentsRegistry(input?: {
  repoRoot?: string
  /** swarm.yaml-derived capabilities: agentId -> capabilities (inheritance). */
  swarmCapabilities?: Map<string, Array<string>>
  /** Existing file content override (tests). */
  rawYaml?: string
}): AgentsRegistry {
  const filePath = getAgentsYamlPath(input?.repoRoot)
  const raw = input?.rawYaml ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null)
  if (raw === null) {
    // No agents.yaml: empty registry, every hermes profile is an orphan.
    return { version: 1, agents: [], byId: new Map(), orphanProfiles: listHermesProfiles() }
  }

  const doc = YAML.parse(raw) as {
    version?: number
    agents?: Array<Record<string, unknown>>
  } | null
  const errors: Array<string> = []
  const agents: Array<AgentDeclaration> = []

  for (const entry of doc?.agents ?? []) {
    const id = String(entry.id ?? '')
    const runtime = String(entry.runtime ?? '') as AgentRuntimeKind
    if (!id) {
      errors.push('agent entry missing id')
      continue
    }
    if (!RUNTIMES.includes(runtime)) {
      errors.push(`agent ${id}: unknown runtime "${runtime}"`)
      continue
    }

    // execution: explicit, else auto-detect from the hermes profile.
    let execution: AgentExecution
    if (entry.execution === 'ssh' || entry.execution === 'local') {
      execution = entry.execution
    } else {
      execution = (entry.profile ? detectExecutionFromProfile(String(entry.profile)) : null) ?? 'local'
    }

    // ssh locality is hermes-only (plan 行 583).
    if (runtime !== 'hermes' && execution === 'ssh') {
      errors.push(
        `agent ${id}: execution=ssh is only supported for runtime=hermes ` +
          `(CLI adapters spawn the process locally; ssh would require exposing the MCP endpoint)`,
      )
      continue
    }

    if (runtime === 'hermes' && !entry.profile) {
      errors.push(`agent ${id}: runtime=hermes requires a profile`)
      continue
    }
    if (runtime !== 'hermes' && !entry.command) {
      errors.push(`agent ${id}: runtime=${runtime} requires a command`)
      continue
    }

    const inherited = input?.swarmCapabilities?.get(id) ?? []
    const capabilities = Array.isArray(entry.capabilities)
      ? (entry.capabilities as Array<string>)
      : inherited

    agents.push({
      id,
      runtime,
      profile: entry.profile ? String(entry.profile) : undefined,
      command: entry.command ? String(entry.command) : undefined,
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      execution,
      capabilities,
      mentionName: entry.mentionName ? String(entry.mentionName) : undefined,
      displayName: entry.displayName ? String(entry.displayName) : undefined,
    })
  }

  if (errors.length > 0) {
    throw new Error(`agents.yaml validation failed:\n  - ${errors.join('\n  - ')}`)
  }

  // Orphan reconciliation (plan 行 130/1249): hermes profiles on disk that
  // no declared agent references. Reported, not silently ignored.
  const declaredProfiles = new Set(agents.map((a) => a.profile).filter(Boolean))
  const orphanProfiles = listHermesProfiles().filter((p) => !declaredProfiles.has(p))

  return {
    version: doc?.version ?? 1,
    agents,
    byId: new Map(agents.map((a) => [a.id, a])),
    orphanProfiles,
  }
}
