# Hermes Native Bridge（双桥合同）

> 状态：Phase 0–1 skeleton（2026-09）  
> 实现起步：[`src/server/agent-runtime/hermes-native-bridge.ts`](../src/server/agent-runtime/hermes-native-bridge.ts)  
> 对照：[`docs/managed-agent-daemon-mapping.md`](./managed-agent-daemon-mapping.md)

## 1. Dual-bridge 模型

Agorax 对前端暴露同一套 `AgentActivityAdapter` / `AgentSessionEngine` 合同，背后有两条互不替代的桥：

| Bridge | 执行面 | Canonical 真相源 | 产品入口 |
| --- | --- | --- | --- |
| **Managed** | `agorax-agentd`（CLI providers） | daemon SQLite Session/Turn/Interaction | 1:1 managed chat、群聊 managed 成员 |
| **Native (Hermes)** | Hermes Gateway +（Swarm）tmux | Workspace 侧映射表 + gateway session；**终态权威仍是 canonical Session/Turn 投影** | 1:1 Hermes chat（`send-stream`）、群聊 Hermes、Swarm dispatch |

```text
AgentSessionEngine
  ├─ managed bridge ──► agorax-agentd REST/WS
  └─ native bridge  ──► Hermes Gateway / send-stream
                          └── Swarm/tmux 仅作投影（不伪装成 child Session）
```

`HermesAdapterStub`（probe-only）与 tmux / swarm-dispatch **继续有效**；native bridge 是并行增长路径，不替换 Swarm 执行模型。

## 2. 所有权

- **Canonical Session / Turn / Interaction** 是终态权威。UI、群聊卡片、mission 列表只投影。
- **观察量（非权威）**：`runtime.json`、tmux 存活、LangGraph checkpoint、gateway WS 连通性。
- **禁止**：把 Swarm worker assignment / Human Gate / mission gate 伪装成 managed child Session 或 provider Interaction。

## 3. Identity 映射（`agorax_run_mapping`）

Workspace 侧（或 collab.db）维护稳定映射，避免把 gateway id 直接当 `agentSessionId` 泄漏到 engine：

| 字段 | 含义 |
| --- | --- |
| `agentSessionId` | Agorax / engine 侧会话 id（UUID） |
| `turnId` | Agorax / engine 侧回合 id |
| `gatewaySessionId` | Hermes gateway session key（可空直至 Create） |
| `assignmentId` | Swarm assignment id（仅 Phase 3+；可空） |
| `hermesRunId` | gateway / send-stream run id（可空） |
| `bridgeKind` | 恒为 `hermes-native` |
| `updatedAtUnixMs` | 映射行更新时间 |

映射规则：

1. CreateSession → 分配 `agentSessionId`，探测/打开 gateway session，写入 `gatewaySessionId`。
2. SendInput → 新 `turnId`，调用 gateway send-stream，绑定 `hermesRunId`。
3. CancelTurn → 走 gateway abort API；**禁止**对 tmux TUI 发送 C-c 杀进程。Turn cancel = 停止等待 + canonical settle（`outcome=canceled`）。
4. Reconcile → 以映射表 + gateway 只读状态重放 activity，不 invent 成功。

## 4. Cancel 规则

| 场景 | 行为 |
| --- | --- |
| Managed | Host `CancelTurn` → provider abort |
| Native 1:1 | Gateway abort / stop waiting；settle Turn |
| Native Swarm / tmux | **禁止 C-c 杀 TUI**；cancel = 停止编排等待 + 标记 Turn/assignment 结算 |
| 未知 / 无映射 | fail closed，不报告假成功 |

## 5. 分阶段

| Phase | 范围 | 本文件状态 |
| --- | --- | --- |
| **0** | 映射类型 + 包边界；不改执行路径 | ✅ skeleton |
| **1** | gateway 1:1：Create/Send/Cancel/stream → activity 事件 + reconcile | ✅ Create/Send stubs；真实流式另迭代 |
| **2** | 群聊 Hermes 成员 Turn 投影 + 精确 cancel/resume | 文档预留 |
| **3** | Swarm assignment ↔ Turn；Human Gate 仍属 Hermes | 文档预留 |
| **4+** | Interaction（仅当 gateway 有真实确认通道）；Goal/Fork 后置 | 文档预留 |

## 6. 与 Runtimes 页的关系

Hermes 在 Settings → Runtimes 的「就绪」= gateway probe（`probeHermesProfileGateway`），与 native bridge hydrate **解耦**：probe 失败不伪造 bridge Create 成功；bridge 未接线时 UI 仍走既有 `send-stream` / swarm 路径。

## 7. 非目标（本阶段）

- 把 Hermes tmux 长会话改成 managed `startRun` 进程模型
- 整包替换为外部 Agent GUI
- 在 native bridge 内重实现 Swarm 编排
