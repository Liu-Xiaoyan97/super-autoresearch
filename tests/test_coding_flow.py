"""Offline §3.2 control-flow and §3.4 strict-adoption regression tests."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import zlib

import pytest

from scientisttwo.agents.base import AgentContext
from scientisttwo.agents.coding import (
    AblationCoder, BaselineCoder, FullSetCoder, IdeaImplementer, RebuttalCoder, SubsetCoder,
)
from scientisttwo.agents.critics import FullSetCritic, ResultComparison, Selector, SubsetCritic
from scientisttwo.agents.engineering import FullSetEngineer, SubsetEngineer
from scientisttwo.config import ScientistTwoConfig
from scientisttwo.providers.base import LLMProvider, LLMRequest, LLMResponse
from scientisttwo.runtime.budget import Budget
from scientisttwo.runtime.store import ArtifactStore, TraceStore
from scientisttwo.runtime.workspace import ExperimentRequest, FileWorkspace, Runner, SimulatedRunner
from scientisttwo.types import (
    AblationPlan, Decision, Evidence, ExperimentResult, Idea, MetricSpec, Problem,
    RebuttalTask, RepoRef, Scope, Trace,
)


class EmptyProvider(LLMProvider):
    """No network or shared mock implementation: use schema defaults."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[LLMRequest] = []

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls.append(req)
        return LLMResponse(text="{}")


class SequenceRunner(Runner):
    def __init__(self, values: list[float]) -> None:
        self.values = iter(values)
        self.calls: list[ExperimentRequest] = []

    async def run(self, req: ExperimentRequest) -> ExperimentResult:
        self.calls.append(req)
        return ExperimentResult(metrics={"score": next(self.values)})


def context(tmp_path: Path, *, runner: Runner | None = None, **config: object) -> AgentContext:
    problem = Problem(
        id="test", statement="Improve the benchmark", metrics=[MetricSpec(name="score")],
        reported_metrics={"score": 1.0}, datasets=["a", "b"], subset_datasets=["a"],
    )
    settings = ScientistTwoConfig(**config)
    store = ArtifactStore(tmp_path)
    return AgentContext(
        problem=problem, config=settings, llm=EmptyProvider(),
        workspace=FileWorkspace(problem, settings, str(tmp_path), runner=runner),
        store=store, traces=TraceStore(tmp_path / "traces.jsonl"), budget=Budget(),
    )


def implementer(ctx: AgentContext) -> IdeaImplementer:
    return IdeaImplementer(
        ctx, subset_critic=SubsetCritic(ctx), full_critic=FullSetCritic(ctx),
        subset_engineer=SubsetEngineer(ctx), full_engineer=FullSetEngineer(ctx),
        baseline_coder=BaselineCoder(ctx), subset_coder=SubsetCoder(ctx), full_set_coder=FullSetCoder(ctx),
    )


def idea(**updates: object) -> Idea:
    return Idea(id="h", hypothesis="Improve predictions", mechanism="spectral", **updates)


def measured(value: float, *, scope: Scope = Scope.FULL) -> Evidence:
    return Evidence(idea_id="h", scope=scope, metrics={"score": value})


def test_simulated_determinism_and_guidance(tmp_path: Path) -> None:
    async def run() -> None:
        ctx = context(tmp_path)
        runner = SimulatedRunner(ctx.problem, ctx.config, tmp_path)
        repo = RepoRef(path=str(tmp_path), label="test")
        req = ExperimentRequest(idea_id="h", repo=repo, idea=idea(), metrics=["score"])
        first = await runner.run(req)
        assert first.metrics == (await runner.run(req)).metrics
        changed = req.model_copy(update={"idea": idea().model_copy(update={"mechanism": "retrieval"})})
        assert first.metrics != (await runner.run(changed)).metrics
        guided = req.model_copy(update={"idea": idea(domain_fit=1.0)})
        guided_result = await runner.run(guided)
        assert guided_result.metrics["score"] > first.metrics["score"]
        assert guided_result.metrics["score"] - first.metrics["score"] == pytest.approx(0.115)
        assert first.status == "ok" and first.wall_time_s == 0.0
        assert Path(first.log_path).is_relative_to(tmp_path)
        assert Path(first.log_path).exists()
        u = lambda text, n: (zlib.crc32(text.encode()) % n) / n
        # contract: gain ~ U[-0.10, 0.40) (calibrated to the paper's 80.4% success rate)
        gain = u("spectral", 1000) * 0.5 - 0.10 + u("h", 97) * 0.02 - 0.01
        expected = 1 + gain * 1.15 + u("hsub", 53) * 0.02 - 0.01
        assert first.metrics["score"] == pytest.approx(expected)
        unguided = SimulatedRunner(ctx.problem, ScientistTwoConfig(guidance_weight=0), tmp_path)
        assert (await unguided.run(guided)).metrics == first.metrics
    asyncio.run(run())


def test_multimetric_fallback_and_minimization(tmp_path: Path) -> None:
    async def run() -> None:
        problem = Problem(
            id="multi", statement="test", metrics=[MetricSpec(name="score"), MetricSpec(name="loss", direction="min")],
            reported_metrics={"score": 2.0},
        )
        runner = SimulatedRunner(problem, ScientistTwoConfig(), tmp_path)
        repo = RepoRef(path="code")
        req = ExperimentRequest(idea_id="baseline", scope=Scope.FULL, repo=repo)
        baseline = await runner.run(req)
        assert baseline.metrics == {"score": 2.0, "loss": 1.0}
        candidate = req.model_copy(update={"idea": idea(domain_fit=1.0)})
        values = (await runner.run(candidate)).metrics
        improved = (await runner.run(candidate.model_copy(update={"idea": idea(domain_fit=0.0)}))).metrics
        assert values["score"] > improved["score"]
        assert values["loss"] < improved["loss"]
        assert values["score"] / 2 - 1 != 1 - values["loss"]
    asyncio.run(run())


def test_subset_failure_prunes_without_full_run(tmp_path: Path) -> None:
    async def run() -> None:
        runner = SequenceRunner([1.0, 0.8])
        ctx = context(tmp_path, runner=runner)
        trace = await implementer(ctx).implement(idea(), round=3)
        assert trace.decision == Decision.BAD
        assert trace.round == 3
        assert [r.scope for r in runner.calls] == [Scope.SUBSET, Scope.SUBSET]
        assert ctx.budget.experiments == 2
        assert len(trace.evidence) == len(trace.lessons) == 1
        assert trace.evidence[0].baseline_metrics == {"score": 1.0}
    asyncio.run(run())


@pytest.mark.parametrize("cap", [0, 1, 2])
def test_subset_engineer_budget_exhaustion(tmp_path: Path, cap: int) -> None:
    async def run() -> None:
        runner = SequenceRunner([1.0] + [1.01] * (1 + cap))
        ctx = context(tmp_path, runner=runner, max_eng_rounds=cap)
        trace = await implementer(ctx).implement(idea())
        assert trace.decision == Decision.BAD
        assert len(trace.evidence) == len(trace.lessons) == cap + 1
        assert ctx.budget.experiments == len(runner.calls) == cap + 2
        assert all(req.scope == Scope.SUBSET for req in runner.calls)
        assert sum(r.task == "engineer.subset" for r in ctx.llm.calls) == cap
    asyncio.run(run())


def test_full_engineer_budget_exhaustion(tmp_path: Path) -> None:
    async def run() -> None:
        runner = SequenceRunner([1.0, 1.1, 0.9, 0.95, 1.0])
        ctx = context(tmp_path, runner=runner, max_eng_rounds=2)
        trace = await implementer(ctx).implement(idea())
        assert trace.decision == Decision.BAD
        assert [e.scope for e in trace.evidence] == [Scope.SUBSET, Scope.FULL, Scope.FULL, Scope.FULL]
        assert len(trace.lessons) == 4
        assert ctx.budget.experiments == len(runner.calls) == 5
        assert sum(r.task == "engineer.full" for r in ctx.llm.calls) == 2
        assert trace.evidence[-1].idea_id == trace.idea.id
    asyncio.run(run())


def test_cached_baseline_is_not_reproduced_per_idea(tmp_path: Path) -> None:
    async def run() -> None:
        runner = SequenceRunner([1.0, 1.1, 1.05, 1.1, 1.05])
        ctx = context(tmp_path, runner=runner)
        coder = implementer(ctx)
        first = await coder.implement(idea())
        second = await coder.implement(idea().model_copy(update={"id": "h2"}))
        assert first.succeeded and second.succeeded
        assert ctx.budget.experiments == len(runner.calls) == 5
        assert sum(req.idea is None for req in runner.calls) == 1
        assert sum(r.task == "code.baseline" for r in ctx.llm.calls) == 1
        assert [e.scope for e in first.evidence] == [Scope.SUBSET, Scope.FULL]
    asyncio.run(run())


@pytest.mark.parametrize("value, decision", [(0.9, Decision.REFINE), (1.1, Decision.GOOD), (1.0, Decision.REFINE)])
def test_result_comparison_is_strict_and_no_llm(tmp_path: Path, value: float, decision: Decision) -> None:
    ctx = context(tmp_path)
    verdict = asyncio.run(ResultComparison(ctx).compare(measured(value), measured(1.0)))
    assert verdict.decision == decision
    assert ctx.llm.calls == []
    assert ctx.budget.llm_calls == ctx.budget.experiments == 0


def test_critics_reject_failed_and_regressing_metrics(tmp_path: Path) -> None:
    async def run() -> None:
        ctx = context(tmp_path)
        ctx.problem.metrics.append(MetricSpec(name="loss", direction="min"))
        base = Evidence(idea_id="baseline", metrics={"score": 1.0, "loss": 1.0})
        tradeoff = Evidence(idea_id="h", metrics={"score": 1.1, "loss": 1.1})
        assert (await SubsetCritic(ctx).judge(tradeoff, baseline=base)).decision == Decision.BAD
        assert (await FullSetCritic(ctx).judge(tradeoff, baseline=base)).decision == Decision.ENGINEER
        assert (await FullSetCritic(ctx).judge(tradeoff, baseline=base, attempts=2)).decision == Decision.BAD
        failed = Evidence(idea_id="h", metrics={"score": 2.0, "loss": 0.5}, result=ExperimentResult(status="failed"))
        assert (await FullSetCritic(ctx).judge(failed, baseline=base)).decision == Decision.BAD
        assert (await ResultComparison(ctx).compare(failed, base)).decision == Decision.REFINE
        missing = Evidence(idea_id="h", metrics={"score": 2.0})
        assert (await ResultComparison(ctx).compare(missing, base)).decision == Decision.REFINE
        assert ctx.llm.calls == []
    asyncio.run(run())


def test_selector_tie_breaks(tmp_path: Path) -> None:
    async def run() -> None:
        ctx = context(tmp_path)
        ctx.problem.metrics.append(MetricSpec(name="aux"))
        base = Evidence(idea_id="baseline", metrics={"score": 1.0, "aux": 1.0})
        def trace(name: str, primary: float, aux: float, novelty: float) -> Trace:
            return Trace(
                idea=Idea(id=name, hypothesis="test", novelty_score=novelty), decision=Decision.GOOD,
                evidence=[Evidence(idea_id=name, scope=Scope.FULL, metrics={"score": primary, "aux": aux})],
            )
        low = trace("low", 1.1, 1.2, 1.0)
        fewer = trace("fewer", 1.2, 1.0, 1.0)
        more = trace("more", 1.2, 1.2, 0.1)
        novel = trace("novel", 1.2, 1.2, 0.9)
        selector = Selector(ctx)
        assert await selector.select([low, fewer], baseline=base) is fewer
        assert await selector.select([fewer, more], baseline=base) is more
        assert await selector.select([more, novel], baseline=base) is novel
        assert await selector.select([novel, more, fewer, low], baseline=base) is novel
        with pytest.raises(ValueError, match="GOOD"):
            await selector.select([Trace(idea=idea(), decision=Decision.BAD)], baseline=base)
        ctx.problem.metrics[0].direction = "min"
        assert await selector.select([low, fewer], baseline=base) is low
        assert ctx.llm.calls == []
    asyncio.run(run())


def test_workspace_snapshots_provenance_and_auxiliary_coders(tmp_path: Path) -> None:
    async def run() -> None:
        ctx = context(tmp_path)
        workspace = ctx.workspace
        original = await workspace.baseline_repo()
        assert (Path(original.path) / "run_experiment.py").exists()
        assert (Path(original.path) / "README.md").exists()
        changed = await workspace.write_patch(original, "component intervention\n", "variant")
        assert changed.parent == original.label
        assert not (Path(original.path) / "patch.txt").exists()
        assert (Path(changed.path) / "patch.txt").read_text() == "component intervention\n"
        assert "+component intervention" in await workspace.diff(original, changed)
        result = await workspace.run(changed, Scope.FULL, idea=idea())
        # Provenance is the write-only-once record on disk (plus Evidence.code), not a
        # field on ExperimentResult: measurements stay independent of traceability.
        provenance = tmp_path / "artifacts" / "experiments" / f"provenance-{changed.label}-full.json"
        assert provenance.exists()
        record = json.loads(provenance.read_text(encoding="utf-8"))
        assert record["request"]["repo"]["label"] == changed.label
        assert record["result"]["metrics"] == result.metrics
        best = Evidence(idea_id="h", scope=Scope.FULL, code=changed, metrics=result.metrics)
        plan = AblationPlan(id="a", component="spectral", description="Remove spectral constraint")
        ablation = await AblationCoder(ctx).run_plan(idea(), plan, best=best)
        task = RebuttalTask(id="t", question="Robust?", plan="Test fixed perturbations")
        rebuttal = await RebuttalCoder(ctx).run_task(idea(), task, best=best)
        assert ablation.ok and ablation.evidence.scope == Scope.ABLATION
        assert ablation.evidence.code.parent == changed.label
        assert rebuttal.scope == Scope.REBUTTAL and rebuttal.code.parent == changed.label
        assert ablation.evidence.baseline_metrics == rebuttal.baseline_metrics == best.metrics
        assert ctx.budget.experiments == 2  # direct workspace calls are not agent executions
    asyncio.run(run())
