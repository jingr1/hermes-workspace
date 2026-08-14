import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  Settings01Icon,
  PuzzleIcon,
  Link01Icon,
  ToolsIcon,
  Folder01Icon,
  Calendar01Icon,
  ViewIcon,
  UserSquareIcon,
  CpuIcon,
  Clock01Icon,
  Alert01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Button } from '@/components/ui/button'
import type { GatewayModelCatalogEntry } from '@/lib/gateway-api'
import { formatRelativeTime } from '@/screens/dashboard/lib/formatters'
import { cn } from '@/lib/utils'
import type { OperationsAgent, AgentSkillItem, AgentMcpItem } from '../hooks/use-operations'

// Fetch models from the local filesystem endpoint — no gateway dependency.
// Falls back gracefully when /api/models (gateway-backed) is unreachable.
async function fetchModelsLocal(): Promise<{
  ok?: boolean
  models?: Array<GatewayModelCatalogEntry>
}> {
  const response = await fetch('/api/models')
  if (!response.ok) throw new Error(`Failed to load models (${response.status})`)
  return (await response.json()) as { ok?: boolean; models?: Array<GatewayModelCatalogEntry> }
}

type AvailableModel = {
  id: string
  provider: string
  name: string
}

type Tab = 'identity' | 'model' | 'capabilities' | 'schedule' | 'activity'

const TABS: Array<{ id: Tab; label: string; icon: typeof UserSquareIcon }> = [
  { id: 'identity', label: 'Identity', icon: UserSquareIcon },
  { id: 'model', label: 'Model & Provider', icon: CpuIcon },
  { id: 'capabilities', label: 'Capabilities', icon: PuzzleIcon },
  { id: 'schedule', label: 'Schedule', icon: Calendar01Icon },
  { id: 'activity', label: 'Activity', icon: ViewIcon },
]

function normalizeModel(model: GatewayModelCatalogEntry): AvailableModel | null {
  if (typeof model === 'string') {
    return {
      id: model,
      provider: model.includes('/') ? (model.split('/')[0] ?? 'model') : 'model',
      name: model.split('/').pop() ?? model,
    }
  }

  const id = model.id ?? model.alias ?? model.model ?? ''
  if (!id) return null

  return {
    id,
    provider: model.provider ?? id.split('/')[0] ?? 'model',
    name:
      model.label ?? model.displayName ?? model.name ?? id.split('/').pop() ?? id,
  }
}

function ModelSelector({
  value,
  onChange,
  models,
}: {
  value: string
  onChange: (nextValue: string) => void
  models: AvailableModel[]
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const selected = (() => {
    if (!value) return null
    const slashIndex = value.indexOf('/')
    if (slashIndex > 0) {
      const valueProvider = value.slice(0, slashIndex)
      const valueModelId = value.slice(slashIndex + 1)
      const exactMatch = models.find(
        (m) => m.provider === valueProvider && (m.id === value || m.id === valueModelId),
      )
      if (exactMatch) return exactMatch
    }
    const idMatch = models.find((m) => m.id === value)
    if (idMatch) return idMatch
    return {
      id: value,
      provider: slashIndex > 0 ? value.slice(0, slashIndex) : 'model',
      name: value.split('/').pop() ?? value,
    }
  })()

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-h-[3rem] w-full items-center justify-between gap-3 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-left text-sm text-[var(--theme-text)] shadow-[0_8px_24px_color-mix(in_srgb,var(--theme-shadow)_18%,transparent)]"
      >
        <span className="truncate">
          {selected ? `${selected.provider} / ${selected.name}` : 'Default (auto)'}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={16}
          strokeWidth={1.8}
          className={cn(
            'text-[var(--theme-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+0.5rem)] z-[80] w-full overflow-hidden rounded-2xl border border-[var(--theme-border2)] bg-[var(--theme-card)] shadow-[0_24px_80px_var(--theme-shadow)]">
          <div className="max-h-80 overflow-y-auto p-2">
            <button
              type="button"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className={cn(
                'flex w-full rounded-xl px-3 py-2.5 text-left text-sm',
                !value ? 'bg-[var(--theme-accent-soft)]' : 'hover:bg-[var(--theme-bg)]',
              )}
            >
              Default (auto)
            </button>
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => {
                  onChange(model.id)
                  setOpen(false)
                }}
                className={cn(
                  'mt-1 flex w-full rounded-xl px-3 py-2.5 text-left text-sm',
                  value === model.id
                    ? 'bg-[var(--theme-accent-soft)]'
                    : 'hover:bg-[var(--theme-bg)]',
                )}
              >
                {model.provider} / {model.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab content components
// ---------------------------------------------------------------------------

function IdentityTab({
  name,
  emoji,
  description,
  systemPrompt,
  onName,
  onEmoji,
  onDescription,
  onSystemPrompt,
}: {
  name: string
  emoji: string
  description: string
  systemPrompt: string
  onName: (v: string) => void
  onEmoji: (v: string) => void
  onDescription: (v: string) => void
  onSystemPrompt: (v: string) => void
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[1.2fr_0.6fr]">
        <label className="space-y-2">
          <span className="text-sm font-medium text-[var(--theme-text)]">Name</span>
          <input
            value={name}
            onChange={(event) => onName(event.target.value)}
            className="w-full rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
          />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-[var(--theme-text)]">Emoji</span>
          <input
            value={emoji}
            onChange={(event) => onEmoji(event.target.value)}
            className="w-full rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
          />
        </label>
      </div>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--theme-text)]">Description</span>
        <input
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          placeholder="One-line description of what this agent does"
          className="w-full rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
        />
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--theme-text)]">System Prompt</span>
        <textarea
          value={systemPrompt}
          onChange={(event) => onSystemPrompt(event.target.value)}
          className="min-h-[220px] w-full rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
        />
      </label>
    </div>
  )
}

function ModelTab({
  model,
  onModel,
  models,
  provider,
  hasProvider,
  hasEnv,
}: {
  model: string
  onModel: (v: string) => void
  models: AvailableModel[]
  provider: string
  hasProvider: boolean
  hasEnv: boolean
}) {
  return (
    <div className="space-y-4">
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--theme-text)]">Model</span>
        <ModelSelector value={model} onChange={onModel} models={models} />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
            Provider
          </p>
          <p className="mt-1 text-sm text-[var(--theme-text)]">
            {hasProvider ? provider : '— not configured —'}
          </p>
          {!hasProvider && (
            <p className="mt-1 text-xs text-amber-600">
              Set a model to auto-detect provider
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
            .env file
          </p>
          <p className="mt-1 text-sm text-[var(--theme-text)]">
            {hasEnv ? '✓ Found' : '✗ Missing'}
          </p>
          {!hasEnv && (
            <p className="mt-1 text-xs text-[var(--theme-muted)]">
              API keys may not be loaded for this profile
            </p>
          )}
        </div>
      </div>
      <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
        <p className="text-xs text-[var(--theme-muted)]">
          Fallback models and advanced parameters (temperature, max_tokens) can be
          configured by editing the profile's <code className="text-[var(--theme-text)]">config.yaml</code> directly.
        </p>
      </div>
    </div>
  )
}

function CapabilitiesTab({
  agent,
  onToggleSkill,
  isTogglingSkill,
  onToggleMcp,
  isTogglingMcp,
  onRemoveMcp,
  isRemovingMcp,
}: {
  agent: OperationsAgent
  onToggleSkill: (input: { profile: string; name: string; enabled: boolean }) => Promise<unknown>
  isTogglingSkill: boolean
  onToggleMcp: (input: { profile: string; server: string; enabled: boolean }) => Promise<unknown>
  isTogglingMcp: boolean
  onRemoveMcp: (input: { profile: string; server: string }) => Promise<unknown>
  isRemovingMcp: boolean
}) {
  const [skillSearch, setSkillSearch] = useState('')
  const [inlineError, setInlineError] = useState<string | null>(null)

  // Local optimistic state — gives immediate visual feedback before the server
  // round-trip completes. Synced from server data whenever capabilities refresh.
  const [localSkills, setLocalSkills] = useState<AgentSkillItem[]>(agent.capabilities.skills)
  const [localMcp, setLocalMcp] = useState<AgentMcpItem[]>(agent.capabilities.mcpServers)

  // Keep local state in sync when SWITCHING to a different agent.
  // Intentionally depend on agent.id (not agent.capabilities.skills) because
  // useOperations polls every ~15s and creates a new array reference on each
  // cycle — depending on the array itself would reset localSkills/localMcp on
  // every poll, wiping any in-flight optimistic toggle.
  useEffect(() => {
    setLocalSkills(agent.capabilities.skills)
  }, [agent.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLocalMcp(agent.capabilities.mcpServers)
  }, [agent.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const toolsets = agent.capabilities.toolsets
  const enabledSkills = localSkills.filter((s) => s.enabled)

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return localSkills
    const q = skillSearch.toLowerCase()
    return localSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false) ||
        (s.category?.toLowerCase().includes(q) ?? false),
    )
  }, [localSkills, skillSearch])

  async function handleToggleSkill(skill: AgentSkillItem) {
    setInlineError(null)
    // Optimistic update
    setLocalSkills((prev) =>
      prev.map((s) => (s.name === skill.name ? { ...s, enabled: !s.enabled } : s)),
    )
    try {
      await onToggleSkill({ profile: agent.id, name: skill.name, enabled: !skill.enabled })
    } catch (err) {
      // Rollback
      setLocalSkills((prev) =>
        prev.map((s) => (s.name === skill.name ? { ...s, enabled: skill.enabled } : s)),
      )
      setInlineError(err instanceof Error ? err.message : 'Failed to toggle skill')
    }
  }

  async function handleToggleMcp(mcp: AgentMcpItem) {
    setInlineError(null)
    // Optimistic update
    setLocalMcp((prev) =>
      prev.map((m) => (m.name === mcp.name ? { ...m, enabled: !m.enabled } : m)),
    )
    try {
      await onToggleMcp({ profile: agent.id, server: mcp.name, enabled: !mcp.enabled })
    } catch (err) {
      // Rollback
      setLocalMcp((prev) =>
        prev.map((m) => (m.name === mcp.name ? { ...m, enabled: mcp.enabled } : m)),
      )
      setInlineError(err instanceof Error ? err.message : 'Failed to toggle MCP server')
    }
  }

  async function handleRemoveMcp(mcp: AgentMcpItem) {
    setInlineError(null)
    if (!confirm(`Remove MCP server "${mcp.name}" from this profile?`)) return
    // Optimistic update
    setLocalMcp((prev) => prev.filter((m) => m.name !== mcp.name))
    try {
      await onRemoveMcp({ profile: agent.id, server: mcp.name })
    } catch (err) {
      // Rollback
      setLocalMcp((prev) => [...prev, mcp])
      setInlineError(err instanceof Error ? err.message : 'Failed to remove MCP server')
    }
  }

  return (
    <div className="space-y-6">
      {/* Inline error banner */}
      {inlineError ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <HugeiconsIcon icon={Alert01Icon} size={16} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Action failed</p>
            <p className="mt-0.5 text-xs">{inlineError}</p>
            {inlineError.includes('503') || inlineError.includes('unavailable') ? (
              <p className="mt-1 text-xs opacity-75">
                This action requires the Hermes Dashboard to be connected (port 9119).
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setInlineError(null)}
            className="ml-auto shrink-0 text-amber-600 hover:text-amber-900"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Skills section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={PuzzleIcon} size={16} strokeWidth={1.8} className="text-[var(--theme-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">
              Skills ({enabledSkills.length}/{localSkills.length} enabled)
            </h3>
          </div>
          <Link
            to="/skills"
            className="text-xs text-[var(--theme-accent)] hover:underline"
          >
            Manage in Skills →
          </Link>
        </div>

        {localSkills.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
            No skills installed in this profile. Visit the Skills page to add some.
          </div>
        ) : (
          <>
            <input
              value={skillSearch}
              onChange={(event) => setSkillSearch(event.target.value)}
              placeholder="Search skills..."
              className="w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
            <div className="max-h-[280px] space-y-1.5 overflow-y-auto">
              {filteredSkills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-center gap-3 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2.5"
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skill.enabled}
                    aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
                    onClick={() => void handleToggleSkill(skill)}
                    disabled={isTogglingSkill}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)] disabled:opacity-50',
                      skill.enabled ? 'bg-[var(--theme-accent)]' : 'bg-primary-200',
                    )}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform',
                        skill.enabled ? 'translate-x-4' : 'translate-x-0',
                      )}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-[var(--theme-text)]">
                        {skill.name}
                      </p>
                      {skill.category ? (
                        <span className="shrink-0 rounded-full bg-[var(--theme-card2)] px-2 py-0.5 text-[10px] text-[var(--theme-muted)]">
                          {skill.category}
                        </span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="truncate text-xs text-[var(--theme-muted)]">
                        {skill.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
              {filteredSkills.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-[var(--theme-muted)]">
                  No skills match "{skillSearch}"
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* MCP Servers section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={Link01Icon} size={16} strokeWidth={1.8} className="text-[var(--theme-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">
              MCP Servers ({localMcp.filter((m) => m.enabled).length}/{localMcp.length})
            </h3>
          </div>
          <Link
            to="/mcp"
            className="text-xs text-[var(--theme-accent)] hover:underline"
          >
            Manage in MCP →
          </Link>
        </div>

        {localMcp.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
            No MCP servers configured for this profile. Visit the MCP page to add some.
          </div>
        ) : (
          <div className="space-y-1.5">
            {localMcp.map((mcp) => (
              <div
                key={mcp.name}
                className="flex items-center gap-3 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2.5"
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={mcp.enabled}
                  aria-label={mcp.enabled ? `Disable ${mcp.name}` : `Enable ${mcp.name}`}
                  onClick={() => void handleToggleMcp(mcp)}
                  disabled={isTogglingMcp}
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)] disabled:opacity-50',
                    mcp.enabled ? 'bg-[var(--theme-accent)]' : 'bg-primary-200',
                  )}
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform',
                      mcp.enabled ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--theme-text)]">
                    {mcp.name}
                  </p>
                  {mcp.error ? (
                    <p className="truncate text-xs text-red-500">{mcp.error}</p>
                  ) : (
                    <p className="text-xs text-[var(--theme-muted)]">
                      {mcp.status === 'ok' ? 'Connected' : mcp.status === 'error' ? 'Error' : 'Disabled'}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemoveMcp(mcp)}
                  disabled={isRemovingMcp}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--theme-muted)] transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  aria-label={`Remove ${mcp.name}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Toolsets section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={ToolsIcon} size={16} strokeWidth={1.8} className="text-[var(--theme-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">
            Toolsets
          </h3>
        </div>
        {toolsets.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-4 text-sm text-[var(--theme-muted)]">
            No toolsets explicitly enabled — this profile uses the default toolset.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {toolsets.map((toolset) => (
              <span
                key={toolset}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)]"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {toolset}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Resources section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={Folder01Icon} size={16} strokeWidth={1.8} className="text-[var(--theme-accent)]" />
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">
            Resources
          </h3>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
              Workspace
            </p>
            <p className="mt-1 truncate text-sm text-[var(--theme-text)]" title={agent.resources.workspace}>
              {agent.resources.workspace || '— not set —'}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
              .env file
            </p>
            <p className="mt-1 text-sm text-[var(--theme-text)]">
              {agent.resources.envExists ? '✓ Found' : '✗ Missing'}
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

function ScheduleTab({
  agent,
  onClose,
}: {
  agent: OperationsAgent
  onClose: () => void
}) {
  const jobs = agent.jobs

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">
            Scheduled Jobs
          </h3>
          <p className="mt-1 text-xs text-[var(--theme-muted)]">
            Cron jobs tagged with <code>ops:{agent.id}:*</code>
          </p>
        </div>
        <Link
          to="/jobs"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
        >
          + Add Job
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
          No scheduled jobs for this agent yet.
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex flex-col gap-2 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      job.enabled ? 'bg-emerald-500' : 'bg-primary-300',
                    )}
                  />
                  <p className="text-sm font-medium text-[var(--theme-text)]">
                    {job.name.replace(`ops:${agent.id}:`, '').replace(/-/g, ' ')}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-[var(--theme-muted)]">
                  {job.description || job.schedule}
                </p>
              </div>
              <div className="text-xs text-[var(--theme-muted)] md:text-right">
                <p className="inline-flex items-center gap-1.5">
                  <HugeiconsIcon icon={Clock01Icon} size={12} strokeWidth={1.8} />
                  {job.schedule}
                </p>
                <p className="mt-0.5">
                  {job.nextRunAt
                    ? `Next ${formatRelativeTime(new Date(job.nextRunAt).getTime())}`
                    : job.lastRun?.startedAt
                      ? `Last ${formatRelativeTime(new Date(job.lastRun.startedAt).getTime())}`
                      : 'No runs yet'}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActivityTab({ agent }: { agent: OperationsAgent }) {
  const outputs = agent.recentOutputs
  const sessions = agent.sessions

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--theme-text)]">
          Recent Outputs
        </h3>
        <p className="mt-1 text-xs text-[var(--theme-muted)]">
          Latest session and cron outputs from this agent
        </p>
      </div>

      {outputs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
          No recent activity yet.
        </div>
      ) : (
        <div className="space-y-2">
          {outputs.map((output) => (
            <div
              key={output.id}
              className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    output.source === 'cron'
                      ? 'bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                      : 'bg-[var(--theme-card2)] text-[var(--theme-muted)]',
                  )}
                >
                  {output.source}
                </span>
                <span className="text-xs text-[var(--theme-muted)]">
                  {formatRelativeTime(output.timestamp)}
                </span>
              </div>
              <p className="mt-2 text-sm text-[var(--theme-text)]">
                {output.summary}
              </p>
            </div>
          ))}
        </div>
      )}

      {sessions.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
            Sessions ({sessions.length})
          </h4>
          {sessions.slice(0, 10).map((session) => (
            <a
              key={session.key}
              href={`/chat?session=${encodeURIComponent(session.key ?? '')}`}
              className="block rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-2.5 transition-colors hover:border-[var(--theme-accent)]"
            >
              <p className="truncate text-sm text-[var(--theme-text)]">
                {session.title || session.initialMessage || session.key}
              </p>
              <p className="mt-0.5 text-xs text-[var(--theme-muted)]">
                {session.status} · {session.updatedAt ? formatRelativeTime(new Date(session.updatedAt).getTime()) : 'unknown'}
              </p>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OperationsAgentDetail({
  open,
  agent,
  onClose,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
  onToggleSkill,
  isTogglingSkill,
  onToggleMcp,
  isTogglingMcp,
  onRemoveMcp,
  isRemovingMcp,
}: {
  open: boolean
  agent: OperationsAgent | null
  onClose: () => void
  onSave: (input: {
    agentId: string
    name: string
    model: string
    emoji: string
    systemPrompt: string
    description?: string
  }) => Promise<unknown>
  onDelete: (agentId: string) => Promise<unknown>
  isSaving: boolean
  isDeleting: boolean
  onToggleSkill: (input: { profile: string; name: string; enabled: boolean }) => Promise<unknown>
  isTogglingSkill: boolean
  onToggleMcp: (input: { profile: string; server: string; enabled: boolean }) => Promise<unknown>
  isTogglingMcp: boolean
  onRemoveMcp: (input: { profile: string; server: string }) => Promise<unknown>
  isRemovingMcp: boolean
}) {
  const [activeTab, setActiveTab] = useState<Tab>('identity')
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [description, setDescription] = useState('')

  // Reset form fields + active tab ONLY when the agent ID changes or panel opens.
  // We intentionally depend on agent?.id (a string) rather than the agent object
  // itself, because useOperations polls every ~15s and produces a new agent object
  // reference on each cycle — depending on `agent` would reset activeTab to
  // 'identity' every time the background data refreshes.
  useEffect(() => {
    if (!agent || !open) return
    setName(agent.name)
    setEmoji(agent.meta.emoji)
    setModel(agent.model || '')
    setSystemPrompt(agent.meta.systemPrompt)
    setDescription(agent.meta.description || agent.description || '')
    setActiveTab('identity')
  }, [agent?.id, open])

  const modelsQuery = useQuery({
    queryKey: ['operations', 'models'],
    queryFn: fetchModelsLocal,
    enabled: open,
  })

  const models = useMemo(() => {
    const fromApi = (modelsQuery.data?.models ?? [])
      .map(normalizeModel)
      .filter((entry): entry is AvailableModel => Boolean(entry))

    // Always inject the agent's current configured model as the first option
    // so the dropdown is never empty even when /api/models-local returns nothing.
    const currentModel = agent?.model?.trim()
    if (currentModel && !fromApi.some((m) => m.id === currentModel)) {
      const slashIdx = currentModel.indexOf('/')
      fromApi.unshift({
        id: currentModel,
        provider: slashIdx > 0 ? currentModel.slice(0, slashIdx) : 'model',
        name: currentModel.split('/').pop() ?? currentModel,
      })
    }
    return fromApi
  }, [modelsQuery.data?.models, agent?.model])

  if (!open || !agent) return null

  function handleSave() {
    void onSave({
      agentId: agent!.id,
      name,
      model,
      emoji,
      systemPrompt,
      description,
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--theme-bg)_55%,transparent)] px-4 py-6 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-3xl border border-[var(--theme-border2)] bg-[var(--theme-card)] shadow-[0_24px_80px_var(--theme-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--theme-border)] px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-accent)]">
              <HugeiconsIcon icon={Settings01Icon} size={20} strokeWidth={1.8} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--theme-muted)]">
                Agent Settings
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--theme-text)]">
                {agent.meta.emoji} {agent.name}
              </h2>
              <p className="mt-1 text-sm text-[var(--theme-muted-2)]">
                {agent.meta.description || agent.description || 'No description'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-10 items-center justify-center rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card2)] text-lg text-[var(--theme-muted)] transition-colors hover:border-[var(--theme-accent)] hover:text-[var(--theme-accent-strong)]"
            aria-label="Close agent settings"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={1.8} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--theme-border)] px-5 py-2 sm:px-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                  : 'text-[var(--theme-muted)] hover:bg-[var(--theme-bg)] hover:text-[var(--theme-text)]',
              )}
            >
              <HugeiconsIcon icon={tab.icon} size={14} strokeWidth={1.8} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {activeTab === 'identity' ? (
            <IdentityTab
              name={name}
              emoji={emoji}
              description={description}
              systemPrompt={systemPrompt}
              onName={setName}
              onEmoji={setEmoji}
              onDescription={setDescription}
              onSystemPrompt={setSystemPrompt}
            />
          ) : activeTab === 'model' ? (
            <ModelTab
              model={model}
              onModel={setModel}
              models={models}
              provider={agent.provider || ''}
              hasProvider={agent.health.hasProvider}
              hasEnv={agent.resources.envExists}
            />
          ) : activeTab === 'capabilities' ? (
            <CapabilitiesTab
              agent={agent}
              onToggleSkill={onToggleSkill}
              isTogglingSkill={isTogglingSkill}
              onToggleMcp={onToggleMcp}
              isTogglingMcp={isTogglingMcp}
              onRemoveMcp={onRemoveMcp}
              isRemovingMcp={isRemovingMcp}
            />
          ) : activeTab === 'schedule' ? (
            <ScheduleTab agent={agent} onClose={onClose} />
          ) : (
            <ActivityTab agent={agent} />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--theme-border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Button
            variant="ghost"
            className="justify-start text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={() => void onDelete(agent.id)}
            disabled={isDeleting || isSaving}
          >
            <HugeiconsIcon icon={Delete02Icon} size={16} strokeWidth={1.8} />
            {isDeleting ? 'Deleting…' : 'Delete agent'}
          </Button>
          <div className="flex justify-end gap-3">
            <Button
              variant="secondary"
              className="border border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
              onClick={onClose}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              className="bg-[var(--theme-accent)] text-primary-950 hover:bg-[var(--theme-accent-strong)]"
              onClick={handleSave}
              disabled={isSaving || isDeleting}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
