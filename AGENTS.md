# Hermes Workspace Agent Contract

This workspace uses semantic Hermes swarm workers, not numbered-only lanes. The source of truth for routing is `swarm.yaml`; each worker also has a matching profile under `~/.hermes/profiles/<worker-id>/`, role skills as listed below, and a wrapper in `~/.local/bin/`.

## Current semantic roster

LangGraph workflows (`cdc.yaml`, `research_only.yaml`, `design_implement.yaml`) may only reference worker ids defined here.

| Worker | Wrapper | Model | Modes | Tools | Skills | MCP | Plugins |
|---|---|---|---|---|---|---|---|
| `orchestrator` | `orchestrator:plan` | `custom:nioint-gateway/DeepSeek-V4-Pro-Seed` | plan | todo, kanban, delegation, terminal, file, session_search, cronjob, skills, clarify, web | orchestrator-core, gstack-for-hermes, llm-wiki, kanban-orchestrator, subagent-driven-development, writing-plans, requesting-code-review, workspace-dispatch | none | none |
| `researcher` | `researcher:quick` | `custom:nioint-gateway/DeepSeek-V4-Pro-Seed` | quick, autoresearch | web, browser, terminal, file, vision, session_search, skills, todo | researcher-core, llm-wiki, autoresearch, browser-harness-power-use, gstack-for-hermes, researcher-quick, researcher-autoresearch, arxiv, youtube-content, polymarket | none | none |
| `architect` | `architect:design` | `nioint/DeepSeek-V4-Flash-Seed` | design | terminal, file, web, session_search, skills, todo | gstack-for-hermes, llm-wiki, writing-plans, requesting-code-review, codebase-inspection | none | none |
| `developer` | `developer:implement` | `custom:nioint-gateway/DeepSeek-V4-Pro-Seed` | implement | terminal, file, browser, web, session_search, skills, todo | gstack-for-hermes, llm-wiki, test-driven-development, systematic-debugging, codebase-inspection, github-pr-workflow | none | none |
| `learning` | `learning` | `custom:nioint-gateway/DeepSeek-V4-Pro-Seed` | — | file, session_search, skills, todo, web | gstack-for-hermes, llm-wiki, obsidian-markdown, writing-plans | none | none |

### Default mission pipeline

| Stage | Worker | Role |
|---|---|---|
| Route / greenlight | `orchestrator` | Decompose missions, assign specialists, enforce human approval gates |
| Research | `researcher` | Establish facts (competitive analysis, data validation, source tracing); no strategy or recommendations; respond to architect challenges with evidence |
| Design / review | `architect` | Technical translation, tech-direction decisions, implementation review; no fact-gathering or coding |
| Implement | `developer` | Code per spec, tests, build verification; no architecture or design decisions |
| Retrospective | `learning` | Mission docs, lessons learned, durable knowledge capture |

## Operating rules

- Keep `swarm.yaml`, profile `config.yaml`, profile skills, and wrappers aligned when changing a worker.
- **GBrain ≡ llm-wiki** in this workspace: the `gbrain` skill/MCP is not deployed locally. Brain-first lookup uses the Hermes builtin `llm-wiki` skill against `WIKI_PATH` (default `~/wiki`), plus swarm mission memory under `memory/swarm/`.
- **Brain-first order** (before web search): ① read `$WIKI_PATH/SCHEMA.md` + `index.md` + recent `log.md`; ② grep `memory/swarm/` and dispatch handoffs; ③ `session_search` for prior sessions; ④ external `web` / `arxiv` only when local context is insufficient.
- **Knowledge layering:** `~/wiki` holds durable domain knowledge; `memory/swarm/<worker>/` holds mission artifacts; `learning` ingests reusable conclusions into the wiki after missions complete.
- **Researcher** establishes facts only (competitive analysis, validation, source trails); no strategy or recommendations. **Architect** may challenge findings; researcher responds with evidence. **Architect** owns technical translation, tech-direction decisions, and implementation review — not primary fact-gathering or code. **Developer** implements and tests per architect specs only — no architecture or design changes, no skipping tests; escalate spec gaps to architect. **Learning** documents; **Orchestrator** routes and enforces greenlight.
- Do not enable optional Hermes plugins globally unless the task explicitly needs them; record plugin/toolset alignment in `swarm.yaml` first.
- For local Workspace pairing/debugging, treat **one gateway + one dashboard** as canonical: `hermes gateway run` on `:8642` and `hermes dashboard` on `:9119`. Before starting another gateway, verify `curl http://127.0.0.1:3000/api/sessions` (or the active workspace port) first. If Sessions already returns data, refresh/reprobe the UI instead of spawning a duplicate gateway.
- If the default model is `gpt-5.4` / `openai-codex`, remember that chat depends on a live local Codex CLI login (`codex login`).

## LangGraph Phase 2 human gate

When the Phase 2 orchestrator raises `needs_human=True`, use one of:

- **Dashboard (recommended):** open `/swarm2`. The Human Gate panel appears automatically, showing the blocked worker, blocker type, checkpoint, pending assignments, and routing analysis. Click **继续执行** to resume or **中止** to abort.
- **CLI fallback:**
  - `python -m hermes_langgraph_orchestrator --execute --resume approved --mission-id <id>`
  - `python -m hermes_langgraph_orchestrator --execute --resume abort --mission-id <id>`
- **API for automation:**
  - `GET /api/orchestrator-active-gates` scans SQLite and returns every mission currently paused at `needs_human=True`.
  - `GET /api/orchestrator-state?missionId=<id>` returns the current paused state for a specific mission.
  - `POST /api/orchestrator-resume` with `{ missionId, action: "approved" | "abort" }` resumes in the background.
  - Prefer `POST /api/swarm-langgraph/run` to start missions and `POST /api/swarm-langgraph/resume` for human gate recovery.

## Windows-specific notes (2026-06-01)

- **Three services required**: Gateway (:8642) + Dashboard (:9119) + Workspace (:3000). All must be running for full functionality.
  - Gateway: `hermes gateway run`
  - Dashboard: `hermes dashboard --port 9119 --host 127.0.0.1 --no-open`
  - Workspace: `pnpm dev`
  - Or use the Electron desktop app: `pnpm electron:dev` (auto-starts all three)
- **Desktop app**: Full Electron app (`electron/main.cjs`). Double-click to launch — no terminal needed. Auto-detects and spawns gateway (or dashboard if configured).
- **Build**: `electron:build:win` produces NSIS installer in `release/`.
- **Dev mode**: `electron:dev` launches Electron in dev mode (builds Vite client first, hot-reloads on change).
- **Running build output**: `release/win-unpacked/hermes-workspace.exe` (test builds).
- **Electron:dev fix**: `NODE_ENV=development` prefix doesn't work on Windows — script stripped to just `electron .`.
- **Windows spawn fixes** (in `electron/main.cjs`): `spawnDetached()` uses `cmd /c` on Windows (not `bash -lc`), log paths use `%TEMP%` (not `/tmp`), `isHermesInstalled()` uses `where hermes`, `installHermesInBackground()` uses `pip install` (not `curl|bash`).
- **Two `.env` files**: Gateway reads `C:\\Users\\<you>\\AppData\\Local\\hermes\\.env`; CLI reads `C:\\Users\\<you>\\.hermes\\.env`; workspace reads `hermes-workspace\\.env`. Keep API keys in sync across all three.
- **Gateway API server**: Requires `API_SERVER_ENABLED=true` + `API_SERVER_KEY` in the gateway's `.env`. Without these, the gateway starts with no connected platforms.
- **Workspace env vars**: Runtime reads `CLAUDE_API_URL` / `CLAUDE_API_TOKEN` / `CLAUDE_DASHBOARD_URL` (not `HERMES_*` variants).
- **sqlite3 CLI**: Not bundled on Windows. Install via `winget install SQLite.SQLite`, then copy `sqlite3.exe` to a Git Bash PATH directory (winget installs to a long path not in PATH).
- **claude CLI**: Required for Claude Tasks / Conductor features. Install via `npm install -g @anthropic-ai/claude-code`.
- **Port conflicts**: Use `netstat -ano | findstr :<port>` + `Stop-Process -Id <PID> -Force` (PowerShell) — `lsof` not available in Git Bash on Windows.
- **PWA install**: Dashboard at `http://127.0.0.1:3000` can be installed as PWA via Chrome/Edge address bar install icon. Prefer Electron build for production.
- **Slack invalid_auth**: Expected if Slack tokens aren't configured — ignore, doesn't affect core functionality.
- **Node version**: Requires Node.js 22+. Check with `node --version`.
- **`NODE_OPTIONS` stripped**: Windows doesn't support env var prefix in npm scripts — removed from `build` and `electron:dev` scripts.

## Swarm dispatch environment variables

- `HERMES_SWARM_FORCE_ONESHOT=1` — force wrapper oneshot (`hermes -p <worker> chat -q`) instead of the default tmux live-session delivery. Use in CI or hosts without tmux.
- `HERMES_SWARM_TMUX_MODE=cli` — tmux session runs `bash -l`; dispatch uses `send-keys` to run `hermes chat -q` per task (`tmux-cli`). Default is `tui` (paste into `hermes chat --tui`).
- `HERMES_SWARM_USE_LIVE=1` — **deprecated** (tmux is now the default). Setting it only emits a warning.
- `HERMES_SWARM_MOCK_BIN=<dir>` — when set, `src/routes/api/swarm-dispatch.ts` looks for worker wrapper scripts in `<dir>` before falling back to `~/.local/bin/`. Useful for validating workflow routing without invoking real LLM workers.
