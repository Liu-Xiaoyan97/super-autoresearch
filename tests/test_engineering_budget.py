"""A.2's two engineering rounds: total per idea, or per stage?

The paper says "If the Idea Critic Agent flags an idea for engineering refinement, we
apply engineering techniques for at most two rounds" — one critic role spanning the
subset and full-set loops, so the literal reading is a **shared** budget per idea.
`ScientistTwoConfig.engineering_budget_scope` exposes both readings; per-idea is the
default. These tests pin the accounting so a refactor cannot silently double it.
"""

from __future__ import annotations

import asyncio

import pytest

from scientisttwo.agents.coding import (
    BaselineCoder, FullSetCoder, IdeaImplementer, SubsetCoder,
)
from scientisttwo.agents.critics import FullSetCritic, SubsetCritic
from scientisttwo.agents.engineering import FullSetEngineer, SubsetEngineer
from scientisttwo.config import ScientistTwoConfig
from scientisttwo.providers.base import LLMProvider, LLMRequest, LLMResponse
from scientisttwo.runtime.budget import Budget
from scientisttwo.runtime.store import ArtifactStore, TraceStore
from scientisttwo.runtime.workspace import ExperimentRequest, FileWorkspace, Runner
from scientisttwo.types import ExperimentResult, Idea, MetricSpec, Problem


class EmptyProvider(LLMProvider):
    async def complete(self, req: LLMRequest) -> LLMResponse:
        return LLMResponse(text="{}")


class SequenceRunner(Runner):
    """Yields a fixed metric sequence, one value per executed benchmark."""

    def __init__(self, values: list[float]) -> None:
        self.values = list(values)
        self.calls: list[ExperimentRequest] = []

    async def run(self, req: ExperimentRequest) -> ExperimentResult:
        self.calls.append(req)
        return ExperimentResult(metrics={"score": self.values[len(self.calls) - 1]})


def _implementer(tmp_path, values: list[float], **config):
    problem = Problem(
        id="budget", statement="Improve the benchmark",
        metrics=[MetricSpec(name="score", tolerance=1e-6)],
        reported_metrics={"score": 1.0},
        datasets=["a", "b"], subset_datasets=["a"],
    )
    settings = ScientistTwoConfig(**config)
    runner = SequenceRunner(values)
    from scientisttwo.agents.base import AgentContext

    ctx = AgentContext(
        problem=problem, config=settings, llm=EmptyProvider(),
        workspace=FileWorkspace(problem, settings, str(tmp_path), runner=runner),
        store=ArtifactStore(tmp_path), traces=TraceStore(tmp_path / "traces.jsonl"),
        budget=Budget(),
    )
    impl = IdeaImplementer(
        ctx,
        subset_critic=SubsetCritic(ctx), full_critic=FullSetCritic(ctx),
        subset_engineer=SubsetEngineer(ctx), full_engineer=FullSetEngineer(ctx),
        baseline_coder=BaselineCoder(ctx), subset_coder=SubsetCoder(ctx),
        full_set_coder=FullSetCoder(ctx),
    )
    return ctx, impl, runner


def _run(values: list[float], tmp_path, **config):
    ctx, impl, runner = _implementer(tmp_path, values, **config)
    trace = asyncio.run(impl.implement(Idea(id="h1", hypothesis="h", mechanism="m"), round=0))
    return ctx, trace, runner


# Value 0 is the reproduced baseline; then the idea's subset run 1.005 (below the 2%
# margin => ENGINEER), refined to 1.05 (GOOD); then the full-set runs stay at or below
# the 1.00 baseline, so only the engineering budget can stop that loop.
SEQUENCE = [1.0, 1.005, 1.05, 1.0, 0.99, 0.98, 0.97]


def test_engineering_budget_is_shared_per_idea(tmp_path) -> None:
    ctx, trace, runner = _run(list(SEQUENCE), tmp_path, engineering_budget_scope="per_idea")

    # baseline + subset + subset refinement + full-set + 1 full-set refinement = 5;
    # the subset refinement already consumed half of the shared budget.
    assert len(runner.calls) == 5, [call.scope.value for call in runner.calls]
    assert ctx.budget.experiments == 5


def test_engineering_budget_can_be_per_stage(tmp_path) -> None:
    ctx, trace, runner = _run(list(SEQUENCE), tmp_path, engineering_budget_scope="per_stage")

    # The full-set loop gets its own two rounds on top of the subset's one.
    assert len(runner.calls) == 6, [call.scope.value for call in runner.calls]
    assert ctx.budget.experiments == 6


def test_zero_engineering_budget_prunes_unimproved_subset(tmp_path) -> None:
    ctx, trace, runner = _run([1.0, 1.005], tmp_path, max_eng_rounds=0)

    assert len(runner.calls) == 2, "no budget => baseline + subset only, no scale-up"
    assert trace.decision.value == "bad"
