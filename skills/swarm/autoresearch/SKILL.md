---
name: autoresearch
description: Bounded optimization-loop contract and discipline — see docs/swarm/AUTORESEARCH.md.
version: 1.0.0
author: Hermes Workspace
metadata:
  hermes:
    tags: [swarm, autoresearch, optimization]
    category: swarm
---

# Autoresearch (Swarm)

Reference: `docs/swarm/AUTORESEARCH.md` in hermes-workspace.

```text
normal research     = gather evidence -> synthesize facts
autoresearch mode   = mutate one target -> verify metric -> keep/revert -> repeat
```

## When to use

Only when a **scalar metric** and **mechanical verify/guard commands** exist. If evaluation requires human judgment, stay in `researcher-quick`.

## Contract fields

Required before loop: goal, scope, mutable_target, locked_eval, metric, direction, verify, guard, iterations, results_log, rollback, greenlight.

## Roles

- `researcher:quick` drafts the contract
- `orchestrator` approves greenlight and budget
- `researcher:autoresearch` runs the loop
- `architect` reviews for metric hacking / scope creep
