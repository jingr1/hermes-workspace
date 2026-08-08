import { beforeEach, describe, expect, it } from 'vitest'
import {
  PENDING_SESSION_MODEL_KEY,
  useSessionModelStore,
} from './session-model-store'

describe('session-model-store', () => {
  beforeEach(() => {
    useSessionModelStore.setState({ models: {} })
  })

  it('stores a pending new-chat model pick under the draft key', () => {
    useSessionModelStore
      .getState()
      .setModel(PENDING_SESSION_MODEL_KEY, 'deepseek/deepseek-v4-flash')

    expect(useSessionModelStore.getState().models[PENDING_SESSION_MODEL_KEY]).toBe(
      'deepseek/deepseek-v4-flash',
    )
  })

  it('transfers a pending pick onto the concrete session id', () => {
    useSessionModelStore
      .getState()
      .setModel(PENDING_SESSION_MODEL_KEY, 'moonshot-coding-plan/k3')
    useSessionModelStore
      .getState()
      .transferModel(PENDING_SESSION_MODEL_KEY, 'thread-123')

    expect(useSessionModelStore.getState().models).toEqual({
      'thread-123': 'moonshot-coding-plan/k3',
    })
  })
})
