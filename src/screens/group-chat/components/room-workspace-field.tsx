'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  WorkspaceFolderPicker,
  preloadWorkspaceFolders,
} from '@/components/workspace-folder-picker'
import { cn } from '@/lib/utils'

type WorkspaceEntry = { name: string; path: string }

export function shortPathLabel(pathValue: string): string {
  const parts = pathValue.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) || pathValue
}

async function fetchWorkspaceEntries(): Promise<Array<WorkspaceEntry>> {
  try {
    const res = await fetch('/api/workspace')
    if (!res.ok) return []
    const data = (await res.json()) as {
      workspaces?: Array<WorkspaceEntry>
      path?: string
    }
    const list = Array.isArray(data.workspaces) ? data.workspaces : []
    if (
      data.path &&
      !list.some((w) => w.path === data.path)
    ) {
      return [
        { name: shortPathLabel(data.path), path: data.path },
        ...list,
      ]
    }
    return list
  } catch {
    return []
  }
}

type RoomWorkspaceFieldProps = {
  value: string
  onChange: (path: string) => void
  className?: string
  /** Compact: hide folder browser until toggled. */
  compact?: boolean
}

/**
 * Sticky room workspace picker — catalog from /api/workspace + optional folder browse.
 * Empty value is allowed (no room cwd).
 */
export function RoomWorkspaceField({
  value,
  onChange,
  className,
  compact = false,
}: RoomWorkspaceFieldProps) {
  const [entries, setEntries] = useState<Array<WorkspaceEntry>>([])
  const [showBrowser, setShowBrowser] = useState(!compact && !value)

  useEffect(() => {
    void fetchWorkspaceEntries().then(setEntries)
    preloadWorkspaceFolders('')
  }, [])

  return (
    <div className={cn('space-y-2', className)}>
      <label className="text-xs opacity-70">Workspace (optional)</label>
      {entries.length > 0 ? (
        <select
          className="w-full h-9 rounded-md border bg-transparent px-2 text-sm"
          style={{ borderColor: 'var(--theme-border)' }}
          value={
            entries.some((e) => e.path === value) ? value : value ? '__custom__' : ''
          }
          onChange={(e) => {
            const next = e.target.value
            if (next === '__custom__') {
              setShowBrowser(true)
              return
            }
            onChange(next)
            setShowBrowser(false)
          }}
        >
          <option value="">None — agents use their default cwd</option>
          {entries.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.name || shortPathLabel(entry.path)}
            </option>
          ))}
          <option value="__custom__">Browse…</option>
        </select>
      ) : null}
      <Input
        placeholder="/absolute/path/to/project"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setShowBrowser(true)}
      />
      {(showBrowser || !entries.length) && (
        <div
          className="rounded-md border p-2 max-h-48 overflow-auto"
          style={{ borderColor: 'var(--theme-border)' }}
        >
          <WorkspaceFolderPicker value={value} onChange={onChange} />
        </div>
      )}
      {value ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange('')
            setShowBrowser(false)
          }}
        >
          Clear workspace
        </Button>
      ) : null}
    </div>
  )
}
