# Swarm Handoff Protocol

Canonical pipeline (main roster + fused challenge/escalation rules from `feature/mychange`):

```text
orchestrator → researcher → architect → (developer | writer) → architect(review) → learning
```

Dispatch: `POST /api/swarm-dispatch` — see [DISPATCH-GUIDE.md](./DISPATCH-GUIDE.md).

Related: [ESCALATION-GUIDE.md](./ESCALATION-GUIDE.md) · [LEARNING-WIKI-INGEST.md](./LEARNING-WIKI-INGEST.md) · [AUTORESEARCH-GUIDE.md](./AUTORESEARCH-GUIDE.md)

---

## 协作原则

1. **Orchestrator** — 分解、路由、greenlight、续跑；不写事实/架构/产品代码。
2. **Researcher** — 只输出事实与来源；不做策略判断。
3. **Architect** — 方向决策（wedge / bets / kill criteria）+ 技术/内容规格；选定 **唯一** `executor: developer | writer`；审查该 executor 产出。不采集一手事实、不写应用代码/成稿（autoresearch 契约内除外）。
4. **Developer** — 仅在 `executor: developer` 时实现与验证代码；不改架构。
5. **Writer** — 仅在 `executor: writer` 时产出受众向内容/视觉交付；不改架构、不改已确立事实。
6. **Learning** — 复盘与 wiki 摄入；不重做调研/设计/实现。
7. 下游可质疑上游；质疑-回应最多 **3 轮**。
8. 3 轮未决 → 已知未知 → [ESCALATION-GUIDE.md](./ESCALATION-GUIDE.md) → 人工决策。

**Executor lane rule:** 同一步 mission **互斥** 选择 developer 或 writer，不双轨并行。若既要代码又要内容，由 architect 排序（通常 developer → writer），每步重新声明 `executor`。

---

## 链路概览

```text
                 Orchestrator
                      │
                      ▼
                 Researcher
                      │
                      ▼
                  Architect
            (strategy + spec + executor)
                 /              \
      executor:developer   executor:writer
               │                  │
           Developer           Writer
               \                  /
                └───────┬────────┘
                        ▼
              Architect (review)
                        │
                        ▼
                    Learning
```

---

## 链路 0: Orchestrator

- 产出 SwarmBrief / assignments（经 dispatch 或 LangGraph）
- 管 greenlight 与 Human Gate
- 不落事实报告或技术规格正文

---

## 链路 1: Researcher → Architect

**输出:** `output/researcher/{topic}-report.md`

```markdown
# Research Report: [Topic]

## Executive Summary
- Research question / Confidence / Key unknowns

## Facts Established
- **Fact** / **Source** / **Verification** / **Confidence** / **Limitations**

## Claims Requiring Validation
## Sources
## Data Quality Assessment

---
**Researcher checkpoint**: Facts only. No strategic recommendations.
```

Checklist: 有来源 · 置信度 · **无策略建议** · 矛盾已标出。

Architect **必须**做决策与规格转化，不得原样转发事实报告。

---

## 链路 2: Architect → 唯一 executor

分支策略里的 Strategist + Designer 合入 **architect**（不新增 profile）。

**输出（可分文件或分章节）:**

- `output/architect/{topic}-strategy.md` — wedge / assumptions / kill criteria
- `output/architect/{topic}-spec.md` — 给 developer 的技术规格（当 `executor: developer`）
- `output/architect/{topic}-content-brief.md` — 给 writer 的内容规格（当 `executor: writer`）

### Strategy 骨架

Problem Framing · Recommended Wedge · Assumption Stack · Kill Criteria · Phased Milestones · Known Unknowns · Risks

### Spec 骨架（developer）

Architecture · Data Model / API · Module Breakdown · Tech Stack · Implementation Order · Testing · Open Questions

### Content brief 骨架（writer）

Audience & Intent · Tone/Brand/A11y · Deliverable types · Structure · Must-cite facts · Out of scope

Checklist: 事实可追溯 · bet 有 kill criterion · 规格可执行 · **声明 `executor`** · 无应用代码 · 无最终成稿。

---

## 链路 3a: Developer → Architect (review)

仅当 `executor: developer`。

- 输出: `output/developer/{topic}-*`
- Checkpoint: STATE / FILES_CHANGED / COMMANDS_RUN / RESULT / BLOCKER / NEXT_ACTION + 测试/browser proof
- 规格缺口 → challenge architect，不改架构
- Architect 审 design-intent fidelity

---

## 链路 3b: Writer → Architect (review)

仅当 `executor: writer`。

- 输出: `output/writer/{topic}-*`
- 事实只引用不改义；事实错误经 architect 退回 researcher
- Architect 审 audience-intent；publish / external-send 走 greenlight

---

## 链路 4: → Learning

输入 mission 产物 + `memory/swarm/missions/<missionId>/manifest.json`。

1. 复盘教训与决策摘要  
2. `learning-wiki-ingest` → `$WIKI_PATH`（见 [LEARNING-WIKI-INGEST.md](./LEARNING-WIKI-INGEST.md)）  
3. 复制归档，不移动  

禁止重做调研/架构/代码/对外成稿。

---

## 质疑路径

| 下游 | 上游 | 路径 |
|------|------|------|
| Architect | Researcher | `output/architect/challenges/{id}.md` |
| Developer | Architect | `output/developer/challenges/{id}.md` |
| Writer | Architect | `output/writer/challenges/{id}.md` |
| Learning | Architect / Orchestrator | `output/learning/challenges/{id}.md` |

Challenge / Response 模板与 3 轮升级见 [ESCALATION-GUIDE.md](./ESCALATION-GUIDE.md)。

---

## Autoresearch 旁路

`architect:autoresearch` / `developer:autoresearch` / `writer:autoresearch` 由 Orchestrator 按 [AUTORESEARCH-GUIDE.md](./AUTORESEARCH-GUIDE.md) 派发，不替代主链路顺序；角色禁止项仍然生效。
