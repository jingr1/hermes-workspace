# Chat turn 分层合同（运行时分叉 · 接口同源）

> 状态：落地中  
> 相关：[`hermes-native-bridge.md`](./hermes-native-bridge.md)、[`managed-agent-daemon-mapping.md`](./managed-agent-daemon-mapping.md)  
> 代码：`src/lib/chat-turn-identity.ts`、`src/lib/hermes-activity-adapter.ts`、`packages/agent-activity-core`

## 1. 分层

```text
┌──────────────────────────────────────────────┐
│ UI 投影（气泡 / Activity / Stop）              │  只认 Engine VM
├──────────────────────────────────────────────┤
│ AgentSessionEngine（权威消息桶 + reconcile）   │  统一接口
├──────────────────────────────────────────────┤
│ Turn / Message 合同                            │  messageId · delta · settle
├──────────────────────────────────────────────┤
│ Runtime Adapter                                │
│   managed  → daemon activity WS                │
│   Hermes   → hermes-activity-adapter ← SSE     │  厂商协议止步于此
└──────────────────────────────────────────────┘
```

| 层 | 统一 | 可不统一 |
| --- | --- | --- |
| 合同 | `messageId` 生命周期、`message_delta` vs settle、禁止换皮 | — |
| 事件 | `@agorax/agent-activity-core` 的 Activity 形态 | 厂商原始 SSE / CLI JSON |
| 接口 | Engine apply / reconcile / 读消息 | — |
| 运行时 | — | Gateway、Claude CLI、Codex… |

**运行时可以不一样；身份、事件、settle 合同必须同源。**

## 2. Identity

| 角色 | id |
| --- | --- |
| Assistant 正文 | `assistant:<runId>`（无 runId → `assistant:pending:<sessionOrTurn>`） |
| Reasoning | `assistant:<runId>:thinking` |
| Tool | `toolcall:<toolCallId>` |

首包分配，流式 / 落库 / 历史同一行。禁止结束后换 ID 换皮。

## 3. Adapter 职责

- **Managed**：daemon 已发 Activity；`event-bridge` 只转发。  
- **Hermes**：`hermesSseToActivityEvents` 把 `started|chunk|thinking|tool|done` 译成同一套 `message_delta` / `turn_update`。  
- UI **不**直接吃 Hermes SSE 业务语义；目标态只订 Engine（当前 Hermes 1:1 仍经过渡路径 `chat-store` write-through，与合同对齐，待 native bridge 接线后切 Engine）。

## 4. Settle

- `done` / `error` → `turn_update` `phase=settled`  
- **禁止**用 history 页整段替换已投影正文  
- Reconcile = 补洞 / stamp id / version，不是换皮  
- **开 turn 期间**：`foldOpenTurnIntoLiveHost` 把 last-user 之后的工具/中间正文并进唯一 `assistant:<runId>`；有线程内 host 时底部 Thinking pill 必须关（禁止 `liveToolActivity` 单独点亮）

## 5. 分阶段

| Phase | 内容 | 状态 |
| --- | --- | --- |
| A | Identity + Hermes write-through（不换皮） | ✅ |
| B | Hermes SSE → Activity 纯 adapter | ✅ `hermes-activity-adapter.ts` |
| C | Native bridge 真接线：send-stream → adapter → Engine | ✅ `hermesSseToActivityEvents` + `hermes-turn-store` phase；UI `turnBusy` / `TurnActivityHost` |
| D | Hermes 1:1 UI 只订 Engine（与 managed 同 hook 投影） | 部分：UI 已订 turnBusy；完整 Engine hydrate 仍可加深 |

## 6. 明确不做

- 在 UI 里维护两套 merge（Hermes history cache vs managed Engine）作为终态  
- 把 Swarm tmux 伪装成 managed child Session  
- 用正文 fingerprint 当 React key
