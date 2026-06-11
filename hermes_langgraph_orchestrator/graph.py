"""
LangGraph Orchestrator Graph — Phase 1 + Phase 2

Phase 1 (对比): collect → classify → dispatch → compare_and_log (with swarm parallel)
Phase 2 (执行): 状态感知路由 + 循环编排

  START → start_workers → initial_dispatch → classify → dispatch
    → [human?] → dispatch_to_swarm → classify → ... (loop until done or max_iter)

initial_dispatch 和 dispatch_to_swarm 都 waitForCheckpoint=true，
返回时 checkpoint 已在响应中，直接进 classify。
"""

from datetime import datetime, timezone

from langgraph.graph import StateGraph, START, END
from langgraph.graph.state import CompiledStateGraph
from langgraph.checkpoint.memory import MemorySaver

from .state import OrchestratorState
from .nodes import (
    collect_checkpoints, classify_workers, langgraph_dispatch,
    swarm_orchestrate, compare_decisions, log_results,
    start_workers, initial_dispatch, dispatch_to_swarm,
    human_approval_node,
)


def build_phase1_graph(collect_fn=None, swarm_fn=None) -> CompiledStateGraph:
    graph = StateGraph(OrchestratorState)
    graph.add_node("collect", collect_fn if collect_fn else collect_checkpoints)  # type: ignore[arg-type]
    graph.add_node("classify", classify_workers)  # type: ignore[arg-type]
    graph.add_node("dispatch", langgraph_dispatch)  # type: ignore[arg-type]
    graph.add_node("swarm", swarm_fn if swarm_fn else swarm_orchestrate)  # type: ignore[arg-type]
    graph.add_node("compare_and_log", _compare_and_log)  # type: ignore[arg-type]
    graph.add_edge(START, "collect")
    graph.add_edge("collect", "classify")
    graph.add_edge("collect", "swarm")
    graph.add_edge("classify", "dispatch")
    graph.add_edge("dispatch", "compare_and_log")
    graph.add_edge("swarm", "compare_and_log")
    graph.add_edge("compare_and_log", END)
    return graph.compile()


def build_phase2_graph(collect_fn=None, classify_fn=None) -> CompiledStateGraph:
    """Phase 2: 状态感知路由 + 循环编排。

    START → start_workers → initial_dispatch → classify → dispatch
      → [human?] → dispatch_to_swarm → classify → ... (loop)
      → [done?] → END
    """
    graph = StateGraph(OrchestratorState)

    graph.add_node("start_workers", start_workers)  # type: ignore[arg-type]
    graph.add_node("initial_dispatch", initial_dispatch)  # type: ignore[arg-type]
    graph.add_node("classify", classify_fn if classify_fn else classify_workers)  # type: ignore[arg-type]
    graph.add_node("dispatch", langgraph_dispatch)  # type: ignore[arg-type]
    graph.add_node("human_approval", human_approval_node)  # type: ignore[arg-type]
    graph.add_node("dispatch_to_swarm", dispatch_to_swarm)  # type: ignore[arg-type]

    # START → start_workers → initial_dispatch → classify → dispatch
    graph.add_edge(START, "start_workers")
    graph.add_edge("start_workers", "initial_dispatch")
    graph.add_edge("initial_dispatch", "classify")
    graph.add_edge("classify", "dispatch")

    # dispatch → 条件路由
    def route_after_dispatch(state: OrchestratorState) -> str:
        if state.get("langgraph_needs_human", False):
            return "human_approval"

        assignments = state.get("langgraph_assignments", [])
        iteration = state.get("iteration", 0)
        max_iter = state.get("max_iterations", 5)

        if len(assignments) == 0 or iteration >= max_iter:
            return END

        return "dispatch_to_swarm"

    graph.add_conditional_edges("dispatch", route_after_dispatch, {
        "human_approval": "human_approval",
        "dispatch_to_swarm": "dispatch_to_swarm",
        END: END,
    })

    graph.add_edge("human_approval", "dispatch_to_swarm")

    # dispatch_to_swarm → classify（checkpoint 已在响应中）
    graph.add_edge("dispatch_to_swarm", "classify")

    memory = MemorySaver()
    return graph.compile(
        checkpointer=memory,
        interrupt_before=["human_approval"],
    )


async def _compare_and_log(state: OrchestratorState) -> dict:
    swarm = state.get("swarm_decision")
    lang = state.get("langgraph_decision")
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] [fan-in] swarm={'OK' if swarm else 'waiting'}, langgraph={'OK' if lang else 'waiting'}")
    if not swarm or not lang:
        return {"log_entries": [f"[fan-in] waiting"]}
    cmp_result = await compare_decisions(state)
    log_result = await log_results({**state, **cmp_result})
    return {**cmp_result, **log_result}


phase1_graph = build_phase1_graph()
phase2_graph = build_phase2_graph()
