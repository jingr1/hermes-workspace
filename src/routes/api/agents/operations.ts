import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import YAML from 'yaml'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getHermesRoot } from '../../../server/claude-paths'
import { getAgentRuntimeRouter } from '../../../server/agent-runtime/router'
import { listProfilesLight } from '../../../server/profiles-browser'

export type OperationsAgentConfig = {
  id: string
  name: string
  runtime: 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness'
  model: string
  provider: string
  workspace?: string
  agentDir?: string
  description?: string
  systemPrompt?: string
  skillCount?: number
  mcpCount?: number
  command?: string
  args?: Array<string>
}

function safeReadJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function safeReadToml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {}
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    // Minimal TOML top-level key extraction without adding a dependency.
    const result: Record<string, unknown> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (trimmed.startsWith('[')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

function readGlobalProvider(): string {
  const configPath = path.join(getHermesRoot(), 'config.yaml')
  if (!fs.existsSync(configPath)) return ''
  try {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    const model = config.model as Record<string, unknown> | undefined
    return typeof model?.provider === 'string' ? model.provider : ''
  } catch {
    return ''
  }
}

function readClaudeCodeConfig(): { model: string; provider: string } {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const settings = safeReadJson(settingsPath)
  const model =
    typeof settings.model === 'string'
      ? settings.model
      : typeof settings.selectedModel === 'string'
        ? settings.selectedModel
        : ''
  const provider =
    typeof settings.provider === 'string'
      ? settings.provider
      : typeof settings.modelProvider === 'string'
        ? settings.modelProvider
        : ''
  return { model, provider }
}

function readCodexConfig(): { model: string; provider: string } {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  const config = safeReadToml(configPath)
  const model =
    typeof config.model === 'string'
      ? config.model
      : typeof config.selectedModel === 'string'
        ? config.selectedModel
        : ''
  const provider =
    typeof config.model_provider === 'string'
      ? config.model_provider
      : typeof config.provider === 'string'
        ? config.provider
        : ''
  return { model, provider }
}

function readExternalAgentConfig(runtime: string): {
  model: string
  provider: string
} {
  switch (runtime) {
    case 'claude-code':
      return readClaudeCodeConfig()
    case 'codex':
      return readCodexConfig()
    default:
      return { model: '', provider: '' }
  }
}

/**
 * GET /api/agents/operations — unified agent listing for the Operations UI.
 *
 * Returns both Hermes profiles and external managed runtimes (Claude Code,
 * Codex, etc.) in a single shape so Operations can render them alongside each
 * other with consistent model/provider labels.
 */
export const Route = createFileRoute('/api/agents/operations')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const globalProvider = readGlobalProvider()
        const router = getAgentRuntimeRouter()
        const profiles = listProfilesLight()

        const agents: Array<OperationsAgentConfig> = profiles.map(
          (profile) => ({
            id: profile.name,
            name: profile.name === 'default' ? 'Workspace' : profile.name,
            runtime: 'hermes',
            model: profile.model || '',
            provider: profile.provider || globalProvider,
            workspace: profile.path,
            agentDir: profile.path,
            description: profile.description,
            systemPrompt: undefined,
            skillCount: profile.skillCount,
            mcpCount: profile.mcpCount,
          }),
        )

        for (const decl of router.registry.agents) {
          if (decl.runtime === 'hermes') continue
          const external = readExternalAgentConfig(decl.runtime)
          agents.push({
            id: decl.id,
            name: decl.displayName ?? decl.mentionName ?? decl.id,
            runtime: decl.runtime,
            model: external.model,
            provider: external.provider || globalProvider,
            command: decl.command,
            args: decl.args,
          })
        }

        return json({ agents, globalProvider })
      },
    },
  },
})
