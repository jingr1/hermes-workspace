import { createFileRoute, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { fetchAgents } from '../../../lib/agent-api'
import { AgentStatusDot } from '../../../screens/chat/components/agent-status-dot'
import { cn } from '../../../lib/utils'
import type { AgentWithStatus } from '../../../lib/agent-types'

const RUNTIME_LABELS: Record<string, string> = {
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'deepseek-harness': 'DeepSeek',
  opencode: 'OpenCode',
}

function SettingsRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-4 border-b border-primary-200 py-3 last:border-0 dark:border-primary-800">
      <dt className="text-sm font-medium text-primary-500 dark:text-primary-400">{label}</dt>
      <dd className="text-sm text-primary-950 dark:text-primary-100">{value}</dd>
    </div>
  )
}

function AgentSettingsPage() {
  const { agentId } = useParams({ from: '/settings/agents/$agentId' })
  const [agent, setAgent] = useState<AgentWithStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetchAgents()
      .then((data) => {
        const found = data.agents.find((a) => a.agentId === agentId)
        if (found) setAgent(found)
        else setError('Agent not found')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [agentId])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-primary-500">
        Loading agent settings…
      </div>
    )
  }

  if (error || !agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-500">
        {error ?? 'Agent not found'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <AgentStatusDot status={agent.status} className="size-3" />
        <div>
          <h1 className="text-xl font-semibold text-primary-950 dark:text-primary-100">
            {agent.name}
          </h1>
          <p className="text-sm text-primary-500 dark:text-primary-400">
            {RUNTIME_LABELS[agent.runtime] ?? agent.runtime}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-primary-200 bg-primary-50/50 p-4 dark:border-primary-800 dark:bg-primary-950/50">
        <dl>
          <SettingsRow label="Agent ID" value={agent.agentId} />
          <SettingsRow label="Runtime" value={agent.runtime} />
          <SettingsRow label="Execution" value={agent.execution} />
          {agent.runtimeConfig.profile ? (
            <SettingsRow label="Hermes Profile" value={agent.runtimeConfig.profile} />
          ) : null}
          {agent.runtimeConfig.command ? (
            <SettingsRow label="Command" value={agent.runtimeConfig.command} />
          ) : null}
          {agent.runtimeConfig.args && agent.runtimeConfig.args.length > 0 ? (
            <SettingsRow label="Args" value={agent.runtimeConfig.args.join(' ')} />
          ) : null}
          <SettingsRow
            label="Capabilities"
            value={
              agent.runtimeConfig.capabilities.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {agent.runtimeConfig.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className={cn(
                        'rounded-full border border-primary-300/70 bg-primary-200/70 px-2 py-0.5 text-xs font-medium text-primary-700',
                        'dark:border-primary-800 dark:bg-primary-900 dark:text-primary-300',
                      )}
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              ) : (
                'None declared'
              )
            }
          />
          {typeof agent.runtimeConfig.maxConcurrentTasks === 'number' ? (
            <SettingsRow label="Max Concurrency" value={agent.runtimeConfig.maxConcurrentTasks} />
          ) : null}
        </dl>
      </div>

      {agent.runtime !== 'hermes' ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/15 dark:text-amber-300">
          <p className="font-medium">Managed runtime configuration</p>
          <p className="mt-1">
            {agent.runtime} adapters are still being wired. To change settings, edit
            the agent declaration in <code>agents.yaml</code> and reload the workspace.
          </p>
        </div>
      ) : null}
    </div>
  )
}

export const Route = createFileRoute('/settings/agents/$agentId')({
  component: AgentSettingsPage,
})
