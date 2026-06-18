"""
CDC end-to-end tests for the LangGraph Swarm orchestrator.

These tests use mock services (no real Workspace API) so they can run in CI.
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Allow importing the orchestrator package from the repo root.
sys.path.insert(0, str(Path(__file__).parent.parent))

from langgraph.types import Command
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from hermes_langgraph_orchestrator.graph import build_phase1_graph, build_phase2_graph
from hermes_langgraph_orchestrator.resume import build_resume_command, list_active_gates, read_mission_state
from hermes_langgraph_orchestrator.state import OrchestratorState
from hermes_langgraph_orchestrator.workflow import (
    load_default_workflow,
    load_workflow,
    route_by_workflow,
    validate_workflow_against_roster,
)


# ============================================================
# Helpers copied from __main__ for mock nodes.
# ============================================================
SCENARIO_CDC = [
    {
        "worker_id": "researcher",
        "state": "DONE",
        "result": "CDC research complete",
        "files_changed": "",
        "commands_run": "",
        "blocker": "",
        "next_action": "交给 architect 设计接口",
        "raw": "STATE: DONE\nRESULT: research complete\nNEXT_ACTION: Architect design",
    },
    {
        "worker_id": "architect",
        "state": "DONE",
        "result": "Design complete",
        "files_changed": "docs/design/cdc_architecture.md",
        "commands_run": "",
        "blocker": "",
        "next_action": "developer 实现",
        "raw": "STATE: DONE\nFILES_CHANGED: docs/design/cdc_architecture.md\nRESULT: Design complete",
    },
    {
        "worker_id": "developer",
        "state": "BLOCKED",
        "result": "Implementation blocked by ODE instability",
        "files_changed": "cdc_model.py (partial)",
        "commands_run": "python cdc_model.py --debug",
        "blocker": "耦合 ODE 数值不稳定，需要架构决策",
        "next_action": "需要 architect 决定",
        "raw": "STATE: BLOCKED\nBLOCKER: ODE instability\nNEXT_ACTION: Architect decide",
    },
]


def _find_checkpoint(worker_id: str, call: int) -> dict | None:
    if worker_id == "researcher":
        return next((cp for cp in SCENARIO_CDC if cp["worker_id"] == "researcher"), None)
    if worker_id == "architect":
        cp = next((cp for cp in SCENARIO_CDC if cp["worker_id"] == "architect"), None)
        if cp and call >= 2:
            cp2 = dict(cp)
            cp2["result"] = "最终审查通过"
            cp2["next_action"] = "任务完成"
            cp2["raw"] = "STATE: DONE\nRESULT: approved\nNEXT_ACTION: done"
            return cp2
        return cp
    if worker_id == "developer":
        cp = next((cp for cp in SCENARIO_CDC if cp["worker_id"] == "developer"), None)
        if cp and call >= 2:
            cp2 = dict(cp)
            cp2["state"] = "DONE"
            cp2["blocker"] = ""
            cp2["result"] = "实现完成，测试通过"
            cp2["next_action"] = "交给 architect 最终审查"
            cp2["raw"] = "STATE: DONE\nRESULT: implementation complete\nNEXT_ACTION: Architect review"
            return cp2
        return cp
    return None


async def mock_init_mission(state: OrchestratorState) -> dict:
    workflow_spec = load_default_workflow()
    return {
        "roster_snapshot": ["orchestrator", "researcher", "architect", "developer", "learning"],
        "workflow_spec": workflow_spec,
        "terminal_docs_enabled": workflow_spec.settings.terminal_docs,
        "langgraph_assignments": [
            {
                "worker_id": workflow_spec.entry,
                "task": state.get("mission_goal", ""),
                "reason": f"workflow entry: {workflow_spec.entry}",
            }
        ],
        "log_entries": [f"[mock-init] {workflow_spec.name}"],
    }


async def mock_ensure_sessions(state: OrchestratorState) -> dict:
    return {"log_entries": ["[mock-ensure] ok"]}


async def mock_dispatch(state: OrchestratorState) -> dict:
    from hermes_langgraph_orchestrator.state import WorkerCheckpoint

    assignments = state.get("langgraph_assignments", [])
    if not assignments:
        return {
            "dispatch_results": None,
            "checkpoints": [],
            "dispatch_error": None,
            "log_entries": ["[mock-dispatch] no assignments"],
        }

    dispatch_counts = dict(state.get("dispatch_counts", {}) or {})
    checkpoints = []
    for a in assignments:
        wid = a["worker_id"]
        call = dispatch_counts.get(wid, 0) + 1
        cp = _find_checkpoint(wid, call)
        if cp:
            checkpoints.append(WorkerCheckpoint(**cp))  # type: ignore[typeddict-item]
        dispatch_counts[wid] = call

    return {
        "dispatch_results": {"results": []},
        "checkpoints": checkpoints,
        "dispatch_error": None,
        "dispatch_counts": dispatch_counts,
        "log_entries": [f"[mock-dispatch] {len(checkpoints)} checkpoints"],
    }


async def mock_classify(state: OrchestratorState) -> dict:
    from hermes_langgraph_orchestrator.state import WorkerClassification

    checkpoints = state.get("checkpoints", [])
    if not checkpoints:
        return {"classifications": [], "log_entries": ["[mock-classify] no checkpoints"]}

    cp = checkpoints[0]
    wid = cp["worker_id"]
    label = cp["state"]
    if wid == "developer" and label == "BLOCKED":
        classifications = [
            WorkerClassification(
                wid,
                "BLOCKED",
                "architecture_decision",
                cp.get("blocker", ""),
                "mock classify",
                "",
            )
        ]
    elif wid == "architect" and "approved" in (cp.get("result", "")).lower():
        classifications = [WorkerClassification(wid, "DONE", "", "", "mock classify", "approved")]
    else:
        classifications = [WorkerClassification(wid, label, "", "", "mock classify", "")]

    return {
        "classifications": classifications,
        "log_entries": [f"[mock-classify] {wid}={label}"],
    }


# ============================================================
# Tests
# ============================================================
def test_load_default_workflow() -> None:
    wf = load_default_workflow()
    assert wf.name == "cdc_research_design_implement"
    assert wf.entry == "researcher"
    assert "developer" in {t.from_worker for t in wf.transitions}


def test_validate_workflow_against_roster() -> None:
    wf = load_default_workflow()
    errors = validate_workflow_against_roster(wf, {"orchestrator", "researcher", "architect", "developer", "learning"})
    assert errors == []

    errors = validate_workflow_against_roster(wf, {"orchestrator", "researcher"})
    assert any("architect" in e for e in errors)


def test_route_by_workflow_done_to_architect() -> None:
    from hermes_langgraph_orchestrator.state import WorkerClassification

    wf = load_default_workflow()
    state: OrchestratorState = {
        "roster_snapshot": ["orchestrator", "researcher", "architect", "developer", "learning"],
        "workflow_spec": wf,
        "transition_counts": {},
    }
    c = WorkerClassification("researcher", "DONE", "", "", "调研完成", "")
    decision = route_by_workflow(c, state, wf)
    assert decision.action == "dispatch"
    assert decision.worker_id == "architect"


def test_route_by_workflow_blocked_escalates() -> None:
    from hermes_langgraph_orchestrator.state import WorkerClassification

    wf = load_default_workflow()
    state: OrchestratorState = {
        "roster_snapshot": ["orchestrator", "researcher", "architect", "developer", "learning"],
        "workflow_spec": wf,
        "transition_counts": {},
    }
    c = WorkerClassification("developer", "BLOCKED", "architecture_decision", "x", "y", "")
    decision = route_by_workflow(c, state, wf)
    assert decision.action == "human"


def test_phase1_graph_mock() -> None:
    """Phase 1 graph runs to completion with mock nodes."""

    async def mock_collect(state: OrchestratorState) -> dict:
        from hermes_langgraph_orchestrator.state import WorkerCheckpoint

        return {
            "checkpoints": [WorkerCheckpoint(**cp) for cp in SCENARIO_CDC],  # type: ignore[typeddict-item]
            "collection_error": None,
            "log_entries": ["[mock-collect] 3 checkpoints"],
        }

    async def mock_swarm(state: OrchestratorState) -> dict:
        from hermes_langgraph_orchestrator.state import DispatchDecision

        return {
            "swarm_decision": DispatchDecision(
                source="swarm",
                analysis="mock swarm",
                assignments=[{"worker_id": "architect", "task": "t", "reason": "r"}],
                human_approval_required=True,
            ),
            "log_entries": ["[mock-swarm] ok"],
        }

    async def run() -> OrchestratorState:
        graph = build_phase1_graph(
            init_fn=mock_init_mission,
            collect_fn=mock_collect,
            swarm_fn=mock_swarm,
        )
        initial: OrchestratorState = {
            "mission_id": "test-phase1",
            "mission_goal": "CDC model",
            "swarm_api_url": "http://localhost:3000/api",
            "checkpoints": [],
            "classifications": [],
            "langgraph_assignments": [],
            "log_entries": [],
        }
        result = await graph.ainvoke(initial, {"configurable": {"thread_id": "test-phase1"}})  # type: ignore[arg-type]
        return result  # type: ignore[return-value]

    result = asyncio.run(run())
    lang = result.get("langgraph_decision")
    assert lang is not None
    assert any(a["worker_id"] == "architect" for a in lang.assignments)
    assert lang.human_approval_required is True


@pytest.mark.asyncio
async def test_phase2_cdc_end_to_end() -> None:
    """Full CDC loop: researcher -> architect -> developer(blocked) -> human -> done."""
    mission_id = "test-cdc-e2e"
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_path = os.path.join(tmpdir, "checkpoints.db")
        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                init_fn=mock_init_mission,
                ensure_fn=mock_ensure_sessions,
                dispatch_fn=mock_dispatch,
                classify_fn=mock_classify,
                checkpointer=saver,
            )
            config = {"configurable": {"thread_id": mission_id}}
            initial: OrchestratorState = {
                "mission_id": mission_id,
                "mission_goal": "Design and implement CDC + airspring model",
                "swarm_api_url": "http://localhost:3000/api",
                "checkpoints": [],
                "classifications": [],
                "langgraph_assignments": [],
                "pending_human_assignments": [],
                "dispatch_counts": {},
                "transition_counts": {},
                "log_entries": [],
            }

            result = await graph.ainvoke(initial, config)  # type: ignore[arg-type]
            # Should pause at human gate.
            assert result.get("langgraph_needs_human") is True
            assert result.get("all_done") is False

            # Resume with human approval.
            current = await graph.aget_state(config)
            assert current is not None and current.values is not None
            command = build_resume_command(current.values, "approved")
            result = await graph.ainvoke(command, config)  # type: ignore[arg-type]

            assert result.get("all_done") is True
            logs = result.get("log_entries", [])
            assert any("finalize" in entry.lower() for entry in logs)


@pytest.mark.asyncio
async def test_phase2_resume_abort() -> None:
    """Aborting from the human gate finalizes the mission immediately."""
    mission_id = "test-cdc-abort"
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_path = os.path.join(tmpdir, "checkpoints.db")
        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                init_fn=mock_init_mission,
                ensure_fn=mock_ensure_sessions,
                dispatch_fn=mock_dispatch,
                classify_fn=mock_classify,
                checkpointer=saver,
            )
            config = {"configurable": {"thread_id": mission_id}}
            initial: OrchestratorState = {
                "mission_id": mission_id,
                "mission_goal": "CDC model",
                "swarm_api_url": "http://localhost:3000/api",
                "checkpoints": [],
                "classifications": [],
                "langgraph_assignments": [],
                "pending_human_assignments": [],
                "dispatch_counts": {},
                "transition_counts": {},
                "log_entries": [],
            }

            result = await graph.ainvoke(initial, config)  # type: ignore[arg-type]
            assert result.get("langgraph_needs_human") is True

            current = await graph.aget_state(config)
            command = build_resume_command(current.values, "abort")  # type: ignore[arg-type]
            result = await graph.ainvoke(command, config)  # type: ignore[arg-type]
            assert result.get("all_done") is True


@pytest.mark.asyncio
async def test_read_mission_state() -> None:
    """read_mission_state returns a JSON-serializable paused state."""
    mission_id = "test-read-state"
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_path = os.path.join(tmpdir, "checkpoints.db")
        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                init_fn=mock_init_mission,
                ensure_fn=mock_ensure_sessions,
                dispatch_fn=mock_dispatch,
                classify_fn=mock_classify,
                checkpointer=saver,
            )
            config = {"configurable": {"thread_id": mission_id}}
            initial: OrchestratorState = {
                "mission_id": mission_id,
                "mission_goal": "CDC model",
                "swarm_api_url": "http://localhost:3000/api",
                "checkpoints": [],
                "classifications": [],
                "langgraph_assignments": [],
                "pending_human_assignments": [],
                "dispatch_counts": {},
                "transition_counts": {},
                "log_entries": [],
            }
            await graph.ainvoke(initial, config)  # type: ignore[arg-type]
            state = await read_mission_state(checkpoint_path, mission_id)
            assert state is not None
            assert state["mission_id"] == mission_id
            assert state["langgraph_needs_human"] is True
            assert isinstance(state["classifications"], list)
            assert state["all_done"] is False

            gates = await list_active_gates(checkpoint_path)
            assert any(g["mission_id"] == mission_id and g["langgraph_needs_human"] is True for g in gates)
