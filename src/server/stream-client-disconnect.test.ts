import { describe, expect, it } from 'vitest'

import {
  evaluateClientDisconnect,
  shouldAbortUpstreamOnStreamClose,
} from './stream-client-disconnect'

describe('stream-client-disconnect', () => {
  it('aborts upstream by default on stream close', () => {
    expect(
      shouldAbortUpstreamOnStreamClose({
        keepUpstreamAlive: false,
        detachedHandoff: false,
      }),
    ).toBe(true)
  })

  it('keeps upstream alive after detached profile handoff', () => {
    expect(
      shouldAbortUpstreamOnStreamClose({
        keepUpstreamAlive: true,
        detachedHandoff: true,
      }),
    ).toBe(false)
  })

  it('honors explicit abort even when detached', () => {
    expect(
      shouldAbortUpstreamOnStreamClose({
        explicitAbort: true,
        keepUpstreamAlive: true,
        detachedHandoff: true,
      }),
    ).toBe(true)
  })

  it('evaluates detach handoff for registered runs', () => {
    expect(
      evaluateClientDisconnect({
        activeRunId: 'run-1',
        streamClosed: false,
        resolveAction: () => 'detach_handoff',
      }),
    ).toEqual({
      keepUpstreamAlive: true,
      detachedHandoff: true,
      runIdToUnregister: null,
      shouldPersistHandoff: true,
    })
  })

  it('unregisters active runs when not detached', () => {
    expect(
      evaluateClientDisconnect({
        activeRunId: 'run-2',
        streamClosed: false,
        resolveAction: () => 'abort_upstream',
      }),
    ).toEqual({
      keepUpstreamAlive: false,
      detachedHandoff: false,
      runIdToUnregister: 'run-2',
      shouldPersistHandoff: false,
    })
  })

  it('ignores disconnect when stream is already closed', () => {
    expect(
      evaluateClientDisconnect({
        activeRunId: 'run-3',
        streamClosed: true,
        resolveAction: () => 'detach_handoff',
      }),
    ).toEqual({
      keepUpstreamAlive: false,
      detachedHandoff: false,
      runIdToUnregister: null,
      shouldPersistHandoff: false,
    })
  })
})
