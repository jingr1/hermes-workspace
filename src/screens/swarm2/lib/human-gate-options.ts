import type { HumanGate } from '../hooks/use-human-gate'

export type HumanGateChoice = 'primary' | 'secondary' | 'custom'

export type HumanGateOption = {
  id: Exclude<HumanGateChoice, 'custom'>
  label: string
  description: string
  targetWorkerId: string
}

export type HumanGateOptions = {
  primary: HumanGateOption
  secondary: HumanGateOption
  customPlaceholder: string
}

/** Two preset choices + optional free-text (Claude Code / Hermes clarify style). */
export function deriveHumanGateOptions(gate: HumanGate): HumanGateOptions {
  const workerId = gate.workerId
  const verdict = gate.verdict

  if (verdict === 'NEEDS_INPUT' && workerId === 'architect') {
    return {
      primary: {
        id: 'primary',
        label: '派 developer 修复 P0',
        description: '按 architect 审查意见修复 half_car / lqr 等阻塞项，完成后回报 checkpoint。',
        targetWorkerId: 'developer',
      },
      secondary: {
        id: 'secondary',
        label: '让 architect 重新审查',
        description: '在修复或补充说明后，由 architect 再次审查并更新 checkpoint。',
        targetWorkerId: 'architect',
      },
      customPlaceholder: '例如：先只修 half_car.py 字段顺序，修完再跑 extensions 测试…',
    }
  }

  if (verdict === 'NEEDS_INPUT' && workerId === 'developer') {
    return {
      primary: {
        id: 'primary',
        label: '交 architect 审查',
        description: '实现完成后交给 architect 做设计/实现审查。',
        targetWorkerId: 'architect',
      },
      secondary: {
        id: 'secondary',
        label: '让 developer 继续修改',
        description: '根据下方说明继续实现或修复，再产出 checkpoint。',
        targetWorkerId: 'developer',
      },
      customPlaceholder: '补充实现范围、测试要求或架构约束…',
    }
  }

  if (verdict === 'BLOCKED') {
    return {
      primary: {
        id: 'primary',
        label: '重试当前 worker',
        description: `重新派发 ${workerId}，并在任务中包含阻塞原因与你的补充说明。`,
        targetWorkerId: workerId,
      },
      secondary: {
        id: 'secondary',
        label: '升级给 orchestrator 判断',
        description: '将阻塞上下文交给 orchestrator worker 做路由/拆解（若 roster 已配置）。',
        targetWorkerId: 'orchestrator',
      },
      customPlaceholder: '说明重试策略、环境修复步骤或希望转派的 worker…',
    }
  }

  return {
    primary: {
      id: 'primary',
      label: '继续执行',
      description: `按编排器建议继续，目标 worker：${workerId}。`,
      targetWorkerId: workerId,
    },
    secondary: {
      id: 'secondary',
      label: '换 worker 处理',
      description: workerId === 'researcher'
        ? '交给 architect 进入设计阶段。'
        : workerId === 'architect'
          ? '交给 developer 进入实现阶段。'
          : `重新指派 ${workerId} 处理当前阻塞。`,
      targetWorkerId:
        workerId === 'researcher'
          ? 'architect'
          : workerId === 'architect'
            ? 'developer'
            : workerId,
    },
    customPlaceholder: '输入你的决策、约束或给 worker 的补充指令…',
  }
}
