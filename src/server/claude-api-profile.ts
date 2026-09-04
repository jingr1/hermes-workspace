/**
 * Per-profile Hermes FastAPI client factory.
 *
 * `claude-api.ts` is a process-wide singleton that always points at the
 * current active gateway (`CLAUDE_API`). Group chat needs to talk to the
 * gateway that owns each participant's profile, so this module builds a
 * lightweight client keyed by profile name.
 *
 * The returned client mirrors the surface of `claude-api.ts` used by the
 * group-chat subsystem:
 *   - createSession
 *   - getMessages
 *   - sendChat
 *   - streamChat
 *   - updateSession
 *   - deleteSession
 */
import {
  getProfileGatewayUrl,
  isGatewayPoolEnabled,
} from './gateway-ports'
import { readProfileApiServerKey } from './gateway-capabilities'

const PROFILE_CLIENT_CACHE = new Map<string, ClaudeApiClient>()

export type ClaudeSession = {
  id: string
  source?: string
  user_id?: string | null
  model?: string | null
  title?: string | null
  started_at?: number
  ended_at?: number | null
  end_reason?: string | null
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  parent_session_id?: string | null
  last_active?: number | null
  preview?: string | null
}

export type ClaudeMessage = {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id?: string | null
  tool_calls?: Array<unknown> | string | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
}

type StreamChatOptions = {
  signal?: AbortSignal
  onEvent: (payload: {
    event: string
    data: Record<string, unknown>
  }) => void | Promise<void>
}

export interface ClaudeApiClient {
  baseUrl: string
  profileName: string
  createSession(opts?: {
    id?: string
    title?: string
    model?: string
  }): Promise<ClaudeSession>
  getMessages(sessionId: string): Promise<Array<ClaudeMessage>>
  sendChat(
    sessionId: string,
    messageOrOpts: string | { message: string; model?: string },
    model?: string,
  ): Promise<Record<string, unknown>>
  streamChat(
    sessionId: string,
    body: {
      message: string
      model?: string
      system_message?: string
      attachments?: Array<Record<string, unknown>>
    },
    opts: StreamChatOptions,
  ): Promise<void>
  updateSession(
    sessionId: string,
    updates: { title?: string },
  ): Promise<ClaudeSession>
  deleteSession(sessionId: string): Promise<void>
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

function authHeaders(profileName: string): Record<string, string> {
  const token = readProfileApiServerKey(profileName)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function profileFetch<T>(
  profileName: string,
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = {
    ...authHeaders(profileName),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes Agent API ${method} ${path}: ${res.status} ${text}`)
  }

  return res.json() as Promise<T>
}

async function profileDelete(
  profileName: string,
  baseUrl: string,
  path: string,
): Promise<void> {
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(profileName),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes Agent API DELETE ${path}: ${res.status} ${text}`)
  }
}

async function profileStreamChat(
  profileName: string,
  baseUrl: string,
  sessionId: string,
  body: {
    message: string
    model?: string
    system_message?: string
    attachments?: Array<Record<string, unknown>>
  },
  opts: StreamChatOptions,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/chat/stream`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(profileName),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes chat stream: ${res.status} ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6)
        if (dataStr === '[DONE]') continue
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>
          await opts.onEvent({ event: currentEvent || 'message', data })
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}

function buildClient(profileName: string, baseUrl: string): ClaudeApiClient {
  const url = normalizeUrl(baseUrl)
  return {
    baseUrl: url,
    profileName,

    createSession: (opts) =>
      profileFetch<{ session?: ClaudeSession; data?: ClaudeSession; id?: string }>(
        profileName,
        url,
        'POST',
        '/api/sessions',
        opts || {},
      ).then((resp) => {
        const session = resp.session ?? resp.data ?? (resp as ClaudeSession)
        if (!session?.id) {
          if (opts?.id) {
            return { id: opts.id, title: opts.title, model: opts.model }
          }
          throw new Error('Invalid session response')
        }
        return session
      }),

    getMessages: (sessionId) =>
      profileFetch<{
        items?: Array<ClaudeMessage>
        data?: Array<ClaudeMessage>
        messages?: Array<ClaudeMessage>
      }>(profileName, url, 'GET', `/api/sessions/${sessionId}/messages`).then(
        (resp) => resp.items ?? resp.data ?? resp.messages ?? [],
      ),

    sendChat: (sessionId, messageOrOpts, model) => {
      const msg =
        typeof messageOrOpts === 'string'
          ? messageOrOpts
          : messageOrOpts.message
      const mdl =
        typeof messageOrOpts === 'string' ? model : messageOrOpts.model
      return profileFetch(
        profileName,
        url,
        'POST',
        `/api/sessions/${sessionId}/chat`,
        { message: msg, model: mdl },
      )
    },

    streamChat: (sessionId, body, opts) =>
      profileStreamChat(profileName, url, sessionId, body, opts),

    updateSession: (sessionId, updates) =>
      profileFetch<{ session: ClaudeSession }>(
        profileName,
        url,
        'PATCH',
        `/api/sessions/${sessionId}`,
        updates,
      ).then((resp) => resp.session),

    deleteSession: (sessionId) =>
      profileDelete(profileName, url, `/api/sessions/${sessionId}`),
  }
}

/**
 * Resolve the gateway URL for a profile. When the multi-gateway pool is
 * enabled, each profile has a stable port; otherwise every profile shares the
 * single active gateway.
 */
export function resolveProfileGatewayUrl(profileName: string): string {
  if (isGatewayPoolEnabled()) {
    return getProfileGatewayUrl(profileName)
  }
  // Fallback to the global active gateway for deployments without a pool.
  return normalizeUrl(
    process.env.HERMES_API_URL ||
      process.env.CLAUDE_API_URL ||
      'http://127.0.0.1:8642',
  )
}

/**
 * Get or create a per-profile claude-api client. Cached so repeated turns
 * for the same participant reuse headers/URL without recomputing paths.
 */
export function getClaudeApiClient(profileName: string): ClaudeApiClient {
  const name = (profileName || 'default').trim() || 'default'
  const cached = PROFILE_CLIENT_CACHE.get(name)
  if (cached) return cached

  const url = resolveProfileGatewayUrl(name)
  const client = buildClient(name, url)
  PROFILE_CLIENT_CACHE.set(name, client)
  return client
}

/** Clear the client cache (useful in tests and after gateway reconfiguration). */
export function clearClaudeApiClientCache(): void {
  PROFILE_CLIENT_CACHE.clear()
}
