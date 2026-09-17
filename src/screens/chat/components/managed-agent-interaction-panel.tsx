'use client'

import { useState } from 'react'
import type { AgentActivityInteraction } from '@/lib/agent-activity-core'
import { projectManagedAgentInteraction } from '../lib/managed-agent-interactions'

export function ManagedAgentInteractionPanel({
  interactions,
  onRespond,
}: {
  interactions: Array<AgentActivityInteraction>
  onRespond: (input: { turnId: string; requestId: string; optionId: string }) => Promise<void>
}) {
  const cards = interactions
    .map(projectManagedAgentInteraction)
    .filter((card): card is NonNullable<typeof card> => card !== null)
  if (cards.length === 0) return null

  return (
    <div className="mx-4 my-2 space-y-2">
      {cards.map((card) => (
        <ManagedAgentInteractionCard key={card.requestId} card={card} onRespond={onRespond} />
      ))}
    </div>
  )
}

function ManagedAgentInteractionCard({
  card,
  onRespond,
}: {
  card: NonNullable<ReturnType<typeof projectManagedAgentInteraction>>
  onRespond: (input: { turnId: string; requestId: string; optionId: string }) => Promise<void>
}) {
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function respond(optionId: string) {
    setPendingOptionId(optionId)
    setError(null)
    try {
      await onRespond({ turnId: card.turnId, requestId: card.requestId, optionId })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPendingOptionId(null)
    }
  }

  return (
    <section className="border border-[var(--theme-border)] bg-[var(--theme-card)] p-3">
      <div className="text-xs font-semibold uppercase text-[var(--theme-muted)]">
        {card.kind}
      </div>
      <div className="mt-1 text-sm font-medium text-[var(--theme-text)]">{card.title}</div>
      {card.detail ? <p className="mt-1 text-xs text-[var(--theme-muted)]">{card.detail}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {card.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={pendingOptionId !== null}
            onClick={() => void respond(action.id)}
            className="border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)] disabled:opacity-50"
          >
            {pendingOptionId === action.id ? 'Sending...' : action.label}
          </button>
        ))}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  )
}