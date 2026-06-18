'use client'

import { useEffect, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Alert02Icon, Cancel01Icon, ComputerTerminal01Icon, PlayIcon } from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import type { HumanGate } from '../hooks/use-human-gate'

type HumanGatePanelProps = {
  gate: HumanGate
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenRuntime?: (workerId: string) => void
  onResume: (action: 'approved' | 'abort', options?: { mock?: boolean }) => void
  isResuming: boolean
  resumeError: Error | null
}

function Section({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
        {label}
      </div>
      <div className="text-sm text-[var(--theme-text)]">{children}</div>
    </div>
  )
}

function MonoBlock({ text }: { text: string }) {
  if (!text || text.trim() === 'none') return <span className="text-[var(--theme-muted)]">—</span>
  return (
    <div className="max-h-32 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2.5 text-xs leading-relaxed text-[var(--theme-text)]">
      {text}
    </div>
  )
}

export function HumanGatePanel({
  gate,
  open,
  onOpenChange,
  onOpenRuntime,
  onResume,
  isResuming,
  resumeError,
}: HumanGatePanelProps) {
  const [useMock, setUseMock] = useState(false)
  const [lastAction, setLastAction] = useState<'approved' | 'abort' | null>(null)

  useEffect(() => {
    if (resumeError) {
      toast(`Resume failed: ${resumeError.message}`, { type: 'error' })
    }
  }, [resumeError])

  const handleResume = (action: 'approved' | 'abort') => {
    setLastAction(action)
    onResume(action, { mock: useMock })
  }

  const cp = gate.checkpoint

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(520px,92vw)]"
        style={{ background: 'var(--theme-card)' }}
      >
        <div className="flex items-start gap-3 border-b border-[var(--theme-border)] p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-warning-soft)] text-[var(--theme-warning)]">
            <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">Mission 需要人工决策</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              LangGraph Phase 2 在当前 checkpoint 触发 human gate，需要你确认后才能继续。
            </DialogDescription>
          </div>
          <DialogClose />
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--theme-text)]">
              {gate.workerId}
            </span>
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-[11px] font-semibold',
                gate.verdict === 'BLOCKED'
                  ? 'bg-red-500/12 text-red-600 border border-red-500/25'
                  : gate.verdict === 'NEEDS_INPUT'
                    ? 'bg-amber-500/12 text-amber-600 border border-amber-500/25'
                    : 'bg-[var(--theme-accent-soft)] text-[var(--theme-accent-strong)] border border-[var(--theme-accent)]/25',
              )}
            >
              {gate.verdict}
            </span>
            {gate.blockerType ? (
              <span className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-card2)] px-2.5 py-1 text-[11px] text-[var(--theme-muted)]">
                {gate.blockerType}
              </span>
            ) : null}
          </div>

          <Section label="阻塞原因">
            <p className="leading-relaxed">{gate.blockerSummary || '未提供详细阻塞原因'}</p>
          </Section>

          {gate.reasoning ? (
            <Section label="编排器推理">
              <p className="leading-relaxed text-[var(--theme-muted-2)]">{gate.reasoning}</p>
            </Section>
          ) : null}

          {cp ? (
            <div className="space-y-3 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
                最新 checkpoint
              </div>
              {cp.result ? <Section label="Result"><MonoBlock text={cp.result} /></Section> : null}
              {cp.files_changed ? <Section label="Files changed"><MonoBlock text={cp.files_changed} /></Section> : null}
              {cp.commands_run ? <Section label="Commands run"><MonoBlock text={cp.commands_run} /></Section> : null}
              {cp.next_action ? <Section label="Next action"><MonoBlock text={cp.next_action} /></Section> : null}
            </div>
          ) : null}

          {gate.pendingAssignments.length > 0 ? (
            <Section label="批准后将派发的任务">
              <ul className="space-y-2">
                {gate.pendingAssignments.map((assignment, index) => (
                  <li
                    key={index}
                    className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3 text-xs"
                  >
                    <div className="font-semibold text-[var(--theme-text)]">{assignment.worker_id}</div>
                    <div className="mt-1 text-[var(--theme-muted-2)]">{assignment.task}</div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {gate.analysis ? (
            <Section label="路由分析">
              <MonoBlock text={gate.analysis} />
            </Section>
          ) : null}

          <div className="text-[10px] text-[var(--theme-muted)]">
            迭代 {gate.iteration} / {gate.maxIterations}
          </div>

          {isResuming ? (
            <div className="flex items-center gap-2 text-sm text-[var(--theme-muted)]">
              <span className="inline-block size-4 animate-spin rounded-full border-2 border-[var(--theme-border)] border-t-[var(--theme-accent)]" />
              {lastAction === 'approved' ? '正在恢复 mission…' : '正在中止 mission…'}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-[var(--theme-border)] p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            {onOpenRuntime ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenRuntime(gate.workerId)}
                disabled={isResuming}
              >
                <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} strokeWidth={1.8} />
                Runtime
              </Button>
            ) : null}
            {import.meta.env.DEV ? (
              <label className="flex items-center gap-1.5 text-xs text-[var(--theme-muted)]">
                <input
                  type="checkbox"
                  checked={useMock}
                  onChange={(e) => setUseMock(e.target.checked)}
                  className="rounded border-[var(--theme-border)]"
                />
                mock
              </label>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => handleResume('abort')}
              disabled={isResuming}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
              中止
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => handleResume('approved')}
              disabled={isResuming}
            >
              <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.8} />
              继续执行
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
