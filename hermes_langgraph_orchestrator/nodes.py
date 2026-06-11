"""
LangGraph Orchestrator Nodes — Phase 1 对比模式

LangGraph 图结构编排:
  collect → classify (唯一 LLM 调用) → 纯函数路由表 → dispatch → 对比

LLM 只做一件事: 把非结构化 checkpoint 文本 → 结构化分类
之后所有路由由图的边 + 纯函数路由表决定。
"""

import asyncio
import json
import os
from datetime import datetime, timezone

import httpx
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from .state import (
    DispatchDecision,
    OrchestratorState,
    WorkerCheckpoint,
    WorkerClassification,
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
# 路由表 — 状态感知路由
# ============================================================

def resolve_next(
    classification: WorkerClassification,
    state: OrchestratorState,
) -> str | None:
    """状态感知路由: 根据 worker + review_outcome + 迭代次数 决定下一个 worker。

    返回 None 表示终止，不需要后续派发。
    """
    wid = classification.worker_id
    outcome = classification.review_outcome
    iteration = state.get("iteration", 0)
    max_iter = state.get("max_iterations", 5)

    # === researcher → architect（调研完成，启动设计） ===
    if wid == "researcher" and classification.verdict == "DONE":
        return "architect"

    # === architect → developer 或 终止 ===
    if wid == "architect" and classification.verdict == "DONE":
        if outcome == "approved":
            return None  # 审查通过，终止循环
        else:
            return "developer"  # 设计完成 / 修改意见 → 交给 developer

    # === developer → architect（实现完成，交回审查） ===
    if wid == "developer" and classification.verdict == "DONE":
        if iteration >= max_iter:
            return None  # 达到最大迭代，强制终止
        return "architect"  # 交回 architect 审查

    # === builder → reviewer ===
    if wid == "builder" and classification.verdict == "DONE":
        return "reviewer"

    # === reviewer → 终止 ===
    if wid == "reviewer" and classification.verdict == "DONE":
        return None

    # === 默认：无后续 ===
    return None


# blocker_type → 处理方式
BLOCKER_ROUTE: dict[str, str] = {
    "missing_dependency":     "retry",
    "test_failure":           "retry",
    "timeout":                "retry",
    "architecture_decision":  "escalate",
    "missing_credential":     "escalate",
    "unknown":                "escalate",
    "":                       "escalate",
}


# ============================================================
# Node 1: collect
# ============================================================
async def collect_checkpoints(state: OrchestratorState) -> dict:
    swarm_url = state.get("swarm_api_url", "http://localhost:3000/api")
    mission_id = state.get("mission_id", "")
    log("[collect] 收集 checkpoint")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-orchestrator-loop",
                json={"dryRun": True, "staleMinutes": 10, "autoContinue": False, "missionId": mission_id or None},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return {"collection_error": str(e), "log_entries": [f"[collect] ERROR: {e}"]}

    checkpoints: list[WorkerCheckpoint] = []
    for r in data.get("results", []):
        cp = r.get("checkpoint")
        if cp:
            checkpoints.append(WorkerCheckpoint(
                worker_id=r.get("workerId", "unknown"),
                state=cp.get("stateLabel", "IN_PROGRESS"),
                result=cp.get("result", ""), files_changed=cp.get("filesChanged", ""),
                commands_run=cp.get("commandsRun", ""), blocker=cp.get("blocker", ""),
                next_action=cp.get("nextAction", ""), raw=cp.get("raw", ""),
            ))
    log(f"[collect] {len(checkpoints)} checkpoints")
    return {"checkpoints": checkpoints, "collection_error": None,
            "log_entries": [f"[collect] {len(checkpoints)} checkpoints"]}


# ============================================================
# Node 2: classify — 唯一 LLM 调用
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

    resp = await llm.ainvoke([
        SystemMessage(content=CLASSIFY_PROMPT),
        HumanMessage(content=f"## Mission\n{state.get('mission_goal', '')}\n\n## Checkpoints\n{cp_text}"),
    ])

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
        data = {"classifications": [
            {"worker_id": cp["worker_id"], "verdict": cp["state"], "reasoning": "默认",
             "blocker_type": "unknown" if cp["state"] == "BLOCKED" else "", "blocker_summary": cp["blocker"]}
            for cp in checkpoints
        ]}

    classifications = [
        WorkerClassification(
            worker_id=c["worker_id"], verdict=c.get("verdict", "SKIP"),
            blocker_type=c.get("blocker_type", ""), blocker_summary=c.get("blocker_summary", ""),
            reasoning=c.get("reasoning", ""),
            review_outcome=c.get("review_outcome", ""),
        )
        for c in data.get("classifications", [])
    ]

    summary = ", ".join(f"{c.worker_id}={c.verdict}" for c in classifications)
    log(f"[classify] {summary}")
    return {"classifications": classifications, "log_entries": [f"[classify] {summary}"]}


# ============================================================
# Node 3: dispatch — 纯函数路由表
# ============================================================
async def langgraph_dispatch(state: OrchestratorState) -> dict:
    """状态感知路由: 根据 classify 结果 + resolve_next() 构建 assignments。不用 LLM。"""
    classifications = state.get("classifications", [])
    checkpoints = state.get("checkpoints", [])
    cp_map = {cp["worker_id"]: cp for cp in checkpoints}

    dispatched: set[str] = set(state.get("dispatched_workers", []))
    existing = state.get("langgraph_assignments", [])
    for a in existing:
        dispatched.add(a.get("worker_id", ""))

    assignments: list[dict] = []
    needs_human = False
    analysis_parts: list[str] = []

    for c in classifications:
        outcome_str = f"({c.review_outcome})" if c.review_outcome else ""
        analysis_parts.append(f"{c.worker_id}: {c.verdict} {outcome_str} — {c.reasoning}")

        if c.verdict == "DONE":
            next_w = resolve_next(c, state)
            if next_w and next_w not in dispatched:
                dispatched.add(next_w)
                cp = cp_map.get(c.worker_id, {})
                assignments.append({
                    "worker_id": next_w,
                    "task": f"Continue {c.worker_id}'s work.\nResult: {cp.get('result', '')[:200]}\nFiles: {cp.get('files_changed', '')}",
                    "reason": f"状态感知路由: {c.worker_id} DONE → {next_w}",
                })
            elif next_w and next_w in dispatched:
                analysis_parts.append(f"  → {next_w} 已派发，跳过")
            elif next_w is None:
                analysis_parts.append(f"  → 终止（{c.worker_id} 完成，无需后续）")

        elif c.verdict == "BLOCKED":
            action = BLOCKER_ROUTE.get(c.blocker_type, "escalate")
            if action == "escalate":
                needs_human = True
                analysis_parts.append(f"  → escalate: {c.blocker_summary}")
            elif c.worker_id not in dispatched:
                dispatched.add(c.worker_id)
                assignments.append({
                    "worker_id": c.worker_id,
                    "task": f"Retry previous task. Blocker was: {c.blocker_summary}",
                    "reason": f"路由表: {c.blocker_type} → retry",
                })

        elif c.verdict in ("NEEDS_INPUT", "HANDOFF"):
            needs_human = True

    analysis = "LangGraph 图结构编排:\n" + "\n".join(analysis_parts)
    analysis += f"\n\n路由结果: {len(assignments)} 个派发"
    if needs_human:
        analysis += ", 需要人工介入"

    decision = DispatchDecision(
        source="langgraph",
        analysis=analysis,
        assignments=assignments,
        human_approval_required=needs_human,
        metadata={"classifications": [
            {"worker_id": c.worker_id, "verdict": c.verdict, "blocker_type": c.blocker_type}
            for c in classifications
        ]},
    )

    log(f"[dispatch] {len(assignments)} assignments, needs_human={needs_human}")
    return {
        "langgraph_decision": decision,
        "langgraph_assignments": assignments,
        "langgraph_needs_human": needs_human,
        "dispatched_workers": list(dispatched),
        "iteration": state.get("iteration", 0) + 1,
        "log_entries": [f"[dispatch] {len(assignments)} assignments, needs_human={needs_human}"],
    }


# ============================================================
# Node 4: swarm — 调用 Swarm API
# ============================================================
async def swarm_orchestrate(state: OrchestratorState) -> dict:
    swarm_url = state.get("swarm_api_url", "http://localhost:3000/api")
    mission_id = state.get("mission_id", "")
    log("[swarm] 调用 Swarm orchestrator-loop")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-orchestrator-loop",
                json={"dryRun": True, "staleMinutes": 10, "autoContinue": True,
                      "allowExecution": True, "missionId": mission_id or None},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return {"swarm_decision": DispatchDecision(source="swarm", analysis=f"API 失败: {e}",
                                                    assignments=[], human_approval_required=True),
                "log_entries": [f"[swarm] ERROR: {e}"]}

    continuation = data.get("continuation")
    assignments = []
    if continuation and isinstance(continuation, dict):
        for a in continuation.get("assignments", []):
            assignments.append({"worker_id": a.get("workerId", ""), "task": a.get("task", ""),
                                "reason": a.get("rationale", "")})

    results = data.get("results", [])
    action_lines = [f"{r['workerId']}: {r.get('action', r.get('status', '?'))}" for r in results]
    analysis = "Swarm 规则引擎:\n" + "\n".join(action_lines)

    decision = DispatchDecision(
        source="swarm", analysis=analysis, assignments=assignments,
        human_approval_required=any(
            (r.get("checkpoint") or {}).get("stateLabel") in ("NEEDS_INPUT", "BLOCKED")
            for r in results if r.get("checkpoint")
        ),
        metadata={"summary": data.get("summary", {}), "mode": data.get("mode", {})},
    )
    log(f"[swarm] {len(assignments)} assignments")
    return {"swarm_decision": decision, "log_entries": [f"[swarm] {len(assignments)} assignments"]}


# ============================================================
# Node 5: compare
# ============================================================
async def compare_decisions(state: OrchestratorState) -> dict:
    swarm = state.get("swarm_decision")
    lang = state.get("langgraph_decision")
    if not swarm or not lang:
        return {"comparison": {"error": "missing"}, "log_entries": ["[compare] missing"]}

    log("[compare] Swarm vs LangGraph")
    swarm_pairs = {f"{a.get('worker_id','')}:{a.get('task','')[:60]}" for a in swarm.assignments}
    lang_pairs = {f"{a.get('worker_id','')}:{a.get('task','')[:60]}" for a in lang.assignments}
    swarm_workers = {a.get("worker_id", "") for a in swarm.assignments}
    lang_workers = {a.get("worker_id", "") for a in lang.assignments}

    agreed = sorted(swarm_pairs & lang_pairs)
    swarm_only = sorted(swarm_pairs - lang_pairs)
    lang_only = sorted(lang_pairs - swarm_pairs)

    comparison = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agreement": {"assignments": agreed, "workers": sorted(swarm_workers & lang_workers), "count": len(agreed)},
        "divergence": {
            "swarm_only": swarm_only, "langgraph_only": lang_only,
            "swarm_only_workers": sorted(swarm_workers - lang_workers),
            "langgraph_only_workers": sorted(lang_workers - swarm_workers),
        },
        "approval": {"swarm": swarm.human_approval_required, "langgraph": lang.human_approval_required},
        "counts": {"swarm": len(swarm.assignments), "langgraph": len(lang.assignments)},
        "summary": _summary(agreed, swarm_only, lang_only, swarm, lang),
    }
    log(f"[compare] agreed={len(agreed)}, swarm_only={len(swarm_only)}, lang_only={len(lang_only)}")
    return {"comparison": comparison, "log_entries": [
        f"[compare] agreed={len(agreed)}, swarm_only={len(swarm_only)}, lang_only={len(lang_only)}"]}


def _summary(agreed, swarm_only, lang_only, swarm, lang) -> str:
    parts = []
    if agreed: parts.append(f"一致: {len(agreed)} 项")
    if swarm_only: parts.append(f"Swarm独有: {len(swarm_only)} 项")
    if lang_only: parts.append(f"LangGraph独有: {len(lang_only)} 项")
    if swarm.human_approval_required != lang.human_approval_required:
        parts.append("审批不一致")
    return "；".join(parts) if parts else "双方均无派发"


# ============================================================
# Node 6: log
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
        "phase": "phase1_compare", "mission_id": mission_id,
        "mission_goal": state.get("mission_goal", ""),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checkpoints": [{"worker_id": cp["worker_id"], "state": cp["state"], "result": cp["result"]}
                        for cp in state.get("checkpoints", [])],
        "swarm_decision": {
            "analysis": swarm.analysis if swarm else "", "assignments": swarm.assignments if swarm else [],
            "human_approval_required": swarm.human_approval_required if swarm else False,
        },
        "langgraph_decision": {
            "analysis": lang.analysis if lang else "", "assignments": lang.assignments if lang else [],
            "human_approval_required": lang.human_approval_required if lang else False,
            "metadata": lang.metadata if lang else {},
        },
        "comparison": comparison,
    }
    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f"[log] {log_file}")
    return {"log_entries": [f"[log] {log_file}", f"[log] {comparison.get('summary', 'N/A')}"]}


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}")


# ============================================================
# Phase 2 节点: start_workers — 启动 Worker tmux 会话
# ============================================================
async def start_workers(state: OrchestratorState) -> dict:
    """直接启动 Worker tmux 会话（非 TUI 模式，避免依赖问题）"""
    initial_tasks = state.get("langgraph_assignments", [])
    worker_ids = list({a["worker_id"] for a in initial_tasks})

    if not worker_ids:
        log("[start_workers] 无 worker 需要启动")
        return {"log_entries": ["[start_workers] 无 worker"]}

    log(f"[start_workers] 启动 {len(worker_ids)} 个 Worker: {worker_ids}")

    results = []
    for wid in worker_ids:
        session_name = f"swarm-{wid}"
        profile_path = os.path.expanduser(f"~/.hermes/profiles/{wid}")

        # 检查是否已存在
        proc = await asyncio.create_subprocess_exec(
            "tmux", "has-session", "-t", session_name,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()

        if proc.returncode == 0:
            results.append(f"{wid}: already running")
            continue

        # 启动新会话（tmux 提供 PTY，TUI 模式）
        try:
            workdir = os.path.expanduser("~/hermes-workspace")
            proc = await asyncio.create_subprocess_exec(
                "tmux", "new-session", "-d", "-s", session_name,
                "-c", workdir,
                "env", f"HERMES_HOME={profile_path}",
                "hermes", "-p", wid, "chat", "--tui",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode == 0:
                results.append(f"{wid}: started")
            else:
                err = stderr.decode()[:100] if stderr else f"exit {proc.returncode}"
                results.append(f"{wid}: error ({err})")
        except asyncio.TimeoutError:
            results.append(f"{wid}: timeout")
        except Exception as e:
            results.append(f"{wid}: error ({e})")

    log(f"[start_workers] {', '.join(results)}")
    return {"log_entries": [f"[start_workers] {', '.join(results)}"]}


# ============================================================
# Phase 2 节点: initial_dispatch — 首次派发，启动 Worker
# ============================================================
async def initial_dispatch(state: OrchestratorState) -> dict:
    """首次派发: 将初始任务发送给 Worker。"""
    initial_tasks = state.get("langgraph_assignments", [])
    swarm_url = state.get("swarm_api_url", "http://localhost:3000/api")
    mission_id = state.get("mission_id", "")

    if not initial_tasks:
        log("[initial_dispatch] 无初始任务")
        return {"dispatch_results": None, "dispatch_error": None,
                "log_entries": ["[initial_dispatch] 无初始任务"]}

    log(f"[initial_dispatch] 派发 {len(initial_tasks)} 个任务")

    try:
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-dispatch",
                json={"assignments": [
                    {"workerId": a["worker_id"], "task": a["task"], "rationale": a.get("reason", "")}
                    for a in initial_tasks
                ], "missionId": mission_id, "timeoutSeconds": 600, "waitForCheckpoint": True},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log(f"[initial_dispatch] 失败: {e}")
        return {"dispatch_results": None, "dispatch_error": str(e),
                "log_entries": [f"[initial_dispatch] ERROR: {e}"]}

    # 从 API 响应中直接解析 checkpoint
    checkpoints: list[WorkerCheckpoint] = []
    for r in data.get("results", []):
        cp = r.get("checkpoint")
        if cp:
            checkpoints.append(WorkerCheckpoint(
                worker_id=r.get("workerId", "unknown"), state=cp.get("stateLabel", "IN_PROGRESS"),
                result=cp.get("result", ""), files_changed=cp.get("filesChanged", ""),
                commands_run=cp.get("commandsRun", ""), blocker=cp.get("blocker", ""),
                next_action=cp.get("nextAction", ""), raw=cp.get("raw", ""),
            ))

    log(f"[initial_dispatch] 成功, {len(checkpoints)} checkpoints")
    return {"dispatch_results": data, "dispatch_error": None, "checkpoints": checkpoints,
            "log_entries": [f"[initial_dispatch] {len(initial_tasks)} tasks, {len(checkpoints)} checkpoints"]}


# ============================================================
# Phase 2 节点: dispatch_to_swarm — 后续派发
# ============================================================
async def dispatch_to_swarm(state: OrchestratorState) -> dict:
    """派发 + 等待 checkpoint。API waitForCheckpoint=true，返回时 checkpoint 已在响应中。"""
    assignments = state.get("langgraph_assignments", [])
    swarm_url = state.get("swarm_api_url", "http://localhost:3000/api")
    mission_id = state.get("mission_id", "")

    if not assignments:
        log("[dispatch_to_swarm] 无 assignments")
        return {"dispatch_results": None, "dispatch_error": None,
                "log_entries": ["[dispatch_to_swarm] 无 assignments"]}

    log(f"[dispatch_to_swarm] 派发 {len(assignments)} 个任务 (waitForCheckpoint)")

    try:
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{swarm_url}/swarm-dispatch",
                json={"assignments": [
                    {"workerId": a["worker_id"], "task": a["task"], "rationale": a.get("reason", "")}
                    for a in assignments
                ], "missionId": mission_id, "timeoutSeconds": 600, "waitForCheckpoint": True},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log(f"[dispatch_to_swarm] 失败: {e}")
        return {"dispatch_results": None, "dispatch_error": str(e),
                "log_entries": [f"[dispatch_to_swarm] ERROR: {e}"]}

    checkpoints: list[WorkerCheckpoint] = []
    for r in data.get("results", []):
        cp = r.get("checkpoint")
        if cp:
            checkpoints.append(WorkerCheckpoint(
                worker_id=r.get("workerId", "unknown"), state=cp.get("stateLabel", "IN_PROGRESS"),
                result=cp.get("result", ""), files_changed=cp.get("filesChanged", ""),
                commands_run=cp.get("commandsRun", ""), blocker=cp.get("blocker", ""),
                next_action=cp.get("nextAction", ""), raw=cp.get("raw", ""),
            ))

    log(f"[dispatch_to_swarm] {len(checkpoints)} checkpoints")
    return {"dispatch_results": data, "dispatch_error": None, "checkpoints": checkpoints,
            "log_entries": [f"[dispatch_to_swarm] {len(assignments)} tasks, {len(checkpoints)} checkpoints"]}


# ============================================================
# Phase 2 节点: wait_for_checkpoints — 轮询等待 Worker 完成
# ============================================================
async def wait_for_checkpoints(state: OrchestratorState) -> dict:
    """轮询 Swarm API，只等待当前编排涉及的 Worker 产出 checkpoint。"""
    swarm_url = state.get("swarm_api_url", "http://localhost:3000/api")
    mission_id = state.get("mission_id", "")
    wait_attempts = state.get("wait_attempts", 0)

    # 只关心当前编排涉及的 worker
    dispatched = set(state.get("dispatched_workers", []))
    initial = state.get("langgraph_assignments", [])
    for a in initial:
        dispatched.add(a.get("worker_id", ""))
    dispatched.discard("")

    max_polls = 30
    poll_interval = 10

    for i in range(max_polls):
        wait_attempts += 1
        log(f"[wait] 第 {wait_attempts} 次轮询 (等待: {dispatched})...")

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{swarm_url}/swarm-orchestrator-loop",
                    json={"dryRun": False, "staleMinutes": 10, "autoContinue": False,
                          "missionId": mission_id or None},
                )
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            log(f"[wait] API 失败: {e}")
            await asyncio.sleep(poll_interval)
            continue

        checkpoints: list[WorkerCheckpoint] = []
        for r in data.get("results", []):
            wid = r.get("workerId", "unknown")
            if wid not in dispatched:
                continue  # 不是当前编排的 worker，忽略
            cp = r.get("checkpoint")
            if cp:
                checkpoints.append(WorkerCheckpoint(
                    worker_id=wid,
                    state=cp.get("stateLabel", "IN_PROGRESS"),
                    result=cp.get("result", ""), files_changed=cp.get("filesChanged", ""),
                    commands_run=cp.get("commandsRun", ""), blocker=cp.get("blocker", ""),
                    next_action=cp.get("nextAction", ""), raw=cp.get("raw", ""),
                ))

        if checkpoints:
            log(f"[wait] 第 {wait_attempts} 次: {len(checkpoints)} checkpointed, 退出轮询")
            return {
                "checkpoints": checkpoints,
                "wait_attempts": wait_attempts,
                "log_entries": [f"[wait] attempt {wait_attempts}: {len(checkpoints)} checkpointed"],
            }

        log(f"[wait] 第 {wait_attempts} 次: 0 relevant checkpointed, {i+1}/{max_polls}")

        if i < max_polls - 1:
            await asyncio.sleep(poll_interval)

    log(f"[wait] {max_polls} 次轮询后仍无相关 checkpoint")
    return {
        "wait_attempts": wait_attempts,
        "log_entries": [f"[wait] {max_polls} attempts, no relevant checkpoints"],
    }


# ============================================================
# Phase 2 节点: check_done — 判断是否所有 worker 完成
# ============================================================
async def check_done(state: OrchestratorState) -> dict:
    """检查编排循环是否应该终止。

    终止条件（满足任一）:
    1. 所有 worker 都是 DONE/SKIP 且没有新的 assignments
    2. 达到最大迭代次数
    """
    classifications = state.get("classifications", [])
    assignments = state.get("langgraph_assignments", [])
    iteration = state.get("iteration", 0)
    max_iter = state.get("max_iterations", 5)

    # 所有 worker 完成
    all_done = all(c.verdict in ("DONE", "SKIP") for c in classifications) if classifications else False

    # 没有新的派发任务（路由表已经没活干了）
    no_more_work = len(assignments) == 0

    # 达到最大迭代
    exceeded = iteration >= max_iter

    done = (all_done and no_more_work) or exceeded

    if done:
        reasons = []
        if all_done: reasons.append("所有 worker 完成")
        if no_more_work: reasons.append("无待派发任务")
        if exceeded: reasons.append(f"达到最大迭代 ({max_iter})")
        log(f"[check_done] 完成: {', '.join(reasons)}")
    else:
        log(f"[check_done] 继续: iteration={iteration}/{max_iter}, all_done={all_done}, pending_assignments={len(assignments)}")

    return {
        "all_done": done,
        "iteration": iteration + 1,
        "log_entries": [f"[check_done] {'DONE' if done else 'CONTINUE'}: iteration={iteration}/{max_iter}, pending={len(assignments)}"],
    }


# ============================================================
# Phase 2 节点: human_approval — interrupt 暂停点
# ============================================================
async def human_approval_node(state: OrchestratorState) -> dict:
    """人工审批节点 — LangGraph interrupt_before 会在此暂停"""
    log("[human_approval] 等待人工审批...")
    return {"log_entries": ["[human_approval] paused for human approval"]}


# ============================================================
# Phase 2 节点: log_execution — 记录执行结果
# ============================================================
async def log_execution(state: OrchestratorState) -> dict:
    """记录 Phase 2 执行结果"""
    mission_id = state.get("mission_id", "unknown")
    lang = state.get("langgraph_decision")

    log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
    os.makedirs(log_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(log_dir, f"execute_{mission_id}_{ts}.json")

    output = {
        "phase": "phase2_execute",
        "mission_id": mission_id,
        "mission_goal": state.get("mission_goal", ""),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "iterations": state.get("iteration", 0),
        "final_decision": {
            "analysis": lang.analysis if lang else "",
            "assignments": lang.assignments if lang else [],
        },
        "dispatch_results": state.get("dispatch_results"),
        "dispatch_error": state.get("dispatch_error"),
    }

    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f"[log_execution] {log_file}")
    return {"log_entries": [f"[log_execution] {log_file}"]}
