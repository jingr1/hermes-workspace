'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  createAgentConsistent,
  CREATE_AGENT_RUNTIMES,
  type CreateAgentRuntime,
  normalizeAgentId,
} from '@/lib/create-agent'
import {
  agentRuntimeLabel,
} from '@/lib/managed-agent-runtime/agent-targets'

type Runtime = CreateAgentRuntime
type Agent = {
  id: string
  name: string
  runtime: Runtime
  profile?: string
  command?: string
  args?: Array<string>
  role?: string
  specialty?: string
}

type FormState = {
  id: string
  name: string
  runtime: Runtime
  profile: string
  cloneFrom: string
  model: string
  command: string
  args: string
  role: string
  specialty: string
}

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  runtime: 'hermes',
  profile: '',
  cloneFrom: '',
  model: '',
  command: '',
  args: '',
  role: 'Worker',
  specialty: '',
}

function formFromAgent(agent: Agent): FormState {
  return {
    id: agent.id,
    name: agent.name,
    runtime: agent.runtime,
    profile: agent.profile ?? '',
    cloneFrom: '',
    model: '',
    command: agent.command ?? '',
    args: agent.args?.join(' ') ?? '',
    role: agent.role ?? 'Worker',
    specialty: agent.specialty ?? '',
  }
}

export function AgentRegistryManager() {
  const [agents, setAgents] = useState<Array<Agent>>([])
  const [profiles, setProfiles] = useState<Array<{ name: string }>>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadAgents() {
    setLoading(true)
    try {
      const response = await fetch('/api/agent-registry')
      const body = (await response.json()) as {
        agents?: Array<Agent>
        error?: string
      }
      if (!response.ok) throw new Error(body.error ?? 'Failed to load agents')
      setAgents(body.agents ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function loadProfiles() {
    try {
      const response = await fetch('/api/profiles/list?light=1')
      const body = (await response.json()) as {
        profiles?: Array<{ name: string }>
      }
      if (!response.ok) return
      setProfiles(
        (body.profiles ?? []).filter((profile) => profile.name !== 'default'),
      )
    } catch {
      // optional for clone dropdown
    }
  }

  useEffect(() => {
    void loadAgents()
    void loadProfiles()
  }, [])

  function resetForm() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setError(null)
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function saveAgent(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        const payload = {
          id: form.id.trim(),
          name: form.name.trim() || form.id.trim(),
          runtime: form.runtime,
          profile:
            form.runtime === 'hermes'
              ? form.profile.trim() || form.id.trim()
              : undefined,
          command:
            form.runtime === 'hermes'
              ? undefined
              : form.command.trim() || undefined,
          args: form.args.trim(),
          role: form.role.trim() || 'Worker',
          specialty: form.specialty.trim(),
        }
        const response = await fetch('/api/agent-registry', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: editingId, patch: payload }),
        })
        const body = (await response.json()) as { error?: string }
        if (!response.ok) throw new Error(body.error ?? 'Failed to save agent')
      } else {
        const id = normalizeAgentId(form.id || form.name)
        await createAgentConsistent({
          id,
          name: form.name.trim() || id,
          runtime: form.runtime,
          profile:
            form.runtime === 'hermes'
              ? form.profile.trim() || id
              : undefined,
          cloneFrom:
            form.runtime === 'hermes'
              ? form.cloneFrom.trim() || undefined
              : undefined,
          model:
            form.runtime === 'hermes' ? form.model.trim() || undefined : undefined,
          command:
            form.runtime === 'hermes'
              ? undefined
              : form.command.trim() || undefined,
          args: form.args.trim() || undefined,
          role: form.role.trim() || 'Worker',
          specialty: form.specialty.trim(),
        })
      }
      resetForm()
      await loadAgents()
      await loadProfiles()
      window.dispatchEvent(new Event('agorax:agents-changed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function removeAgent(agent: Agent) {
    if (
      !window.confirm(
        `Delete ${agent.name}?${agent.runtime === 'hermes' ? ' Its Hermes profile will also be deleted.' : ''}`,
      )
    )
      return
    setError(null)
    try {
      const response = await fetch('/api/agent-registry', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Failed to delete agent')
      if (editingId === agent.id) resetForm()
      await loadAgents()
      window.dispatchEvent(new Event('agorax:agents-changed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function renderEditor(showCancel: boolean) {
    const isHermes = form.runtime === 'hermes'
    const creating = !editingId
    return (
      <>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm text-primary-800">
            Agent ID
            <Input
              required
              disabled={!!editingId}
              value={form.id}
              onChange={(event) => updateField('id', event.target.value)}
              placeholder="reviewer"
            />
          </label>
          <label className="text-sm text-primary-800">
            Display name
            <Input
              value={form.name}
              onChange={(event) => updateField('name', event.target.value)}
              placeholder="Reviewer"
            />
          </label>
          <label className="text-sm text-primary-800">
            Runtime
            <select
              value={form.runtime}
              disabled={!!editingId}
              onChange={(event) =>
                updateField('runtime', event.target.value as Runtime)
              }
              className="mt-1 h-9 w-full rounded-lg border border-primary-200 bg-surface px-3 text-sm"
            >
              {CREATE_AGENT_RUNTIMES.map((runtime) => (
                <option key={runtime} value={runtime}>
                  {agentRuntimeLabel(runtime)}
                </option>
              ))}
            </select>
          </label>
          {isHermes ? (
            <label className="text-sm text-primary-800">
              Hermes profile
              <Input
                value={form.profile}
                onChange={(event) => updateField('profile', event.target.value)}
                placeholder={form.id || 'profile-id'}
                disabled={!!editingId}
              />
            </label>
          ) : (
            <label className="text-sm text-primary-800">
              Command
              <Input
                value={form.command}
                onChange={(event) => updateField('command', event.target.value)}
                placeholder={agentRuntimeLabel(form.runtime)}
              />
            </label>
          )}
          {isHermes && creating ? (
            <>
              <label className="text-sm text-primary-800 md:col-span-2">
                Profile create guidance
                <p className="mt-1 rounded-lg border border-dashed border-primary-300 bg-surface px-3 py-2 text-xs text-primary-600">
                  Creating a Hermes agent calls{' '}
                  <code className="text-primary-800">POST /api/profiles/create</code>{' '}
                  first (optional clone + model), then registers the agent in
                  the roster — same path as Agents → New Agent.
                </p>
              </label>
              <label className="text-sm text-primary-800">
                Clone from profile
                <select
                  value={form.cloneFrom}
                  onChange={(event) =>
                    updateField('cloneFrom', event.target.value)
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-primary-200 bg-surface px-3 text-sm"
                >
                  <option value="">None (blank / default clone on server)</option>
                  <option value="default">default</option>
                  {profiles.map((profile) => (
                    <option key={profile.name} value={profile.name}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-primary-800">
                Model (optional)
                <Input
                  value={form.model}
                  onChange={(event) => updateField('model', event.target.value)}
                  placeholder="provider/model"
                />
              </label>
            </>
          ) : null}
          <label className="text-sm text-primary-800">
            Role
            <Input
              value={form.role}
              onChange={(event) => updateField('role', event.target.value)}
              placeholder="Worker"
            />
          </label>
          <label className="text-sm text-primary-800">
            Specialty
            <Input
              value={form.specialty}
              onChange={(event) => updateField('specialty', event.target.value)}
              placeholder="Code review"
            />
          </label>
          <label className="text-sm text-primary-800 md:col-span-2">
            Arguments
            <Input
              value={form.args}
              onChange={(event) => updateField('args', event.target.value)}
              placeholder="Optional command arguments"
            />
          </label>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          {showCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={resetForm}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create agent'}
          </Button>
        </div>
      </>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3">
        {loading ? (
          <p className="text-sm text-primary-500">Loading agents…</p>
        ) : null}
        {!loading && agents.length === 0 ? (
          <p className="rounded-xl border border-dashed border-primary-300 p-4 text-sm text-primary-600">
            No agents declared yet.
          </p>
        ) : null}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="rounded-xl border border-primary-200 bg-primary-50 p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-primary-900">
                  {agent.name}
                </p>
                <p className="truncate text-xs text-primary-600">
                  {agent.id} · {agentRuntimeLabel(agent.runtime)}
                </p>
                {agent.runtime === 'hermes' ? (
                  <p className="truncate text-xs text-primary-500">
                    Profile: {agent.profile ?? agent.id}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                {agent.id === 'default' ? (
                  <span className="px-2 text-xs text-primary-500">System</span>
                ) : null}
                {agent.id !== 'default' ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${agent.name}`}
                      onClick={() => {
                        setEditingId(agent.id)
                        setForm(formFromAgent(agent))
                        setError(null)
                      }}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${agent.name}`}
                      onClick={() => void removeAgent(agent)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={16} />
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            {editingId === agent.id ? (
              <form
                onSubmit={saveAgent}
                className="mt-4 border-t border-primary-200 pt-4"
              >
                {renderEditor(true)}
              </form>
            ) : null}
          </div>
        ))}
      </div>

      {!editingId ? (
        <form
          onSubmit={saveAgent}
          className="rounded-xl border border-primary-200 bg-primary-50/60 p-4"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-primary-900">
                Add agent
              </h3>
              <p className="text-xs text-primary-600">
                Same create path as Agents → New Agent. Hermes creates a profile
                via /api/profiles/create first.
              </p>
            </div>
            <HugeiconsIcon icon={PlusSignIcon} size={18} />
          </div>
          {renderEditor(false)}
        </form>
      ) : null}
    </div>
  )
}
