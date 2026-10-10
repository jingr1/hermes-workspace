# Chat turn identity contract (Hermes ↔ managed 同源)

> 状态：落地中  
> 对齐：Agent Activity（稳定 `messageId` + delta write-through + settle 不换皮）  
> 实现：`src/lib/chat-turn-identity.ts`、`src/stores/chat-store.ts`

## 目标

Hermes 1:1 与 managed-agent **共用同一生命周期合同**，不再「流式一份、history 再换皮」。


| 原则             | 合同                                                                 |
| -------------- | ------------------------------------------------------------------ |
| Identity-first | 首包（`started` / 首 token）分配最终 `messageId`；流式、realtime、history 同一行    |
| Write-through  | chunk / thinking / tool 只 upsert 该行；禁止另造 `streaming-current` 占位换行  |
| Settle ≠ 换皮    | `done` 只把 `__streamingStatus` 置 complete；禁止用 history 页替换可见 content |
| Reconcile      | 只 stamp 缺失 server id / 补缺口；正文以 live 累加为准                           |
| 列表 key         | React key = durable `messageId`（或等价 id），不是正文 fingerprint           |




## Hermes 映射

- `messageId = assistant:<runId>`（无 runId 时 `assistant:pending:<sessionKey>`）
- `StreamingState.messageId` 与 realtime 行、UI `streamingMessageId` 三者相同
- managed 路径保持 Tutti Engine；本仓库 Hermes 路径收敛到同一合同，而不是再抄一套 UI merge



## 明确不做

- 完成后立刻 `refetch history` 并用 server echo 覆盖已打印正文
- 用 `content.toString()` / 正文 fingerprint 当 React key（长流式会 remount）
- 把 provisional placeholder id 在 settle 时换成另一个 id 并换行

