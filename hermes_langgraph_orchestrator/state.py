"""
LangGraph Orchestrator State — Phase 1 + Phase 2

Phase 1 (对比): LangGraph 图结构 vs Swarm 规则引擎
Phase 2 (执行): LangGraph 图结构真实编排，替代 Swarm orchestrator-loop
"""

from typing import TypedDict, Annotated, Any
from dataclasses import dataclass, field
import operator


class WorkerCheckpoint(TypedDict):
    worker_id: str
    state: str
    result: str
    files_changed: str
    commands_run: str
    blocker: str
    next_action: str
    raw: str


@dataclass
class WorkerClassification:
    worker_id: str
    verdict: str           # DONE | BLOCKED | NEEDS_INPUT | HANDOFF | SKIP
    blocker_type: str      # missing_dependency | test_failure | timeout | architecture_decision | missing_credential | unknown | ""
    blocker_summary: str
    reasoning: str
    review_outcome: str    # "" | "approved" | "changes_requested" — 仅 architect 审查 developer 时有效


@dataclass
class DispatchDecision:
    source: str
    analysis: str
    assignments: list[dict]
    human_approval_required: bool
    metadata: dict = field(default_factory=dict)


class OrchestratorState(TypedDict, total=False):
    # --- 输入 ---
    mission_id: str
    mission_goal: str
    swarm_api_url: str
    thread_id: str

    # --- roster / workflow ---
    roster_snapshot: list[str]
    workflow_spec: Any  # WorkflowSpec loaded from YAML
    terminal_docs_enabled: bool

    # --- 收集 ---
    checkpoints: list[WorkerCheckpoint] | None
    collection_error: str | None

    # --- LangGraph 编排 ---
    classifications: list[WorkerClassification] | None
    langgraph_assignments: list[dict]
    langgraph_needs_human: bool
    langgraph_decision: DispatchDecision | None
    dispatched_workers: Annotated[list[str], operator.add]
    active_worker: str | None
    pending_assignments: list[dict]
    pending_human_assignments: list[dict]
    dispatch_counts: dict[str, int]
    transition_counts: dict[str, int]
    awaiting_checkpoint: bool

    # --- Swarm 规则引擎 (Phase 1 only) ---
    swarm_decision: DispatchDecision | None

    # --- Phase 2: 执行状态 ---
    dispatch_results: dict | None
    dispatch_error: str | None
    wait_attempts: int
    all_done: bool

    # --- 对比 (Phase 1 only) ---
    comparison: dict | None

    # --- 控制 ---
    iteration: int
    max_iterations: int
    phase: str

    # --- human gate ---
    human_resume_action: str | None
    human_resume_payload: dict | None

    # --- 日志 ---
    log_entries: Annotated[list[str], operator.add]
