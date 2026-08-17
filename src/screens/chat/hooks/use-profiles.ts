import { chatQueryKeys } from '../chat-queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
}

type ProfilesListResponse = {
  profiles?: Array<ChatProfileSummary>
  activeProfile?: string
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
    staleTime: 15_000,
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
      queryClient.setQueryData<ProfilesListResponse>(['profiles', 'chat'], (old) =>
        old
          ? {
              ...old,
              activeProfile: profileName,
              profiles: old.profiles?.map((p) => ({
                ...p,
                active: p.name === profileName,
              })),
            }
          : old,
      )
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
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions }),
        queryClient.invalidateQueries({ queryKey: ['workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['claude', 'models'] }),
        queryClient.invalidateQueries({
          queryKey: ['claude', 'session-status-model'],
        }),
      ])
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
