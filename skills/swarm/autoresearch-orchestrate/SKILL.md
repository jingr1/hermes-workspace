---
name: autoresearch-orchestrate
description: Hermes orchestrator — draft/validate autoresearch contracts, greenlight, dispatch executor (architect|developer). Ported from uditgoenka/autoresearch orchestrator mode.
version: 2.2.1-hermes
author: Hermes Workspace (adapted from uditgoenka/autoresearch)
metadata:
  hermes:
    tags: [swarm, orchestrator, autoresearch, dispatch]
    category: swarm
---

# Autoresearch Orchestrate (Hermes)

**Mode:** `orchestrator:autoresearch-dispatch`. Announce: "Using autoresearch-orchestrate mode."

Orchestrator owns **contract + greenlight + dispatch**. Executors (`architect:autoresearch`, `developer:autoresearch`) run the classic metric loop only after dispatch.

Reference: `docs/swarm/AUTORESEARCH.md`, routing table in `references/orchestrator-routing.md` (from [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch)).

## Safety invariants

- Never push, publish, merge, or deploy without explicit human greenlight.
- Bounded by default; override only when contract sets `iterations: unlimited` and greenlight approves.
- Screen every `verify` / `guard` shell command before pinning into the contract (no `rm -rf`, fork bombs, `curl|sh`, credential exfil).
- Predicate pinned in contract — do not re-derive mid-run.

## Dispatch flow

1. **Intake** — goal from user, researcher fact sheet, or architect spec. Classify archetype (see `references/orchestrator-routing.md`).
2. **Plan** — load `autoresearch-plan` to derive or validate: scope, metric, direction, verify, guard, iterations, results_log, rollback.
3. **Choose executor** — set `executor` on contract:
   - `developer` — code, tests, build artifacts, scripts, configs in repo
   - `architect` — specs, skills, prompts, routing hints, interface docs (no application code)
4. **Greenlight** — confirm all required fields + budget; pause at Human Gate if `long-running-loop` or publish/merge scope.
5. **Dispatch** — via `workspace-dispatch` or delegation:
   - `developer:autoresearch chat -q` with full contract block
   - `architect:autoresearch chat -q` with full contract block
6. **Monitor** — read executor TSV checkpoint; on `BLOCKED` re-route or escalate; on `DONE` hand to architect review (if developer executed) then learning.

## Required contract fields

`goal`, `scope`, `mutable_target`, `locked_eval`, `metric`, `direction`, `verify`, `guard`, `iterations`, `results_log`, `rollback`, `greenlight`, **`executor`** (`architect` | `developer`)

## Checkpoint contract

```text
STATE: DISPATCHED | MONITORING | DONE | BLOCKED | NEEDS_GREENLIGHT
CONTRACT: path to contract.yaml
EXECUTOR: architect | developer
RESULT: TSV summary or blocker
NEXT_ACTION: ...
```

## Do not

- Run the modify/verify/keep loop yourself (executor only)
- Assign autoresearch to `researcher` (facts only)
