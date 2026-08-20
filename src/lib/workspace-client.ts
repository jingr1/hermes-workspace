import type { QueryClient } from '@tanstack/react-query'

export const WORKSPACE_PROFILE_QUERY_KEY = ['profiles', 'workspace-profile'] as const

export type WorkspaceCatalog = {
  path: string
  folderName: string
  source: string
  isValid: boolean
  workspaces: Array<{ name: string; path: string }>
  last: string
}

export type ActiveWorkspace = {
  path: string
  folderName: string
}

export type FileTreeEntry = {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: Array<FileTreeEntry>
}

function withProfileQuery(basePath: string, profileName: string): string {
  const query = new URLSearchParams()
  query.set('profile', profileName)
  const join = basePath.includes('?') ? '&' : '?'
  return `${basePath}${join}${query.toString()}`
}

export async function fetchWorkspaceCatalog(
  profileName: string,
): Promise<WorkspaceCatalog> {
  const response = await fetch(withProfileQuery('/api/workspace', profileName))
  if (!response.ok) {
    throw new Error(`Failed to load workspace (${response.status})`)
  }
  return (await response.json()) as WorkspaceCatalog
}

export async function fetchActiveWorkspace(
  profileName: string,
): Promise<ActiveWorkspace> {
  const catalog = await fetchWorkspaceCatalog(profileName)
  return {
    path: catalog.path ?? '',
    folderName: catalog.folderName?.trim() || '',
  }
}

export async function fetchFileTree(
  profileName: string,
  maxDepth = 1,
): Promise<Array<FileTreeEntry>> {
  const url = withProfileQuery(
    `/api/files?action=list&maxDepth=${maxDepth}`,
    profileName,
  )
  const response = await fetch(url)
  const data = (await response.json().catch(() => null)) as {
    entries?: Array<FileTreeEntry>
    error?: string
  } | null
  if (!response.ok) {
    throw new Error(data?.error || `Failed to load files (${response.status})`)
  }
  return Array.isArray(data?.entries) ? data.entries : []
}

export type ActivateProfileResponse = {
  ok?: boolean
  profile?: string
  workspace?: WorkspaceCatalog
  error?: string
}

export function seedWorkspaceQueries(
  queryClient: QueryClient,
  profileName: string,
  catalog: WorkspaceCatalog,
): void {
  queryClient.setQueryData(['workspace', 'active', profileName], {
    path: catalog.path ?? '',
    folderName: catalog.folderName?.trim() || '',
  } satisfies ActiveWorkspace)
  queryClient.setQueryData(
    ['workspace', 'composer-context', profileName],
    catalog,
  )
  if (catalog.path) {
    void queryClient.prefetchQuery({
      queryKey: ['files', 'tree', profileName, catalog.path],
      queryFn: () => fetchFileTree(profileName, 1),
      staleTime: 30_000,
    })
  }
}

export async function prefetchProfileWorkspace(
  queryClient: QueryClient,
  profileName: string,
  catalog?: WorkspaceCatalog,
): Promise<void> {
  const resolved = catalog ?? (await fetchWorkspaceCatalog(profileName))
  seedWorkspaceQueries(queryClient, profileName, resolved)
}
