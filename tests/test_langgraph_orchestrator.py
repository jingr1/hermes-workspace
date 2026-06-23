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
from hermes_langgraph_orchestrator.resume import (
    build_human_gate_assignments,
    build_resume_command,
    list_active_gates,
    read_mission_state,
)
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


def test_try_rule_classify_done_and_blocked():
    from hermes_langgraph_orchestrator.nodes import _try_rule_classify

    done = _try_rule_classify({
        "worker_id": "researcher",
        "state": "DONE",
        "result": "research complete",
        "files_changed": "",
        "commands_run": "",
        "blocker": "",
        "next_action": "architect",
        "review_outcome": "",
        "raw": "STATE: DONE\nRESULT: research complete",
    })
    assert done is not None
    assert done.verdict == "DONE"

    blocked = _try_rule_classify({
        "worker_id": "developer",
        "state": "BLOCKED",
        "result": "ODE unstable",
        "files_changed": "",
        "commands_run": "",
        "blocker": "architecture_decision needed for solver",
        "next_action": "escalate",
        "review_outcome": "",
        "raw": "STATE: BLOCKED\nBLOCKER: architecture_decision needed",
    })
    assert blocked is not None
    assert blocked.verdict == "BLOCKED"
    assert blocked.blocker_type == "architecture_decision"

    in_progress = _try_rule_classify({
        "worker_id": "developer",
        "state": "IN_PROGRESS",
        "result": "",
        "files_changed": "",
        "commands_run": "",
        "blocker": "",
        "next_action": "",
        "review_outcome": "",
        "raw": "STATE: IN_PROGRESS",
    })
    assert in_progress is None


@pytest.mark.asyncio
async def test_classify_workers_rule_fast_path_skips_llm(monkeypatch):
    from hermes_langgraph_orchestrator import nodes

    async def _fail_llm(*_args, **_kwargs):
        raise AssertionError("LLM should not be called for deterministic checkpoints")

    monkeypatch.setattr(nodes, "_get_llm", _fail_llm)
    result = await nodes.classify_workers({
        "mission_goal": "CDC",
        "checkpoints": [
            {
                "worker_id": "researcher",
                "state": "DONE",
                "result": "done",
                "files_changed": "",
                "commands_run": "",
                "blocker": "",
                "next_action": "",
                "review_outcome": "",
                "raw": "STATE: DONE",
            }
        ],
    })
    assert result["classifications"][0].verdict == "DONE"


def test_swarm_roster_has_cdc_worker_wrappers():
    import yaml
    from pathlib import Path

    swarm_path = Path(__file__).parent.parent / "swarm.yaml"
    with open(swarm_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    workers = {w["id"]: w for w in data.get("workers", [])}
    for wid in ("architect", "developer", "learning", "researcher"):
        assert wid in workers, f"missing worker {wid}"
        assert workers[wid].get("wrapper"), f"{wid} missing wrapper"
        assert workers[wid].get("tools"), f"{wid} missing tools"
        assert workers[wid].get("skills"), f"{wid} missing skills"
    wf = load_default_workflow()
    errors = validate_workflow_against_roster(wf, set(workers.keys()))
    assert errors == []


@pytest.mark.asyncio
async def test_check_swarm_workspace_retries_after_timeout(monkeypatch):
    import httpx
    from hermes_langgraph_orchestrator import nodes

    calls = {"n": 0}

    class FakeResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers=None):
            calls["n"] += 1
            if calls["n"] < 3:
                raise httpx.TimeoutException("simulated vite compile stall")
            return FakeResponse()

    async def fast_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(nodes, "_workspace_http_client", lambda *args, **kwargs: FakeClient())
    monkeypatch.setattr(nodes.asyncio, "sleep", fast_sleep)

    err = await nodes.check_swarm_workspace("http://127.0.0.1:3000/api")
    assert err is None
    assert calls["n"] == 3


def test_load_workspace_dotenv_does_not_override_existing(monkeypatch):
    from hermes_langgraph_orchestrator import nodes

    env_file = Path(__file__).parent.parent / ".env"
    if not env_file.is_file():
        pytest.skip("workspace .env not present")

    monkeypatch.setenv("EXISTING_TEST_KEY_SHOULD_NOT_BE_IN_ENV", "from-shell")
    before = os.environ.get("HERMES_SWARM_TMUX_MODE")
    nodes.load_workspace_dotenv()
    if before is None and "HERMES_SWARM_TMUX_MODE" in env_file.read_text(encoding="utf-8"):
        assert os.environ.get("HERMES_SWARM_TMUX_MODE") in ("cli", "tui")
    assert os.environ.get("EXISTING_TEST_KEY_SHOULD_NOT_BE_IN_ENV") == "from-shell"


def test_load_research_only_workflow() -> None:
    wf = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    assert wf.entry == "researcher"
    roster = {"orchestrator", "researcher", "architect", "developer", "learning"}
    assert validate_workflow_against_roster(wf, roster) == []


def test_build_human_gate_assignments_architect_to_developer():
    state: OrchestratorState = {
        "mission_id": "cdc-gate",
        "mission_goal": "CDC model",
        "classifications": [
            {
                "worker_id": "architect",
                "verdict": "NEEDS_INPUT",
                "blocker_type": "review",
                "blocker_summary": "P0: half_car field order",
                "reasoning": "needs human",
                "review_outcome": "",
            }
        ],
        "checkpoints": [
            {
                "worker_id": "architect",
                "state": "NEEDS_INPUT",
                "result": "Review found P0 issues",
                "files_changed": "half_car.py",
                "commands_run": "none",
                "blocker": "P0 issues",
                "next_action": "fix half_car",
            }
        ],
    }
    assignments = build_human_gate_assignments(
        state,
        choice="primary",
        human_note="先修 half_car",
        target_worker_id="developer",
    )
    assert len(assignments) == 1
    assert assignments[0]["worker_id"] == "developer"
    assert "half_car" in assignments[0]["task"]
    assert "先修 half_car" in assignments[0]["task"]

    command = build_resume_command(
        state,
        "approved",
        human_choice="primary",
        human_note="先修 half_car",
        target_worker_id="developer",
    )
    assert command.update["langgraph_assignments"][0]["worker_id"] == "developer"
    assert command.update["human_resume_payload"]["choice"] == "primary"


def test_is_local_workspace_url():
    from hermes_langgraph_orchestrator.nodes import _is_local_workspace_url

    assert _is_local_workspace_url("http://127.0.0.1:3000/api")
    assert _is_local_workspace_url("http://localhost:3000/api")
    assert not _is_local_workspace_url("http://10.0.0.5:3000/api")
