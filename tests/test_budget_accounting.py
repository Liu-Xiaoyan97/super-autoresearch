"""Budget accounting: exactly one charge per real unit of work.

sa4 raised the risk explicitly while the pipeline was being built in parallel: the
orchestrator, the composite `IdeaImplementer` and the individual coders could each
"own" the same experiment and charge it twice, inflating the cost model without
changing behaviour. The agreed policy is:

    the ONLY component that charges an experiment is the one that calls
    ``workspace.run(...)``; the orchestrator only calls ``budget.check()``.

These tests pin that policy against the whole pipeline, not just a unit.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from scientisttwo.agents.base import AgentContext
from scientisttwo.config import ScientistTwoConfig
from scientisttwo.core.orchestrator import Orchestrator
from scientisttwo.providers import build_provider
from scientisttwo.runtime.budget import Budget
from scientisttwo.runtime.store import ArtifactStore, TraceStore
from scientisttwo.runtime.workspace import FileWorkspace, SimulatedRunner
from scientisttwo.types import Problem

ROOT = Path(__file__).resolve().parents[1]


def _run(tmp_path: Path, max_refine_rounds: int | None = None):
    problem = Problem.model_validate(
        json.loads((ROOT / "examples" / "ood_frozen_encoder.json").read_text(encoding="utf-8"))
    )
    overrides = {} if max_refine_rounds is None else {"max_refine_rounds": max_refine_rounds}
    config = ScientistTwoConfig(seed=7, **overrides)
    store = ArtifactStore(tmp_path)
    traces = TraceStore(tmp_path / "traces.jsonl")
    budget = Budget()
    runner = SimulatedRunner(problem, config, store)

    executed = {"count": 0}
    original = runner.run

    async def counted(req):  # type: ignore[no-untyped-def]
        executed["count"] += 1
        return await original(req)

    runner.run = counted  # type: ignore[method-assign]

    ctx = AgentContext(
        problem=problem, config=config, llm=build_provider(config, "mock"),
        workspace=FileWorkspace(problem, config, str(tmp_path), runner=runner),
        store=store, traces=traces, budget=budget,
    )
    final = asyncio.run(Orchestrator(ctx).run())
    return final, budget, traces, executed


def test_each_experiment_is_charged_exactly_once(tmp_path: Path) -> None:
    final, budget, _, executed = _run(tmp_path)

    assert executed["count"] > 0, "the pipeline must actually run experiments"
    assert budget.experiments == executed["count"], (
        f"{executed['count']} workspace.run calls but {budget.experiments} charges "
        "-> double counting somewhere in the orchestration"
    )
    assert final.decision_path, "the run must record its decisions"
    # A scientific run executes strictly less than the hard stop.
    assert budget.experiments < budget.max_experiments


def test_each_llm_call_is_charged_exactly_once(tmp_path: Path) -> None:
    _, budget, traces, _ = _run(tmp_path)

    llm_traces = [record for record in traces.read_all() if record["kind"] == "llm"]
    assert budget.llm_calls > 0
    assert budget.llm_calls == len(llm_traces), (
        f"{len(llm_traces)} traced LLM calls but {budget.llm_calls} charges"
    )


def test_budget_scales_with_the_refinement_limit(tmp_path: Path) -> None:
    """A tighter refinement budget must cost strictly fewer experiments."""

    _, wide, _, wide_executed = _run(tmp_path / "wide", max_refine_rounds=4)
    _, tight, _, tight_executed = _run(tmp_path / "tight", max_refine_rounds=1)

    assert wide_executed["count"] == wide.experiments
    assert tight_executed["count"] == tight.experiments
    assert tight.experiments <= wide.experiments
