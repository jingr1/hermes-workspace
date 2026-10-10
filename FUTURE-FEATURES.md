# FUTURE-FEATURES.md

---

## 🔴 高优先（解锁「App Factory」通宵跑；以及 Chat 同源切轨）

### 1. 迭代精炼循环（Iterative Refinement Loop）

**做什么：** 校验不止跑一遍 `tsc`。循环：跑 tsc → 有错？→ 打回 agent → 修复 → 再跑。最多 3 轮，再升给人审。  
**为什么：** Anthropic 明确把这当作让 agent 可靠的模式。当前单次校验失败时容易静默。  
**落点：** mission/swarm 校验路径（原 `workspace-daemon` 已移除；见 `src/server/task-pipeline/` / LangGraph harden gate）  
**模式来源：** Anthropic Skills Guide — "Iterative Refinement"

### 2. Agent Handoff（跨 agent 传上下文）

**做什么：** 一个 agent 完成一波后，把结构化上下文（git diff、错误日志、做了什么、跳过了什么）交给下一个。禁止冷启动。  
**为什么：** 现在每个任务几乎从零开始。Handoff 是 OpenAI Agents SDK 的一等原语——显式交接 + 上下文。通宵跑要靠这个连贯。  
**落点：** `docs/swarm/HANDOFF-PROTOCOL.md` + swarm dispatch handoff（原 `workspace-daemon` 已移除）  
**模式来源：** OpenAI Agents SDK — "Handoffs"

### 3. 专用 Agent 角色

**做什么：** 用角色化 agent 替代泛化 Codex adapter：

- **Researcher** — 读代码库，产出规格/上下文文档
- **Planner** — 吃规格，产出带依赖的任务拆解
- **Builder** — 执行任务（Codex）
- **Validator** — 跑 tsc、测试、审 diff
- **Deployer** — git 操作、开 PR、通知

**为什么：** 「App Factory」截图跑的是专用角色；泛化 agent 缺领域上下文。  
**落点：** `agents.yaml` roster + Hermes/managed adapters（原 `workspace-daemon` 已移除）  
**模式来源：** Anthropic Skills — "Domain-specific intelligence" + App Factory

### 4. Chat turn Phase C — Native bridge 真接线

**做什么：** `send-stream` → `hermes-activity-adapter` → `AgentSessionEngine`。Hermes SSE 不再直接驱动 `chat-store` 业务语义；厂商事件止步于 adapter，权威消息桶是 Engine（与 managed 同一套 apply / reconcile）。  
**为什么：** 当前 Hermes 1:1 仍是 `chat-store` write-through 过渡轨。截图里的「工具/中间正文当已结束气泡 + 父 turn 还 Working」一类分裂，终态要靠 **一 turn 一 Engine 宿主**，而不是在 UI 再叠一层 fold/dedup。  
**落点：**

- 合同：`[docs/chat-turn-identity-contract.md](docs/chat-turn-identity-contract.md)` Phase C
- Bridge：`[docs/hermes-native-bridge.md](docs/hermes-native-bridge.md)`、`src/server/agent-runtime/hermes-native-bridge.ts`（现状：skeleton）
- Adapter：`src/lib/hermes-activity-adapter.ts`（Phase B 已有纯翻译；本项要接 Engine apply）
- 映射：`agorax_run_mapping`（`agentSessionId` / `turnId` ↔ gateway session / `hermesRunId`）持久化；Cancel = gateway abort + settle，禁止对 tmux 发 C-c

**前置：** Phase A（identity write-through）✅、Phase B（SSE→Activity adapter）✅  
**不做（本项）：** 不把 Swarm tmux 伪装成 managed child Session；不整包替换为外部 Agent GUI。

### 5. Chat turn Phase D — Hermes 1:1 UI 只订 Engine

**做什么：** Hermes 1:1 与 managed 共用同一套 UI 投影 hook（读 Engine VM：气泡 / Activity / Stop / 空档 Thinking pill）。删除或退役 Hermes 专用双轨：`useRealtimeChatHistory` + `finalDisplayMessages` 上的 history/store 并行 merge、`hermesShowProcessingIndicator` 与 `shouldShowManagedProcessingIndicator` 分叉。  
**为什么：** 合同目标是「运行时可以分叉，身份/事件/settle 同源」；D 完成后 UI **只认 Engine**，底部 pill 与线程内 host 互斥由同一套 selector 保证。  
**落点：**

- 合同：`[docs/chat-turn-identity-contract.md](docs/chat-turn-identity-contract.md)` Phase D
- 对照实现：`src/screens/chat/hooks/use-managed-agent-chat.ts`、`src/screens/chat/lib/managed-agent-engine.ts`
- 迁移面：`chat-screen.tsx` Hermes 路径、`chat-store` 流式缓冲逐步降级为兼容或删除

**前置：** **必须先完成 Phase C**（Engine 里已有 Hermes turn 权威桶，才能「只订 Engine」）。  
**风险：** Hermes 1:1 是主路径；未稳定 C 前切 D 会同时踩 streaming、Stop、history 回填、portable mode。

---



## 🟡 中优先



### 6. 并行护栏（agent 跑着时的 tsc watcher）

**做什么：** Codex 跑的同时开 tsc watch，不只在 checkpoint 后才查错；实时标错、不堵主流程。  
**为什么：** OpenAI SDK 把 guardrail 和 agent 并行跑——发现问题但不阻塞主链路。  
**落点：** 在 `agent-runner.ts` 旁拉起新进程  
**模式来源：** OpenAI Agents SDK — "Guardrails"

### 7. Checkpoint 拒绝时回滚

**做什么：** checkpoint 被拒时自动回到任务前 git 状态，不要把脏代码留在树上。  
**为什么：** 现在拒绝后坏代码会留给下一个 agent。  
**落点：** `src/server/git-ops.ts` — 增加 `revertToCheckpoint()`

### 8. 上下文感知的工具选择

**做什么：** 按文件大小、任务类型、上下文选不同工具。大重构 → Codex；小手术 → Claude ACP session；调研 → 带 web search 的 Claude。  
**模式来源：** Anthropic Skills — "Context-aware tool selection"

---



## 🔵 低优先（企业 / 规模）



### 9. 把会话持久化暴露给 Agent

**做什么：** 每个任务开始时把上一轮上下文（什么成了、什么挂了、git 历史）塞进 agent。现在即使重跑也经常从盲状态起步。  
**落点：** 更新 adapter `buildPrompt()`，从 SQLite 带入 run history

### 10. Agent Prompt 的渐进式 Skill 加载

**做什么：** 系统提示用 Anthropic 三级渐进披露——最小 header 常驻，完整说明仅在触发时加载，参考文档按需。  
**为什么：** 多 agent 并行时保持上下文精简。  
**模式来源：** Anthropic Skills Guide — 核心架构

### 11. Skills 市场 / Agent Skill 定义

**做什么：** 把 agent「技能」做成可移植的 SKILL.md 风格文件，可共享、可版本、可替换。例如「React Builder」vs「Python API Builder」。  
**模式来源：** Anthropic agentskills.io 开放标准

---



## 汇总表


| 功能                            | 影响   | 工作量 | 优先建议                 |
| ----------------------------- | ---- | --- | -------------------- |
| 迭代精炼循环                        | 🔥 高 | 低   | 先做                   |
| Agent Handoff                 | 🔥 高 | 中   | 其次                   |
| 专用 Agent 角色                   | 🔥 高 | 高   | 第三                   |
| Chat Phase C（bridge → Engine） | 🔥 高 | 高   | 与 Chat UX 同源；A/B 已完成 |
| Chat Phase D（UI 只订 Engine）    | 🔥 高 | 中–高 | **阻塞于 C**            |
| 并行护栏                          | 中    | 中   | 角色之后                 |
| 拒绝时回滚                         | 中    | 低   | 角色之后                 |
| 上下文感知工具选择                     | 中    | 高   | 更晚                   |
| 会话持久化暴露                       | 低    | 低   | 更晚                   |
| 渐进式 Skill 加载                  | 低    | 中   | 更晚                   |
| Skills 市场                     | 低    | 高   | 很晚                   |


