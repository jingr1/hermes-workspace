import { chatQueryKeys, fetchSessions } from '../chat-queries'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from '@/components/ui/toast'
import { sanitizeHttpErrorText } from '@/lib/http-error'

export type ChatProfileSummary = {
  name: string
  active?: boolean
  model?: string
  provider?: string
  skillCount?: number
  sessionCount?: number
  description?: string
  gatewayState?: 'stopped' | 'spawning' | 'healthy' | 'dead'
  gatewayPort?: number
}

type ProfilesListResponse = {
  profiles?: Array<ChatProfileSummary>
  activeProfile?: string
}

export function setActiveProfileOptimistic(
  queryClient: QueryClient,
  profileName: string,
) {
  queryClient.setQueryData<ProfilesListResponse>(
    ['profiles', 'chat'],
    (old) =>
      old
        ? {
            ...old,
            activeProfile: profileName,
            profiles: old.profiles?.map((p) => ({
              ...p,
              active: p.name === profileName,
            })),
          }
        : { activeProfile: profileName, profiles: [] },
  )
}

async function fetchProfiles(): Promise<ProfilesListResponse> {
  const response = await fetch('/api/profiles/list')
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Failed to load profiles (${response.status})`)
  }
  return (await response.json()) as ProfilesListResponse
}

async function activateProfile(name: string): Promise<void> {
  const response = await fetch('/api/profiles/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const text = sanitizeHttpErrorText(
      await response.text().catch(() => ''),
      `Failed to activate profile (${response.status})`,
    )
    throw new Error(text)
  }
}

export function useProfiles() {
  const queryClient = useQueryClient()

  const profilesQuery = useQuery({
    queryKey: ['profiles', 'chat'],
    queryFn: fetchProfiles,
    retry: false,
    staleTime: 60_000,
  })

  const activateMutation = useMutation({
    mutationFn: activateProfile,
    onMutate: async (profileName) => {
      // Optimistically update the active profile so the UI (including the
      // ChatSessionSidebar session list) switches immediately.
      await queryClient.cancelQueries({ queryKey: ['profiles', 'chat'] })
      const previous = queryClient.getQueryData<ProfilesListResponse>([
        'profiles',
        'chat',
      ])
      setActiveProfileOptimistic(queryClient, profileName)
      return { previous }
    },
    onError: (error, _profileName, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['profiles', 'chat'], context.previous)
      }
      toast(
        error instanceof Error ? error.message : 'Failed to activate profile',
      )
    },
    onSuccess: (_data, profileName) => {
      toast(`Activated ${profileName}`)
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['profiles', 'chat'] })
        void queryClient.invalidateQueries({ queryKey: ['gateway-pool', 'status'] })
      }, 1500)
    },
    onSettled: (_data, _error, profileName) => {
      // Don't await model refetch — it probes the new gateway and would
      // contend with the chat history request during profile switch.
      void queryClient.invalidateQueries({ queryKey: ['claude', 'models'] })
      void queryClient.invalidateQueries({
        queryKey: ['claude', 'session-status-model'],
      })
      if (profileName) {
        void queryClient.prefetchQuery({
          queryKey: chatQueryKeys.sessionsForProfile(profileName),
          queryFn: () => fetchSessions(profileName),
          staleTime: 60_000,
        })
      }
    },
  })

  const activeProfileName =
    profilesQuery.data?.activeProfile ||
    profilesQuery.data?.profiles?.find((p) => p.active)?.name ||
    'default'

  const activeProfile = profilesQuery.data?.profiles?.find(
    (profile) => profile.name === activeProfileName,
  )

  return {
    profiles: profilesQuery.data?.profiles ?? [],
    activeProfileName,
    activeProfile,
    isLoading: profilesQuery.isLoading,
    isReady: profilesQuery.isFetched,
    isError: profilesQuery.isError,
    error:
      profilesQuery.error instanceof Error
        ? profilesQuery.error.message
        : null,
    activateProfile: activateMutation.mutate,
    isActivating: activateMutation.isPending,
    refetch: profilesQuery.refetch,
  }
}

export type GatewayPoolEntry = {
  profile: string
  port: number
  url?: string
  state: 'stopped' | 'spawning' | 'healthy' | 'dead'
}

export function useGatewayPoolStatus() {
  return useQuery({
    queryKey: ['gateway-pool', 'status'],
    queryFn: async () => {
      const response = await fetch('/api/gateway-pool')
      if (!response.ok) {
        throw new Error(`Failed to load gateway pool (${response.status})`)
      }
      return (await response.json()) as {
        gateways?: Array<GatewayPoolEntry>
      }
    },
    retry: false,
    staleTime: 5_000,
    refetchInterval: 10_000,
  })
}
