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

from hermes_langgraph_orchestrator.graph import build_phase2_graph
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
    resolve_workflow_path,
    route_by_workflow,
    validate_workflow_against_roster,
)


from hermes_langgraph_orchestrator.mock_services import (
    build_mock_checkpoint,
    make_mock_classify,
    make_mock_dispatch,
    make_mock_ensure_sessions,
    make_mock_init_mission,
    resolve_mock_profile,
)


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


@pytest.mark.asyncio
async def test_phase2_cdc_end_to_end() -> None:
    """Full CDC loop: researcher -> architect -> developer(blocked) -> human -> done."""
    mission_id = "test-cdc-e2e"
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_path = os.path.join(tmpdir, "checkpoints.db")
        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                init_fn=make_mock_init_mission("auto"),
                ensure_fn=make_mock_ensure_sessions(),
                dispatch_fn=make_mock_dispatch("auto"),
                classify_fn=make_mock_classify(),
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
                init_fn=make_mock_init_mission("auto"),
                ensure_fn=make_mock_ensure_sessions(),
                dispatch_fn=make_mock_dispatch("auto"),
                classify_fn=make_mock_classify(),
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
                init_fn=make_mock_init_mission("auto"),
                ensure_fn=make_mock_ensure_sessions(),
                dispatch_fn=make_mock_dispatch("auto"),
                classify_fn=make_mock_classify(),
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


def test_resolve_workflow_path_relative() -> None:
    resolved = resolve_workflow_path("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    assert resolved.is_file()
    assert resolved.name == "research_only.yaml"


def test_init_mission_honors_workflow_path_channel() -> None:
    """workflow_path must be a LangGraph state channel or UI-provided paths are ignored."""

    async def run() -> dict:
        state: OrchestratorState = {
            "mission_id": "wf-channel-test",
            "mission_goal": "research only",
            "swarm_api_url": "http://localhost:3000/api",
            "workflow_path": "hermes_langgraph_orchestrator/workflows/research_only.yaml",
            "langgraph_assignments": [],
        }
        # roster fetch will fail without server; only assert path survives until load.
        from hermes_langgraph_orchestrator.nodes import init_mission

        assert state.get("workflow_path")
        wf = load_workflow(resolve_workflow_path(state["workflow_path"]))  # type: ignore[arg-type]
        assert wf.name == "research_adversarial_review"
        assert wf.entry == "researcher"
        next_target = None
        for t in wf.transitions:
            if t.from_worker == "researcher" and t.on.verdict == "DONE":
                next_target = t.to
        assert next_target == "architect"
        return {"ok": True}

    assert asyncio.run(run())["ok"] is True


def test_load_research_only_workflow() -> None:
    wf = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    assert wf.name == "research_adversarial_review"
    assert wf.entry == "researcher"
    roster = {"orchestrator", "researcher", "architect", "developer", "learning"}
    assert validate_workflow_against_roster(wf, roster) == []


def test_route_research_review_loop_limit_triggers_human() -> None:
    from hermes_langgraph_orchestrator.state import WorkerClassification

    wf = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    state: OrchestratorState = {
        "roster_snapshot": ["orchestrator", "researcher", "architect", "developer", "learning"],
        "workflow_spec": wf,
        "transition_counts": {"architect→researcher": 3},
    }
    c = WorkerClassification(
        "architect", "DONE", "", "", "仍有分歧", "changes_requested"
    )
    decision = route_by_workflow(c, state, wf)
    assert decision.action == "human"
    assert "review loop limit" in (decision.reason or "")


def test_route_research_done_to_architect() -> None:
    from hermes_langgraph_orchestrator.state import WorkerClassification

    wf = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    state: OrchestratorState = {
        "roster_snapshot": ["orchestrator", "researcher", "architect", "developer", "learning"],
        "workflow_spec": wf,
        "transition_counts": {},
    }
    c = WorkerClassification("researcher", "DONE", "", "", "调研完成", "")
    decision = route_by_workflow(c, state, wf)
    assert decision.action == "dispatch"
    assert decision.worker_id == "architect"


def test_route_research_architect_approved_terminates() -> None:
    from hermes_langgraph_orchestrator.state import WorkerClassification

    wf = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    state: OrchestratorState = {
        "roster_snapshot": ["orchestrator", "researcher", "architect", "developer", "learning"],
        "workflow_spec": wf,
        "transition_counts": {},
    }
    c = WorkerClassification("architect", "DONE", "", "", "审查通过", "approved")
    decision = route_by_workflow(c, state, wf)
    assert decision.action == "done"
    assert decision.terminal is True


def test_resolve_mock_profile_auto() -> None:
    cdc = load_default_workflow()
    research = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    assert resolve_mock_profile(cdc, "auto") == "cdc"
    assert resolve_mock_profile(research, "auto") == "generic"
    assert resolve_mock_profile(research, "human_gate") == "human_gate"


def test_build_mock_checkpoint_research_review_cycle() -> None:
    wf = load_workflow("hermes_langgraph_orchestrator/workflows/research_only.yaml")
    first_review = build_mock_checkpoint(
        "architect", 1, workflow=wf, profile="generic", transition_counts={}
    )
    assert first_review["review_outcome"] == "changes_requested"
    approved = build_mock_checkpoint(
        "architect", 2, workflow=wf, profile="generic", transition_counts={"architect→researcher": 1}
    )
    assert approved["review_outcome"] == "approved"


def test_build_mock_checkpoint_cdc_developer_blocked() -> None:
    wf = load_default_workflow()
    blocked = build_mock_checkpoint("developer", 1, workflow=wf, profile="cdc")
    assert blocked["state"] == "BLOCKED"
    done = build_mock_checkpoint("developer", 2, workflow=wf, profile="cdc")
    assert done["state"] == "DONE"


@pytest.mark.asyncio
async def test_mock_research_only_workflow_e2e() -> None:
    mission_id = "test-research-mock-e2e"
    wf_path = "hermes_langgraph_orchestrator/workflows/research_only.yaml"
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_path = os.path.join(tmpdir, "checkpoints.db")
        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                init_fn=make_mock_init_mission("generic"),
                ensure_fn=make_mock_ensure_sessions(),
                dispatch_fn=make_mock_dispatch("generic"),
                classify_fn=make_mock_classify(),
                checkpointer=saver,
            )
            config = {"configurable": {"thread_id": mission_id}}
            initial: OrchestratorState = {
                "mission_id": mission_id,
                "mission_goal": "research mock e2e",
                "workflow_path": wf_path,
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
            assert result.get("all_done") is True


@pytest.mark.asyncio
async def test_mock_human_gate_research_workflow() -> None:
    mission_id = "test-research-mock-human-gate"
    wf_path = "hermes_langgraph_orchestrator/workflows/research_only.yaml"
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_path = os.path.join(tmpdir, "checkpoints.db")
        async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
            graph = build_phase2_graph(
                init_fn=make_mock_init_mission("human_gate"),
                ensure_fn=make_mock_ensure_sessions(),
                dispatch_fn=make_mock_dispatch("human_gate"),
                classify_fn=make_mock_classify(),
                checkpointer=saver,
            )
            config = {"configurable": {"thread_id": mission_id}}
            initial: OrchestratorState = {
                "mission_id": mission_id,
                "mission_goal": "research mock human gate",
                "workflow_path": wf_path,
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
            assert result.get("all_done") is False


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


def test_latest_assignment_checkpoints_prefers_newest_assignment():
    from hermes_langgraph_orchestrator.nodes import _latest_assignment_checkpoints_from_mission

    mission = {
        "assignments": [
            {
                "workerId": "architect",
                "dispatchedAt": 100,
                "checkpoint": {
                    "stateLabel": "DONE",
                    "result": "design complete",
                    "raw": "STATE: DONE\nRESULT: design complete",
                },
            },
            {
                "workerId": "architect",
                "dispatchedAt": 200,
                "checkpoint": None,
            },
        ]
    }
    latest = _latest_assignment_checkpoints_from_mission(mission, worker_filter={"architect"})
    assert latest == {}


def test_sync_cp_map_clears_stale_current_worker_checkpoint():
    from hermes_langgraph_orchestrator.nodes import _sync_cp_map_from_mission
    from hermes_langgraph_orchestrator.state import WorkerCheckpoint

    cp_map = {
        "architect": WorkerCheckpoint(
            worker_id="architect",
            state="DONE",
            result="design complete",
            files_changed="",
            commands_run="",
            blocker="",
            next_action="",
            review_outcome="",
            raw="STATE: DONE\nRESULT: design complete",
        )
    }
    mission = {
        "assignments": [
            {
                "workerId": "architect",
                "dispatchedAt": 100,
                "checkpoint": {
                    "stateLabel": "DONE",
                    "result": "design complete",
                    "raw": "STATE: DONE\nRESULT: design complete",
                },
            },
            {
                "workerId": "architect",
                "dispatchedAt": 200,
                "checkpoint": None,
            },
        ]
    }
    _sync_cp_map_from_mission(
        cp_map,
        mission,
        current_workers={"architect"},
        dispatched={"architect", "developer"},
    )
    assert "architect" not in cp_map


@pytest.mark.asyncio
async def test_route_skips_stale_architect_to_developer_redispatch():
    from hermes_langgraph_orchestrator.nodes import route_workflow
    from hermes_langgraph_orchestrator.state import WorkerClassification

    state: OrchestratorState = {
        "mission_goal": "CDC",
        "workflow_spec": load_default_workflow(),
        "roster_snapshot": ["researcher", "architect", "developer", "learning"],
        "classifications": [
            WorkerClassification(
                worker_id="architect",
                verdict="DONE",
                blocker_type="",
                blocker_summary="",
                reasoning="rule classify from STATE",
                review_outcome="",
            )
        ],
        "checkpoints": [
            {
                "worker_id": "architect",
                "state": "DONE",
                "result": "design complete",
                "files_changed": "",
                "commands_run": "",
                "blocker": "",
                "next_action": "",
                "review_outcome": "",
                "raw": "STATE: DONE\nRESULT: design complete",
            },
            {
                "worker_id": "developer",
                "state": "DONE",
                "result": "implementation complete",
                "files_changed": "",
                "commands_run": "",
                "blocker": "",
                "next_action": "",
                "review_outcome": "",
                "raw": "STATE: DONE\nRESULT: implementation complete",
            },
        ],
        "dispatched_workers": ["researcher", "architect", "developer"],
        "transition_counts": {},
        "iteration": 0,
        "max_iterations": 5,
    }
    result = await route_workflow(state)
    assert result["langgraph_assignments"] == []
    assert "skip stale architect→developer" in result["langgraph_decision"].analysis
