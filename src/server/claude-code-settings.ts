/**
 * Read ~/.claude/settings.json for Claude Code provider/model configuration.
 * agents.yaml must not duplicate these — the CLI settings file is the source
 * of truth for both interactive `claude` and the hermes-workspace adapter.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type ClaudeCodeSettings = {
  model?: string
  env?: Record<string, string | number | boolean>
  [key: string]: unknown
}

export type ClaudeCodeModelOption = {
  id: string
  name: string
  provider: string
  alias?: string
}

export function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

export function readClaudeCodeSettings(): ClaudeCodeSettings | null {
  try {
    const raw = fs.readFileSync(getClaudeSettingsPath(), 'utf-8')
    return JSON.parse(raw) as ClaudeCodeSettings
  } catch {
    return null
  }
}

export function settingsEnvRecord(
  settings: ClaudeCodeSettings | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = settings?.env
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    out[key] = String(value)
  }
  return out
}

export function resolveClaudeCodeProvider(
  settings: ClaudeCodeSettings | null,
): string {
  if (!settings) return 'claude-code'
  if (typeof settings.provider === 'string' && settings.provider.trim()) {
    return settings.provider.trim()
  }
  if (
    typeof settings.modelProvider === 'string' &&
    settings.modelProvider.trim()
  ) {
    return settings.modelProvider.trim()
  }
  const baseUrl = settingsEnvRecord(settings).ANTHROPIC_BASE_URL?.trim()
  if (baseUrl) {
    try {
      return new URL(baseUrl).host || 'claude-code'
    } catch {
      return 'claude-code'
    }
  }
  return 'claude-code'
}

/**
 * Expand haiku/sonnet/opus aliases via ANTHROPIC_DEFAULT_* from settings.env.
 * Bare proxy ids (e.g. Claude-Sonnet-5) pass through unchanged.
 */
export function expandClaudeCodeModelAlias(
  model: string,
  settings: ClaudeCodeSettings | null = readClaudeCodeSettings(),
): string {
  const alias = model.trim()
  if (!alias) return ''
  const env = settingsEnvRecord(settings)
  const lower = alias.toLowerCase()
  if (lower === 'haiku' && env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  if (lower === 'sonnet' && env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  if (lower === 'opus' && env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  return alias
}

/**
 * Expand settings.model aliases (haiku/sonnet/opus) via ANTHROPIC_DEFAULT_*.
 */
export function resolveClaudeCodeCurrentModel(
  settings: ClaudeCodeSettings | null,
): string {
  if (!settings) return ''
  const alias =
    typeof settings.model === 'string'
      ? settings.model.trim()
      : typeof settings.selectedModel === 'string'
        ? settings.selectedModel.trim()
        : ''
  if (!alias) return ''
  return expandClaudeCodeModelAlias(alias, settings)
}

/**
 * Models exposed in the Claude Code picker — derived from settings.env
 * defaults (haiku/sonnet/opus + subagent), not the Hermes provider catalog.
 */
export function listClaudeCodeModels(
  settings: ClaudeCodeSettings | null = readClaudeCodeSettings(),
): {
  models: Array<ClaudeCodeModelOption>
  currentModel: string
  currentProvider: string
} {
  const env = settingsEnvRecord(settings)
  const provider = resolveClaudeCodeProvider(settings)
  const seen = new Set<string>()
  const models: Array<ClaudeCodeModelOption> = []

  const push = (id: string | undefined, alias?: string) => {
    const trimmed = id?.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    models.push({
      id: trimmed,
      name: trimmed,
      provider,
      ...(alias ? { alias } : {}),
    })
  }

  push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku')
  push(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet')
  push(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus')
  push(env.CLAUDE_CODE_SUBAGENT_MODEL)

  const currentModel = resolveClaudeCodeCurrentModel(settings)
  // Ensure the currently selected model appears even if it isn't one of the
  // default-* slots (user may have set an arbitrary model id).
  push(currentModel)

  return { models, currentModel, currentProvider: provider }
}
