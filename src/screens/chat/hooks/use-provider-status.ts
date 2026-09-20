import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/ui/toast'
import { sanitizeHttpErrorText } from '@/lib/http-error'
import type {
  AgentProviderId,
  AgentProviderInstallResultDto,
  AgentProviderStatusListDto,
} from '@/lib/managed-agent-runtime/provider-status'

export const AGENT_PROVIDER_STATUS_QUERY_KEY = [
  'agent-runtime',
  'status',
] as const

const PROVIDER_STATUS_REFETCH_INTERVAL_MS = 30_000

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body: unknown = JSON.parse(text)
    if (body && typeof body === 'object' && 'error' in body) {
      const detail = (body as { error?: unknown }).error
      if (typeof detail === 'string' && detail.trim()) return detail.trim()
    }
  } catch {
    // Fall through to the generic sanitizer for non-JSON bodies.
  }
  return sanitizeHttpErrorText(text, fallback)
}

async function fetchProviderStatus(): Promise<AgentProviderStatusListDto> {
  const response = await fetch('/api/agent-runtime/status')
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to load agent runtime status (${response.status})`,
      ),
    )
  }
  return (await response.json()) as AgentProviderStatusListDto
}

async function installProvider(input: {
  provider: AgentProviderId
  version?: string
}): Promise<AgentProviderInstallResultDto> {
  const response = await fetch('/api/agent-runtime/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      input.version
        ? { provider: input.provider, version: input.version }
        : { provider: input.provider },
    ),
  })
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to install ${input.provider} (${response.status})`,
      ),
    )
  }
  return (await response.json()) as AgentProviderInstallResultDto
}

async function setProviderEnabled(input: {
  provider: AgentProviderId
  enabled: boolean
}): Promise<{ provider: string; enabled: boolean }> {
  const response = await fetch('/api/agent-runtime/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to update ${input.provider} (${response.status})`,
      ),
    )
  }
  return (await response.json()) as { provider: string; enabled: boolean }
}

type UseAgentProviderStatusOptions = {
  /** Disable periodic polling when the user turns off auto-check. */
  refetchInterval?: number | false
}

/**
 * Polls the daemon provider runtime aggregate. Errors are swallowed into the
 * query state on purpose: the agent list renders an "unknown" badge instead
 * of error surfaces while the daemon is starting or unreachable.
 */
export function useAgentProviderStatus(
  options?: UseAgentProviderStatusOptions,
) {
  return useQuery({
    queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
    queryFn: fetchProviderStatus,
    retry: false,
    staleTime: 15_000,
    refetchInterval:
      options?.refetchInterval ?? PROVIDER_STATUS_REFETCH_INTERVAL_MS,
  })
}

/** Installs/upgrades one provider runtime and refreshes the status poll. */
export function useInstallAgentProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: installProvider,
    onSuccess: (result, input) => {
      toast(
        result.status === 'already'
          ? `${input.provider} is already up to date`
          : `Installed ${input.provider}${result.version ? ` ${result.version}` : ''}`,
      )
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Install failed')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
  })
}

/** Enables/disables one provider runtime and refreshes the status poll. */
export function useSetAgentProviderEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: setProviderEnabled,
    onSuccess: (_, input) => {
      toast(`${input.enabled ? 'Enabled' : 'Disabled'} ${input.provider}`)
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Update failed')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: AGENT_PROVIDER_STATUS_QUERY_KEY,
      })
    },
  })
}
