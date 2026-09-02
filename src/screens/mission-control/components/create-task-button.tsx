'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import { PlusSignIcon } from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toast'

const PIPELINES_QUERY_KEY = ['mission-control', 'pipelines'] as const

async function fetchPipelines(): Promise<
  Array<{ id: string; name: string; stages: number }>
> {
  const res = await fetch('/api/pipelines')
  if (!res.ok) throw new Error(`Failed to fetch pipelines: ${res.status}`)
  const data = (await res.json()) as {
    pipelines?: Array<{ id: string; name: string; stages: number }>
    error?: string
  }
  if (data.error) throw new Error(data.error)
  return data.pipelines ?? []
}

async function createTask(payload: {
  title: string
  spec: string
  pipelineId: string
  acceptanceCriteria: Array<string>
}): Promise<unknown> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok || data.error) {
    throw new Error(data.error || `Failed to create task: ${res.status}`)
  }
  return data
}

type CreateTaskButtonProps = {
  variant?: 'header' | 'inline'
}

export function CreateTaskButton({
  variant = 'header',
}: CreateTaskButtonProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  const [criteria, setCriteria] = useState('')
  const [selectedPipelineId, setSelectedPipelineId] = useState('')
  const queryClient = useQueryClient()

  const pipelinesQuery = useQuery({
    queryKey: PIPELINES_QUERY_KEY,
    queryFn: fetchPipelines,
    enabled: open,
  })

  const createMutation = useMutation({
    mutationFn: createTask,
    onSuccess: () => {
      setOpen(false)
      setTitle('')
      setSpec('')
      setCriteria('')
      setSelectedPipelineId('')
      void queryClient.invalidateQueries({
        queryKey: ['mission-control', 'tasks'],
      })
      void queryClient.invalidateQueries({
        queryKey: ['mission-control', 'agents'],
      })
      toast('Task created', { type: 'success' })
    },
    onError: (error: Error) => {
      toast(error.message || 'Failed to create task', { type: 'error' })
    },
  })

  const pipelines = pipelinesQuery.data ?? []

  return (
    <>
      {variant === 'header' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-[var(--theme-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--theme-accent-strong)]"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} />
          New task
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-[var(--theme-accent-strong)] hover:underline"
        >
          + New task
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className={cn(
              'w-full max-w-lg rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-5 text-[var(--theme-text)] shadow-xl',
            )}
          >
            <h2 className="text-sm font-semibold">Create task</h2>
            <p className="text-xs text-[var(--theme-muted)]">
              Create a kanban card and instantiate a pipeline mission.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--theme-muted)]">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Refactor auth layer"
                  className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--theme-accent)]"
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--theme-muted)]">
                  Pipeline
                </label>
                <select
                  value={selectedPipelineId}
                  onChange={(e) => setSelectedPipelineId(e.target.value)}
                  className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--theme-accent)]"
                >
                  <option value="">Select a pipeline…</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.stages} stage{p.stages === 1 ? '' : 's'})
                    </option>
                  ))}
                </select>
                {pipelinesQuery.isLoading && (
                  <p className="mt-1 text-[10px] text-[var(--theme-muted)]">
                    Loading pipelines…
                  </p>
                )}
                {pipelinesQuery.isError && (
                  <p className="mt-1 text-[10px] text-red-500">
                    {pipelinesQuery.error instanceof Error
                      ? pipelinesQuery.error.message
                      : 'Failed to load pipelines'}
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--theme-muted)]">
                  Spec
                </label>
                <textarea
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  rows={4}
                  placeholder="What should the agents do?"
                  className="w-full resize-none rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--theme-accent)]"
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--theme-muted)]">
                  Acceptance criteria
                </label>
                <textarea
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  rows={3}
                  placeholder="One per line"
                  className="w-full resize-none rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--theme-accent)]"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-[var(--theme-border)] px-3 py-1.5 text-xs font-medium text-[var(--theme-muted)] hover:bg-[var(--theme-hover)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  !title.trim() ||
                  !selectedPipelineId ||
                  createMutation.isPending
                }
                onClick={() => {
                  createMutation.mutate({
                    title: title.trim(),
                    spec: spec.trim(),
                    pipelineId: selectedPipelineId,
                    acceptanceCriteria: criteria
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }}
                className="rounded-md bg-[var(--theme-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--theme-accent-strong)] disabled:opacity-50"
              >
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
