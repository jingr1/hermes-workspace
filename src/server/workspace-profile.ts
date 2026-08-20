/**
 * Profile-scoped workspace resolution.
 *
 * Workspace APIs accept an explicit ?profile= so the client can load the
 * correct catalog during profile switches without racing ~/.hermes/active_profile.
 */
import { getActiveProfileName, readProfile } from './profiles-browser'
import { readRemoteTerminalCwd } from './workspace-remote'

export function resolveWorkspaceProfileName(explicit?: string | null): string {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  return getActiveProfileName()
}

export type WorkspaceProfileScope = {
  profileName: string
  profileHome: string
  config: Record<string, unknown>
}

export function workspaceProfileScope(
  profileName?: string | null,
): WorkspaceProfileScope {
  const name = resolveWorkspaceProfileName(profileName)
  try {
    const profile = readProfile(name)
    return {
      profileName: name,
      profileHome: profile.path,
      config: profile.config,
    }
  } catch {
    return { profileName: name, profileHome: '', config: {} }
  }
}

export function remoteWorkspaceContextForScope(scope: WorkspaceProfileScope): {
  remoteCwd: string
  config: Record<string, unknown>
} | null {
  const remoteCwd = readRemoteTerminalCwd(scope.config)
  if (!remoteCwd) return null
  return { remoteCwd, config: scope.config }
}

export function readProfileQueryParam(request: Request): string | undefined {
  try {
    const value = new URL(request.url).searchParams.get('profile')?.trim()
    return value || undefined
  } catch {
    return undefined
  }
}
