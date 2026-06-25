# Swarm 共享记忆布局

工作区内 Swarm 产物的分层约定。与 `docs/swarm2-memory-framework-spec.md` 互补：该 spec 定义 worker profile 本地记忆；本目录定义**跨 worker、可 grep 的共享产物**。

## 三层结构

```
memory/
├── handoffs/swarm/              # 协作总线：仅 *-latest.{md,json}（最新 checkpoint 指针）
└── swarm/
    ├── missions/<missionId>/    # 任务归档（canonical，按 mission 收拢）
    │   ├── manifest.json        # 产物索引 + 状态
    │   ├── researcher/
    │   ├── architect/
    │   ├── learning/
    │   └── developer/
    ├── <worker>/                # 进行中的草稿（missionId 未知或尚未归档时）
    └── orchestrator/            # autoresearch 合约等编排产物
```

## 生命周期

| 阶段 | 写入位置 | 说明 |
|------|----------|------|
| 进行中 | `memory/swarm/missions/<missionId>/<worker>/` 或 `memory/swarm/<worker>/` | 有 missionId 时优先写入 missions 子目录 |
| Mission 完成 | 保持在 `missions/<missionId>/`，更新 `manifest.json` | `status`: `active` → `archived` |
| 可复用知识 | `~/wiki`（经 learning + `llm-wiki`） | 只沉淀结论摘要，不复制整份 spec |
| 协作状态 | `memory/handoffs/swarm/<worker>-latest.*` | 仅最新指针；历史写入 mission `events.jsonl`（未来） |

## Brain-first 检索顺序

1. `memory/swarm/missions/<missionId>/manifest.json`
2. `memory/handoffs/swarm/*-latest.*`
3. `grep -r` 于 `memory/swarm/missions/`
4. `~/wiki`（`llm-wiki`）

## 已归档 Mission

| missionId | 标题 | 路径 |
|-----------|------|------|
| `research-vmc-1782283462` | 世界模型 VMC / WMPC | [missions/research-vmc-1782283462/](missions/research-vmc-1782283462/) |
