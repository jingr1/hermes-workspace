import { parseSwarmModelLabel, type ResolvedSwarmModel } from './swarm-model-resolver'
import { rosterByWorkerId } from './swarm-roster'

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

/** Resolve the swarm roster model for a worker without mutating profile config. */
export function resolveWorkerRuntimeModel(
  workerId: string,
): ResolvedSwarmModel | null {
  const roster = rosterByWorkerId([workerId]).get(workerId)
  return parseSwarmModelLabel(roster?.model ?? null)
}

/** Shell env assignments for a launch-scoped model seed (tmux TUI / shell). */
export function buildSwarmModelEnvAssignments(
  resolved: ResolvedSwarmModel,
): Array<string> {
  return [
    `HERMES_MODEL='${shellEscapeSingle(resolved.default)}'`,
    `HERMES_INFERENCE_MODEL='${shellEscapeSingle(resolved.default)}'`,
    `HERMES_TUI_PROVIDER='${shellEscapeSingle(resolved.provider)}'`,
    `HERMES_INFERENCE_PROVIDER='${shellEscapeSingle(resolved.provider)}'`,
  ]
}

export function buildHermesChatQueryArgs(
  prompt: string,
  runtimeModel?: ResolvedSwarmModel | null,
): string[] {
  // `hermes chat -q` requires the query as the *immediate* next argv item.
  const args = [
    'chat',
    '-q',
    prompt,
    '-Q',
    '--yolo',
    '--ignore-rules',
    '--accept-hooks',
    '--max-turns',
    '15',
    '--source',
    'swarm-dispatch',
  ]
  if (!runtimeModel) return args
  return [
    'chat',
    '-q',
    prompt,
    '--model',
    runtimeModel.default,
    '--provider',
    runtimeModel.provider,
    '-Q',
    '--yolo',
    '--ignore-rules',
    '--accept-hooks',
    '--max-turns',
    '15',
    '--source',
    'swarm-dispatch',
  ]
}
