# Escalation Guide for All Agents

When 3 rounds of challenge-response fail to resolve a dispute on the canonical pipeline:

```text
orchestrator → researcher → architect → (developer | writer) → architect(review) → learning
```

See also [HANDOFF-PROTOCOL.md](./HANDOFF-PROTOCOL.md). Human Gate UI/API: `AGENTS.md` (LangGraph Phase 2).

## When to Escalate

- 3 rounds of challenge/response still unresolved
- A **blocking** known-unknown prevents a valid downstream checkpoint
- Greenlight-bound action needs an explicit human decision

## Escalation Flow

```text
Round 1: Downstream Challenge
    ↓
Round 2: Upstream Response
    ↓
Round 3: Final Challenge or Final Response
    ↓
Still unresolved?
    ↓
YES → Escalation File → Notify Orchestrator → STOP WORK
    ↓
Orchestrator → Inbox / Human Gate → User decides
    ↓
Decision recorded → Workers notified → Continue
```

## Escalation File Format

Save to: `output/{downstream-role}/escalations/{topic}-{id}.md`

Valid roles: `architect`, `developer`, `writer`, `learning` (rare), or `orchestrator`.

```markdown
# Escalation: [Topic]

## 争议双方
- **挑战方**: [downstream]
- **被挑战方**: [upstream]

## 争议内容
- **原始交付**: [link]
- **Challenge 文件**: [link]
- **Response 文件**: [link]

## 3 轮回顾
### Round 1
- 挑战: ...
- 回应: ...

### Round 2
- 挑战: ...
- 回应: ...

### Round 3
- 挑战: ...
- 回应: ...

## 核心分歧
[一句话]

## 对下游工作的影响
[...]

## 建议的决策选项
1. [接受上游]
2. [接受下游]
3. [折中]

---
**需要人工决策**
```

## After Human Decision

```markdown
# Decision Record: [Escalation ID]

## Decision
...

## Rationale
...

## Action Items
- [Upstream]: ...
- [Downstream]: ...

## Recorded By
Orchestrator at [timestamp]
```

Resume paths (unchanged):

- Dashboard `/swarm2` Human Gate
- `python -m hermes_langgraph_orchestrator --execute --resume approved|abort --mission-id <id>`
- `POST /api/orchestrator-resume` with `{ missionId, action }`

## Rules

1. **STOP work** after creating escalation — no assumption-driven progress
2. **Notify Orchestrator** explicitly
3. **Record the decision**
4. **Update deliverables** after resume
5. Role boundaries still hold (researcher≠strategy, developer≠architecture, writer≠facts)
