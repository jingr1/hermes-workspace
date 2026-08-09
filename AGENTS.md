# Hermes Workspace Agent Contract

This workspace uses semantic Hermes swarm workers, not numbered-only lanes. The source of truth for routing is `swarm.yaml`; each worker also has a matching profile under `~/.hermes/profiles/<worker-id>/`, role skills as listed below, and a wrapper in `~/.local/bin/`.

## Current semantic roster

LangGraph workflows (`radw.yaml` default, `rdi.yaml`, `research_only.yaml`, `design_implement.yaml`) may only reference worker ids defined here.

**Model source of truth:** each worker's `model` lives only in [`swarm.yaml`](swarm.yaml) (`provider/model-id`). Do not hardcode model names in this file — change models via Swarm UI or edit `swarm.yaml`, then run `node scripts/sync-swarm-profiles.mjs`.

| Worker | Wrapper | Modes | Tools | Skills | MCP | Plugins |
|---|---|---|---|---|---|---|
| `orchestrator` | `orchestrator:plan` | plan, autoresearch, autoresearch-dispatch | todo, kanban, delegation, terminal, file, session_search, cronjob, skills, clarify, web | orchestrator-core, gstack-for-hermes, llm-wiki, kanban-orchestrator, subagent-driven-development, writing-plans, autoresearch, autoresearch-plan, autoresearch-orchestrate | none | none |
| `researcher` | `researcher:quick` | quick | web, browser, terminal, file, vision, session_search, skills, todo | researcher-core, llm-wiki, browser-harness, gstack-for-hermes, researcher-quick, arxiv, youtube-content, polymarket | none | none |
| `architect` | `architect:design` | design, autoresearch | terminal, file, web, session_search, skills, todo | architect-core, harden-gate, gstack-for-hermes, llm-wiki, writing-plans, requesting-code-review, codebase-inspection, autoresearch, autoresearch-execute | none | none |
| `developer` | `developer:implement` | implement, autoresearch | terminal, file, browser, web, session_search, skills, todo | gstack-for-hermes, llm-wiki, test-driven-development, systematic-debugging, codebase-inspection, github-pr-workflow, autoresearch, autoresearch-execute | none | none |
| `writer` | `writer:author` | author, autoresearch | terminal, file, web, browser, session_search, skills, todo, vision | gstack-for-hermes, llm-wiki, powerpoint, docx, pdf, writing-plans, autoresearch, autoresearch-execute | none | none |
| `learning` | `learning` | — | file, session_search, skills, todo, web | gstack-for-hermes, llm-wiki, obsidian, writing-plans, learning-wiki-ingest | none | none |

### Default mission pipeline

```text
orchestrator → researcher → architect → (developer | writer) → architect (review + harden) → learning
```

Canonical contracts: [`docs/swarm/HANDOFF-PROTOCOL.md`](docs/swarm/HANDOFF-PROTOCOL.md) · [`docs/swarm/ESCALATION-GUIDE.md`](docs/swarm/ESCALATION-GUIDE.md).

| Stage | Worker | Role |
|---|---|---|
| Route / greenlight / autoresearch dispatch | `orchestrator` | Decompose missions, draft autoresearch contracts, dispatch executors, enforce human approval gates |
| Research | `researcher` | Establish facts (competitive analysis, data validation, source tracing); no strategy or recommendations; respond to architect challenges with evidence |
| Direction + design / lane / review | `architect` | Wedge/bets/kill criteria + specs/content brief; **choose exactly one build executor** (`developer` or `writer`); review that executor's output. No fact-gathering or coding/authoring |
| Build (dev lane) | `developer` | Code per spec, tests, build verification — only when architect sets `executor: developer` |
| Build (write lane) | `writer` | Docs/slides/narrative/visual deliverables — only when architect sets `executor: writer` |
| Retrospective | `learning` | Mission docs, lessons learned, durable knowledge capture via `learning-wiki-ingest` |

**Executor lane rule:** Architect owns `executor: developer | writer`. Lanes are mutually exclusive for the same mission step — do not parallel-dispatch both. If code and content are both required, sequence them (usually developer then writer) under a fresh architect decision.

**Gate C (review retry ≤3):** When architect returns `REVIEW_OUTCOME: changes_requested`, LangGraph re-dispatches the same executor (`developer` or `writer`) with review feedback. After **3** failed review rounds on that lane, routing raises `needs_human` (Human Gate) instead of looping forever. Configured via `max_iterations: 3` on the `changes_requested` transitions in `hermes_langgraph_orchestrator/workflows/` (`radw.yaml`, `rdi.yaml`, `design_implement.yaml`).

**Gate H (harden checklist):** After build-lane `REVIEW_OUTCOME: approved`, architect must also emit `HARDEN_OUTCOME: pass|fail` using skill `harden-gate` (evidence checklist: secrets, file paths, test/doc fidelity). `pass` → learning / publish greenlight request; `fail` → same EXECUTOR revises (≤2); missing harden after approve → Human Gate. Not a new worker — skill on architect.

## Operating rules

- Keep `swarm.yaml`, profile `config.yaml`, profile skills, and wrappers aligned when changing a worker.
- **GBrain ≡ llm-wiki** in this workspace: the `gbrain` skill/MCP is not deployed locally. Brain-first lookup uses the Hermes builtin `llm-wiki` skill against `WIKI_PATH` (default `~/wiki`), plus swarm mission memory under `memory/swarm/`.
- **Brain-first order** (before web search): ① read `$WIKI_PATH/SCHEMA.md` + `index.md` + recent `log.md`; ② grep `memory/swarm/` and dispatch handoffs; ③ `session_search` for prior sessions; ④ external `web` / `arxiv` only when local context is insufficient.
- **Knowledge layering:** `~/wiki` holds durable domain knowledge; `memory/swarm/missions/<missionId>/` holds archived mission artifacts; `memory/swarm/<worker>/` holds in-progress drafts; `memory/handoffs/swarm/` holds latest checkpoints; `learning` ingests reusable conclusions into the wiki after missions complete (see `docs/swarm/LEARNING-WIKI-INGEST.md`).
- **Researcher** establishes facts only (competitive analysis, validation, source trails); no strategy or recommendations. **Architect** may challenge findings; researcher responds with evidence. **Architect** owns direction (wedge/bets/kill criteria), technical/content specs, **executor lane selection** (`developer` \| `writer`), and review/harden of the chosen executor — not primary fact-gathering, coding, or audience authoring. **Developer** / **Writer** execute only their lane per architect specs; no architecture or design changes; escalate gaps to architect (writer fact gaps → researcher via architect). **Learning** documents and wiki-ingests; **Orchestrator** routes and enforces greenlight. Challenge/response max 3 rounds, then escalate per `docs/swarm/ESCALATION-GUIDE.md`.
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
- `HERMES_SWARM_TMUX_MODE=tui` — **默认/推荐配置**。tmux session 长驻运行 `hermes chat --tui`；WebUI 输入区消息通过 bracketed-paste 直接送达 TUI prompt，支持实时对话。
- `HERMES_SWARM_TMUX_MODE=cli` — **可选 fallback**。tmux session 运行 `bash -l`；dispatch 使用 `send-keys` 每轮单独运行 `hermes chat -q`。CLI 模式不支持 WebUI 实时聊天，但 paste 更稳定，可用于纯编排场景或 TUI 不可用的环境。
- **tmux 全局配置要求**（TUI/CLI 共同依赖）：在 `~/.tmux.conf` 添加以下两行，防止最后一个 session 关闭时 tmux server 退出：
  ```
  set -g exit-empty off
  set -g exit-unattached off
  ```

  **相关修复**：

  1. **TUI bracketed-paste 包装**：`src/server/swarm-tmux-delivery.ts` 新增 `tmuxPasteWithBracketedPaste`，在 `\e[?2004h` / `\e[200~` / `\e[201~` / `\e[?2004l` 序列内包装 `tmux paste-buffer`，解决 prompt_toolkit 多行 paste 进入 continuation 模式的问题。

  2. **TUI session 空壳检测与自动重启**：`src/routes/api/swarm-direct-chat.ts` 在发送消息前检测 tmux session 是否实际运行 Hermes；若只有 bare shell，则 kill 并重建 session，避免消息被当成 shell 命令执行。

  3. **CLI shell ready 检测增强**：修改 `src/server/swarm-tmux-delivery.ts` 的 `tmuxPaneLooksLikeShellReady`，允许识别 `~$` 结尾、忽略 `.bashrc` 噪音（conda 插件警告、VS Code shell 集成失败等）。

  4. **workflowId 解析修复**：修改 `src/routes/api/swarm-langgraph/run.ts`，不把短 workflow 名称（如 `rdi`）当成路径。只有包含 `/` 或 `\` 时才当作绝对路径。

  5. **Human Gate 继续等待支持**：完整实现链路：
     - `src/server/langgraph-human-gate.ts`：增加 `continueWaitMinutes` 字段
     - `src/routes/api/swarm-langgraph/resume.ts`：读取并写入环境变量 `HERMES_LANGGRAPH_CONTINUE_WAIT_MINUTES`
     - `hermes_langgraph_orchestrator/nodes.py`：`wait_for_checkpoints` 从环境变量读取并覆盖 `staleMinutes`
     - `src/screens/swarm2/lib/human-gate-options.ts`：timeout 阻塞时提供"继续等待 15/60 分钟"选项
     - `src/screens/swarm2/components/human-gate-panel.tsx`：传递 `continueWaitMinutes` 到 resume API
     - `src/screens/swarm2/hooks/use-human-gate.ts`：`HumanGateResumeRequest` 类型增加 `continueWaitMinutes?`

  6. **workflow 超时处理**：`rdi.yaml` 把 `timeout` 从 `retry` 移到 `escalate`，触发 Human Gate 而不是无限重试。

  - `HERMES_SWARM_USE_LIVE=1` — **deprecated** (tmux is now the default). Setting it only emits a warning.
  - `HERMES_SWARM_MOCK_BIN=<dir>` — when set, `src/routes/api/swarm-dispatch.ts` looks for worker wrapper scripts in `<dir>` before falling back to `~/.local/bin/`. Useful for validating workflow routing without invoking real LLM workers.
