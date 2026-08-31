# Swarm RADW 任务排障记录（2026-08-23）

本文档记录 mission `lg-mt5n77h6`（CLT + ICAP 自主学习系统调研 → 架构 → 开发 → 写作）执行过程中遇到的问题、根因与解决方案，供后续复现与规避参考。

**工作流：** `hermes_langgraph_orchestrator/workflows/radw.yaml`（Research → Architect → Developer → Writer）

**Mission ID：** `lg-mt5n77h6`

**产出目录（canonical，2026-08-23 起）：**

| Worker | 路径 |
|--------|------|
| Researcher | `memory/swarm/missions/<missionId>/researcher/` |
| Architect | `memory/swarm/missions/<missionId>/architect/` |
| Developer | `memory/swarm/missions/<missionId>/developer/` |

> 本次 incident 发生时 worker 仍写入旧路径 `output/<worker>/`（磁盘文件已保留）；新 mission 须使用上表路径。

---

## 1. 手机远程语音输入（STT）

### 现象

- Android 浏览器报 `Speech recognition blocked`
- 配置 `stt.provider: local` 后，前端仍尝试走 Web Speech API，而非 Mac 本地 Whisper

### 根因

- `local` provider 未被服务端识别为「远程转写」模式
- `/api/transcribe` 依赖 gateway `/api/config`，Tailscale 远程场景下配置读取失败

### 解决方案

| 文件 | 改动 |
|------|------|
| `src/server/stt-transcription.ts` | `local` 走 Mac 上 `faster-whisper`（`~/.hermes/hermes-agent/venv`） |
| `src/routes/api/transcribe.ts`、`stt-status.ts` | 直接读 `~/.hermes/config.yaml` |
| `chat-composer.tsx` | `useRemoteStt=true` 时用录音 + `/api/transcribe` |
| `use-voice-input.ts` | Android 保持麦克风流，改进 stop/重试 |

**推荐配置（`~/.hermes/config.yaml`）：**

```yaml
stt:
  provider: local
  language: zh
  local:
    model: base
    language: zh
```

**行为：** 手机点麦录音 → 再点停止 → Mac Whisper 批处理转写（非实时出字）。

---

## 2. Swarm tmux 任务投递失败

### 现象

```
paste-buffer failed: no buffer swarm-bp-...
```

Workspace 在 tmux 内跑 `pnpm start` 时，worker 收不到派发内容。

### 根因

子进程继承了宿主 tmux 的 `TMUX` / `TMUX_PANE` 环境变量，paste-buffer 写入了错误的 tmux server，buffer 在目标 session 中不可见。

### 解决方案

`src/server/swarm-tmux-delivery.ts`：

- 投递前清除 `TMUX`、`TMUX_PANE`
- paste 失败时自动重试一次

**注意：** 修改后需 `pnpm build &&` 重启 `pnpm start`（生产模式读 `dist/`）。

---

## 3. Worker import 错误（旧代码未加载）

### 现象

```
EXECUTION_GUIDANCE_MODELS import error
```

### 根因

各 worker 的 tmux session 在 `git pull` / `pip install -e .` 之前启动，仍加载旧版 hermes-agent。

### 解决方案

**自动（推荐）：** Workspace 更新 Hermes Agent 后会自动执行：

1. `venv/bin/pip install -e .`（重装 Python 包）
2. `scripts/sync-swarm-profiles.mjs`（同步 wrapper / profile）
3. 重启所有活跃的 `swarm-*` tmux session（`POST /api/update/agent` 内置）

也可手动触发：

```bash
curl -X POST http://127.0.0.1:3000/api/swarm-tmux-restart-active \
  -H 'Content-Type: application/json' -d '{}'
```

**手动（旧流程）：**

```bash
cd ~/.hermes/hermes-agent && git pull && venv/bin/pip3 install -e .

curl -X POST http://127.0.0.1:3000/api/swarm-tmux-stop  -d '{"workerId":"researcher"}'
curl -X POST http://127.0.0.1:3000/api/swarm-tmux-start -d '{"workerId":"researcher"}'
# architect / developer / writer 同理
```

---

## 4. Researcher「完成」但无新产出

### 现象

- Checkpoint 显示 `STATE: DONE`，`filesChanged: none`
- `memory/swarm/missions/<missionId>/researcher/`（当时为 `output/researcher/`）下只有 8/22 旧文件，无本次日期新稿

### 根因

Researcher 仅复述派发内容或验证旧稿，未真正写入新文件；或 orchestrator 误将旧 handoff 当作本次结果。

### 解决方案（操作层）

1. **新建 mission**，避免沿用脏状态 mission（如 `lg-mt56nhlz`）
2. 在 `missionGoal` 中明确要求：
   - 勿复用旧稿
   - 新文件须含当日日期
   - 须有外部来源引用
3. 验收：`ls -lt memory/swarm/missions/<missionId>/researcher/` 时间戳须为本次运行

**本次成功产出（当时路径）：** `output/researcher/ai-companion-self-directed-learning-clt-icap-2026-08-23.md`（约 21 KB，297 行，14 项引用）

---

## 5. Architect「卡住」— 实为误判完成（核心问题）

### 现象

| 观察 | 实际含义 |
|------|----------|
| Dashboard 显示 mission `reviewing` / 已完成 | Orchestrator 已 finalize |
| Architect tmux 显示 `ready` | Agent idle，并非在执行 |
| Checkpoint 内容为 M1 pytest 审查 | 误收了**旧 session** 的审查输出 |
| Developer 从未被派发 | 工作流在 architect 阶段被提前终止 |

### 时间线

```
researcher DONE（新报告写入）
    → architect 派发
    → 90 次轮询超时 → Human Gate（BLOCKED）
    → 人工选「重试 architect」
    → harvester 立即读到 tmux 中残留的 M1 审查 checkpoint
         （REVIEW_OUTCOME: approved + HARDEN_OUTCOME: pass）
    → 匹配 radw.yaml「Gate H pass → terminal」
    → mission 被错误标记为完成，developer/writer 被跳过
```

### 根因（两层）

#### 5.1 Assignment 状态机缺陷

`isTerminalAssignment()` 原先只把 `done`、`cancelled` 视为终态。

Architect 处于 `checkpointed` 时，重派**无法创建新 assignment**（同 worker 被认为仍有 active assignment）。Orchestrator wait 节点继续读**旧 assignment 上的 stale checkpoint**。

**修复（`src/server/swarm-missions.ts`）：**

```typescript
const TERMINAL_ASSIGNMENT_STATES = new Set([
  'done', 'cancelled',
  'checkpointed', 'blocked', 'needs_input',  // 新增
])
```

重派时为同一 worker 创建新 assignment，`checkpoint: null`，不再继承旧结果。

#### 5.2 Gate H 路由误匹配

`radw.yaml` 中「Gate H pass」规则要求 `REVIEW_OUTCOME=approved` + `HARDEN_OUTCOME=pass`。

初始 **architect 设计阶段**不应带这些字段，但 tmux 历史输出中残留了上次 developer 审查的 checkpoint，classifier 将其匹配为 Gate H 通过 → 直接 `to: null`（mission complete）。

**修复（`hermes_langgraph_orchestrator/workflow.py`）：**

在 developer/writer **尚未运行**时，忽略 architect checkpoint 上的 `review_outcome` / `harden_outcome`：

```python
if (
    classification.worker_id == "architect"
    and classification.verdict == "DONE"
    and "developer" not in dispatched_workers
    and "writer" not in dispatched_workers
):
    classification.review_outcome = ""
    classification.metadata.pop("harden_outcome", None)
```

**辅助修复（`nodes.py`）：** 若 checkpoint 含 `DELIVERABLE_TYPE`（设计阶段标记），不解析 Gate H 字段。

---

## 6. 恢复流程（从 architect 续跑）

修复代码并 `pnpm build` 重启服务后：

```bash
# 1. 重启 architect（清空 tmux 上下文）
curl -X POST http://127.0.0.1:3000/api/swarm-tmux-stop  \
  -H 'Content-Type: application/json' -d '{"workerId":"architect"}'
curl -X POST http://127.0.0.1:3000/api/swarm-tmux-start \
  -H 'Content-Type: application/json' -d '{"workerId":"architect"}'

# 2. 从 architect 续跑（复用 mission id，跳过 researcher）
curl -X POST http://127.0.0.1:3000/api/swarm-langgraph/run \
  -H 'Content-Type: application/json' \
  -d '{
    "missionId": "lg-mt5n77h6",
    "workflowId": "hermes_langgraph_orchestrator/workflows/radw.yaml",
    "initialWorkers": "architect",
    "missionGoal": "基于 memory/swarm/missions/lg-mt5n77h6/researcher/ai-companion-self-directed-learning-clt-icap-2026-08-23.md 撰写架构设计，写入 memory/swarm/missions/lg-mt5n77h6/architect/（文件名含 2026-08-23），checkpoint 末尾含 DELIVERABLE_TYPE: code，不要写 REVIEW_OUTCOME/HARDEN_OUTCOME"
  }'
```

**验收新 assignment：**

```bash
curl -s 'http://127.0.0.1:3000/api/swarm-missions?id=lg-mt5n77h6' | jq \
  '.mission.assignments[] | select(.workerId=="architect") | {id, state, checkpoint}'
```

- 应出现**新** assignment id（如 `assign-mt5of9gn-...`）
- `state: dispatched`，`checkpoint: null`
- Architect runtime：`checkpointStatus: in_progress`，`checkpointRaw: null`

---

## 7. 监控与排障命令

```bash
# Worker 实时输出
tmux attach -t swarm-researcher
tmux attach -t swarm-architect

# Mission 状态
curl -s 'http://127.0.0.1:3000/api/swarm-missions?id=lg-mt5n77h6' | jq '.mission | {id, state, assignments}'

# LangGraph 日志
tail -f ~/.hermes/logs/langgraph-lg-mt5n77h6.log

# 执行详情
ls -lt hermes-workspace/logs/execute_lg-mt5n77h6_*.json | head -3

# Human Gate 恢复
curl -X POST http://127.0.0.1:3000/api/swarm-langgraph/resume \
  -H 'Content-Type: application/json' \
  -d '{"missionId":"lg-mt5n77h6","action":"approved","choice":"primary","targetWorkerId":"architect"}'
```

---

## 8. 经验总结与检查清单

### 派发前

- [ ] `pnpm build` 后重启 `pnpm start`（tmux 修复、mission 修复需进 dist）
- [ ] hermes-agent 已 `git pull && pip install -e .`
- [ ] 各 worker tmux 已重启
- [ ] 复杂任务优先**新建 mission id**，避免脏 checkpoint

### 验收 worker 产出

- [ ] 检查 `memory/swarm/missions/<missionId>/<worker>/` 文件**修改时间**是否为本次运行
- [ ] Checkpoint `filesChanged` 指向新文件，而非 `none` 或旧路径
- [ ] Architect 设计阶段 checkpoint 应含 `DELIVERABLE_TYPE`，**不应**含 `REVIEW_OUTCOME` / `HARDEN_OUTCOME`

### 识别「假完成」

| 信号 | 含义 |
|------|------|
| Architect `ready` 但无新 `memory/swarm/missions/<missionId>/architect/` 文件 | 可能误收 stale checkpoint |
| Checkpoint 提及 M1 pytest / 旧 mission 内容 | 历史输出被 harvest |
| LangGraph log：`Gate H pass — mission complete` 但 developer 未派发 | 路由误匹配，需按 §6 恢复 |
| Mission `reviewing` 且仅 researcher + architect 有 assignment | 链路未走完 RADW 全流程 |

### Architect checkpoint 格式（设计阶段）

```
STATE: DONE
FILES_CHANGED: memory/swarm/missions/<missionId>/architect/<name>-2026-08-23.md
COMMANDS_RUN: none
RESULT: ...
BLOCKER: none
NEXT_ACTION: 建议派 developer 实现 M1
DELIVERABLE_TYPE: code
```

### Architect checkpoint 格式（审查阶段，developer 交付后）

```
STATE: DONE
...
REVIEW_OUTCOME: approved | changes_requested
HARDEN_OUTCOME: pass | fail
HARDEN_CHECKLIST:
- [x] files_exist
...
```

---

## 9. 相关代码变更索引

| 文件 | 变更说明 |
|------|----------|
| `src/server/swarm-missions.ts` | `checkpointed` 等状态视为 dispatch 终态 |
| `hermes_langgraph_orchestrator/workflow.py` | 初始 architect 阶段忽略 Gate H 字段 |
| `hermes_langgraph_orchestrator/nodes.py` | 设计阶段（含 DELIVERABLE_TYPE）不解析 harden |
| `src/server/swarm-tmux-delivery.ts` | 清除 TMUX 环境、paste 重试 |
| `src/server/swarm-tmux-restart.ts` | Agent 更新后自动重启活跃 swarm tmux |
| `src/server/update-system.ts` | Agent 更新后 pip install + sync profiles + worker restart |

---

## 10. 参考

- 工作流定义：`hermes_langgraph_orchestrator/workflows/radw.yaml`
- Swarm 派发：`docs/swarm/DISPATCH-GUIDE.md`
- Handoff 协议：`docs/swarm/HANDOFF-PROTOCOL.md`
- 通用排障：`docs/troubleshooting.md`
