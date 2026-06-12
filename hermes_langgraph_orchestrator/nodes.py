"""
LangGraph Orchestrator Nodes — Phase 1 对比模式 + Phase 2 执行模式

LangGraph 图结构编排:
  init → collect → classify (唯一 LLM 调用) → 纯函数路由表 → dispatch → ...

LLM 只做一件事: 把非结构化 checkpoint 文本 → 结构化分类
之后所有路由由图的边 + workflow.yaml 决定。
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from .state import (
    DispatchDecision,
    OrchestratorState,
    WorkerCheckpoint,
    WorkerClassification,
)
from .workflow import (
    WorkflowSpec,
    load_default_workflow,
    load_workflow,
    route_by_workflow,
    validate_workflow_against_roster,
)


# ============================================================
# LLM 配置 — DeepSeek V4 Pro Seed via nioint gateway
# ============================================================
def _get_llm() -> ChatOpenAI:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        hermes_env = os.path.expanduser("~/.hermes/.env")
        if os.path.exists(hermes_env):
            with open(hermes_env) as f:
                for line in f:
                    if "DEEPSEEK_API_KEY" in line:
                        api_key = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
                        break

    return ChatOpenAI(
        model="DeepSeek-V4-Pro-Seed",
        base_url="https://modelgateway.nioint.com/v1",
        api_key=api_key,
        temperature=0.1,
    )


# ============================================================
# Helpers
# ============================================================
def _swarm_api_url(state: OrchestratorState) -> str:
    return state.get("swarm_api_url", "http://localhost:3000/api")


def _parse_dispatch_checkpoints(data: dict[str, Any]) -> list[WorkerCheckpoint]:
    checkpoints: list[WorkerCheckpoint] = []
    for r in data.get("results", []):
        cp = r.get("checkpoint")
        if not cp:
            continue
        checkpoints.append(
            WorkerCheckpoint(
                worker_id=r.get("workerId") or "unknown",
                state=cp.get("stateLabel") or "IN_PROGRESS",
                result=cp.get("result") or "",
                files_changed=cp.get("filesChanged") or "",
                commands_run=cp.get("commandsRun") or "",
                blocker=cp.get("blocker") or "",
                next_action=cp.get("nextAction") or "",
                raw=cp.get("raw") or "",
            )
        )
    return checkpoints


def _active_assignments_to_workers(assignments: list[dict]) -> list[str]:
    return sorted({a.get("worker_id", "").strip() for a in assignments if a.get("worker_id")})


# ============================================================
# Node: init_mission — load roster + workflow, validate
# ============================================================
async def init_mission(state: OrchestratorState) -> dict:
    """Load workflow.yaml, fetch roster, validate, and seed initial assignments."""
    swarm_url = _swarm_api_url(state)

    # Load workflow from explicit path or default.
    workflow_spec: WorkflowSpec
    workflow_path = state.get("workflow_path")
    if workflow_path:
        try:
            workflow_spec = load_workflow(str(workflow_path))
        except Exception as e:
            return {
                "collection_error": f"Failed to load workflow {workflow_path}: {e}",
                "log_entries": [f"[init_mission] workflow load failed: {e}"],
            }
    else:
        workflow_spec = state.get("workflow_spec") or load_default_workflow()

    # Fetch roster. The Workspace API returns { ok: true, roster: SwarmRoster }
    # where SwarmRoster = { version, workers: [{ id, ... }] }.
    roster_ids: set[str] = set()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{swarm_url}/swarm-roster")
            resp.raise_for_status()
            data = resp.json()
            roster = data.get("roster", {})
            if isinstance(roster, dict):
                workers = roster.get("workers", [])
                if isinstance(workers, list):
                    roster_ids = {str(w.get("id", w.get("workerId", ""))).strip() for w in workers if w}
                else:
                    # Fallback: dict keyed by worker id
                    roster_ids = {k.strip() for k in roster.keys() if isinstance(k, str)}
            elif isinstance(roster, list):
                roster_ids = {str(w.get("id", w.get("workerId", ""))).strip() for w in roster if w}
    except Exception as e:
        return {
            "collection_error": f"Failed to fetch roster: {e}",
            "log_entries": [f"[init_mission] roster fetch failed: {e}"],
        }

    errors = validate_workflow_against_roster(workflow_spec, roster_ids)
    if errors:
        msg = "; ".join(errors)
        return {
            "collection_error": msg,
            "log_entries": [f"[init_mission] roster validation failed: {msg}"],
        }

    # Seed initial assignments from workflow entry if none provided.
    assignments = state.get("langgraph_assignments", []) or []
    if not assignments:
        entry = workflow_spec.entry
        if entry not in roster_ids:
            return {
                "collection_error": f"Entry worker '{entry}' not in roster",
                "log_entries": [f"[init_mission] entry worker '{entry}' missing from roster"],
            }
        assignments = [
            {
                "worker_id": entry,
                "task": state.get("mission_goal", ""),
                "reason": f"workflow entry: {entry}",
            }
        ]

    log(
        f"[init_mission] workflow={workflow_spec.name}, "
        f"roster={len(roster_ids)} workers, entry_assignments={len(assignments)}"
    )
    return {
        "roster_snapshot": sorted(roster_ids),
        "workflow_spec": workflow_spec,
        "terminal_docs_enabled": workflow_spec.settings.terminal_docs,
        "langgraph_assignments": assignments,
        "log_entries": [
            f"[init_mission] workflow={workflow_spec.name}, roster={len(roster_ids)} workers"
        ],
    }


# ============================================================
# Node: collect
# ============================================================
async def collect_checkpoints(state: OrchestratorState) -> dict:
    swarm_url = _swarm_api_url(state)
    mission_id = state.get("mission_id", "")
    log("[collect] 收集 checkpoint")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-orchestrator-loop",
                json={
                    "dryRun": True,
                    "staleMinutes": 10,
                    "autoContinue": False,
                    "missionId": mission_id or None,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return {"collection_error": str(e), "log_entries": [f"[collect] ERROR: {e}"]}

    checkpoints = _parse_dispatch_checkpoints(data)
    log(f"[collect] {len(checkpoints)} checkpoints")
    return {
        "checkpoints": checkpoints,
        "collection_error": None,
        "log_entries": [f"[collect] {len(checkpoints)} checkpoints"],
    }


# ============================================================
# Node: classify — 唯一 LLM 调用
# ============================================================
CLASSIFY_PROMPT = """分析每个 Worker 的 checkpoint，输出结构化分类。

输出 JSON:
{
  "classifications": [
    {
      "worker_id": "worker 名称",
      "verdict": "DONE | BLOCKED | NEEDS_INPUT | HANDOFF | SKIP",
      "blocker_type": "missing_dependency | test_failure | timeout | architecture_decision | missing_credential | unknown | (空字符串)",
      "blocker_summary": "一句话描述阻塞原因",
      "reasoning": "一句话分类理由",
      "review_outcome": "approved | changes_requested | (空字符串)"
    }
  ]
}

review_outcome 判断规则（仅 architect 审查 developer 时有效）:
- approved: developer 的实现完全符合设计规格，测试通过，无需修改
- changes_requested: developer 的实现有问题，需要修改后重新提交
- 空字符串: 非审查场景

verdict 判断规则:
- DONE: 任务完成
- BLOCKED: 遇到阻塞
- NEEDS_INPUT: 需要人工输入
- HANDOFF: 需要交接
- SKIP: 仍在执行中

blocker_type 判断规则:
- missing_dependency: 缺少文件/依赖/库
- test_failure: 测试失败
- timeout: 超时
- architecture_decision: 需要架构决策
- missing_credential: 缺少 API key/凭证
- unknown: 其他
"""


async def classify_workers(state: OrchestratorState) -> dict:
    checkpoints = state.get("checkpoints", [])
    if not checkpoints:
        log("[classify] 无 checkpoint")
        return {"log_entries": ["[classify] 无 checkpoint"]}

    log(f"[classify] 分类 {len(checkpoints)} 个 worker")
    llm = _get_llm()

    cp_text = "\n\n".join(
        f"Worker: {cp['worker_id']}\nSTATE: {cp['state']}\n"
        f"Result: {cp['result'][:300]}\nBlocker: {cp['blocker']}\nNext: {cp['next_action']}"
        for cp in checkpoints
    )

    resp = await llm.ainvoke(
        [
            SystemMessage(content=CLASSIFY_PROMPT),
            HumanMessage(
                content=f"## Mission\n{state.get('mission_goal', '')}\n\n## Checkpoints\n{cp_text}"
            ),
        ]
    )

    try:
        content = str(resp.content)
        if "```json" in content:
            js = content.split("```json")[1].split("```")[0].strip()
        elif "```" in content:
            js = content.split("```")[1].split("```")[0].strip()
        else:
            js = content.strip()
        data = json.loads(js)
    except (json.JSONDecodeError, IndexError):
        log("[classify] JSON 解析失败，使用默认分类")
        data = {
            "classifications": [
                {
                    "worker_id": cp["worker_id"],
                    "verdict": cp["state"],
                    "reasoning": "默认",
                    "blocker_type": "unknown" if cp["state"] == "BLOCKED" else "",
                    "blocker_summary": cp["blocker"],
                }
                for cp in checkpoints
            ]
        }

    classifications = [
        WorkerClassification(
            worker_id=c["worker_id"],
            verdict=c.get("verdict", "SKIP"),
            blocker_type=c.get("blocker_type", ""),
            blocker_summary=c.get("blocker_summary", ""),
            reasoning=c.get("reasoning", ""),
            review_outcome=c.get("review_outcome", ""),
        )
        for c in data.get("classifications", [])
    ]

    summary = ", ".join(f"{c.worker_id}={c.verdict}" for c in classifications)
    log(f"[classify] {summary}")
    return {
        "classifications": classifications,
        "log_entries": [f"[classify] {summary}"],
    }


# ============================================================
# Node: route_workflow — roster-driven routing (replaces resolve_next)
# ============================================================
async def route_workflow(state: OrchestratorState) -> dict:
    """Build assignments from classifications using workflow.yaml + route_by_workflow."""
    classifications = state.get("classifications", []) or []
    checkpoints = state.get("checkpoints", []) or []
    cp_map = {cp["worker_id"]: cp for cp in checkpoints}

    workflow_spec = state.get("workflow_spec") or load_default_workflow()

    dispatched: set[str] = set(state.get("dispatched_workers", []))
    existing = state.get("langgraph_assignments", []) or []
    for a in existing:
        dispatched.add(a.get("worker_id", ""))
    dispatched.discard("")
    dispatch_counts: dict[str, int] = dict(state.get("dispatch_counts", {}) or {})
    transition_counts: dict[str, int] = dict(state.get("transition_counts", {}) or {})

    assignments: list[dict] = []
    pending_human: list[dict] = []
    needs_human = False
    terminal = False
    awaiting_checkpoint = False
    analysis_parts: list[str] = []

    for c in classifications:
        decision = route_by_workflow(c, state, workflow_spec)
        outcome_str = f"({c.review_outcome})" if c.review_outcome else ""
        target_str = f" → {decision.worker_id}" if decision.worker_id else ""
        analysis_parts.append(
            f"{c.worker_id}: {c.verdict} {outcome_str}{target_str} | "
            f"{decision.action} | {decision.reason}"
        )

        if decision.action == "wait":
            # Worker still in progress; wait_for_checkpoints will keep polling.
            awaiting_checkpoint = True
            continue

        if decision.action == "done":
            terminal = True
            continue

        if decision.action == "human":
            needs_human = True
            pending_human.append(
                {
                    "worker_id": c.worker_id,
                    "task": (
                        f"Human gate cleared. Retry previous task. "
                        f"Blocker: {c.blocker_summary or decision.reason}"
                    ),
                    "reason": f"human approved retry: {decision.reason}",
                }
            )
            continue

        if decision.action in ("dispatch", "retry"):
            target = decision.worker_id
            if target:
                key = f"{c.worker_id}→{target}"
                transition_counts[key] = transition_counts.get(key, 0) + 1
                dispatched.add(target)
                cp = cp_map.get(c.worker_id, {})
                if decision.action == "retry":
                    task = f"Retry previous task. Blocker was: {c.blocker_summary}"
                else:
                    task = (
                        f"Continue {c.worker_id}'s work.\n"
                        f"Result: {cp.get('result', '')[:200]}\n"
                        f"Files: {cp.get('files_changed', '')}"
                    )
                assignments.append(
                    {
                        "worker_id": target,
                        "task": task,
                        "reason": decision.reason,
                    }
                )
            elif target and target in dispatched:
                analysis_parts.append(f"  → {target} 已派发，跳过")

    iteration = state.get("iteration", 0) + 1
    max_iter = state.get("max_iterations", workflow_spec.settings.max_iterations)
    exceeded = iteration >= max_iter

    # Done only when we hit a terminal route, no human gate, no new work, and under limit.
    all_done = terminal and not needs_human and not assignments and not exceeded

    analysis = "Workflow routing:\n" + "\n".join(analysis_parts)
    analysis += (
        f"\n\n路由结果: {len(assignments)} 个派发, "
        f"needs_human={needs_human}, terminal={terminal}, done={all_done}"
    )

    decision = DispatchDecision(
        source="langgraph",
        analysis=analysis,
        assignments=assignments,
        human_approval_required=needs_human,
        metadata={
            "classifications": [
                {"worker_id": c.worker_id, "verdict": c.verdict, "blocker_type": c.blocker_type}
                for c in classifications
            ]
        },
    )

    log(f"[route] {len(assignments)} assignments, needs_human={needs_human}, done={all_done}")
    return {
        "langgraph_decision": decision,
        "langgraph_assignments": assignments,
        "pending_human_assignments": pending_human,
        "langgraph_needs_human": needs_human,
        "awaiting_checkpoint": awaiting_checkpoint,
        "dispatched_workers": list(dispatched),
        "dispatch_counts": dispatch_counts,
        "transition_counts": transition_counts,
        "iteration": iteration,
        "all_done": all_done,
        "log_entries": [
            f"[route] {len(assignments)} assignments, "
            f"pending_human={len(pending_human)}, needs_human={needs_human}, done={all_done}"
        ],
    }


# Backward-compatible alias for Phase 1 graphs that import langgraph_dispatch.
langgraph_dispatch = route_workflow


# ============================================================
# Node: swarm — 调用 Swarm API (Phase 1 only)
# ============================================================
async def swarm_orchestrate(state: OrchestratorState) -> dict:
    swarm_url = _swarm_api_url(state)
    mission_id = state.get("mission_id", "")
    log("[swarm] 调用 Swarm orchestrator-loop")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-orchestrator-loop",
                json={
                    "dryRun": True,
                    "staleMinutes": 10,
                    "autoContinue": True,
                    "allowExecution": True,
                    "missionId": mission_id or None,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return {
            "swarm_decision": DispatchDecision(
                source="swarm",
                analysis=f"API 失败: {e}",
                assignments=[],
                human_approval_required=True,
            ),
            "log_entries": [f"[swarm] ERROR: {e}"],
        }

    continuation = data.get("continuation")
    assignments = []
    if continuation and isinstance(continuation, dict):
        for a in continuation.get("assignments", []):
            assignments.append(
                {
                    "worker_id": a.get("workerId", ""),
                    "task": a.get("task", ""),
                    "reason": a.get("rationale", ""),
                }
            )

    results = data.get("results", [])
    action_lines = [f"{r['workerId']}: {r.get('action', r.get('status', '?'))}" for r in results]
    analysis = "Swarm 规则引擎:\n" + "\n".join(action_lines)

    decision = DispatchDecision(
        source="swarm",
        analysis=analysis,
        assignments=assignments,
        human_approval_required=any(
            (r.get("checkpoint") or {}).get("stateLabel") in ("NEEDS_INPUT", "BLOCKED")
            for r in results
            if r.get("checkpoint")
        ),
        metadata={"summary": data.get("summary", {}), "mode": data.get("mode", {})},
    )
    log(f"[swarm] {len(assignments)} assignments")
    return {
        "swarm_decision": decision,
        "log_entries": [f"[swarm] {len(assignments)} assignments"],
    }


# ============================================================
# Node: compare (Phase 1 only)
# ============================================================
async def compare_decisions(state: OrchestratorState) -> dict:
    swarm = state.get("swarm_decision")
    lang = state.get("langgraph_decision")
    if not swarm or not lang:
        return {"comparison": {"error": "missing"}, "log_entries": ["[compare] missing"]}

    log("[compare] Swarm vs LangGraph")
    swarm_pairs = {
        f"{a.get('worker_id','')}:{a.get('task','')[:60]}" for a in swarm.assignments
    }
    lang_pairs = {
        f"{a.get('worker_id','')}:{a.get('task','')[:60]}" for a in lang.assignments
    }
    swarm_workers = {a.get("worker_id", "") for a in swarm.assignments}
    lang_workers = {a.get("worker_id", "") for a in lang.assignments}

    agreed = sorted(swarm_pairs & lang_pairs)
    swarm_only = sorted(swarm_pairs - lang_pairs)
    lang_only = sorted(lang_pairs - swarm_pairs)

    comparison = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agreement": {
            "assignments": agreed,
            "workers": sorted(swarm_workers & lang_workers),
            "count": len(agreed),
        },
        "divergence": {
            "swarm_only": swarm_only,
            "langgraph_only": lang_only,
            "swarm_only_workers": sorted(swarm_workers - lang_workers),
            "langgraph_only_workers": sorted(lang_workers - swarm_workers),
        },
        "approval": {
            "swarm": swarm.human_approval_required,
            "langgraph": lang.human_approval_required,
        },
        "counts": {"swarm": len(swarm.assignments), "langgraph": len(lang.assignments)},
        "summary": _summary(agreed, swarm_only, lang_only, swarm, lang),
    }
    log(f"[compare] agreed={len(agreed)}, swarm_only={len(swarm_only)}, lang_only={len(lang_only)}")
    return {
        "comparison": comparison,
        "log_entries": [
            f"[compare] agreed={len(agreed)}, swarm_only={len(swarm_only)}, lang_only={len(lang_only)}"
        ],
    }


def _summary(agreed, swarm_only, lang_only, swarm, lang) -> str:
    parts = []
    if agreed:
        parts.append(f"一致: {len(agreed)} 项")
    if swarm_only:
        parts.append(f"Swarm独有: {len(swarm_only)} 项")
    if lang_only:
        parts.append(f"LangGraph独有: {len(lang_only)} 项")
    if swarm.human_approval_required != lang.human_approval_required:
        parts.append("审批不一致")
    return "；".join(parts) if parts else "双方均无派发"


# ============================================================
# Node: log (Phase 1 only)
# ============================================================
async def log_results(state: OrchestratorState) -> dict:
    comparison = state.get("comparison")
    if not comparison:
        return {"log_entries": ["[log] waiting"]}
    mission_id = state.get("mission_id", "unknown")
    swarm = state.get("swarm_decision")
    lang = state.get("langgraph_decision")

    log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
    os.makedirs(log_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(log_dir, f"compare_{mission_id}_{ts}.json")

    output = {
        "phase": "phase1_compare",
        "mission_id": mission_id,
        "mission_goal": state.get("mission_goal", ""),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checkpoints": [
            {"worker_id": cp["worker_id"], "state": cp["state"], "result": cp["result"]}
            for cp in state.get("checkpoints", [])
        ],
        "swarm_decision": {
            "analysis": swarm.analysis if swarm else "",
            "assignments": swarm.assignments if swarm else [],
            "human_approval_required": swarm.human_approval_required if swarm else False,
        },
        "langgraph_decision": {
            "analysis": lang.analysis if lang else "",
            "assignments": lang.assignments if lang else [],
            "human_approval_required": lang.human_approval_required if lang else False,
            "metadata": lang.metadata if lang else {},
        },
        "comparison": comparison,
    }
    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f"[log] {log_file}")
    return {
        "log_entries": [f"[log] {log_file}", f"[log] {comparison.get('summary', 'N/A')}"],
    }


# ============================================================
# Phase 2 nodes
# ============================================================
async def ensure_sessions(state: OrchestratorState) -> dict:
    """Idempotently ensure tmux sessions exist via POST /api/swarm-tmux-start."""
    swarm_url = _swarm_api_url(state)
    assignments = state.get("langgraph_assignments", []) or []
    workers = _active_assignments_to_workers(assignments)

    if not workers:
        log("[ensure_sessions] 无 worker 需要启动")
        return {"log_entries": ["[ensure_sessions] 无 worker"]}

    log(f"[ensure_sessions] 预热 {len(workers)} 个 session: {workers}")
    results: list[str] = []
    session_errors: list[str] = []
    async with httpx.AsyncClient(timeout=30) as client:
        for wid in workers:
            try:
                resp = await client.post(
                    f"{swarm_url}/swarm-tmux-start",
                    json={"workerId": wid},
                )
                resp.raise_for_status()
                data = resp.json()
                if data.get("alreadyRunning"):
                    results.append(f"{wid}: already-running")
                elif data.get("started"):
                    results.append(f"{wid}: started")
                else:
                    results.append(f"{wid}: ok")
            except httpx.HTTPStatusError as e:
                try:
                    body = e.response.json()
                    detail = body.get("error", body)
                except Exception:
                    detail = e.response.text or str(e)
                msg = f"{wid}: error ({detail})"
                results.append(msg)
                session_errors.append(msg)
            except Exception as e:
                results.append(f"{wid}: error ({e})")
                session_errors.append(f"{wid}: error ({e})")

    log(f"[ensure_sessions] {', '.join(results)}")
    return {
        "log_entries": [f"[ensure_sessions] {', '.join(results)}"],
        "collection_error": "; ".join(session_errors) if session_errors else None,
    }


async def dispatch_assignments(state: OrchestratorState) -> dict:
    """Unified dispatch node: call /api/swarm-dispatch with waitForCheckpoint=true."""
    swarm_url = _swarm_api_url(state)
    mission_id = state.get("mission_id", "")
    assignments = state.get("langgraph_assignments", []) or []

    if not assignments:
        log("[dispatch] 无 assignments")
        return {
            "dispatch_results": None,
            "dispatch_error": None,
            "log_entries": ["[dispatch] 无 assignments"],
        }

    log(f"[dispatch] 派发 {len(assignments)} 个任务 (waitForCheckpoint)")

    try:
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-dispatch",
                json={
                    "assignments": [
                        {
                            "workerId": a["worker_id"],
                            "task": a["task"],
                            "rationale": a.get("reason", ""),
                        }
                        for a in assignments
                    ],
                    "missionId": mission_id,
                    "timeoutSeconds": 600,
                    "waitForCheckpoint": True,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log(f"[dispatch] 失败: {e}")
        return {
            "dispatch_results": None,
            "dispatch_error": str(e),
            "log_entries": [f"[dispatch] ERROR: {e}"],
        }

    checkpoints = _parse_dispatch_checkpoints(data)
    log(f"[dispatch] {len(checkpoints)} checkpoints")
    dispatch_counts = dict(state.get("dispatch_counts", {}) or {})
    dispatched_workers = list(state.get("dispatched_workers", []) or [])
    for a in assignments:
        wid = a.get("worker_id")
        if wid:
            dispatch_counts[wid] = dispatch_counts.get(wid, 0) + 1
            if wid not in dispatched_workers:
                dispatched_workers.append(wid)
    return {
        "dispatch_results": data,
        "dispatch_error": None,
        "checkpoints": checkpoints,
        "dispatch_counts": dispatch_counts,
        "dispatched_workers": dispatched_workers,
        "log_entries": [f"[dispatch] {len(assignments)} tasks, {len(checkpoints)} checkpoints"],
    }


async def wait_for_checkpoints(state: OrchestratorState) -> dict:
    """Poll until all dispatched workers reach a terminal checkpoint.

    Dispatch returns the first fresh checkpoint, which may be IN_PROGRESS.
    This node polls Swarm missions until every tracked worker is DONE,
    BLOCKED, NEEDS_INPUT, or HANDOFF (or max polls reached).

    The returned ``checkpoints`` only contains workers from the current
    assignment batch, so downstream classify/route acts on the latest workers.
    ``terminal_checkpoints`` accumulates terminal checkpoints across the whole
    mission so we do not lose already-terminal workers when dispatch overwrites
    the checkpoint list.
    """
    swarm_url = _swarm_api_url(state)
    mission_id = state.get("mission_id", "")

    assignments = state.get("langgraph_assignments", []) or []
    current_workers = set(_active_assignments_to_workers(assignments))
    dispatched = set(state.get("dispatched_workers", []) or [])
    dispatched.update(current_workers)
    dispatched.discard("")

    if not current_workers:
        return {"awaiting_checkpoint": False, "log_entries": ["[wait] 无 current workers"]}

    terminal_states = {"DONE", "BLOCKED", "NEEDS_INPUT", "HANDOFF"}
    current_checkpoints = state.get("checkpoints", []) or []
    terminal_history = state.get("terminal_checkpoints", []) or []

    def _all_terminal(cp_map: dict[str, WorkerCheckpoint]) -> bool:
        return current_workers.issubset(cp_map.keys()) and all(
            cp["state"] in terminal_states for cp in cp_map.values()
            if cp["worker_id"] in current_workers
        )

    cp_map: dict[str, WorkerCheckpoint] = {
        cp["worker_id"]: cp for cp in terminal_history if cp["worker_id"] in dispatched
    }
    for cp in current_checkpoints:
        wid = cp.get("worker_id")
        if wid in dispatched:
            cp_map[wid] = cp

    # If current workers are already terminal, skip polling.
    if _all_terminal(cp_map):
        return {
            "awaiting_checkpoint": False,
            "checkpoints": [cp_map[wid] for wid in current_workers if wid in cp_map],
            "terminal_checkpoints": list(cp_map.values()),
            "log_entries": [f"[wait] {len(current_workers)} current workers already terminal"],
        }

    max_polls = 30
    poll_interval = 10

    for attempt in range(max_polls):
        missing = current_workers - set(cp_map.keys())
        log(f"[wait] 第 {attempt + 1}/{max_polls} 次轮询 (等待: {missing})...")

        # Drive the Swarm harvester so chat checkpoints get recorded to the
        # mission store even when no UI autopilot is running.
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                await client.post(
                    f"{swarm_url}/swarm-orchestrator-loop",
                    json={
                        "workerIds": sorted(current_workers),
                        "missionId": mission_id,
                        "dryRun": False,
                        "autoContinue": False,
                        "allowExecution": False,
                    },
                )
        except Exception as e:
            log(f"[wait] harvester probe failed: {e}")

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(f"{swarm_url}/swarm-missions", params={"id": mission_id})
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            log(f"[wait] API 失败: {e}")
            await asyncio.sleep(poll_interval)
            continue

        mission = data.get("mission")
        if not mission or not isinstance(mission, dict):
            await asyncio.sleep(poll_interval)
            continue

        # Collect latest checkpoints for tracked workers.
        for assignment in mission.get("assignments", []):
            wid = assignment.get("workerId")
            if wid not in dispatched:
                continue
            checkpoint = assignment.get("checkpoint")
            if not checkpoint:
                continue
            cp_map[wid] = _checkpoint_from_parsed(checkpoint, wid)

        terminal_count = sum(
            1 for cp in cp_map.values() if cp["state"] in terminal_states
        )
        log(f"[wait] {terminal_count}/{len(dispatched)} terminal, {len(cp_map)} seen")

        if _all_terminal(cp_map):
            return {
                "checkpoints": [cp_map[wid] for wid in current_workers if wid in cp_map],
                "terminal_checkpoints": list(cp_map.values()),
                "awaiting_checkpoint": False,
                "log_entries": [f"[wait] all {len(current_workers)} current workers terminal after {attempt + 1} polls"],
            }

        await asyncio.sleep(poll_interval)

    log(f"[wait] {max_polls} 次轮询后仍有 worker 未完成")
    return {
        "checkpoints": [cp_map[wid] for wid in current_workers if wid in cp_map],
        "terminal_checkpoints": list(cp_map.values()),
        "awaiting_checkpoint": False,
        "langgraph_needs_human": True,
        "log_entries": [f"[wait] timeout after {max_polls} polls, {len(cp_map)} checkpoints"],
    }


def _checkpoint_from_parsed(checkpoint: dict[str, Any], worker_id: str) -> WorkerCheckpoint:
    """Convert a Workspace ParsedSwarmCheckpoint dict into a WorkerCheckpoint."""
    return WorkerCheckpoint(
        worker_id=worker_id,
        state=checkpoint.get("stateLabel") or "IN_PROGRESS",
        result=checkpoint.get("result") or "",
        files_changed=checkpoint.get("filesChanged") or "",
        commands_run=checkpoint.get("commandsRun") or "",
        blocker=checkpoint.get("blocker") or "",
        next_action=checkpoint.get("nextAction") or "",
        raw=checkpoint.get("raw") or "",
    )


async def human_approval_node(state: OrchestratorState) -> dict:
    """Human gate — LangGraph interrupt_before pauses here."""
    action = state.get("human_resume_action")
    log(f"[human_approval] 等待人工审批... (resume_action={action})")
    return {
        "log_entries": [f"[human_approval] paused (resume_action={action})"]
    }


async def finalize_mission(state: OrchestratorState) -> dict:
    """Terminal node: log execution outcome and mark done."""
    mission_id = state.get("mission_id", "unknown")
    log(f"[finalize] mission={mission_id} 完成")
    # log_execution writes logs/execute_*.json.
    exec_log = await log_execution(state)
    return {
        "all_done": True,
        "log_entries": [f"[finalize] mission={mission_id} complete"]
        + exec_log.get("log_entries", []),
    }


async def log_execution(state: OrchestratorState) -> dict:
    """Record Phase 2 execution results to logs/execute_*.json."""
    mission_id = state.get("mission_id", "unknown")
    lang = state.get("langgraph_decision")

    log_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs"
    )
    os.makedirs(log_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(log_dir, f"execute_{mission_id}_{ts}.json")

    output = {
        "phase": "phase2_execute",
        "mission_id": mission_id,
        "mission_goal": state.get("mission_goal", ""),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "iterations": state.get("iteration", 0),
        "all_done": state.get("all_done", False),
        "final_decision": {
            "analysis": lang.analysis if lang else "",
            "assignments": lang.assignments if lang else [],
        },
        "dispatch_results": state.get("dispatch_results"),
        "dispatch_error": state.get("dispatch_error"),
        "classifications": [
            {
                "worker_id": c.worker_id,
                "verdict": c.verdict,
                "blocker_type": c.blocker_type,
                "review_outcome": c.review_outcome,
            }
            for c in (state.get("classifications") or [])
        ],
    }

    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f"[log_execution] {log_file}")
    return {"log_entries": [f"[log_execution] {log_file}"]}


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}")
