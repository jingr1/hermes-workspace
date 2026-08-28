# Swarm Model 配置统一化

> **状态：已落地**。Swarm 编排模型以 `swarm.yaml` 为准，**运行时注入**；profile `config.yaml` 的 `model` 段由 **Settings** 管理（Web Chat / 日常默认）。文档勿硬编码具体 model id。

## 背景问题（已解决）

原先存在多套模型信息源，且 dispatch 会把 `swarm.yaml` 的 model **写进** profile `config.yaml`，与 Settings / Web Chat 抢真源：

| 源  | 位置                                  | 现状                                                                                       |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `~/.hermes/profiles/<id>/config.yaml` | **日常默认模型**（Settings）；provider 定义见 [provider-catalog.md](./provider-catalog.md) |
| 2   | `swarm.yaml`                          | **Swarm 编排模型**（`provider/model-id`）；仅写 roster，不改 config                        |
| 3   | `swarm-runtime-model.ts`              | dispatch / tmux-start **运行时注入**（`HERMES_MODEL` / `chat -q --model`）                 |
| 4   | `swarm-model-resolver.ts`             | 解析 `provider/model-id`；硬编码翻译表已删除                                               |
| 5   | `operational-worker-card.tsx`         | 从 `/api/models` 动态读取；保存时 PATCH `swarm.yaml`                                       |

## 目标

1. `swarm.yaml` 的 `model` 使用 `provider/model-id` 格式
2. Swarm dispatch **不修改** profile `config.yaml`
3. UI 下拉框从 `/api/models` 读取，选中后只写 `swarm.yaml`
4. 新增 provider 只需改 `config.yaml`，UI 自动出现新模型

## 实现状态

| 项                        | 状态      | 说明                                                                                       |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `swarm-model-resolver.ts` | ✅        | `parseSwarmModelLabel` + `toSwarmModelKey` / `resolveSwarmModelKey`                        |
| `swarm-runtime-model.ts`  | ✅        | `resolveWorkerRuntimeModel` / `buildSwarmModelEnvAssignments` / `buildHermesChatQueryArgs` |
| `swarm-tmux-start.ts`     | ✅        | tmux 启动时注入 `HERMES_MODEL` + provider env                                              |
| `swarm-dispatch.ts`       | ✅        | tmux-cli / oneshot 传 `--model` + `--provider`；tmux-tui 启动时注入 env                    |
| `PATCH /api/swarm-roster` | ✅        | 仅写 `swarm.yaml`（dev / prod 一致）                                                       |
| `syncSwarmProfileModel`   | 🗑️ 已删除 | 不再把 roster model 写入 config                                                            |
| `sync-swarm-profiles.mjs` | ✅        | 同步 toolsets / SOUL / IDENTITY / skills；**不写 model**                                   |

### `swarm.yaml` 模型格式

```yaml
model: moonshot-coding-plan/kimi-for-coding
model: deepseek/deepseek-v4-flash
model: custom:my-gateway/some-model-id   # provider 可含冒号
```

## 核心模块

### 1. `parseSwarmModelLabel` — roster 解析

文件：`src/server/swarm-model-resolver.ts`

按**第一个 `/`** 拆分：

```typescript
export function parseSwarmModelLabel(
  label: string | null | undefined,
): ResolvedSwarmModel | null {
  if (!label) return null
  const trimmed = label.trim()
  if (!trimmed) return null
  const slashIdx = trimmed.indexOf('/')
  if (slashIdx <= 0) return null
  return {
    provider: trimmed.slice(0, slashIdx),
    default: trimmed.slice(slashIdx + 1),
  }
}
```

### 2. `swarm-runtime-model.ts` — 运行时注入（不写 config）

| 场景                        | 机制                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| tmux-tui 启动               | `HERMES_MODEL` / `HERMES_INFERENCE_MODEL` + `HERMES_TUI_PROVIDER` |
| tmux-cli / oneshot dispatch | `hermes chat -q ... --model <id> --provider <provider>`           |
| 无 roster model             | 回退 profile `config.yaml` 默认（Settings）                       |

### 3. UI — 动态下拉 + 持久化

- 下拉：`availableModels` → `swarmModelKeyFromOption(m)`
- 保存：`PATCH /api/swarm-roster` → 只更新 `swarm.yaml`
- 显示：`resolveSwarmModelKey` / `formatAssignedModel`

### 4. `PATCH /api/swarm-roster`

```typescript
PATCH: async ({ request }) => {
  const { workerId, patch } = await request.json()
  const roster = patchSwarmRosterWorker(workerId, patch, ids)
  return json({ ok: true, roster, savedAt: Date.now() })
}
```

Dev 与 prod 均**只**写 `swarm.yaml`；不再同步 profile `config.yaml`。

## 数据流

```
Settings (config.yaml)              swarm.yaml                    运行时
────────────────────                ──────────                    ──────
profile model.provider/default      workers[].model               tmux-start:
  ↑ Web Chat 默认                     provider/model-id              HERMES_MODEL=...
  ↑ Providers 屏保存                  PATCH roster 写入              dispatch:
                                                                      chat -q --model ...

parseSwarmModelLabel(swarm.yaml)
        ↓
resolveWorkerRuntimeModel(workerId)
        ↓
注入 env / CLI flags（不写 config.yaml）
```

## 新增模型流程

```
① 在 Settings / config.yaml 配置 provider（若尚未存在）
② 在 Swarm Compose UI 选择模型 → PATCH 写入 swarm.yaml
③ 重启 worker tmux session（或等下次 dispatch）使运行时注入生效
✅ 无需改 TypeScript、无需写 profile config 的 model 段
```

## 模型真源分工

| 用途                        | 真源                                | 生效方式                                  |
| --------------------------- | ----------------------------------- | ----------------------------------------- |
| Web Chat / 日常聊天         | profile `config.yaml`               | Settings；每 session 可 localStorage 覆盖 |
| Swarm mission / tmux worker | `swarm.yaml`                        | `swarm-runtime-model` 运行时注入          |
| Provider 凭证与列表         | `config.yaml` `providers:` + `.env` | Settings                                  |

## 遗留改进（可选）

1. **tmux session 模型热更新**：roster 改 model 后，已运行的 tmux 需重启才换模型（可检测 mismatch 自动 recreate）
2. **合并 `formatAssignedModel`**：`swarm2-screen.tsx` 与 `resolveSwarmModelKey` 显示一致化
3. **Electron bundle**：`pnpm electron:bundle-server` 重建 `server-bundle.cjs`

## 相关文件

| 文件                                 | 职责                                              |
| ------------------------------------ | ------------------------------------------------- |
| `src/server/swarm-model-resolver.ts` | 解析 + key 构建                                   |
| `src/server/swarm-runtime-model.ts`  | 运行时 model 注入                                 |
| `src/server/swarm-tmux-delivery.ts`  | tmux 启动命令 + env                               |
| `src/routes/api/swarm-roster.ts`     | GET / POST / PATCH roster                         |
| `src/routes/api/swarm-dispatch.ts`   | dispatch + tmux session                           |
| `src/routes/api/swarm-tmux-start.ts` | 手动启动 worker tmux                              |
| `src/routes/api/models.ts`           | 模型列表 API                                      |
| `scripts/sync-swarm-profiles.mjs`    | toolsets / SOUL / IDENTITY / skills（不含 model） |
| `swarm.yaml`                         | Swarm roster 源文件                               |
