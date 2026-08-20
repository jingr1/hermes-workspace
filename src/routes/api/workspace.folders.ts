import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { WorkspaceFolderAccessError } from '../../server/workspace-path-policy'
import { readProfileQueryParam } from '../../server/workspace-profile'
import { listActiveWorkspaceFolders } from '../../server/ssh-terminal'

export const Route = createFileRoute('/api/workspace/folders')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const subPath = url.searchParams.get('path') || ''
          const profile = readProfileQueryParam(request)
          return json(await listActiveWorkspaceFolders(subPath, profile))
        } catch (err) {
          if (err instanceof WorkspaceFolderAccessError) {
            return json(
              { error: err.message, folders: [] },
              { status: err.status },
            )
          }
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
              folders: [],
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
