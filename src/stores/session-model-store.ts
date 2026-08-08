import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Per-session model preference.
 *
 * Stored locally in the browser keyed by sessionKey, so a user can pick a
 * different model for one chat without affecting the global default in
 * `~/.hermes/config.yaml` or any other channel (Telegram, Discord, etc.).
 *
 * On every send, the workspace passes this value as the `model` field in
 * the chat-completion request body. The gateway uses it for that request
 * only; nothing else mutates.
 *
 * Cleared automatically when the session is deleted.
 *
 * New-chat drafts use {@link PENDING_SESSION_MODEL_KEY} until the first
 * message creates a real session id; chat-screen migrates the value then.
 */
export const PENDING_SESSION_MODEL_KEY = 'new'

type State = {
  models: Record<string, string>
}

type Actions = {
  getModel: (sessionKey: string | null | undefined) => string | undefined
  setModel: (sessionKey: string, model: string) => void
  clearModel: (sessionKey: string) => void
  /** Move a pending/new-chat pick onto the concrete session key. */
  transferModel: (fromKey: string, toKey: string) => void
}

export const useSessionModelStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      models: {},
      getModel: (sessionKey) => {
        if (!sessionKey) return undefined
        return get().models[sessionKey]
      },
      setModel: (sessionKey, model) => {
        if (!sessionKey) return
        const trimmed = model.trim()
        if (!trimmed) return
        set((state) => ({
          models: { ...state.models, [sessionKey]: trimmed },
        }))
      },
      clearModel: (sessionKey) => {
        if (!sessionKey) return
        set((state) => {
          if (!(sessionKey in state.models)) return state
          const next = { ...state.models }
          delete next[sessionKey]
          return { models: next }
        })
      },
      transferModel: (fromKey, toKey) => {
        const from = fromKey.trim()
        const to = toKey.trim()
        if (!from || !to || from === to) return
        const value = get().models[from]
        if (!value) return
        set((state) => {
          const next = { ...state.models, [to]: value }
          delete next[from]
          return { models: next }
        })
      },
    }),
    {
      name: 'hermes-session-model',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ models: state.models }),
    },
  ),
)
