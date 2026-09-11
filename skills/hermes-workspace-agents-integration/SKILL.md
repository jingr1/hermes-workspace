---
name: hermes-workspace-agents-integration
description: "Use when wiring external managed agents (Claude Code, Codex, etc.) into hermes-workspace."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Hermes-Workspace, Managed-Agent, Agent-Runtime, Provider-Catalog, Settings, Chat, Group-Chat, Mission-Control, Claude-Code, Codex]
    related_skills: [claude-code, hermes-agent]
---

# Hermes Workspace 中接入 Claude Code / Codex 等外部 Agent

本 skill 描述如何在 hermes-workspace 中让 Claude Code、Codex 等外部 CLI agent 作为受管理 runtime 接入，并复用 Hermes Provider Catalog 做认证与模型选择。

## 1. 总体架构

hermes-workspace 的 agent 运行时分为两类：

- `runtime: hermes` — 由 hermes CLI/网关作为 agent，使用 hermes 自带的 provider/model/skill 体系。
- `runtime: claude-code | codex | deepseek-harness | ...` — 外部 CLI agent，由 workspace 的 **AgentRuntimeAdapter** 拆解为统一的：
  - 控制通道：MCP 工具调用（`task_start`, `task_complete`）
  - 展示通道：`AgentStreamEvent` 类型的 SSE 事件（`text_delta`、`thinking`、`tool`、`error`、`run_exited`）

主要文件：

- `agents.yaml` — 声明 agent 的 runtime/command/args/execution/capabilities。
- `src/server/agent-runtime/types.ts` — `AgentRuntimeKind`、`AgentRuntimeAdapter`、`AgentRunInput`、`AgentStreamEvent`。
- `src/server/agent-runtime/router.ts` — 根据 `agents.yaml` 选择 adapter，统一提供 `startRun` / `streamEvents` / `interrupt` / `probe`。
- `src/server/agent-runtime/claude-code-adapter.ts` — Claude Code 专用 adapter。
- `src/server/agent-runtime/codex-adapter.ts` — Codex 专用 adapter。
- `src/server/agent-runtime/run-managed-turn.ts` — 统一的单轮执行器，被 chat、群聊、mission control 复用。
- `src/server/claude-code-settings.ts` — 读写 `~/.claude/settings.json`，处理 alias、provider 显示、模型列表等。
- `src/server/codex-settings.ts` — 读写 `~/.codex/config.toml`，复用 Hermes Provider Catalog 的 provider/model/key。
- `src/server/local-env-check.ts` — 检测受管理 CLI agent（Claude Code、Codex 等）的本地版本与最新版本。
- `src/server/agent-env-action.ts` — 执行 npm 全局安装/升级，支持可选 sudo 提权。
- `src/routes/api/claude-code/settings.ts` + `claude-code-settings-panel.tsx` — Claude Code Settings UI 与 API。
- `src/routes/api/agents/codex-impl/config.ts` + `codex-settings-panel.tsx` — Codex Settings UI 与 API。
- `src/routes/api/agents/$agentId/env-check.ts` + `env-action.ts` — 动态 agent 本地环境检查与生命周期 action。
- `src/routes/api/agents/claude-code/models.ts` / `src/routes/api/agents/codex-impl/models.ts` — chat/model picker 的模型列表。
- `src/routes/api/agents/operations.ts` — Mission Control / Operations agent 列表，拼接 Hermes profiles 与外部 agent。
- `src/routes/api/agents/$agentId/chat.ts` — 1:1 managed chat SSE endpoint。

## 2. 接入 Claude Code 的必要配置

Claude Code CLI 通过 `~/.claude/settings.json` 配置 provider 和 model，而不是 hermes 的 `config.yaml`。

### 2.1 直连 Anthropic

服务商直连时，使用 `ANTHROPIC_API_KEY`：

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-3-5"
}
```

### 2.2 走代理/网关（如 tokenx）

走代理时必须用 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`，并且显式清空 `ANTHROPIC_API_KEY`：

```json
{
  "ANTHROPIC_BASE_URL": "https://model.nioint.com/token-x",
  "ANTHROPIC_AUTH_TOKEN": "...",
  "ANTHROPIC_API_KEY": "",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "Claude-Sonnet-5",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "Claude-Opus-5",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "Kimi-K2.7-Code"
}
```

关键区别：

- `ANTHROPIC_API_KEY` — 发送为 `x-api-key` header，用于直连 Anthropic。
- `ANTHROPIC_AUTH_TOKEN` — 发送为 `Authorization: Bearer <token>` header，用于 LLM 网关/代理。
- `ANTHROPIC_BASE_URL` 不应带末尾 `/v1`。Claude Code SDK 会自动拼接 `/v1/messages`。

### 2.3 复用 Hermes Provider Catalog

Settings panel 会从 `src/server/provider-catalog.ts` 读取已配置的 provider，用户选择 provider 后：

1. 取得 provider 的 `baseUrl`。
2. 自动去掉末尾 `/v1` 或 `/v1/`（`normalizeClaudeBaseUrl`），写入 `ANTHROPIC_BASE_URL`。
3. 根据用户选择的 auth mode 写入 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，并清空另一个 key。
4. 复用时，前端显示 mask（`••••`）但不标记为 dirty，避免误将 mask 写回文件。

## 3. 接入点一览

| 接入点 | 负责组件 | 说明 |
|---|---|---|
| Settings | `claude-code-settings-panel.tsx` + `src/routes/api/claude-code/settings.ts` | 选 provider、auth mode、model alias 和默认模型 |
| Local env check | `local-env-check-section.tsx` + `src/server/local-env-check.ts` | 检测本地 CLI 版本，提示安装/升级 |
| Env action | `src/server/agent-env-action.ts` + `src/routes/api/agents/$agentId/env-action.ts` | npm 全局安装/升级，可选 sudo 提权 |
| 1:1 Chat | `src/screens/chat/components/managed-agent-chat-view.tsx` | 选择 claude-code / codex agent 后进入 managed chat 界面 |
| Chat API | `src/routes/api/agents/$agentId/chat.ts` | SSE 推送 `text_delta/thinking/tool/error/run_exited` |
| Model Picker | `src/routes/api/agents/claude-code/models.ts` / `src/routes/api/agents/codex-impl/models.ts` | 返回当前 agent 的可用模型 + 当前 model/provider |
| Group Chat | `src/server/agent-runtime/run-managed-turn.ts` | 每个 managed runtime 成员轮次执行，使用统一的 adapter |
| Mission Control | `src/routes/api/agents/operations.ts` | 列出所有 agent，外部 runtime 读取各自配置文件展示 model/provider |
| Status Probe | `src/routes/api/agents/status.ts` + adapter.probe() | 检查 CLI 可执行文件是否可用 |

## 4. Codex 落地实现

Codex 复用与 Claude Code 相同的 managed-runtime 接入模式，但认证方式不同：

### 4.1 Runtime 与 Chat 路由

- `src/server/agent-runtime/codex-adapter.ts`：实现 `AgentRuntimeAdapter`。
  - `kind = 'codex'`
  - `probe()` — 检查 `codex` 命令是否可用。
  - `startRun()` — 生成 `codex exec --skip-git-repo-check --model <model> -- <task>`，注入 `HERMES_MCP_TOKEN` 与 provider API key。
  - `streamEvents()` — 解析 Codex stdout/stderr 为 `AgentStreamEvent`。
  - **注意：** Codex 0.146+ 没有 `--mcp-config` 参数，MCP 必须在 `~/.codex/config.toml` 中预配。
- `src/screens/chat/components/chat-workspace.tsx`：将 `codex` runtime 路由到 `ManagedAgentChatView`。
- `src/screens/chat/agent-chat-brands.tsx`：新增 `CODEX_CHAT_BRAND`。
- `src/screens/chat/components/managed-agent-chat-view.tsx`：按 runtime 选择 brand、models endpoint、头像/label。
- `src/screens/chat/components/chat-composer.tsx` / `agent-chat-frame.tsx`：新增 `runtimeLabel` / `runtimeConfigHint` props，避免 footer 写死 "Claude Code"。

### 4.2 Codex 配置桥接

Codex 使用 `~/.codex/config.toml`，通过 `src/server/codex-settings.ts` 管理：

- `readCodexConfig()` / `patchCodexConfig()` / `listCodexModels()` / `resolveCodexProviderDisplay()`。
- 复用 Hermes Provider Catalog：`[model_providers.<id>]` 块的 `name`、`base_url`、`env_key` 从 catalog 同步。
- `wire_api = "responses"`，因为 Codex 0.146+ 默认使用 OpenAI Responses API。
- **不写硬编码 api_key 到 TOML**：用 `env_key = "TOKENX_API_KEY_VPEL"`（或 provider 对应 key_env），启动时再根据该 env_key 注入真实值。
- 保留 config.toml 中其他 block（如 `[mcp_servers]`、`[projects]`），只改写目标 provider block。
- 切换回 `openai` 等非 catalog provider 时，把旧的 catalog block key 注释掉，避免仍用 gateway key。

### 4.3 Settings UI

- `src/components/settings-dialog/codex-settings-panel.tsx`：复用 catalog provider 下拉 + model 下拉。
- `src/components/settings-dialog/local-env-check-section.tsx`：Codex 本地环境检查卡片，展示当前/最新版本、可升级状态，支持一键安装/升级（通过 `/api/agents/$agentId/env-action` 调用 `src/server/agent-env-action.ts` 运行 npm 命令）。
- `src/components/settings/settings-sidebar.tsx` 与 `src/routes/settings/index.tsx`：把 Codex 加进独立 `/settings` 页面。
- `src/components/settings-dialog/settings-dialog.tsx`：按 runtime 渲染 Codex 设置面板。

### 4.4 API 路由

- `src/routes/api/agents/codex-impl/config.ts` — GET/PATCH `/api/agents/codex-impl/config`。
- `src/routes/api/agents/codex-impl/models.ts` — GET `/api/agents/codex-impl/models`。
- 使用静态 `codex-impl` 目录而非动态 `$agentId`，避免 TanStack Router 生成问题。

### 4.5 API Key 注入

Codex 0.146+ 不识别 `-c model_providers.<id>.api_key=...` 命令行覆盖，因此：

- 不在 TOML 中写死 `api_key`。
- 在 `codex-adapter.ts#buildCodexSpawnEnv` 中读取 `~/.codex/config.toml` 当前 provider 的 `env_key`：
  1. 先用 `getCatalogProviderCredential()` 从 Hermes catalog 的 `.env` 取真实 key。
  2. fallback 直接读 `~/.hermes/.env`（当 key 未同步到 default profile 时）。
  3. 将真实 key 以该 env_key 注入 Codex 子进程。

### 4.6 在 agents.yaml 声明

```yaml
version: 1
agents:
  - id: codex-impl
    runtime: codex
    command: codex
    execution: local
    capabilities: [coding, review]
    displayName: Codex
```

## 5. 本地环境检查与一键升级

受管理的 CLI agent 在 Settings 面板中会展示本地环境检查卡片：

### 5.1 后端

- `src/server/local-env-check.ts`：
  - 根据 `agentId`（如 `cc-impl`、`codex-impl`）找到 `MANAGED_AGENTS` 配置。
  - 通过 `command --version` 探测本地版本，并尝试解析 npm registry 的 `dist-tags.latest`。
  - 返回 `{ currentVersion, latestVersion, installed, installedButBroken, detail, envType }`。
- `src/server/agent-env-action.ts`：
  - 支持 `install` / `update` 两种 action，实际都是 `npm i -g <pkg>@latest`。
  - 格式化命令时优先使用与已安装 CLI 同目录的 npm，确保升级与当前 PATH 一致。
  - 可选 `useSudo + sudoPassword`，在 Linux/macOS 非 root 时调用 `sudo -S`。
- `src/routes/api/agents/$agentId/env-check.ts` 与 `env-action.ts`：
  - 通用路由，`params.agentId` 传递给 `checkLocalEnvForAgent` / `runAgentEnvAction`，所有 `MANAGED_AGENTS` 中的 agent 都支持。

### 5.2 前端

- `src/components/settings-dialog/local-env-check-section.tsx`：
  - 卡片展示：agent 名称（如 Codex）、本地环境检查标签、状态 pill（可升级/未安装/异常/平台）。
  - 版本行：当前版本 / 最新版本。
  - 右下角按钮：可升级时为蓝色“升级”，未安装/异常时为“安装”，已是最新时为“刷新”。
  - 点击升级/安装弹出 Dialog：可勾选 sudo，输入密码，显示命令输出。
- `src/components/settings-dialog/codex-settings-panel.tsx`、`claude-code-settings-panel.tsx` 中渲染 `<LocalEnvCheckSection agentId="..." />`，平台标签由后端 `envType` 动态决定。

### 5.3 添加新 agent

1. 在 `agents.yaml` 声明 `id`、`runtime`、`command`、`displayName`。
2. 在 `src/server/local-env-check.ts` 的 `MANAGED_AGENTS` 与 `src/server/agent-env-action.ts` 的 `MANAGED_AGENTS` 中同步加入 `{ agentId, name, command, npmPackage }`。
3. 如果该 agent 需要独立的 Settings 面板，创建对应的 `*-settings-panel.tsx` 并在 `src/components/settings-dialog/settings-dialog.tsx` 的 `renderAgentSpecificSettings` 中路由。
4. 如果与 `claude-code` 接口兼容（如 opencode），可直接复用 `ClaudeCodeSettingsPanel`。

## 6. 实现新的外部 Agent（通用步骤）

要让新的 CLI agent（如 Pi）复用同一套接入模式，需要：

### 6.1 扩展 `AgentRuntimeKind`

在 `src/server/agent-runtime/types.ts` 中：

```ts
export type AgentRuntimeKind =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'deepseek-harness'
  | 'opencode'
  | 'pi'
```

### 6.2 新增 Adapter

在 `src/server/agent-runtime/` 下新建 `<agent>-adapter.ts`，实现 `AgentRuntimeAdapter`：

- `kind = '<agent>'`
- `probe()` — 检查 CLI 命令是否可用。
- `startRun()` — 生成该 agent 的 argv，注入 HERMES_MCP_TOKEN 和必要环境变量，spawn 子进程。
- `streamEvents()` — 解析该 CLI 的 stdout/stderr 为 `AgentStreamEvent`。
- `interrupt()` — SIGKILL 整个进程组。

### 6.3 注册到 Router

在 `src/server/agent-runtime/router.ts` 的 `AgentRuntimeRouter` 中，根据 `decl.runtime === '<agent>'` 返回新 adapter 实例。

### 6.4 配置桥接（Settings）

参照 Codex 模式：

- 配置文件读写（JSON/TOML）。
- Settings panel（可通用化为 `external-agent-settings-panel.tsx` 抽象层）。
- Provider/model 解析，优先复用 Hermes Provider Catalog 的 `base_url` / `key_env` / `models`。

### 6.5 更新 Operations 列表

`src/routes/api/agents/operations.ts` 中继续扩展 `readExternalAgentConfig`：

```ts
function readPiConfig(): { model: string; provider: string } {
  // 读取 ~/.pi/config 或环境变量
  return { model: '', provider: '' }
}
```

## 6. 重要约束与常见问题

- **Secrets 不上前端：** `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 在服务端 mask 后才返回 UI。
- **base URL 不带 `/v1`：** Claude Code SDK 自己拼 `/v1/messages`。配置和复用 catalog provider 时需自动 strip。
- **AUTH_TOKEN 与 API_KEY 互斥：** 保存时按 auth mode 写入一个，清空另一个，避免 priority 覆盖。
- **Mask 不写回文件：** UI 使用 `keyDirty` 状态，只有用户真实编辑的 key 才会被写入。
- **Provider 显示：** 优先从 Hermes catalog 反查 provider 名称，而不是用 URL host。
- **Subagent model 不进入 picker：** `CLAUDE_CODE_SUBAGENT_MODEL` 用于 workflow/subagent，不应在 chat picker 中与 alias 模型重复显示。
- **Codex 不写硬编码 `api_key`：** 因为 Codex 0.146+ 对 `[model_providers.<id>].api_key` 解析/优先级有问题，导致 401。应在 TOML 中写 `env_key = "TOKENX_API_KEY_VPEL"`（对应 Hermes catalog 的 `key_env`），由 adapter 启动时注入真实 key。
- **Codex 子进程 key 注入 fallback：** 服务端进程可能没继承用户 shell 的环境变量。adapter 先从 Hermes catalog 的 `.env` 读取，失败再 fallback 读 `~/.hermes/.env`。
- **Codex 配置 patch 要避免 duplicate key：** 原文件 block 缺失 `env_key`/`requires_openai_auth` 时，不能往文件末尾追加，必须紧跟对应 table header 插入到 block 内部。
- **Codex 切换 provider 时清理旧 block：** 从 catalog provider 切回 `openai` 时，要把旧 catalog block 的 `env_key` 注释掉，否则 Codex 仍可能用旧 gateway 认证。
- **Chat 品牌动态化：** `ChatComposer` / `AgentChatFrame` 不要写死 "Claude Code"，通过 `runtimeLabel` / `runtimeConfigHint` props 由 `ManagedAgentChatView` 按 agent runtime/brand 传入，并同步切换头像（`ClaudeCodeMark` / `CodexMark`）。
- **本地环境检查 agentId 一致：** `agents.yaml`、`local-env-check.ts`、`agent-env-action.ts` 中的 `agentId` 必须一一对应，否则 env-check 会返回 "Unsupported agent"。
- **动态路由与静态路径并存：** `env-check` / `env-action` 使用 `src/routes/api/agents/$agentId/*`，对所有 managed agent 通用；专属路由（如 `codex-impl/config` 、`codex-impl/models`）仍然保留静态目录。
- **sudo 密码仅用于本机提权：** 传输过程中不做加密，如需更高安全等级别请改用 keyring / pkexec / sudo -A。

## 7. Claude Code adapter 启动时的环境传递

`claude-code-adapter.ts` 的 `buildClaudeSpawnEnv` 会：

1. 继承 `process.env`，但删除 Cursor sandbox 变量、空的 Anthropic 认证变量。
2. 叠加 `~/.claude/settings.json` 中的 `env`。
3. 如果 `ANTHROPIC_AUTH_TOKEN` 有值而 `ANTHROPIC_API_KEY` 没有，则将 AUTH_TOKEN 镜像到 API_KEY（print mode 下一些版本需要此 fallback）。
4. 注入 `HERMES_MCP_TOKEN` 和 `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`。

## 8. 测试要点

- `src/server/claude-code-settings.test.ts` 要覆盖：
  - `maskClaudeCodeSettings` 对 `ANTHROPIC_AUTH_TOKEN` 的 mask。
  - `resolveClaudeCodeProvider` 在匹配 catalog provider 时返回名称，不匹配时返回 host。
  - `listClaudeCodeModels` 不重复返回 `CLAUDE_CODE_SUBAGENT_MODEL`。
- `src/server/codex-settings.test.ts` 要覆盖：
  - `patchCodexConfig` 从 catalog 同步 provider 时写 `env_key` 而不是硬编码 `api_key`。
  - 已有的 provider block 被正确覆盖，不产生 duplicate key。
  - 切回 `openai` 时旧的 catalog block key 被注释掉。
  - `maskSecrets` 脱敏 `api_key` 但保留 `env_key` 可读。
  - `listCodexModels` 正确返回 catalog provider 的模型。
- `src/server/agent-runtime/agent-runtime.test.ts` 要覆盖：
  - `CodexAdapter.probe()` 在 PATH 中存在/不存在 codex 时的行为。
- 类型检查：`pnpm tsc -p tsconfig.json --noEmit` 无新增报错。
- 本地环境检查测试：
  - `src/server/local-env-check.test.ts` 要覆盖 `cc-impl` 和 `codex-impl` 的版本检测。
  - `src/server/agent-env-action.test.ts` 要覆盖升级流程、不支持 agent 的错误返回。
  - 手动验证：`GET /api/agents/<agentId>/env-check` 返回版本信息；`POST /api/agents/<agentId>/env-action` 执行 `npm i -g <pkg>@latest`。
- 真实呼叫检查：
  - Claude Code 使用 `claude -p "hi"` 确保认证、base URL、model alias 生效。
  - Codex 使用 `codex exec --skip-git-repo-check "hi"` 确保 `env_key` 模式下 tokenx `/v1/responses` 返回 200。
