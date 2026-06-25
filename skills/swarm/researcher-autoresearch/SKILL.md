---
name: researcher-autoresearch
description: Gated optimization loop — mutate one target, verify metric, keep/revert; requires full AUTORESEARCH contract.
version: 1.0.0
author: Hermes Workspace
metadata:
  hermes:
    tags: [swarm, researcher, autoresearch, optimization]
    category: swarm
---

# Researcher Autoresearch Mode

**Mode:** `researcher:autoresearch`. Announce: "Using researcher-autoresearch mode."

Use only when mechanical evaluation exists. Full contract: `docs/swarm/AUTORESEARCH.md`.

## Entry gate

Do not start unless **all** fields are explicit:

`goal`, `scope`, `mutable_target`, `locked_eval`, `metric`, `direction`, `verify`, `guard`, `iterations`, `results_log`, `rollback`, `greenlight`

If any field is missing → `STATE: BLOCKED` and request orchestrator to complete the contract.

## Iteration loop

1. Read prior `results_log` and git state
2. One small falsifiable change to `mutable_target` only
3. Run `verify` and `guard`
4. Keep if improved and guards pass; else revert
5. Append TSV log row; stop at iteration budget

## Prohibited

- Broad refactors outside `scope`
- Metric hacking or disabling guards
- Long-running / background loops without orchestrator greenlight
