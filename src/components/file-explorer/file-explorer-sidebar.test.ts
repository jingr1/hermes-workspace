import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sidebarSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'file-explorer-sidebar.tsx'),
  'utf8',
)

describe('file explorer workspace refresh', () => {
  it('reloads the tree when the active workspace path changes', () => {
    expect(sidebarSource).toContain('useActiveWorkspace')
    expect(sidebarSource).toContain('workspacePath')
    expect(sidebarSource).toContain('filesQuery.refetch')
  })

  it('paints top-level then prefetches depth 3 in the background', () => {
    expect(sidebarSource).toContain('fetchFileTree(workspaceProfileName, 0)')
    expect(sidebarSource).toContain('fetchFileTree(workspaceProfileName, 3)')
    expect(sidebarSource).not.toContain('loadFolderChildren')
    expect(sidebarSource).not.toContain('patchFileTreeChildren')
  })

  it('shows loading instead of empty while the tree is fetching', () => {
    expect(sidebarSource).toContain('showEmpty')
    expect(sidebarSource).toContain('entries.length === 0 && filesQuery.isFetching')
  })

  it('docks on the right by default with a left border', () => {
    expect(sidebarSource).toContain("side = 'right'")
    expect(sidebarSource).toContain(
      "side === 'right' ? 'border-l border-primary-200'",
    )
  })
})
