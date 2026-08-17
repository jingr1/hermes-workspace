import { useQuery } from '@tanstack/react-query'

export type ActiveWorkspace = {
  path: string
  folderName: string
}

async function fetchActiveWorkspace(): Promise<ActiveWorkspace> {
  const response = await fetch('/api/workspace')
  if (!response.ok) {
    throw new Error(`Failed to load workspace (${response.status})`)
  }
  const data = (await response.json()) as {
    path?: string
    folderName?: string
  }
  return {
    path: typeof data.path === 'string' ? data.path : '',
    folderName:
      typeof data.folderName === 'string' && data.folderName.trim()
        ? data.folderName.trim()
        : '',
  }
}

/** Shared active workspace path for file browsers / search invalidation. */
export function useActiveWorkspace() {
  return useQuery({
    queryKey: ['workspace', 'active'],
    queryFn: fetchActiveWorkspace,
    staleTime: 15_000,
    retry: false,
  })
}
