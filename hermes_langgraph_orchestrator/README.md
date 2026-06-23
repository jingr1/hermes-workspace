# Hermes LangGraph Swarm Orchestrator

LangGraph 作为 Hermes Swarm 的**确定性编排大脑**：加载 workflow.yaml → 校验 roster → 派发 worker → 等待 checkpoint → 路由到下一个 worker，支持人工门控与 resume。

---

## 目录

- [环境准备](#环境准备)
- [重启 Workspace](#重启-workspace)
- [执行任务派发与编排](#执行任务派发与编排)
  - [Phase 1：与 orchestrator-loop 对比](#phase-1与-orchestrator-loop-对比)
  - [Phase 2：真实编排](#phase-2真实编排)
  - [Phase 2：Mock 模式（无 API/无 worker）](#phase-2mock-模式无-api无-worker)
  - [从 human gate 恢复](#从-human-gate-恢复)
- [查看与 Attach tmux](#查看与-attach-tmux)
- [状态与日志](#状态与日志)
- [常见问题](#常见问题)

---

## 环境准备

```bash
cd /home/ramon.jing/hermes-workspace/hermes_langgraph_orchestrator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

> 如果系统已安装全部依赖，也可以直接用 `python3 -m hermes_langgraph_orchestrator ...`。
> 但 Phase 2 的 SQLite checkpointer 需要 `langgraph-checkpoint-sqlite`，建议用上面的 venv。

---

## 重启 Workspace

Workspace 必须运行在 `http://localhost:3000`，LangGraph orchestrator 通过它访问 roster、tmux、dispatch、mission 等 API。

### 1. 找到当前进程

```bash
lsof -i :3000
```

典型输出：

```text
COMMAND     PID       USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1990100 ramon.jing   37u  IPv4 ...    0t0      TCP *:3000 (LISTEN)
```

### 2. 停止并重启

**方法 A：在原终端里操作**

找到你之前运行 `pnpm dev` 的窗口，按 `Ctrl + C`，然后：

```bash
cd /home/ramon.jing/hermes-workspace
TMUX_BIN=/usr/bin/tmux pnpm dev
```

**方法 B：找不到原终端**

```bash
kill 1990100          # 把 PID 换成 lsof 看到的
# 确认端口释放
lsof -i :3000

# 重新启动
cd /home/ramon.jing/hermes-workspace
TMUX_BIN=/usr/bin/tmux pnpm dev
```

### 3. 验证 Workspace 已恢复

```bash
curl -s http://localhost:3000/api/swarm-roster | python3 -m json.tool
curl -s -X POST http://localhost:3000/api/swarm-tmux-start \
  -H 'Content-Type: application/json' \
  -d '{"workerId":"researcher"}' | python3 -m json.tool
```

如果 tmux 返回 `spawn /opt/homebrew/bin/tmux ENOENT`，说明 `TMUX_BIN` 没传对，按方法 B 重启。

---

## 执行任务派发与编排

所有命令都从仓库根目录执行。

```bash
cd /home/ramon.jing/hermes-workspace
```

### Phase 1：与 orchestrator-loop 对比

快速对比 LangGraph 路由 vs Hermes Swarm 规则引擎，**不真派发**。

```bash
# 全部 mock
hermes_langgraph_orchestrator/.venv/bin/python -m hermes_langgraph_orchestrator \
  --mock --scenario cdc

# 真实 LLM 分类 + mock checkpoint
hermes_langgraph_orchestrator/.venv/bin/python -m hermes_langgraph_orchestrator \
  --mock-collect --scenario cdc
```

### Phase 2：真实编排

会真实启动 tmux session（默认 `tmux-tui`）、派发任务、等待 checkpoint、自动路由。无需设置 `HERMES_SWARM_USE_LIVE`。

**推荐（TUI paste 不稳定时）**：在 `hermes-workspace/.env` 加 `HERMES_SWARM_TMUX_MODE=cli`，重启 `pnpm dev`。走 `tmux-cli`：session 长驻 bash，每次 dispatch 在 pane 里跑 `hermes chat -q`。

```bash
# .env
HERMES_SWARM_TMUX_MODE=cli
TMUX_BIN=/usr/bin/tmux
```

```bash
hermes_langgraph_orchestrator/.venv/bin/python -m hermes_langgraph_orchestrator \
  --execute --scenario cdc --mission-id cdc-real-001
```

流程示例：

```text
researcher DONE → architect DONE → developer BLOCKED → human gate
```

### Phase 2：Mock 模式（无 API/无 worker）

适合 CI 或没有启动 Workspace 时验证图结构。

```bash
hermes_langgraph_orchestrator/.venv/bin/python -m hermes_langgraph_orchestrator \
  --execute --mock-services --scenario cdc --mission-id cdc-mock-001
```

Mock CDC 场景会自动跑完：

```text
researcher → architect → developer(BLOCKED) → human gate
resume approved → developer DONE → architect approved → finalize
```

### 从 human gate 恢复

```bash
hermes_langgraph_orchestrator/.venv/bin/python -m hermes_langgraph_orchestrator \
  --execute --scenario cdc --mission-id cdc-real-001 --resume approved

# 或放弃当前 mission
hermes_langgraph_orchestrator/.venv/bin/python -m hermes_langgraph_orchestrator \
  --execute --scenario cdc --mission-id cdc-real-001 --resume abort
```

恢复依赖 SQLite checkpointer，默认路径 `~/.hermes/langgraph-checkpoints.db`。也可以用 `--checkpoint-path` 自定义。

### 常用 CLI 参数

| 参数 | 说明 |
|---|---|
| `--execute` | Phase 2 真实编排 |
| `--mock-services` | mock init/ensure/dispatch，不依赖 Workspace |
| `--scenario cdc` | CDC + 空簧场景（当前 5 worker roster） |
| `--scenario rate-limiter` | rate limiter 场景（旧 roster，用于 Phase 1） |
| `--mission-id <id>` | mission 标识，也是 LangGraph thread_id |
| `--goal "..."` | 自定义 mission goal |
| `--initial-workers researcher,architect` | 跳过 workflow entry，直接派发指定 worker |
| `--max-iterations 5` | 最大路由轮数 |
| `--workflow path/to.yaml` | 自定义 workflow YAML |
| `--checkpoint-path path.db` | 自定义 SQLite checkpointer |
| `--resume approved\|abort` | 从 human gate 恢复 |

---

## 查看与 Attach tmux

每个 worker 对应一个 tmux session：`swarm-<workerId>`。

### 查看有几个正在运行的 tmux

```bash
tmux ls
```

典型输出：

```text
swarm-researcher: 1 windows (created Fri Jun 12 13:06:12 2026) [80x24]
swarm-architect: 1 windows (created Fri Jun 12 13:08:45 2026) [80x24]
```

### Attach 到某个 worker 的 tmux

```bash
tmux attach -t swarm-researcher
```

Attach 后按 `Ctrl + B` 再按 `D` 可以** detach**（保持 session 后台运行）。

### 批量查看所有 swarm session

```bash
for s in $(tmux ls -F '#{session_name}' | grep '^swarm-'); do
  echo "=== $s ==="
  tmux capture-pane -p -t "$s" -S -20
done
```

### 结束某个 worker session

```bash
tmux kill-session -t swarm-researcher
```

或者通过 Workspace API：

```bash
curl -s -X POST http://localhost:3000/api/swarm-tmux-stop \
  -H 'Content-Type: application/json' \
  -d '{"workerId":"researcher"}' | python3 -m json.tool
```

---

## 状态与日志

### LangGraph 执行日志

```bash
ls logs/
# compare_<mission>_<timestamp>.json   # Phase 1
# execute_<mission>_<timestamp>.json   # Phase 2
```

### SQLite checkpointer

默认在 `~/.hermes/langgraph-checkpoints.db`，可以用 sqlite3 查看：

```bash
sqlite3 ~/.hermes/langgraph-checkpoints.db "SELECT thread_id, checkpoint_id FROM checkpoints ORDER BY checkpoint_id DESC LIMIT 10;"
```

### Mission 状态

```bash
curl -s "http://localhost:3000/api/swarm-missions?id=cdc-real-001" | python3 -m json.tool
```

---

## Tmux Worker 生命周期（Swarm2 Runtime）

| 步骤 | API | 行为 |
|------|-----|------|
| 创建 | `POST /api/swarm-tmux-start` | `tmux new-session -d -s swarm-<role> "<shell\|hermes --tui>"` |
| 分发 | `POST /api/swarm-dispatch` | `tmux send-keys` 注入任务（TUI paste 或 CLI `hermes chat -q`） |
| 交互 | `POST /api/swarm-tmux-scroll` | copy-mode 滚动；Runtime 通过 `capture-pane` 读输出 |
| 销毁 | `POST /api/swarm-tmux-stop` | `tmux kill-session` |

派发模式：

| 模式 | 环境变量 / `deliveryMode` | 创建 | 分发 |
|------|---------------------------|------|------|
| `tmux-tui` | 默认 | `hermes chat --tui` | paste SwarmBrief 进 TUI |
| `tmux-cli` | `HERMES_SWARM_TMUX_MODE=cli` | `bash -l` + Hermes env | `send-keys` 跑 `swarm-run.sh` |
| `oneshot` | `HERMES_SWARM_FORCE_ONESHOT=1` | 无 tmux | 直接 `hermes chat -q` |

---

## 常见问题

### 0. `Failed to fetch roster` / `Workspace timed out` / preflight failed

Phase 2 真实执行依赖 **Hermes Workspace**（`:3000`）。常见根因：

1. **`pnpm dev` 刚启动**：Vite 首次编译 SSR API 路由可能 **>5s**，旧版 preflight 会误报 timeout。现已自动重试最多 6 次（读超时 12s/次）。
2. **Workspace 未运行**：先 `pnpm dev`，等 Vite ready 后再跑 LangGraph。

```bash
cd hermes-workspace && pnpm dev
curl -s http://127.0.0.1:3000/api/swarm-roster | head
```

CLI 启动时会自动加载 `hermes-workspace/.env`（不覆盖已有环境变量）。若启用了 `HERMES_PASSWORD`，设置 `HERMES_WORKSPACE_TOKEN`。

CLI 会在 `--execute` 前做 preflight；也可手动指定 API 地址：`--swarm-url http://127.0.0.1:3000/api`。

### 1. `ensure_sessions researcher: error (Server error '500' ... ENOENT)`

Workspace 没找到 tmux。重启 Workspace 时带 `TMUX_BIN`：

```bash
TMUX_BIN=/usr/bin/tmux pnpm dev
```

### 2. `researcher=SKIP` 后进入 human gate

这发生在真实执行早期：dispatch 返回了 `IN_PROGRESS` checkpoint。当前版本已加入 `wait_for_checkpoints` 轮询，会等到 researcher 完成后再路由，不再误判为人工门控。

### 3. Phase 2 真实执行卡住/超时

- 检查 worker tmux 是否还在：`tmux ls`
- Attach 看 worker 在干嘛：`tmux attach -t swarm-researcher`
- 检查 mission 状态：`curl /api/swarm-missions?id=<missionId>`
- 如果 worker 长时间不产出 checkpoint，会超时进 human gate，可用 `--resume approved` 重试

### 4. 如何运行测试

```bash
hermes_langgraph_orchestrator/.venv/bin/python -m pytest tests/test_langgraph_orchestrator.py -v
```
