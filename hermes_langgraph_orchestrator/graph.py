"""
LangGraph Orchestrator Graph — Phase 1 + Phase 2

Phase 1 (对比): init → collect → classify → route → compare (with swarm parallel)
Phase 2 (执行): init → ensure → dispatch → classify → route → [human | finalize | dispatch]
"""

from datetime import datetime, timezone

from langgraph.graph import StateGraph, START, END
from langgraph.graph.state import CompiledStateGraph
from langgraph.checkpoint.memory import MemorySaver

from .state import OrchestratorState
from .nodes import (
    collect_checkpoints,
    classify_workers,
    route_workflow,
    swarm_orchestrate,
    compare_decisions,
    log_results,
    init_mission,
    ensure_sessions,
    dispatch_assignments,
    human_approval_node,
    finalize_mission,
)


def build_phase1_graph(collect_fn=None, swarm_fn=None, init_fn=None) -> CompiledStateGraph:
    """Phase 1: compare LangGraph routing against Swarm orchestrator-loop."""
    graph = StateGraph(OrchestratorState)
    graph.add_node("init", init_fn if init_fn else init_mission)  # type: ignore[arg-type]
    graph.add_node("collect", collect_fn if collect_fn else collect_checkpoints)  # type: ignore[arg-type]
    graph.add_node("classify", classify_workers)  # type: ignore[arg-type]
    graph.add_node("route", route_workflow)  # type: ignore[arg-type]
    graph.add_node("swarm", swarm_fn if swarm_fn else swarm_orchestrate)  # type: ignore[arg-type]
    graph.add_node("compare_and_log", _compare_and_log)  # type: ignore[arg-type]

    graph.add_edge(START, "init")
    graph.add_edge("init", "collect")
    graph.add_edge("init", "swarm")
    graph.add_edge("collect", "classify")
    graph.add_edge("classify", "route")
    graph.add_edge("route", "compare_and_log")
    graph.add_edge("swarm", "compare_and_log")
    graph.add_edge("compare_and_log", END)
    return graph.compile()


def build_phase2_graph(
    collect_fn=None,
    classify_fn=None,
    init_fn=None,
    ensure_fn=None,
    dispatch_fn=None,
    checkpointer=None,
) -> CompiledStateGraph:
    """Phase 2: deterministic LangGraph loop with workflow-driven routing.

    START → init_mission → ensure_sessions → dispatch_assignments → classify
      → route_workflow → [human_approval | finalize_mission | dispatch_assignments]
    """
    graph = StateGraph(OrchestratorState)

    graph.add_node("init", init_fn if init_fn else init_mission)  # type: ignore[arg-type]
    graph.add_node("ensure_sessions", ensure_fn if ensure_fn else ensure_sessions)  # type: ignore[arg-type]
    graph.add_node("dispatch_assignments", dispatch_fn if dispatch_fn else dispatch_assignments)  # type: ignore[arg-type]
    graph.add_node("classify", classify_fn if classify_fn else classify_workers)  # type: ignore[arg-type]
    graph.add_node("route", route_workflow)  # type: ignore[arg-type]
    graph.add_node("human_approval", human_approval_node)  # type: ignore[arg-type]
    graph.add_node("finalize_mission", finalize_mission)  # type: ignore[arg-type]

    graph.add_edge(START, "init")
    graph.add_edge("init", "ensure_sessions")
    graph.add_edge("ensure_sessions", "dispatch_assignments")
    graph.add_edge("dispatch_assignments", "classify")
    graph.add_edge("classify", "route")

    def route_after_route(state: OrchestratorState) -> str:
        if state.get("langgraph_needs_human", False):
            return "human_approval"
        iteration = state.get("iteration", 0)
        max_iter = state.get("max_iterations", 5)
        if state.get("all_done", False) or iteration >= max_iter:
            return "finalize_mission"
        return "dispatch_assignments"

    graph.add_conditional_edges(
        "route",
        route_after_route,
        {
            "human_approval": "human_approval",
            "finalize_mission": "finalize_mission",
            "dispatch_assignments": "dispatch_assignments",
        },
    )

    graph.add_edge("human_approval", "dispatch_assignments")
    graph.add_edge("finalize_mission", END)

    saver = checkpointer if checkpointer is not None else MemorySaver()
    return graph.compile(
        checkpointer=saver,
        interrupt_before=["human_approval"],
    )


async def _compare_and_log(state: OrchestratorState) -> dict:
    swarm = state.get("swarm_decision")
    lang = state.get("langgraph_decision")
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] [fan-in] swarm={'OK' if swarm else 'waiting'}, langgraph={'OK' if lang else 'waiting'}")
    if not swarm or not lang:
        return {"log_entries": ["[fan-in] waiting"]}
    cmp_result = await compare_decisions(state)
    log_result = await log_results({**state, **cmp_result})
    return {**cmp_result, **log_result}


phase1_graph = build_phase1_graph()
phase2_graph = build_phase2_graph()
