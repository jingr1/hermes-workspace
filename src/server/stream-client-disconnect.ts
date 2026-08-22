import {
  resolveClientDisconnectAction,
  type ClientDisconnectAction,
} from './stream-handoff-registry'

export function shouldAbortUpstreamOnStreamClose(input: {
  explicitAbort?: boolean
  keepUpstreamAlive: boolean
  detachedHandoff: boolean
}): boolean {
  return (
    input.explicitAbort ?? (!input.keepUpstreamAlive && !input.detachedHandoff)
  )
}

export type ClientDisconnectEvaluation = {
  keepUpstreamAlive: boolean
  detachedHandoff: boolean
  runIdToUnregister: string | null
  shouldPersistHandoff: boolean
}

export function evaluateClientDisconnect(input: {
  activeRunId: string | null
  streamClosed: boolean
  resolveAction?: (args: {
    runId: string
  }) => ClientDisconnectAction
}): ClientDisconnectEvaluation {
  const idle: ClientDisconnectEvaluation = {
    keepUpstreamAlive: false,
    detachedHandoff: false,
    runIdToUnregister: null,
    shouldPersistHandoff: false,
  }
  if (!input.activeRunId || input.streamClosed) return idle

  const resolve = input.resolveAction ?? resolveClientDisconnectAction
  const keepUpstreamAlive =
    resolve({ runId: input.activeRunId }) === 'detach_handoff'
  if (keepUpstreamAlive) {
    return {
      keepUpstreamAlive: true,
      detachedHandoff: true,
      runIdToUnregister: null,
      shouldPersistHandoff: true,
    }
  }
  return {
    keepUpstreamAlive: false,
    detachedHandoff: false,
    runIdToUnregister: input.activeRunId,
    shouldPersistHandoff: false,
  }
}
