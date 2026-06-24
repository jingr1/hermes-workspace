'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogContent, DialogDescription, DialogRoot, DialogTitle } from '@/components/ui/dialog'
import { useLanggraphAutopilot } from '../hooks/use-langgraph-autopilot'

type LanggraphAutopilotPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LanggraphAutopilotPanel({ open, onOpenChange }: LanggraphAutopilotPanelProps) {
  const [goal, setGoal] = useState('设计并开发 CDC+空簧 的物理模型')
  const [workflowPath, setWorkflowPath] = useState('')
  const [useMock, setUseMock] = useState(false)
  const {
    activeMissionId,
    start,
    isStarting,
    startError,
    status,
    isLoadingStatus,
  } = useLanggraphAutopilot()

  const orchestrator = status?.orchestratorState

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,92vw)]" style={{ background: 'var(--theme-card)' }}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--theme-border)] p-5">
          <div>
            <DialogTitle className="text-base font-semibold">LangGraph Autopilot</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              通过 tmux 优先派发启动 CDC 工作流；Human Gate 触发时会在 Swarm 顶部提示。
            </DialogDescription>
          </div>
          <DialogClose />
        </div>

        <div className="space-y-4 p-5">
          <label className="block space-y-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">Mission goal</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
              Workflow 路径（可选）
            </span>
            <input
              value={workflowPath}
              onChange={(e) => setWorkflowPath(e.target.value)}
              placeholder="hermes_langgraph_orchestrator/workflows/research_only.yaml"
              className="w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
            />
            <span className="block text-[11px] text-[var(--theme-muted)]">
              留空使用默认 CDC；示例：`research_only.yaml`、`design_implement.yaml`
            </span>
          </label>

          {import.meta.env.DEV ? (
            <label className="flex items-center gap-2 text-xs text-[var(--theme-muted)]">
              <input type="checkbox" checked={useMock} onChange={(e) => setUseMock(e.target.checked)} />
              mock services (CI / no workers)
            </label>
          ) : null}

          {startError ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
              {startError.message}
            </div>
          ) : null}

          <Button
            type="button"
            disabled={isStarting || !goal.trim()}
            onClick={() =>
              start(goal.trim(), {
                mock: useMock,
                workflowId: workflowPath.trim() || undefined,
              })
            }
          >
            {isStarting ? '启动中…' : '启动 LangGraph Mission'}
          </Button>

          {activeMissionId ? (
            <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3 text-xs">
              <div className="font-semibold text-[var(--theme-text)]">Mission {activeMissionId}</div>
              {isLoadingStatus ? (
                <div className="mt-2 text-[var(--theme-muted)]">加载状态…</div>
              ) : (
                <div className="mt-2 space-y-1 text-[var(--theme-muted-2)]">
                  <div>
                    Workflow:{' '}
                    {orchestrator?.workflow_spec?.name
                      ?? (orchestrator?.workflow_path ? orchestrator.workflow_path : 'cdc (default)')}
                  </div>
                  <div>迭代: {orchestrator?.iteration ?? 0} / {orchestrator?.max_iterations ?? 5}</div>
                  <div>Human gate: {orchestrator?.langgraph_needs_human ? '等待审批' : '无'}</div>
                  <div>完成: {orchestrator?.all_done ? '是' : '否'}</div>
                  {status?.mission?.state ? <div>Mission store: {status.mission.state}</div> : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
