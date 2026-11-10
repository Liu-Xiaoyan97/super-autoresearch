"""Table 1 uses two different comparison targets.

    subset stage   -> "Is it better than the reproduced baseline?"
    full-set stage -> "Is it better than the original SOTA result?"

The simulated runner derives both references from the fixture's reported metrics, so
offline runs cannot show the difference. These tests inject divergent references into
``ctx.scratch`` and assert that the full-set gate uses the *full-benchmark* one - the
mismatch this guards against (judging full-set results against a subset baseline) is
otherwise invisible and silently revertible.
"""

from __future__ import annotations

import asyncio

from scientisttwo.agents.base import AgentContext
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
from scientisttwo.types import (
    Decision, Evidence, ExperimentResult, Idea, MetricSpec, Problem, RepoRef, Scope,
)


class EmptyProvider(LLMProvider):
    async def complete(self, req: LLMRequest) -> LLMResponse:
        return LLMResponse(text="{}")


class SequenceRunner(Runner):
    def __init__(self, values: list[float]) -> None:
        self.values = list(values)
        self.calls: list[ExperimentRequest] = []

    async def run(self, req: ExperimentRequest) -> ExperimentResult:
        self.calls.append(req)
        return ExperimentResult(metrics={"score": self.values[len(self.calls) - 1]})


def _implementer(tmp_path, values: list[float], scratch: dict | None = None):
    # The code snapshots and the artifact store must live in separate trees: a
    # RepoRef pointing at the store root makes write_patch copy the store into itself.
    repo_root = tmp_path / "repo"
    repo_root.mkdir(exist_ok=True)
    (repo_root / "run_experiment.py").write_text("print('{}')\n", encoding="utf-8")
    store_root = tmp_path / "store"
    store_root.mkdir(exist_ok=True)
    problem = Problem(
        id="ref", statement="Improve", metrics=[MetricSpec(name="score", tolerance=1e-6)],
        reported_metrics={"score": 1.0}, datasets=["a", "b"], subset_datasets=["a"],
    )
    config = ScientistTwoConfig()
    runner = SequenceRunner(values)
    ctx = AgentContext(
        problem=problem, config=config, llm=EmptyProvider(),
        workspace=FileWorkspace(problem, config, str(store_root), runner=runner),
        store=ArtifactStore(store_root), traces=TraceStore(store_root / "t.jsonl"), budget=Budget(),
    )
    ctx.scratch.update(scratch or {})
    impl = IdeaImplementer(
        ctx,
        subset_critic=SubsetCritic(ctx), full_critic=FullSetCritic(ctx),
        subset_engineer=SubsetEngineer(ctx), full_engineer=FullSetEngineer(ctx),
        baseline_coder=BaselineCoder(ctx), subset_coder=SubsetCoder(ctx),
        full_set_coder=FullSetCoder(ctx),
    )
    return impl


def _refs(tmp_path):
    repo = str(tmp_path / "repo")
    subset = Evidence(idea_id="baseline", scope=Scope.SUBSET, metrics={"score": 0.90},
                      code=RepoRef(path=repo, label="baseline-subset"))
    full = Evidence(idea_id="baseline", scope=Scope.FULL, metrics={"score": 0.50},
                    code=RepoRef(path=repo, label="baseline-full"))
    return subset, full


def test_full_set_gate_uses_the_full_benchmark_reference(tmp_path) -> None:
    subset_ref, full_ref = _refs(tmp_path)
    impl = _implementer(
        tmp_path, [0.92, 0.70],  # subset beats 0.90; full run 0.70 beats 0.50 but not 0.90
        {"baseline": subset_ref, "baseline_full": full_ref},
    )
    trace = asyncio.run(impl.implement(Idea(id="h1", hypothesis="h", mechanism="m"), round=0))

    assert trace.decision is Decision.GOOD, trace.lessons
    full_evidence = trace.evidence[-1]
    assert full_evidence.scope is Scope.FULL
    assert full_evidence.baseline_metrics == {"score": 0.50}, (
        "the full-set evidence must record the full-benchmark reference, not the subset one"
    )


def test_without_a_full_reference_it_falls_back_to_the_reproduced_baseline(tmp_path) -> None:
    subset_ref, _ = _refs(tmp_path)
    # Subset passes, then every full-set attempt stays below 0.90, so the shared
    # engineering budget is spent and the idea is pruned.
    impl = _implementer(tmp_path, [0.92, 0.70, 0.71, 0.72], {"baseline": subset_ref})
    trace = asyncio.run(impl.implement(Idea(id="h1", hypothesis="h", mechanism="m"), round=0))

    # 0.70 does not beat 0.90, and the engineering budget is spent, so it is pruned.
    assert trace.decision is Decision.BAD, trace.lessons
    assert trace.evidence[-1].baseline_metrics == {"score": 0.90}
