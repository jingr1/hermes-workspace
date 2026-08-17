'use client'

import { ArrowDown01Icon, ArrowRight01Icon, Folder01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type WorkspaceFolderEntry = {
  name: string
  path: string
  fullPath: string
}

type FolderListResponse = {
  base: string
  current: string
  folders: Array<WorkspaceFolderEntry>
}

type FlatNode = {
  folder: WorkspaceFolderEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  hasChildren: boolean | null
}

type WorkspaceFolderPickerProps = {
  value: string
  onChange: (path: string) => void
  className?: string
}

async function fetchFolders(subPath = ''): Promise<FolderListResponse | null> {
  try {
    const query = subPath ? `?path=${encodeURIComponent(subPath)}` : ''
    const response = await fetch(`/api/workspace/folders${query}`)
    if (!response.ok) return null
    return (await response.json()) as FolderListResponse
  } catch {
    return null
  }
}

export function WorkspaceFolderPicker({
  value,
  onChange,
  className,
}: WorkspaceFolderPickerProps) {
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [basePath, setBasePath] = useState('')
  const [folders, setFolders] = useState<Array<WorkspaceFolderEntry>>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<
    Map<string, Array<WorkspaceFolderEntry>>
  >(() => new Map())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchFolders('').then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res) {
        setLoadFailed(true)
        return
      }
      setLoadFailed(false)
      setBasePath(res.base)
      setFolders(res.folders)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleExpand = useCallback((folder: WorkspaceFolderEntry) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(folder.path)) {
        next.delete(folder.path)
        return next
      }
      next.add(folder.path)
      return next
    })
  }, [])

  useEffect(() => {
    const pending = [...expandedPaths].filter(
      (entryPath) => !childrenCache.has(entryPath) && !loadingPaths.has(entryPath),
    )
    if (pending.length === 0) return

    setLoadingPaths((current) => {
      const next = new Set(current)
      for (const entryPath of pending) next.add(entryPath)
      return next
    })
    for (const entryPath of pending) {
      void fetchFolders(entryPath).then((res) => {
        setChildrenCache((current) => {
          const next = new Map(current)
          next.set(entryPath, res?.folders ?? [])
          return next
        })
        setLoadingPaths((current) => {
          const next = new Set(current)
          next.delete(entryPath)
          return next
        })
      })
    }
  }, [expandedPaths, childrenCache, loadingPaths])

  const flatNodes = useMemo<Array<FlatNode>>(() => {
    const result: Array<FlatNode> = []
    function traverse(entries: Array<WorkspaceFolderEntry>, depth: number) {
      for (const folder of entries) {
        const isExpanded = expandedPaths.has(folder.path)
        const children = childrenCache.get(folder.path)
        result.push({
          folder,
          depth,
          isExpanded,
          isLoading: loadingPaths.has(folder.path),
          hasChildren: children ? children.length > 0 : null,
        })
        if (isExpanded && children && children.length > 0) {
          traverse(children, depth + 1)
        }
      }
    }
    traverse(folders, 0)
    return result
  }, [folders, expandedPaths, childrenCache, loadingPaths])

  return (
    <div
      className={cn(
        'flex max-h-[360px] flex-col overflow-hidden rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2',
        className,
      )}
    >
      <Input
        size="sm"
        value={value}
        placeholder="Enter project path, e.g. /home/user/project"
        onChange={(event) => onChange(event.target.value)}
        className="mb-2 shrink-0"
      />
      {loading ? (
        <div className="flex justify-center px-3 py-6 text-xs text-[var(--theme-muted)]">
          Loading folders…
        </div>
      ) : (
        <div className="max-h-[260px] overflow-y-auto text-[13px]">
          {basePath ? (
            <button
              type="button"
              onClick={() => onChange(basePath)}
              className={cn(
                'mb-1 flex w-full items-center gap-1 rounded-md px-2 py-1 text-left font-semibold transition-colors',
                value === basePath
                  ? 'bg-[var(--theme-accent-soft)] outline outline-1 outline-[var(--theme-accent)]'
                  : 'hover:bg-[var(--theme-card2)]',
              )}
            >
              <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} />
              <span className="min-w-0 truncate">{basePath || '/'}</span>
            </button>
          ) : null}

          {flatNodes.map((node) => (
            <div key={node.folder.path}>
              <button
                type="button"
                onClick={() => onChange(node.folder.fullPath)}
                className={cn(
                  'flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left transition-colors',
                  value === node.folder.fullPath
                    ? 'bg-[var(--theme-accent-soft)] outline outline-1 outline-[var(--theme-accent)]'
                    : 'hover:bg-[var(--theme-card2)]',
                )}
                style={{ paddingLeft: `${12 + node.depth * 16}px` }}
              >
                <span
                  className="inline-flex w-3.5 shrink-0 items-center justify-center text-[10px] text-[var(--theme-muted)]"
                  onClick={(event) => {
                    event.stopPropagation()
                    void toggleExpand(node.folder)
                  }}
                >
                  {node.isLoading ? (
                    '…'
                  ) : (
                    <HugeiconsIcon
                      icon={node.isExpanded ? ArrowDown01Icon : ArrowRight01Icon}
                      size={11}
                      strokeWidth={1.8}
                    />
                  )}
                </span>
                <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} className="shrink-0" />
                <span className="min-w-0 truncate">{node.folder.name}</span>
              </button>
              {node.isExpanded && !node.isLoading && node.hasChildren === false ? (
                <div
                  className="px-2 py-0.5 text-[11px] italic text-[var(--theme-muted)]"
                  style={{ paddingLeft: `${28 + node.depth * 16}px` }}
                >
                  (Empty)
                </div>
              ) : null}
            </div>
          ))}

          {(folders.length === 0 || loadFailed) && !loading ? (
            <div className="px-3 py-4 text-center text-[var(--theme-muted)]">
              No workspace folders
            </div>
          ) : null}
        </div>
      )}

      {value ? (
        <div className="mt-2 flex min-w-0 shrink-0 items-center gap-2 rounded-md bg-[var(--theme-accent-soft)] px-2 py-1.5 text-xs">
          <span className="shrink-0 text-[var(--theme-muted)]">Selected:</span>
          <span className="min-w-0 truncate font-mono" title={value}>
            {value}
          </span>
        </div>
      ) : null}
    </div>
  )
}
