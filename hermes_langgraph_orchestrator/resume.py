"""
Human gate helpers for the LangGraph Phase 2 orchestrator.

Provides:
- `build_resume_command`: construct a LangGraph Command from a paused state.
- `read_mission_state`: read the current paused state for a mission id.
- `resume_mission`: resume a paused mission with `approved` or `abort`.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import asdict, is_dataclass
from typing import Any

from langgraph.types import Command

from .state import OrchestratorState


def _serialize(value: Any) -> Any:
    """Recursively serialize dataclasses/lists/dicts for JSON output."""
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _serialize(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize(v) for v in value]
    if isinstance(value, set):
        return sorted(_serialize(v) for v in value)
    return value


def serialize_state(state: OrchestratorState) -> dict[str, Any]:
    """Return a JSON-serializable copy of an OrchestratorState dict."""
    return _serialize(state)


def build_resume_command(
    state: OrchestratorState,
    action: str,
    assignment_overrides: list[dict] | None = None,
) -> Command:
    """Build a LangGraph Command to resume from the human_approval interrupt.

    Args:
        state: The paused orchestrator state.
        action: Either ``approved`` or ``abort``.
        assignment_overrides: Optional replacement assignments for the human
            gate. If provided and ``action`` is ``approved``, these are used
            instead of ``pending_human_assignments``.
    """
    if action == "approved":
        pending = assignment_overrides if assignment_overrides is not None else (
            state.get("pending_human_assignments", []) or []
        )
        return Command(
            update={
                "langgraph_assignments": pending,
                "pending_human_assignments": [],
                "human_resume_action": "approved",
            }
        )
    if action == "abort":
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


async def read_mission_state(
    checkpoint_path: str,
    mission_id: str,
) -> dict[str, Any] | None:
    """Read the latest persisted LangGraph state for ``mission_id``.

    Returns a JSON-serializable dict, or ``None`` if no state exists.
    """
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    from .graph import build_phase2_graph

    config = {"configurable": {"thread_id": mission_id}}
    async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
        graph = build_phase2_graph(checkpointer=saver)
        current = await graph.aget_state(config)
        if current is None or current.values is None:
            return None
        return serialize_state(current.values)


async def resume_mission(
    checkpoint_path: str,
    mission_id: str,
    action: str,
    assignment_overrides: list[dict] | None = None,
) -> OrchestratorState:
    """Resume a paused mission and return the final orchestrator state."""
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    from .graph import build_phase2_graph

    config = {"configurable": {"thread_id": mission_id}}
    async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as saver:
        graph = build_phase2_graph(checkpointer=saver)
        current = await graph.aget_state(config)
        if current is None or current.values is None:
            raise ValueError(f"No paused state for mission {mission_id}")
        command = build_resume_command(current.values, action, assignment_overrides)
        return await graph.ainvoke(command, config)  # type: ignore[arg-type]


async def list_active_gates(
    checkpoint_path: str,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Scan the SQLite checkpointer for missions currently paused at human gate.

    Returns a list of JSON-serializable orchestrator states that have
    ``langgraph_needs_human=True`` and are not yet done, ordered by most
    recent checkpoint first.
    """
    import logging

    import aiosqlite
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

    # Silence non-fatal deserialization warnings while scanning.
    logging.getLogger("langgraph.checkpoint.serde.jsonplus").setLevel(logging.ERROR)

    serde = JsonPlusSerializer()
    gates: list[dict[str, Any]] = []

    async with aiosqlite.connect(checkpoint_path) as db:
        async with db.execute(
            """
            SELECT thread_id, MAX(checkpoint_id) AS max_id
            FROM checkpoints
            GROUP BY thread_id
            ORDER BY max_id DESC
            LIMIT ?
            """,
            (limit,),
        ) as cursor:
            threads = await cursor.fetchall()

        for thread_id, max_id in threads:
            async with db.execute(
                "SELECT type, checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_id = ?",
                (thread_id, max_id),
            ) as cursor:
                row = await cursor.fetchone()
            if not row:
                continue
            type_, blob = row
            try:
                cp = serde.loads_typed((type_, blob))
            except Exception:
                continue
            values = cp.get("channel_values") or {}
            if values.get("langgraph_needs_human") and not values.get("all_done"):
                gates.append(serialize_state(values))

    return gates


def print_state_json(state: OrchestratorState | None) -> None:
    """Print a JSON-serializable state to stdout."""
    print(json.dumps(serialize_state(state) if state is not None else None, ensure_ascii=False, indent=2))


def print_gates_json(gates: list[dict[str, Any]]) -> None:
    """Print a list of active gates as JSON."""
    print(json.dumps(gates, ensure_ascii=False, indent=2))
