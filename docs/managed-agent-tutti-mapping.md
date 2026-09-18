# Managed Agent Tutti 映射逻辑复用记录

状态：迁移完成（2026-09，Phase 0–5）

本文记录 agorax 把 tutti（`/home/ramon.jing/tutti`，只读参考）的 agent 前后端映射逻辑
复刻到本仓库的过程：复用来源对照、SSE/REST 合同摘要、与 tutti 合同的已知偏差、
状态所有权规则与验证命令清单。规划原文见
`~/.kimi-code/.../plans/havok-miles-morales-storm.md`（本文不重复其问题分析）。

tutti 侧的对应设计文档：`tutti/docs/architecture/agent-gui-hermes-workspace-mapping.md`。

## 结论

agorax 自有 UI（`src/screens/chat/`、群聊）现在通过 **canonical 合同**消费
`agorax-agent-daemon`：事件只是提示（events are hints），canonical 读兜底修复缺口；
前端状态由 activity-core engine 持有；群聊 / mission / Swarm 只投影、不双写。
复用的是 tutti 的**语义层与映射层**，不是 UI 组件——外壳、群聊、mission 所有权不变。

## 复用来源对照表

| tutti 包 | agorax 包 | 说明 |
| --- | --- | --- |
| `tutti/packages/agent/activity-core` | `packages/agent-activity-core`（`@agorax/agent-activity-core`） | canonical 状态引擎整体提取：engine / reducers / selectors / `workspaceEventCoordinator` / `optimisticMessageOverlay` / `sessionReconcileExecutor` / envelope 一致性校验（`agentActivityEventEnvelopeIsConsistent`） |
| `tutti/packages/agent/activity-tuttid-adapter` | `packages/agent-activity-daemon-adapter`（`@agorax/agent-activity-daemon-adapter`） | daemon DTO↔canonical 映射（~2400 行含测试）：`mappers.ts` / `sessionDetail.ts` / `requests.ts` / `composerOptions.ts` / `composerSettings.ts` / `capabilityReferences.ts`。daemon Go struct 的 PascalCase JSON 是真相源，不一致处以 daemon 实际输出为准修正 |
| tutti daemon（host + WS hub） | `agorax-agent-daemon/` | 复制体升级：WS 事件补全 tutti envelope；REST 新增 session list 与 `afterVersion` 分页 |
| tutti desktop 壳事件桥 | `src/lib/managed-agent-runtime/event-bridge.ts` | SSE 帧→envelope 校验→`queueMicrotask` 批处理→coordinator→engine；断线/坏帧触发 reconcile |
| tutti desktop 壳 reconcile 装配 | `src/lib/managed-agent-runtime/reconcile-port.ts` | core `AgentActivitySessionReconcilePort` 实现：detail 读 + `afterVersion` 增量分页（协议仅支持前向分页，desc/beforeVersion 在端口内组装） |
| tutti `interactiveAnswerPayload.ts` | `src/lib/managed-agent-runtime/interactive-answer-payload.ts` | question interaction 的 `answersByQuestionId` 权威 payload 纯函数 |

被替换掉的 agorax 自有实现：

- `src/lib/agent-activity-core.ts` 本地 shim 已删除，类型统一从
  `@agorax/agent-activity-core` 导入（消除双轨类型漂移）。
- `src/screens/chat/lib/managed-agent-activity-mapper.ts` 的手写 PascalCase 白名单
  （~40 键硬编码 + 写死默认值）已改为委托 `@agorax/agent-activity-daemon-adapter`，
  保留对外函数签名，fail-closed。
- backend→targetId 映射收敛到 `src/lib/managed-agent-runtime/agent-targets.ts`
  （client-safe 单一源，服务端 `http-client` 也从这里 import）。
- `use-managed-agent-chat.ts` 的 ping→全量 refetch + 2s 轮询兜底已删除，
  首载一次 hydrate 保留（经 detail 读 + reconcile）。
- `workspaceId` 硬编码 `'default'` 已消除：服务端读 `AGORAX_WORKSPACE_ID`，
  SSE `connected` 帧把它带给前端。

## 分层与合同摘要

```
agorax UI → command port(typed settlement)
          → POST /api/agents/:id/engine/activate|input|cancel|interactions/...
daemon WS ──► SSE(forward 全帧) ──► event-bridge ──► coordinator.ingestEvent ──► engine
                                     缺口/断线 ──► session/reconcileRequested
                                     reconcile-port ──► detail + messages?afterVersion&limit
```

### daemon WS envelope（`/v1/events/ws`）

```json
{
  "id": "<event id>",
  "topic": "agent.activity.updated",
  "version": 42,
  "emittedAt": 1758000000000,
  "scope": { "workspaceId": "<ws>" },
  "payload": {
    "workspaceId": "<ws>",
    "agentSessionId": "<canonical session>",
    "eventType": "message_delta | message_update | turn_update | interaction_update | session_reconcile_required",
    "data": { "…": "eventType 对应负载；identity 字段缺失时 daemon 注入" }
  }
}
```

- `version` 是 hub 单调 revision，发布顺序即订阅观察顺序。
- 滞后订阅者丢帧 → daemon 发 `session_reconcile_required`（可恢复丢失信号）。
- 非 text 消息（payloadSet / toolOutput）经 `message_delta` 完整下发；
  `message_update` 携带 committed 快照的 latestVersion / acceptedCount / 完整 messages。

### daemon REST（`/v1/workspaces/{ws}/...`）

| 端点 | 说明 |
| --- | --- |
| `GET /v1/agent-targets` | daemon catalog target 列表 |
| `GET /v1/workspaces/{ws}/agent-sessions` | session list（含 messageVersion 游标） |
| `POST /v1/workspaces/{ws}/agent-sessions` | 建 canonical session（client 提供 agentSessionId） |
| `POST .../agent-sessions/{id}/input` | sendInput（clientSubmitId 幂等） |
| `POST .../turns/{tid}/cancel` | cancelTurn |
| `GET .../agent-sessions/{id}/interactions` | pending interaction 快照 |
| `POST .../turns/{tid}/interactions/{rid}/response` | respondToInteraction |
| `GET .../agent-sessions/{id}/activity?afterVersion=&limit=` | activity 聚合（session+turns+messages+interactions）+ `messageVersion`/`hasMoreMessages` 游标；limit 默认 500、上限 1000 |

服务端 `agorax-managed-agent-http-client.ts` 实现 core `AgentActivityAdapter`
（`listSessions / listSessionMessages(afterVersion) / createSession / sendInput /
submitInteractive / cancelTurn`），是该接口的 daemon 方言 typed client。

### 服务端 SSE（`GET /api/agents/:id/engine/session/:sid/events`）

按 workspace 共享一条 daemon WS（module 级注册表 + 引用计数，取代每客户端一条），
按 `agentSessionId` 匹配 fan-out，**全帧转发**（不丢 payload）：

- `event: connected` — `data {"workspaceId": "..."}`，每次 attach（含重连）
- `event: activity` — `data <完整 daemon envelope>`
- `event: reconnect` — `data {"reason": "daemon-ws-drop" | "daemon-ws-reconnect"}`，
  daemon WS 断线/恢复时广播，前端据此跑 gap-closing reconcile

### 前端事件桥（`src/lib/managed-agent-runtime/event-bridge.ts`）

1. `activity` 帧 → `parseManagedAgentActivityEnvelope`（topic/scope/payload 形状 +
   core `agentActivityEventEnvelopeIsConsistent` 一致性校验，data 缺 identity 字段时归一化补齐）；
2. 校验通过 → `queueMicrotask` 批处理 → 宿主回调里
   `workspaceEventCoordinator.ingestEvent` → engine inline 应用；
3. 坏帧 / 解析失败 → `onMalformedActivity` → 宿主 dispatch `session/reconcileRequested`；
4. EventSource error → CLOSED 时显式重开（3s 退避），新 `connected` 帧触发优先 reconcile。

### 群聊 managed 成员

`turn-executor` 消费 canonical 事件（不再只认 `text_delta`/`run_exited`）：
`interaction_update` 经 `src/lib/group-chat-interaction-card.ts` 投影为 room 消息卡片
（marker `agorax:managed-interaction:v1`），状态以 daemon canonical 为准、无本地 pending
状态机；人回写走
`POST /api/rooms/:roomId/messages/:messageId/interaction-response`
（`src/server/group-chat/managed-interaction-cards.ts`），同一 canonical command 路径。

## 状态所有权规则

1. **daemon host** 是 Session / Turn / Interaction 生命周期 owner（其 SQLite 为真相源）。
2. **activity-core engine** 是前端 canonical state owner（不可变 snapshot + selectors）；
   事件流只是提示，一切终态以 canonical 读为准。
3. **群聊 / mission / Swarm / sidebar（managed-chat-store）** 只投影：room 卡片、assignment
   推进、会话列表都不复制生命周期事实，不写第二套 pending/turn 状态机。
4. Hermes runtime 完全不动：仍走 gateway / swarm-dispatch 路径，managed 合同仅覆盖
   claude-code / codex / cursor / kimi / opencode。
5. Legacy `AgentStreamEvent` 路径（router → bridge → transport →
   `agorax-managed-agent-events.ts` 转换）保留：群聊 managed turn 与旧
   `POST /api/agents/:id/chat` 路由仍消费它；daemon transport 未配置
   （无 `AGORAX_MANAGED_AGENT_URL`）时 router 回退 spawn adapter。

## 与 tutti 合同的已知偏差

| 偏差 | 现状 | 后续 |
| --- | --- | --- |
| composer options 端点缺失 | daemon 无 composer options REST 端点；engine session 未上报 capabilities 时 composer 显示 `capabilities: null`（"unknown"，fail-closed，不臆造）；显式 `false` 优先 | daemon 补端点后自动点亮 |
| client 生成 agentSessionId | 前端 `crypto.randomUUID()` 生成 canonical session id，activate 时提交给 daemon（tutti 由 host 侧生成） | 如需 tutti 对齐再调 |
| plan decision 端点缺失 | daemon 无 plan approve/reject 端点；plan interaction 渲染为只读信息卡片（`respondable: false` fail-closed） | 接 plan 决策合同后开放回写 |
| goal control 未接 | engine 已支持 goal 语义，daemon 未暴露 goal 操作端点 | 单独立项 |
| session fork 未接 | engine 支持，agorax 未暴露 fork saga | 单独立项 |
| edit retry 未接 | engine 支持，无 history revision fence | 单独立项 |
| side conversation 未接 | 无对应产品流程 | 需要时映射为 thread/panel |
| mission MCP 控制通道 | mission 派发到 daemon-backed agent 时 `task_start/task_complete` 合同不成立（transport 丢弃 `McpHandshake`） | 需单独决策（补 daemon MCP 通道或 mission 回退非 daemon 路径） |
| capability 上报 | canonical session 的 `capabilities` 依赖 daemon 写入 runtime context；未写时按未知处理 | 随 composer options 端点一起补 |

## 非目标（本次明确不做）

- 不迁移 tutti UI 组件 / UI System / Workbench；agorax 保留全部自有外壳。
- 不实现 mission MCP 控制通道（见上表）。
- goal control / session fork / edit retry / side conversation 等 tutti 高级合同不接。
- 不改 tutti 原仓库（只读参考）。

## 验证命令清单

```bash
# 类型基线（pre-existing 39 处错误，e2e specs / debug tests 等，与重构无关）
pnpm exec tsc --noEmit | grep -c "error TS"   # 期望 39

# 前端 + 服务端相关 vitest（Node 22）
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" \
  pnpm exec vitest run src/screens/chat src/server/agent-runtime \
    src/lib/managed-agent-runtime src/server/group-chat
# 已知 2 个环境敏感失败：agent-session-manager「退休中毒 session」、
# runner-baseline「single drive reproducibility」——与本重构无关

# 各包 node --test（activity-core / daemon-adapter）
(cd packages/agent-activity-core && pnpm test)
(cd packages/agent-activity-daemon-adapter && pnpm test)

# src 下 node:test 约定文件（*-node-test.ts，vitest 不收集）
node --test --experimental-strip-types \
  src/lib/managed-agent-runtime/interactive-answer-payload-node-test.ts

# daemon（改动涉及的 package）
(cd agorax-agent-daemon && go test ./...)
```

已知环境注意：

- vitest jsdom 已从 27 降到 25（修 `html-encoding-sniffer ERR_REQUIRE_ESM`）。
- 仓库 `.env` 配置 `AGORAX_MANAGED_AGENT_URL` 时，router 测试用 `vi.stubEnv` 钉空，
  断言的是「transport 未配置」回退路径。
