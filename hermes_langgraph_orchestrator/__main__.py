#!/usr/bin/env python3
"""
LangGraph Orchestrator — Phase 1 (对比) + Phase 2 (执行)

Phase 1: LangGraph 图结构 vs Swarm 规则引擎
Phase 2: LangGraph 图结构真实编排（循环 + interrupt + dispatch）

用法:
    # Phase 1 对比
    python -m hermes_langgraph_orchestrator --mock --scenario cdc
    python -m hermes_langgraph_orchestrator --mock-collect --scenario cdc

    # Phase 2 执行
    python -m hermes_langgraph_orchestrator --execute --mock-services --scenario cdc

    # Resume after human gate
    python -m hermes_langgraph_orchestrator --execute --resume approved --mission-id <id>
    python -m hermes_langgraph_orchestrator --execute --resume abort --mission-id <id>
"""

import argparse
import asyncio
import os
import sys
import time
import warnings
import logging

# LangGraph checkpoints serialize custom dataclasses via msgpack and warn about
# unregistered modules. The state objects are under our control, so silence the
# non-fatal warning in CLI output.
warnings.filterwarnings(
    "ignore",
    message="Deserializing unregistered type .* from checkpoint",
    category=UserWarning,
)
logging.getLogger("langgraph.checkpoint.serde.jsonplus").setLevel(logging.ERROR)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from langgraph.types import Command

from hermes_langgraph_orchestrator.state import (
    DispatchDecision,
    OrchestratorState,
    WorkerCheckpoint,
    WorkerClassification,
)
from hermes_langgraph_orchestrator.workflow import load_workflow

# ============================================================
# 场景数据
# ============================================================
SCENARIO_RATE_LIMITER = [
    {
        "worker_id": "builder",
        "state": "DONE",
        "result": "实现了 rate_limiter.py，token bucket，14/14 测试通过",
        "files_changed": "src/rate_limiter.py, tests/test_rate_limiter.py",
        "commands_run": "pytest tests/test_rate_limiter.py -v",
        "blocker": "",
        "next_action": "提交给 reviewer 审查",
        "raw": "STATE: DONE\nRESULT: 14/14 tests pass\nNEXT_ACTION: Submit for review",
    },
    {
        "worker_id": "researcher",
        "state": "DONE",
        "result": "调研 3 种方案，推荐 token bucket",
        "files_changed": "",
        "commands_run": "",
        "blocker": "",
        "next_action": "交给 builder 参考",
        "raw": "STATE: DONE\nRESULT: token bucket recommended",
    },
]

# Current Hermes Swarm roster (5 workers): orchestrator, researcher, architect,
# developer, learning.  CDC scenario adapted to use researcher → architect →
# developer loop.
SCENARIO_CDC = [
    {
        "worker_id": "researcher",
        "state": "DONE",
        "result": "CDC+空簧调研完成: digressive_tanh 模型已有，推荐两种结构方案",
        "files_changed": "",
        "commands_run": "",
        "blocker": "",
        "next_action": "交给 architect 设计接口",
        "raw": "STATE: DONE\nRESULT: research complete\nNEXT_ACTION: Architect design",
    },
    {
        "worker_id": "architect",
        "state": "DONE",
        "result": "设计完成: 结构A(独立叠加)和结构B(耦合状态)的接口、数据模型已定义",
        "files_changed": "docs/design/cdc_airspring_architecture.md",
        "commands_run": "",
        "blocker": "",
        "next_action": "developer 实现结构 A",
        "raw": "STATE: DONE\nFILES_CHANGED: docs/design/cdc_airspring_architecture.md\nRESULT: Designs complete\nNEXT_ACTION: Developer implement",
    },
    {
        "worker_id": "developer",
        "state": "BLOCKED",
        "result": "结构 A 实现中: 耦合 ODE 数值不稳定，Dopri5 发散",
        "files_changed": "cdc_airspring_model_a.py (partial)",
        "commands_run": "python cdc_airspring_model_a.py --debug",
        "blocker": "耦合 ODE 数值不稳定: 气压动态与悬架运动时间尺度不匹配(100x)，需改用 implicit solver",
        "next_action": "需要 architect 决定: implicit solver vs quasi-static",
        "raw": "STATE: BLOCKED\nBLOCKER: Coupled ODE numerical instability\nNEXT_ACTION: Architect decide solver",
    },
]

SCENARIOS = {"rate-limiter": SCENARIO_RATE_LIMITER, "cdc": SCENARIO_CDC}


# ============================================================
# Phase 1 mocks
# ============================================================
async def make_mock_collect(scenario: str):
    checkpoints = SCENARIOS.get(scenario, SCENARIO_RATE_LIMITER)

    async def _fn(state: OrchestratorState) -> dict:
        print(f"[mock] 场景: {scenario}, {len(checkpoints)} 个 checkpoint")
        cps = [WorkerCheckpoint(**cp) for cp in checkpoints]  # type: ignore[typeddict-item]
        return {
            "checkpoints": cps,
            "collection_error": None,
            "log_entries": [f"[mock] {len(cps)} checkpoints"],
        }

    return _fn


async def make_mock_classify_phase1(scenario: str):
    if scenario == "cdc":
        classifications = [
            WorkerClassification("researcher", "DONE", "", "", "调研完成", ""),
            WorkerClassification("architect", "DONE", "", "", "设计完成", ""),
            WorkerClassification(
                "developer",
                "BLOCKED",
                "architecture_decision",
                "耦合ODE数值不稳定",
                "数值方法选择是架构决策",
                "",
            ),
        ]
    else:
        classifications = [
            WorkerClassification("builder", "DONE", "", "", "实现完成", ""),
            WorkerClassification("researcher", "DONE", "", "", "调研完成", ""),
        ]

    async def _fn(state: OrchestratorState) -> dict:
        print(f"[mock-classify] {len(classifications)} workers")
        return {
            "classifications": classifications,
            "log_entries": [f"[mock-classify] {len(classifications)} workers"],
        }

    return _fn


async def make_mock_swarm(scenario: str):
    if scenario == "cdc":
        analysis = "Swarm: researcher→architect, architect→developer, developer→human"
        assignments = [
            {"worker_id": "architect", "task": "Design CDC+airspring interface...", "reason": "regex(nextAction)"},
            {"worker_id": "developer", "task": "Implement structure A...", "reason": "regex(nextAction)"},
        ]
        needs_human = True
    else:
        analysis = "Swarm: builder→reviewer, researcher→skip"
        assignments = [
            {"worker_id": "reviewer", "task": "Review rate_limiter.py...", "reason": "Autopilot review gate"}
        ]
        needs_human = False

    async def _fn(state: OrchestratorState) -> dict:
        print(f"[mock-swarm] {len(assignments)} assignments")
        return {
            "swarm_decision": DispatchDecision(
                source="swarm",
                analysis=analysis,
                assignments=assignments,
                human_approval_required=needs_human,
            ),
            "log_entries": [f"[mock-swarm] {len(assignments)} assignments"],
        }

    return _fn


# ============================================================
# Phase 2 mocks
# ============================================================
def _find_scenario_checkpoint(scenario: str, worker_id: str, call: int) -> dict | None:
    """Return the appropriate checkpoint for a worker on its Nth dispatch."""
    if scenario == "cdc":
        if worker_id == "researcher":
            return next((cp for cp in SCENARIO_CDC if cp["worker_id"] == "researcher"), None)
        if worker_id == "architect":
            # First dispatch: plain DONE; second dispatch (review) : approved.
            cp = next((cp for cp in SCENARIO_CDC if cp["worker_id"] == "architect"), None)
            if cp and call >= 2:
                cp2 = dict(cp)
                cp2["result"] = "最终审查通过: 实现符合设计，测试通过"
                cp2["next_action"] = "任务完成"
                cp2["raw"] = "STATE: DONE\nRESULT: approved\nNEXT_ACTION: done"
                return cp2
            return cp
        if worker_id == "developer":
            # First dispatch: BLOCKED; retry: DONE.
            cp = next((cp for cp in SCENARIO_CDC if cp["worker_id"] == "developer"), None)
            if cp and call >= 2:
                cp2 = dict(cp)
                cp2["state"] = "DONE"
                cp2["blocker"] = ""
                cp2["result"] = "结构 A 实现完成: cdc_airspring_model_a.py, 8/8 测试通过, jit/vmap 兼容"
                cp2["files_changed"] = "cdc_airspring_model_a.py, test_model_a.py"
                cp2["commands_run"] = "pytest test_model_a.py -v"
                cp2["next_action"] = "交给 architect 最终审查"
                cp2["raw"] = "STATE: DONE\nFILES_CHANGED: cdc_airspring_model_a.py\nRESULT: 8/8 tests pass\nNEXT_ACTION: Architect review"
                return cp2
            return cp
        return None

    # rate-limiter scenario (uses old builder/reviewer roster for Phase 1 smoke)
    return next((cp for cp in SCENARIOS.get(scenario, []) if cp["worker_id"] == worker_id), None)


async def make_mock_dispatch(scenario: str):
    """Mock dispatch_assignments: returns checkpoint(s) for assigned workers.

    Call count is derived from persisted dispatched_workers so resume works
    across process restarts.
    """

    async def _fn(state: OrchestratorState) -> dict:
        assignments = state.get("langgraph_assignments", [])
        if not assignments:
            return {
                "dispatch_results": None,
                "checkpoints": [],
                "dispatch_error": None,
                "log_entries": ["[mock-dispatch] 无 assignments"],
            }

        dispatch_counts = dict(state.get("dispatch_counts", {}) or {})
        checkpoints: list[WorkerCheckpoint] = []
        for a in assignments:
            wid = a["worker_id"]
            call = dispatch_counts.get(wid, 0) + 1
            cp = _find_scenario_checkpoint(scenario, wid, call)
            if cp:
                checkpoints.append(WorkerCheckpoint(**cp))  # type: ignore[typeddict-item]
            dispatch_counts[wid] = call

        print(f"[mock-dispatch] {len(checkpoints)} checkpoints for {len(assignments)} assignments")
        return {
            "dispatch_results": {"results": []},
            "checkpoints": checkpoints,
            "dispatch_error": None,
            "dispatch_counts": dispatch_counts,
            "log_entries": [f"[mock-dispatch] {len(checkpoints)} checkpoints"],
        }

    return _fn


async def make_mock_classify_phase2(scenario: str):
    """Classify based on the single checkpoint returned by mock dispatch."""

    async def _fn(state: OrchestratorState) -> dict:
        checkpoints = state.get("checkpoints", [])
        if not checkpoints:
            return {"classifications": [], "log_entries": ["[mock-classify] 无 checkpoint"]}

        cp = checkpoints[0]
        wid = cp["worker_id"]
        state_label = cp["state"]
        blocker = cp.get("blocker", "")

        if wid == "developer" and state_label == "BLOCKED":
            classifications = [
                WorkerClassification(
                    wid,
                    "BLOCKED",
                    "architecture_decision",
                    blocker or "耦合ODE数值不稳定",
                    "数值方法选择是架构决策",
                    "",
                )
            ]
        elif wid == "architect" and "approved" in (cp.get("result", "")).lower():
            classifications = [
                WorkerClassification(wid, "DONE", "", "", "最终审查通过", "approved")
            ]
        else:
            classifications = [WorkerClassification(wid, state_label, "", "", "mock classify", "")]

        summary = ", ".join(f"{c.worker_id}={c.verdict}" for c in classifications)
        print(f"[mock-classify] {summary}")
        return {
            "classifications": classifications,
            "log_entries": [f"[mock-classify] {summary}"],
        }

    return _fn


async def make_mock_init_mission(scenario: str):
    """Mock init_mission: load default workflow and a 5-worker roster."""

    async def _fn(state: OrchestratorState) -> dict:
        workflow_spec = state.get("workflow_spec") or load_workflow(
            state.get("workflow_path") or ""
        ) if state.get("workflow_path") else None
        if workflow_spec is None:
            from hermes_langgraph_orchestrator.workflow import load_default_workflow

            workflow_spec = load_default_workflow()

        roster_ids = {"orchestrator", "researcher", "architect", "developer", "learning"}
        assignments = state.get("langgraph_assignments", [])
        if not assignments:
            assignments = [
                {
                    "worker_id": workflow_spec.entry,
                    "task": state.get("mission_goal", ""),
                    "reason": f"workflow entry: {workflow_spec.entry}",
                }
            ]

        print(f"[mock-init] workflow={workflow_spec.name}, entry={workflow_spec.entry}")
        return {
            "roster_snapshot": sorted(roster_ids),
            "workflow_spec": workflow_spec,
            "terminal_docs_enabled": workflow_spec.settings.terminal_docs,
            "langgraph_assignments": assignments,
            "log_entries": [f"[mock-init] workflow={workflow_spec.name}, roster={len(roster_ids)} workers"],
        }

    return _fn


async def make_mock_ensure_sessions():
    async def _fn(state: OrchestratorState) -> dict:
        workers = sorted({a["worker_id"] for a in state.get("langgraph_assignments", []) if a.get("worker_id")})
        print(f"[mock-ensure] {workers}")
        return {"log_entries": [f"[mock-ensure] {', '.join(workers)}"]}

    return _fn


# ============================================================
# Resume helpers
# ============================================================
def build_resume_command(state: OrchestratorState, action: str) -> Command:
    """Build a LangGraph Command to resume from the human_approval interrupt."""
    pending = state.get("pending_human_assignments", []) or []
    if action == "approved":
        # Move pending human assignments into the dispatch queue and clear pending.
        return Command(
            update={
                "langgraph_assignments": pending,
                "pending_human_assignments": [],
                "human_resume_action": "approved",
            }
        )
    if action == "abort":
        # Clear pending work and jump straight to finalize.
        return Command(
            update={
                "pending_human_assignments": [],
                "langgraph_assignments": [],
                "human_resume_action": "abort",
                "all_done": True,
            },
            goto="finalize_mission",
        )
    raise ValueError(f"Unsupported resume action: {action}")


# ============================================================
# CLI
# ============================================================
async def main():
    parser = argparse.ArgumentParser(description="LangGraph Orchestrator")
    parser.add_argument("--mock", action="store_true", help="全部 mock (Phase 1)")
    parser.add_argument("--mock-collect", action="store_true", help="mock checkpoint，真实 LLM (Phase 1)")
    parser.add_argument("--execute", action="store_true", help="Phase 2: 真实编排执行")
    parser.add_argument("--mock-services", action="store_true", help="Phase 2: mock init/ensure/dispatch (用于 CI/无 API 环境)")
    parser.add_argument("--scenario", type=str, default="cdc", choices=["rate-limiter", "cdc"])
    parser.add_argument("--mission-id", type=str, default="", help="mission ID，默认自动生成唯一 ID")
    parser.add_argument("--goal", type=str, default="")
    parser.add_argument("--swarm-url", type=str, default="http://localhost:3000/api")
    parser.add_argument("--workflow", type=str, default="", help="workflow YAML 路径，默认 cdc.yaml")
    parser.add_argument(
        "--initial-workers",
        type=str,
        default="",
        help="初始派发的 worker 列表，逗号分隔。如 'researcher' 或 'architect,developer'",
    )
    parser.add_argument("--max-iterations", type=int, default=5)
    parser.add_argument(
        "--checkpoint-path",
        type=str,
        default="",
        help="SQLite checkpointer 路径，默认 ~/.hermes/langgraph-checkpoints.db",
    )
    parser.add_argument(
        "--resume",
        type=str,
        default="",
        choices=["", "approved", "abort"],
        help="从 human_approval 中断点恢复",
    )
    args = parser.parse_args()

    scenario = args.scenario
    mission_id = args.mission_id or f"mission-{int(time.time())}"
    goal = args.goal or {
        "rate-limiter": "为 API 服务添加 rate limiter",
        "cdc": "设计并开发 CDC+空簧 的物理模型，用 JAX 构建",
    }[scenario]

    phase = "Phase 2 (执行)" if args.execute else "Phase 1 (对比)"
    mode = "全部 mock" if args.mock else "mock services" if args.mock_services else "真实 LLM + mock collect" if args.mock_collect else "真实 LLM + 真实 API"

    print("=" * 60)
    print(f"LangGraph Orchestrator — {phase}")
    print(f"场景: {scenario}")
    print("=" * 60)
    print(f"  Goal: {goal}")
    print(f"  Mode: {mode}")
    print(f"  Max iterations: {args.max_iterations}")
    if args.workflow:
        print(f"  Workflow: {args.workflow}")
    print()

    if args.execute:
        from hermes_langgraph_orchestrator.graph import build_phase2_graph
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        initial_tasks: list[dict] = []
        if args.initial_workers:
            workers = [w.strip() for w in args.initial_workers.split(",") if w.strip()]
            initial_tasks = [
                {"worker_id": w, "task": goal, "reason": f"初始派发: {w}"}
                for w in workers
            ]

        checkpoint_path = getattr(args, "checkpoint_path", None)
        if not checkpoint_path:
            checkpoint_dir = os.path.expanduser("~/.hermes")
            os.makedirs(checkpoint_dir, exist_ok=True)
            checkpoint_path = os.path.join(checkpoint_dir, "langgraph-checkpoints.db")

        config = {"configurable": {"thread_id": mission_id}}

        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                classify_fn=(await make_mock_classify_phase2(scenario)) if args.mock_services else None,
                dispatch_fn=(await make_mock_dispatch(scenario)) if args.mock_services else None,
                init_fn=(await make_mock_init_mission(scenario)) if args.mock_services else None,
                ensure_fn=(await make_mock_ensure_sessions()) if args.mock_services else None,
                checkpointer=saver,
            )

            if args.resume:
                current_state = await graph.aget_state(config)
                if current_state is None or current_state.values is None:
                    print(f"\n❌ 找不到 mission {mission_id} 的状态，无法恢复")
                    sys.exit(1)
                command = build_resume_command(current_state.values, args.resume)
                print(f"▶ Phase 2 恢复 (action={args.resume})...\n")
                try:
                    result = await graph.ainvoke(command, config)  # type: ignore[arg-type]
                except Exception as e:
                    print(f"\n❌ 恢复失败: {e}")
                    import traceback

                    traceback.print_exc()
                    sys.exit(1)
            else:
                initial: OrchestratorState = {
                    "mission_id": mission_id,
                    "mission_goal": goal,
                    "swarm_api_url": args.swarm_url,
                    "workflow_path": args.workflow or None,
                    "checkpoints": [],
                    "terminal_checkpoints": [],
                    "collection_error": None,
                    "classifications": [],
                    "langgraph_assignments": initial_tasks,
                    "langgraph_needs_human": False,
                    "langgraph_decision": None,
                    "dispatched_workers": [],
                    "pending_human_assignments": [],
                    "dispatch_counts": {},
                    "transition_counts": {},
                    "awaiting_checkpoint": False,
                    "dispatch_results": None,
                    "dispatch_error": None,
                    "wait_attempts": 0,
                    "all_done": False,
                    "iteration": 0,
                    "max_iterations": args.max_iterations,
                    "phase": "phase2_execute",
                    "log_entries": [],
                }
                print(f"▶ Phase 2 执行开始...\n")
                try:
                    result = await graph.ainvoke(initial, config)  # type: ignore[arg-type]
                except Exception as e:
                    print(f"\n❌ 失败: {e}")
                    import traceback

                    traceback.print_exc()
                    sys.exit(1)

            print("\n" + "=" * 60)
            print("Phase 2 结果")
            print("=" * 60)

            lang = result.get("langgraph_decision")
            if lang:
                print(f"\n🧠 最终编排决策:")
                print(f"   派发: {len(lang.assignments)} 项")
                for a in lang.assignments:
                    print(f"     → {a['worker_id']}: {a.get('reason', '')[:100]}")

            print(f"\n📊 执行统计:")
            print(f"   迭代次数: {result.get('iteration', 0)}")
            print(f"   终止: {result.get('all_done', False)}")
            print(f"   派发结果: {'成功' if result.get('dispatch_results') else '未执行/mock'}")
            if result.get("dispatch_error"):
                print(f"   派发错误: {result['dispatch_error']}")

            logs = result.get("log_entries", [])
            if logs:
                print(f"\n📋 日志 ({len(logs)} 条):")
                for l in logs:
                    print(f"   {l}")

            print(f"\n✅ Phase 2 完成。详细: logs/execute_*.json")

    else:
        from hermes_langgraph_orchestrator.graph import build_phase1_graph

        graph = build_phase1_graph(
            collect_fn=(await make_mock_collect(scenario)) if (args.mock or args.mock_collect) else None,
            swarm_fn=(await make_mock_swarm(scenario)) if args.mock else None,
            init_fn=(await make_mock_init_mission(scenario)) if args.mock else None,
        )

        if args.mock:
            # Replace classify with mock too.
            from hermes_langgraph_orchestrator import nodes as graph_nodes

            graph_nodes.classify_workers = await make_mock_classify_phase1(scenario)  # type: ignore[assignment]
            graph = build_phase1_graph(
                collect_fn=await make_mock_collect(scenario),
                swarm_fn=await make_mock_swarm(scenario),
                init_fn=await make_mock_init_mission(scenario),
            )

        initial: OrchestratorState = {
            "mission_id": mission_id,
            "mission_goal": goal,
            "swarm_api_url": args.swarm_url,
            "workflow_path": args.workflow or None,
            "checkpoints": [],
            "terminal_checkpoints": [],
            "collection_error": None,
            "classifications": [],
            "langgraph_assignments": [],
            "langgraph_needs_human": False,
            "swarm_decision": None,
            "langgraph_decision": None,
            "comparison": None,
            "iteration": 0,
            "max_iterations": 1,
            "phase": "phase1_compare",
            "log_entries": [],
        }

        print("▶ Phase 1 对比开始...\n")

        try:
            result = await graph.ainvoke(initial, {"configurable": {"thread_id": mission_id}})  # type: ignore[arg-type]
        except Exception as e:
            print(f"\n❌ 失败: {e}")
            import traceback

            traceback.print_exc()
            sys.exit(1)

        print("\n" + "=" * 60)
        print("Phase 1 结果")
        print("=" * 60)

        lang = result.get("langgraph_decision")
        if lang:
            print(f"\n🧠 LangGraph 图结构编排 (LLM classify + workflow 路由):")
            print(f"   派发: {len(lang.assignments)} 项, 需人工: {lang.human_approval_required}")
            for a in lang.assignments:
                print(f"     → {a['worker_id']}: {a.get('reason', '')[:100]}")
            if lang.metadata.get("classifications"):
                parts = [
                    f"{c['worker_id']}={c['verdict']}"
                    + (f"({c['blocker_type']})" if c.get("blocker_type") else "")
                    for c in lang.metadata["classifications"]
                ]
                print(f"   分类: {', '.join(parts)}")

        swarm = result.get("swarm_decision")
        if swarm:
            print(f"\n🔧 Hermes Swarm 规则引擎:")
            print(f"   派发: {len(swarm.assignments)} 项, 需人工: {swarm.human_approval_required}")
            for a in swarm.assignments:
                print(f"     → {a['worker_id']}: {a.get('reason', '')[:100]}")

        comp = result.get("comparison", {})
        if comp:
            print(f"\n🔍 对比:")
            print(f"   一致: {comp.get('agreement', {}).get('count', 0)} 项")
            div = comp.get("divergence", {})
            print(f"   Swarm 独有: {len(div.get('swarm_only', []))} 项")
            print(f"   LangGraph 独有: {len(div.get('langgraph_only', []))} 项")
            print(f"   摘要: {comp.get('summary', 'N/A')}")

        logs = result.get("log_entries", [])
        if logs:
            print(f"\n📋 日志 ({len(logs)} 条):")
            for l in logs:
                print(f"   {l}")

        print(f"\n✅ Phase 1 完成。详细: logs/compare_*.json")


if __name__ == "__main__":
    asyncio.run(main())
