import { URL, fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { resolve, join } from 'node:path'
import os from 'node:os'
import * as yaml from 'yaml'

// devtools removed
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// nitro plugin removed (tanstackStart handles server runtime)
import { defineConfig, loadEnv } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const config = defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Bridge loadEnv into process.env for server-side SSR runtime code that
  // reads env vars directly from process.env (e.g. getBearerToken() in
  // openai-compat-api.ts reads process.env.HERMES_API_TOKEN). Without this,
  // Vite's loadEnv only populates the local `env` object — not process.env.
  for (const key of Object.keys(env)) {
    if (!(key in process.env)) {
      process.env[key] = env[key]
    }
  }
  const claudeApiUrl = env.CLAUDE_API_URL?.trim() || 'http://127.0.0.1:8642'
  // /api/connection-status is handled by the real route file at
  // src/routes/api/connection-status.ts; the dev server no longer
  // intercepts that path with a slim shortcut. See #285.

  // Hermes Agent auto-start state
  let claudeAgentStarted = false

  const startClaudeAgent = async () => {
    if (claudeAgentStarted) return
    const explicitUrl = (
      env.HERMES_API_URL ||
      env.CLAUDE_API_URL ||
      process.env.HERMES_API_URL ||
      process.env.CLAUDE_API_URL ||
      claudeApiUrl ||
      ''
    ).trim()
    let remote = false
    try {
      const host = new URL(explicitUrl || 'http://127.0.0.1:8642').hostname.toLowerCase()
      remote =
        Boolean(explicitUrl) &&
        host !== '127.0.0.1' &&
        host !== 'localhost' &&
        host !== '::1'
    } catch {
      remote = false
    }
    if (remote) {
      console.log(
        `[hermes-agent] Skipping auto-start — using external API: ${explicitUrl}`,
      )
      claudeAgentStarted = true
      return
    }

    try {
      const { ensureActiveProfileGateway } = await import(
        './src/server/gateway-pool'
      )
      const result = await ensureActiveProfileGateway()
      claudeAgentStarted = true
      if (result.ok) {
        console.log(
          `[hermes-agent] ✓ ${result.profile ?? 'default'} ${result.message}${
            'url' in result && result.url ? ` on ${result.url}` : ''
          }`,
        )
      } else {
        console.warn(
          `[hermes-agent] ${'error' in result ? result.error : 'failed to start'}`,
        )
      }
    } catch (error) {
      console.warn(
        `[hermes-agent] Auto-start failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  let workspaceDaemonStarted = false
  let workspaceDaemonStarting = false
  let workspaceDaemonShuttingDown = false
  let workspaceDaemonRestarting = false
  let workspaceDaemonChild: ChildProcess | null = null
  let workspaceDaemonRetryCount = 0
  const workspaceDaemonPort = '3099'
  const daemonCwd = resolve('workspace-daemon')
  const daemonSrcEntry = resolve('workspace-daemon/src/server.ts')
  const daemonDistEntry = resolve('workspace-daemon/dist/server.js')
  const workspaceDaemonDbPath = resolve(
    'workspace-daemon/.workspaces/workspace.db',
  )

  const getWorkspaceDaemonDelayMs = (attempt: number) =>
    Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 30000)

  const startWorkspaceDaemon = () => {
    if (workspaceDaemonShuttingDown) return
    if (workspaceDaemonStarted || workspaceDaemonStarting) return

    const spawnCommand = existsSync(daemonSrcEntry)
      ? {
          commandName: 'npx',
          args: ['tsx', 'watch', 'src/server.ts'],
          options: {
            cwd: daemonCwd,
            env: {
              ...process.env,
              PORT: workspaceDaemonPort,
              DB_PATH: workspaceDaemonDbPath,
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
            },
            stdio: 'inherit' as const,
          },
        }
      : existsSync(daemonDistEntry)
        ? {
            commandName: 'node',
            args: ['dist/server.js'],
            options: {
              cwd: daemonCwd,
              env: {
                ...process.env,
                PORT: workspaceDaemonPort,
                DB_PATH: workspaceDaemonDbPath,
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
              },
              stdio: 'inherit' as const,
            },
          }
        : null

    if (!spawnCommand) {
      workspaceDaemonStarting = false
      console.error('[workspace-daemon] no server entry found to spawn.')
      return
    }

    workspaceDaemonStarted = true
    workspaceDaemonStarting = false
    const child = spawn(
      spawnCommand.commandName,
      spawnCommand.args,
      spawnCommand.options,
    )
    workspaceDaemonChild = child

    child.on('exit', (code) => {
      if (workspaceDaemonChild === child) {
        workspaceDaemonChild = null
      }

      if (workspaceDaemonShuttingDown || workspaceDaemonRestarting) {
        workspaceDaemonStarted = false
        workspaceDaemonStarting = false
        return
      }

      if (code === 0) {
        workspaceDaemonStarted = false
        workspaceDaemonStarting = false
        return
      }

      if (workspaceDaemonRetryCount >= 20) {
        workspaceDaemonStarted = false
        workspaceDaemonStarting = false
        console.error(
          `[workspace-daemon] crashed with code ${code ?? 'unknown'}; max restart attempts reached.`,
        )
        return
      }

      workspaceDaemonRetryCount += 1
      const delayMs = getWorkspaceDaemonDelayMs(workspaceDaemonRetryCount)
      console.error(
        `[workspace-daemon] crashed with code ${code ?? 'unknown'}; restarting in ${Math.round(
          delayMs / 1000,
        )}s (${workspaceDaemonRetryCount}/20).`,
      )

      workspaceDaemonStarting = true
      workspaceDaemonStarted = false
      setTimeout(() => {
        startWorkspaceDaemon()
      }, delayMs)
    })

    child.on('error', (error) => {
      console.error(`[workspace-daemon] failed to spawn: ${error.message}`)
    })
  }

  const stopWorkspaceDaemon = async () => {
    const child = workspaceDaemonChild
    if (!child) {
      workspaceDaemonStarted = false
      workspaceDaemonStarting = false
      return
    }

    workspaceDaemonRestarting = true

    await new Promise<void>((resolve) => {
      const exitTimer = setTimeout(() => {
        if (!child.killed && child.pid) {
          try {
            process.kill(child.pid, 'SIGKILL')
          } catch {
            // ignore
          }
        }
      }, 5000)

      child.once('exit', () => {
        clearTimeout(exitTimer)
        resolve()
      })

      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch {
          clearTimeout(exitTimer)
          resolve()
        }
      } else {
        clearTimeout(exitTimer)
        resolve()
      }
    })

    workspaceDaemonStarted = false
    workspaceDaemonStarting = false
    workspaceDaemonRestarting = false
  }

  const restartWorkspaceDaemon = async () => {
    workspaceDaemonRetryCount = 0
    await stopWorkspaceDaemon()
    workspaceDaemonStarted = false
    workspaceDaemonStarting = false
    startWorkspaceDaemon()
  }

  const isPortInUse = (port: number) =>
    new Promise<boolean>((resolvePortCheck) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => {
        socket.destroy()
        resolvePortCheck(true)
      })
      socket.once('error', () => resolvePortCheck(false))
    })

  const hasHealthyWorkspaceDaemon = async () => {
    try {
      const response = await fetch(
        `http://127.0.0.1:${workspaceDaemonPort}/api/workspace/version`,
        {
          signal: AbortSignal.timeout(2000),
        },
      )
      return response.ok
    } catch {
      return false
    }
  }

  // Allow access from Tailscale, LAN, or custom domains via env var
  // e.g. CLAUDE_ALLOWED_HOSTS=my-server.tail1234.ts.net,192.168.1.50
  const _allowedHosts: string[] | true = env.CLAUDE_ALLOWED_HOSTS?.trim()
    ? env
        .CLAUDE_ALLOWED_HOSTS!.split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    : ['.ts.net'] // allow all Tailscale hostnames by default
  let proxyTarget = 'http://127.0.0.1:18789'

  try {
    const parsed = new URL(claudeApiUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = ''
    proxyTarget = parsed.toString().replace(/\/$/, '')
  } catch {
    // fallback
  }

  return {
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/skills-bundle/**',
        '**/.{idea,git,cache,output,temp}/**',
      ],
      // Force vitest to run React through its own transform pipeline so ESM
      // `import` and CJS `require('react')` share a single module instance.
      // Without this, react-dom sets the dispatcher on its CJS React copy while
      // components call hooks on the ESM React copy → null dispatcher → crash.
      deps: {
        inline: [
          'react',
          'react-dom',
          '@testing-library/react',
          '@testing-library/dom',
        ],
      },
    },
    define: {
      // Note: Do NOT set 'process.env': {} here — TanStack Start uses environment-based
      // builds where isSsrBuild is unreliable. Blanket process.env replacement breaks
      // server-side code in Docker (kills runtime env var access).
      // Client-side process.env is handled per-environment below.
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      // Single React instance for ESM + CJS interop (vitest inline comment applies here too).
      // Without dedupe, react-dom may bind the dispatcher on a different copy than hooks use
      // → "Cannot read properties of null (reading 'useContext')".
      dedupe: ['react', 'react-dom'],
    },
    ssr: {
      external: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    optimizeDeps: {
      holdUntilCrawlEnd: true,
      // Pre-bundle xterm so the client never requests a missing `.vite/deps/xterm.js`.
      // Excluding xterm left metadata pointing at deps/ without generating the file → black terminals.
      include: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zustand',
        '@tanstack/react-router',
        '@tanstack/react-query',
        'motion/react',
        'xterm',
        'xterm-addon-fit',
        'xterm-addon-web-links',
      ],
      exclude: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
      needsInterop: [
        'xterm',
        'xterm-addon-fit',
        'xterm-addon-web-links',
      ],
    },
    server: {
      // Cross-origin isolation is only needed for HermesWorld / Playground (SharedArrayBuffer).
      // Applying COOP/COEP globally on HTTP LAN IPs triggers browser warnings and is ignored
      // on non-trustworthy origins anyway — see configureServer middleware below.
      warmup: {
        clientFiles: [
          './src/routes/__root.tsx',
          './src/components/workspace-shell.tsx',
          './src/screens/chat/chat-screen.tsx',
        ],
      },
      // Force IPv4 — 'localhost' resolves to ::1 (IPv6) on Windows, breaking connectivity
      host: '0.0.0.0',
      // Port precedence:
      //   1. --port CLI flag (wins, but we no longer hardcode it in package.json)
      //   2. $PORT env var (for containers, reverse proxies, WhatsApp bridge collisions, etc. — see #96)
      //   3. default 3000 (matches README/docs/docker-compose expectations)
      port: process.env.PORT ? Number(process.env.PORT) : 3000,
      // Managed Workspace launchers expect a stable port. Fail loudly instead
      // of silently hopping to 3001+ so launchctl/service health matches the
      // actual listening socket.
      strictPort: true,
      allowedHosts: true,
      watch: {
        ignored: [
          // NOTE: the generated TanStack route tree must NOT be added to this
          // ignore list — doing so causes route changes to require a full
          // dev-server restart. See src/router-route-resolution.test.ts.
          // Real fix for HMR thrash on the generated tree is to ensure only
          // ONE vite dev server runs against this source tree at a time.
          // Local portable session store, rewritten on every chat send.
          // Without this, the watcher fires on every message → spurious
          // server-side reload events / test churn during development.
          '**/.runtime/**',
          // Internal TanStack Start state cache.
          '**/.tanstack/**',
          // Local plan/notes/scratch state used by OMC tooling — never
          // imported by the module graph, but file events still spam logs.
          '**/.omc/**',
          '**/.omx/**',
          // Build artifacts.
          '**/dist/**',
          '**/.output/**',
          // Test/coverage outputs.
          '**/coverage/**',
          '**/playwright-report/**',
          '**/test-results/**',
          // Editor / agent metadata.
          '**/.vscode/**',
          '**/.claude/**',
          '**/.cursor/**',
          // Loose log files.
          '**/*.log',
          // Runtime config written by the swarm PATCH API — not imported by
          // the module graph; writing it must not trigger a Vite HMR reload.
          '**/swarm.yaml',
        ],
      },
      proxy: {
        // WebSocket proxy: clients connect to /ws-claude on the Hermes Workspace
        // server (any IP/port), which internally forwards to the local server.
        // This means phone/LAN/Docker users never need to reach port 18789 directly.
        '/ws-claude': {
          target: proxyTarget,
          changeOrigin: false,
          ws: true,
          rewrite: (path) => path.replace(/^\/ws-claude/, ''),
        },
        // REST API proxy: API proxy for Hermes backend
        '/api/claude-proxy': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/claude-proxy/, ''),
        },
        '/claude-ui': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/claude-ui/, ''),
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyRes', (_proxyRes) => {
              // Strip iframe-blocking headers so we can embed
              delete _proxyRes.headers['x-frame-options']
              delete _proxyRes.headers['content-security-policy']
            })
          },
        },
        '/workspace-api': {
          target: 'http://127.0.0.1:3099',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/workspace-api/, ''),
        },
      },
    },
    plugins: [
      // devtools(),
      // this is the plugin that enables path aliases
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
      {
        name: 'hermes-dev-no-cache',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            res.setHeader('Pragma', 'no-cache')
            res.setHeader('Expires', '0')
            next()
          })
        },
      },
      {
        name: 'workspace-daemon',
        buildStart() {
          if (command !== 'serve') return
        },
        configureServer(server) {
          // Cross-origin isolation headers for HermesWorld / Playground only.
          server.middlewares.use((req, res, next) => {
            const requestPath = req.url?.split('?')[0] ?? ''
            const needsIsolation =
              requestPath === '/hermes-world' ||
              requestPath.startsWith('/hermes-world/') ||
              requestPath === '/world' ||
              requestPath.startsWith('/world/') ||
              requestPath === '/playground' ||
              requestPath.startsWith('/playground/')
            if (needsIsolation) {
              res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
              res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
            }
            next()
          })
          // Content Security Policy as a real HTTP response header. Sending
          // it here (not as a `<meta>` tag) keeps the policy authoritative
          // when an edge proxy mutates the response body — e.g. Cloudflare's
          // JS Challenge injecting a per-request nonce into the served HTML
          // when a browser request trips the "impersonate browsers" WAF rule.
          // Without this, the inline-style source expression
          // `style-src ' 'nonce-...'; self` gets concatenated onto our meta
          // tag and chromium rejects every script and stylesheet with a
          // mangled-CSP error. See the parallel logic in server-entry.js
          // for production.
          server.middlewares.use((_req, res, next) => {
            // KEEP IN SYNC with src/lib/csp.ts and server-entry.js
            res.setHeader(
              'Content-Security-Policy',
              [
                "default-src 'self'",
                "base-uri 'self'",
                "object-src 'none'",
                "form-action 'self'",
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
                "img-src 'self' data: blob: https:",
                "font-src 'self' data: https://fonts.gstatic.com",
                "connect-src 'self' ws: wss: http: https:",
                "worker-src 'self' blob:",
                "media-src 'self' blob: data:",
                "frame-src 'self' http: https:",
              ].join('; '),
            )
            res.setHeader('X-Content-Type-Options', 'nosniff')
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
            res.setHeader('Permissions-Policy', 'microphone=(self), camera=()')
            next()
          })
          server.middlewares.use(async (req, res, next) => {
            const requestPath = req.url?.split('?')[0]
            if (req.method === 'GET' && requestPath === '/api/healthcheck') {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            // /api/connection-status is handled by the real route file at
            // src/routes/api/connection-status.ts — it returns the full
            // ConnectionStatus payload including capabilities and chatMode
            // that downstream feature gates depend on. Earlier versions
            // had an inline shortcut handler here that returned a slim
            // body ({ok, mode, backend}) which silently broke things like
            // useFeatureCapability/useFeatureAvailable in dev mode. See #285.

            if (
              req.method !== 'POST' ||
              requestPath !== '/api/workspace/daemon/restart'
            ) {
              next()
              return
            }

            try {
              await restartWorkspaceDaemon()
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
            } catch (error) {
              res.statusCode = 500
              res.setHeader('content-type', 'application/json')
              res.end(
                JSON.stringify({
                  error:
                    error instanceof Error ? error.message : 'Internal error',
                }),
              )
            }
          })

          // PATCH /api/swarm-roster — writes directly to swarm.yaml.
          // Bypasses TanStack Start SSR (which hangs on PATCH in dev mode).
          server.middlewares.use(async (req, res, next) => {
            const path = req.url?.split('?')[0] ?? ''
            if (req.method !== 'PATCH' || path !== '/api/swarm-roster') {
              next()
              return
            }
            const chunks: Buffer[] = []
            for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
            let body: { workerId?: string; patch?: Record<string, unknown> }
            try {
              body = JSON.parse(Buffer.concat(chunks).toString())
            } catch {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
              return
            }
            const workerId = typeof body.workerId === 'string' ? body.workerId.trim() : ''
            if (!workerId) {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'workerId required' }))
              return
            }
            const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
              ? body.patch
              : {}
            if (Object.keys(patch).length === 0) {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'patch object required' }))
              return
            }
            try {
              const SWARM_ROSTER_PATH = resolve(process.cwd(), 'swarm.yaml')
              if (!existsSync(SWARM_ROSTER_PATH)) throw new Error(`swarm.yaml not found at ${SWARM_ROSTER_PATH}`)
              const raw = readFileSync(SWARM_ROSTER_PATH, 'utf8')
              const roster = yaml.parse(raw) as { version?: number; workers?: Array<Record<string, unknown>> }
              const workers = roster.workers ?? []
              const idx = workers.findIndex(
                (w) => (w.id as string)?.toLowerCase() === workerId.toLowerCase(),
              )
              if (idx < 0) throw new Error(`Worker ${workerId} not found in swarm roster`)
              workers[idx] = { ...workers[idx], ...patch }

              writeFileSync(SWARM_ROSTER_PATH, yaml.stringify({ ...roster, workers }), 'utf8')
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true, path: SWARM_ROSTER_PATH, savedAt: Date.now() }))
            } catch (err) {
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(
                JSON.stringify({
                  ok: false,
                  error: err instanceof Error ? err.message : 'Failed to patch swarm roster',
                }),
              )
            }
          })

          // dev-only: disable Node's default 5-minute request timeout so
          // long-running SSE streams (agent runs that go silent for minutes
          // during heavy reasoning / tool calls) don't get killed mid-stream
          // by the HTTP layer. Heartbeats handle keep-alive at the application
          // layer. Production servers should keep their default timeouts to
          // avoid slowloris exposure.
          if (command === 'serve' && server.httpServer) {
            const httpServer = server.httpServer as unknown as {
              requestTimeout?: number
              headersTimeout?: number
              timeout?: number
            }
            // Do NOT set requestTimeout=0 globally — it makes SSR PATCH requests
            // hang forever when the TanStack Start handler fails to respond.
            // Instead, keep the default 5-minute timeout as a safety net.
            httpServer.requestTimeout = 0
            httpServer.headersTimeout = 0
            httpServer.timeout = 0
          }

          // dev-only: disable Node's default 5-minute request timeout so
          // This is the correct layering: httpServer-level = infinite (SSE safety),
          // per-route = selective enforcement (PATCH/POST/API routes get a deadline).
          server.middlewares.use(async (req, res, next) => {
            const { socket } = req
            if (!socket) { next(); return }
            const method = req.method?.toUpperCase() ?? 'GET'
            const path = req.url?.split('?')[0] ?? ''
            // SSE and long-running swarm routes need no socket timeout.
            const isLongRunning =
              path.startsWith('/api/sse') ||
              path.startsWith('/sse') ||
              path.startsWith('/api/live') ||
              path === '/api/terminal-stream' ||
              path === '/api/terminal-input' ||
              path === '/api/terminal-resize' ||
              path === '/api/swarm-direct-chat' ||
              path === '/api/swarm-dispatch' ||
              path === '/api/swarm-decompose' ||
              path === '/api/conductor-spawn'
            const timeout = isLongRunning ? 0 : 15_000
            socket.setTimeout(timeout)
            next()
          })

          server.httpServer?.on('close', () => {
            workspaceDaemonShuttingDown = true
            workspaceDaemonStarted = false
            workspaceDaemonStarting = false
            if (workspaceDaemonChild) {
              workspaceDaemonChild.kill()
              workspaceDaemonChild = null
            }
          })

          // Auto-start hermes-agent when dev server launches.
          // Skip when launchd manages the gateway (HERMES_WORKSPACE_AUTO_START_AGENT=false)
          // to avoid SIGTERM cycle on close that nukes the launchd-managed process.
          const autoStartAgent =
            process.env.HERMES_WORKSPACE_AUTO_START_AGENT !== 'false'
          if (command === 'serve' && autoStartAgent) {
            void startClaudeAgent()
          }

          if (
            command !== 'serve' ||
            workspaceDaemonStarted ||
            workspaceDaemonStarting
          )
            return

          workspaceDaemonStarting = true
          void (async () => {
            const running = await isPortInUse(Number(workspaceDaemonPort))
            if (workspaceDaemonStarted) {
              workspaceDaemonStarting = false
              return
            }

            if (running) {
              const healthy = await hasHealthyWorkspaceDaemon()
              if (healthy) {
                workspaceDaemonStarting = false
                console.log('[workspace-daemon] Reusing existing daemon')
                return
              }

              try {
                execSync(
                  `lsof -ti:${workspaceDaemonPort} | xargs kill -9 2>/dev/null || true`,
                )
              } catch {
                // ignore stale cleanup failures and continue with a fresh spawn
              }
            }

            startWorkspaceDaemon()
          })()
        },
      },
      // Client-only: replace process.env references in client bundles
      // Server bundles must keep real process.env for Docker runtime env vars
      {
        name: 'client-process-env',
        enforce: 'pre',
        transform(code, _id) {
          const envName = this.environment?.name
          if (envName !== 'client') return null
          if (
            !code.includes('process.env') &&
            !code.includes('process.platform')
          )
            return null

          // Replace specific env vars first, then the generic fallback
          let result = code
          result = result.replace(
            /process\.env\.CLAUDE_API_URL/g,
            JSON.stringify(claudeApiUrl),
          )
          result = result.replace(
            /process\.env\.CLAUDE_API_TOKEN/g,
            JSON.stringify(env.CLAUDE_API_TOKEN || ''),
          )
          result = result.replace(
            /process\.env\.NODE_ENV/g,
            JSON.stringify(mode),
          )
          result = result.replace(/process\.env/g, '{}')
          result = result.replace(/process\.platform/g, '"browser"')
          return result
        },
      },
      // Copy pty-helper.py into the server assets directory after build
      {
        name: 'copy-pty-helper',
        closeBundle() {
          const src = resolve('src/server/pty-helper.py')
          const destDir = resolve('dist/server/assets')
          const dest = resolve(destDir, 'pty-helper.py')
          if (existsSync(src)) {
            mkdirSync(destDir, { recursive: true })
            copyFileSync(src, dest)
          }
        },
      },
    ],
  }
})

export default config
