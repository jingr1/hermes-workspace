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
    python -m hermes_langgraph_orchestrator --execute --mock-collect --scenario cdc
"""

import argparse, asyncio, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hermes_langgraph_orchestrator.state import (
    OrchestratorState, WorkerCheckpoint, DispatchDecision, WorkerClassification
)

# ============================================================
# 场景数据
# ============================================================
SCENARIO_RATE_LIMITER = [
    {"worker_id": "builder", "state": "DONE",
     "result": "实现了 rate_limiter.py，token bucket，14/14 测试通过",
     "files_changed": "src/rate_limiter.py, tests/test_rate_limiter.py",
     "commands_run": "pytest tests/test_rate_limiter.py -v",
     "blocker": "", "next_action": "提交给 reviewer 审查",
     "raw": "STATE: DONE\nRESULT: 14/14 tests pass\nNEXT_ACTION: Submit for review"},
    {"worker_id": "researcher", "state": "DONE",
     "result": "调研 3 种方案，推荐 token bucket",
     "files_changed": "", "commands_run": "",
     "blocker": "", "next_action": "交给 builder 参考",
     "raw": "STATE: DONE\nRESULT: token bucket recommended"},
]

SCENARIO_CDC = [
    {"worker_id": "researcher", "state": "DONE",
     "result": "CDC+空簧调研完成: digressive_tanh 模型已有，推荐两种结构方案",
     "files_changed": "", "commands_run": "",
     "blocker": "", "next_action": "交给 architect 设计接口",
     "raw": "STATE: DONE\nRESULT: research complete\nNEXT_ACTION: Architect design"},
    {"worker_id": "architect", "state": "DONE",
     "result": "设计完成: 结构A(独立叠加)和结构B(耦合状态)的接口、数据模型已定义",
     "files_changed": "docs/design/cdc_airspring_architecture.md",
     "commands_run": "", "blocker": "",
     "next_action": "builder 实现结构 A，developer 实现结构 B",
     "raw": "STATE: DONE\nFILES_CHANGED: docs/design/cdc_airspring_architecture.md\nRESULT: Two designs complete\nNEXT_ACTION: Builder + Developer implement"},
    {"worker_id": "builder", "state": "DONE",
     "result": "结构 A 实现完成: cdc_airspring_model_a.py, 8/8 测试通过, jit/vmap 兼容",
     "files_changed": "cdc_airspring_model_a.py, test_model_a.py",
     "commands_run": "pytest test_model_a.py -v",
     "blocker": "", "next_action": "需要 reviewer 审查",
     "raw": "STATE: DONE\nFILES_CHANGED: cdc_airspring_model_a.py\nRESULT: 8/8 tests pass\nNEXT_ACTION: Reviewer verify"},
    {"worker_id": "developer", "state": "BLOCKED",
     "result": "结构 B 实现中: 耦合 ODE 数值不稳定，Dopri5 发散",
     "files_changed": "cdc_airspring_model_b.py (partial)",
     "commands_run": "python cdc_airspring_model_b.py --debug",
     "blocker": "耦合 ODE 数值不稳定: 气压动态与悬架运动时间尺度不匹配(100x)，需改用 implicit solver",
     "next_action": "需要 architect 决定: implicit solver vs quasi-static",
     "raw": "STATE: BLOCKED\nBLOCKER: Coupled ODE numerical instability\nNEXT_ACTION: Architect decide solver"},
]

SCENARIOS = {"rate-limiter": SCENARIO_RATE_LIMITER, "cdc": SCENARIO_CDC}


async def make_mock_collect(scenario: str):
    checkpoints = SCENARIOS.get(scenario, SCENARIO_RATE_LIMITER)
    async def _fn(state: OrchestratorState) -> dict:
        print(f"[mock] 场景: {scenario}, {len(checkpoints)} 个 checkpoint")
        cps = [WorkerCheckpoint(**cp) for cp in checkpoints]  # type: ignore[typeddict-item]
        return {"checkpoints": cps, "collection_error": None, "log_entries": [f"[mock] {len(cps)} checkpoints"]}
    return _fn


async def make_mock_classify(scenario: str):
    """Mock classify: 根据已派发状态模拟多轮，包含 review_outcome"""
    call_count = [0]

    async def _fn(state: OrchestratorState) -> dict:
        call_count[0] += 1
        round_num = call_count[0]

        if scenario == "cdc":
            if round_num == 1:
                classifications = [
                    WorkerClassification("researcher", "DONE", "", "", "调研完成", ""),
                    WorkerClassification("architect", "DONE", "", "", "设计完成", ""),
                    WorkerClassification("builder", "DONE", "", "", "实现完成", ""),
                    WorkerClassification("developer", "BLOCKED", "architecture_decision",
                                         "耦合ODE数值不稳定", "数值方法选择是架构决策", ""),
                ]
            elif round_num == 2:
                # architect 审查 developer → changes_requested
                classifications = [
                    WorkerClassification("architect", "DONE", "", "", "审查完成，需要修改", "changes_requested"),
                ]
            elif round_num == 3:
                # developer 修改后重新提交 → architect 审查通过
                classifications = [
                    WorkerClassification("developer", "DONE", "", "", "修改完成", ""),
                ]
            else:
                # architect 最终审查通过
                classifications = [
                    WorkerClassification("architect", "DONE", "", "", "最终审查通过", "approved"),
                ]
        else:
            if round_num == 1:
                classifications = [
                    WorkerClassification("builder", "DONE", "", "", "实现完成", ""),
                    WorkerClassification("researcher", "DONE", "", "", "调研完成", ""),
                ]
            else:
                classifications = [
                    WorkerClassification("builder", "DONE", "", "", "实现完成", ""),
                    WorkerClassification("researcher", "DONE", "", "", "调研完成", ""),
                    WorkerClassification("reviewer", "DONE", "", "", "审查完成", ""),
                ]

        print(f"[mock-classify] round {round_num}: {', '.join(f'{c.worker_id}={c.verdict}' + (f'({c.review_outcome})' if c.review_outcome else '') for c in classifications)}")
        return {"classifications": classifications, "log_entries": [f"[mock-classify] round {round_num}: {len(classifications)} workers"]}
    return _fn


async def make_mock_swarm(scenario: str):
    if scenario == "cdc":
        analysis = "Swarm: builder→reviewer, architect→builder, researcher→skip, developer→ignore"
        assignments = [
            {"worker_id": "builder", "task": "Continue architect's design...", "reason": "regex(nextAction)"},
            {"worker_id": "reviewer", "task": "Review builder's structure A...", "reason": "Autopilot review gate"},
        ]
        needs_human = True
    else:
        analysis = "Swarm: builder→reviewer, researcher→skip"
        assignments = [{"worker_id": "reviewer", "task": "Review rate_limiter.py...", "reason": "Autopilot review gate"}]
        needs_human = False

    async def _fn(state: OrchestratorState) -> dict:
        print(f"[mock-swarm] {len(assignments)} assignments")
        return {"swarm_decision": DispatchDecision(source="swarm", analysis=analysis,
                assignments=assignments, human_approval_required=needs_human),
                "log_entries": [f"[mock-swarm] {len(assignments)} assignments"]}
    return _fn


async def main():
    parser = argparse.ArgumentParser(description="LangGraph Orchestrator")
    parser.add_argument("--mock", action="store_true", help="全部 mock")
    parser.add_argument("--mock-collect", action="store_true", help="mock checkpoint，真实 LLM")
    parser.add_argument("--execute", action="store_true", help="Phase 2: 真实编排执行")
    parser.add_argument("--scenario", type=str, default="cdc", choices=["rate-limiter", "cdc"])
    parser.add_argument("--mission-id", type=str, default="",
                        help="mission ID，默认自动生成唯一 ID")
    parser.add_argument("--goal", type=str, default="")
    parser.add_argument("--swarm-url", type=str, default="http://localhost:3000/api")
    parser.add_argument("--initial-workers", type=str, default="",
                        help="初始派发的 worker 列表，逗号分隔。如 'researcher' 或 'architect,developer'")
    parser.add_argument("--max-iterations", type=int, default=5)
    args = parser.parse_args()

    scenario = args.scenario
    mission_id = args.mission_id or f"mission-{int(time.time())}"
    goal = args.goal or {
        "rate-limiter": "为 API 服务添加 rate limiter",
        "cdc": "设计并开发 CDC+空簧 的物理模型，用 JAX 构建",
    }[scenario]

    phase = "Phase 2 (执行)" if args.execute else "Phase 1 (对比)"
    mode = "全部 mock" if args.mock else "真实 LLM + mock collect" if args.mock_collect else "真实 LLM + 真实 API"

    print("=" * 60)
    print(f"LangGraph Orchestrator — {phase}")
    print(f"场景: {scenario}")
    print("=" * 60)
    print(f"  Goal: {goal}")
    print(f"  Mode: {mode}")
    print(f"  Max iterations: {args.max_iterations}")
    print()

    use_mock_collect = args.mock or args.mock_collect

    if args.execute:
        # Phase 2
        from hermes_langgraph_orchestrator.graph import build_phase2_graph

        # 构建初始任务列表
        if args.initial_workers:
            # 命令行指定
            workers = [w.strip() for w in args.initial_workers.split(",") if w.strip()]
            initial_tasks = [
                {"worker_id": w, "task": goal, "reason": f"初始派发: {w}"}
                for w in workers
            ]
        elif scenario == "cdc":
            initial_tasks = [
                {"worker_id": "researcher", "task": "调研 CDC+空簧 物理模型方案，分析现有 cdc_core.py 代码，输出调研报告。",
                 "reason": "初始派发: 调研"},
            ]
        else:
            initial_tasks = [
                {"worker_id": "builder", "task": "实现 rate limiter，使用 token bucket 算法，包含测试。",
                 "reason": "初始派发: 实现"},
            ]

        graph = build_phase2_graph(
            collect_fn=await make_mock_collect(scenario) if use_mock_collect else None,
            classify_fn=await make_mock_classify(scenario) if args.mock else None,
        )

        initial: OrchestratorState = {
            "mission_id": mission_id, "mission_goal": goal,
            "swarm_api_url": args.swarm_url,
            "checkpoints": [], "collection_error": None,
            "classifications": [], "langgraph_assignments": initial_tasks,
            "langgraph_needs_human": False, "langgraph_decision": None,
            "dispatched_workers": [],
            "dispatch_results": None, "dispatch_error": None,
            "wait_attempts": 0, "all_done": False,
            "iteration": 0, "max_iterations": args.max_iterations,
            "phase": "phase2_execute", "log_entries": [],
        }

        print(f"▶ Phase 2 执行开始 (初始派发 {len(initial_tasks)} 个任务)...\n")

        config = {"configurable": {"thread_id": mission_id}}

        try:
            result = await graph.ainvoke(initial, config)  # type: ignore[arg-type]
        except Exception as e:
            print(f"\n❌ 失败: {e}")
            import traceback; traceback.print_exc()
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
        print(f"   等待轮询: {result.get('wait_attempts', 0)}")
        print(f"   派发结果: {'成功' if result.get('dispatch_results') else '未执行'}")
        if result.get("dispatch_error"):
            print(f"   派发错误: {result['dispatch_error']}")

        logs = result.get("log_entries", [])
        if logs:
            print(f"\n📋 日志 ({len(logs)} 条):")
            for l in logs: print(f"   {l}")

        print(f"\n✅ Phase 2 完成。详细: logs/execute_*.json")

    else:
        # Phase 1
        from hermes_langgraph_orchestrator.graph import build_phase1_graph

        graph = build_phase1_graph(
            collect_fn=await make_mock_collect(scenario) if use_mock_collect else None,
            swarm_fn=await make_mock_swarm(scenario) if args.mock else None,
        )

        if args.mock:
            from hermes_langgraph_orchestrator import nodes as graph_nodes
            graph_nodes.classify_workers = await make_mock_classify(scenario)  # type: ignore[assignment]
            graph = build_phase1_graph(
                collect_fn=await make_mock_collect(scenario),
                swarm_fn=await make_mock_swarm(scenario),
            )

        initial: OrchestratorState = {
            "mission_id": mission_id, "mission_goal": goal,
            "swarm_api_url": args.swarm_url,
            "checkpoints": [], "collection_error": None,
            "classifications": [], "langgraph_assignments": [],
            "langgraph_needs_human": False,
            "swarm_decision": None, "langgraph_decision": None,
            "comparison": None, "iteration": 0, "max_iterations": 1,
            "phase": "phase1_compare", "log_entries": [],
        }

        print("▶ Phase 1 对比开始...\n")

        try:
            result = await graph.ainvoke(initial, {"configurable": {"thread_id": mission_id}})  # type: ignore[arg-type]
        except Exception as e:
            print(f"\n❌ 失败: {e}")
            import traceback; traceback.print_exc()
            sys.exit(1)

        print("\n" + "=" * 60)
        print("Phase 1 结果")
        print("=" * 60)

        lang = result.get("langgraph_decision")
        if lang:
            print(f"\n🧠 LangGraph 图结构编排 (LLM classify + 纯函数路由表):")
            print(f"   派发: {len(lang.assignments)} 项, 需人工: {lang.human_approval_required}")
            for a in lang.assignments:
                print(f"     → {a['worker_id']}: {a.get('reason', '')[:100]}")
            if lang.metadata.get("classifications"):
                parts = [f"{c['worker_id']}={c['verdict']}" + (f"({c['blocker_type']})" if c.get('blocker_type') else "")
                         for c in lang.metadata["classifications"]]
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
            for l in logs: print(f"   {l}")

        print(f"\n✅ Phase 1 完成。详细: logs/compare_*.json")


if __name__ == "__main__":
    asyncio.run(main())
