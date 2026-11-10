"""Offline structural/evidence checks for §§3.4–3.6; no scientific-score oracle."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import pytest

from scientisttwo.agents.ablation import AblationCritic, AblationPlanner
from scientisttwo.agents.base import AgentContext
from scientisttwo.agents.review import MetaReviewer, PeerReviewer, RebuttalPlanner
from scientisttwo.agents.writing import InitialDrafter, PaperEnhancer, validate_manuscript
from scientisttwo.config import ScientistTwoConfig
from scientisttwo.providers.base import LLMProvider, LLMRequest, LLMResponse
from scientisttwo.runtime.budget import Budget
from scientisttwo.runtime.store import ArtifactStore, TraceStore
from scientisttwo.runtime.workspace import Workspace
from scientisttwo.types import (
    AblationResult,
    Claim,
    Decision,
    Evidence,
    ExperimentResult,
    Idea,
    Manuscript,
    MetricSpec,
    Problem,
    ResearchDirection,
    Review,
    Scope,
)


class FakeProvider(LLMProvider):
    """Tiny task-keyed JSON provider; never imports the shared mock implementation."""

    def __init__(self, script: dict[str, list[dict[str, Any]]] | None = None) -> None:
        super().__init__()
        self.script = {task: list(values) for task, values in (script or {}).items()}
        self.calls: list[LLMRequest] = []

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls.append(req)
        values = self.script.get(req.task, [])
        return LLMResponse(text=json.dumps(values.pop(0) if values else {}))


def make_context(tmp_path: Path, script: dict[str, list[dict[str, Any]]] | None = None,
                 **config_values: Any) -> AgentContext:
    problem = Problem(
        id="problem", statement="Improve frozen forecasting", source_paper="Human Reference",
        datasets=["held-out-series"], metrics=[MetricSpec(name="accuracy", tolerance=0.001)],
        directions=[ResearchDirection(id="d1", title="Spectral priors", keywords=["FFT"])],
    )
    return AgentContext(
        problem=problem, config=ScientistTwoConfig(**config_values), llm=FakeProvider(script),
        workspace=cast(Workspace, None), store=ArtifactStore(tmp_path),
        traces=TraceStore(tmp_path / "traces.jsonl"), budget=Budget(),
    )


def idea() -> Idea:
    return Idea(id="idea", hypothesis="Spectral priors improve predictions", mechanism="spectral transform and safety gate",
                direction_ids=["d1"])


def best() -> Evidence:
    return Evidence(idea_id="idea", scope=Scope.FULL, metrics={"accuracy": 0.9}, label="full-run")


def manuscript(config: ScientistTwoConfig) -> Manuscript:
    sections = {section: f"Substantive {section} content." for section in config.required_sections}
    sections["method"] = "Replace the human baseline representation with spectral priors (d1)."
    return Manuscript(
        id="paper", title="Spectral forecasting", sections=sections, abstract=sections["abstract"],
        claims=[Claim(text="Measured accuracy is 0.9.", metric="accuracy", value=0.9, evidence_ref="full-run")],
        evidence_ledger={"accuracy": 0.9}, format=config.venue_format,
    )


def test_planner_config_count_distinct_components_and_guidance(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, n_ablation_plans=6)
    plans = asyncio.run(AblationPlanner(ctx).plan(idea(), best=best(), n=6))
    assert len(plans) == 6
    assert len({plan.component for plan in plans}) == 6
    assert len({plan.id for plan in plans}) == 6
    assert all(plan.variant_of == "idea" and plan.expects for plan in plans)
    assert all("remove only" in plan.description and "accuracy" in plan.description for plan in plans)
    assert [plan.component for plan in plans][-3:] == [
        "structural ablation: primary mechanism", "structural ablation: auxiliary loss/regularizer",
        "structural ablation: input representation",
    ]
    provider = cast(FakeProvider, ctx.llm)
    assert provider.calls[0].meta["n"] == 6
    assert ctx.guidance() in provider.calls[0].user
    assert ctx.budget.llm_calls == 1


def test_empty_idea_uses_fixed_structural_padding_order(tmp_path: Path) -> None:
    ctx = make_context(tmp_path)
    plans = asyncio.run(AblationPlanner(ctx).plan(Idea(id="empty", hypothesis=""), best=best()))
    assert [plan.component for plan in plans] == [
        "structural ablation: primary mechanism", "structural ablation: auxiliary loss/regularizer",
        "structural ablation: input representation", "structural ablation: safety/calibration gate",
        "structural ablation: training-free adaptation",
    ]


def test_planner_rejects_nonpositive_count(tmp_path: Path) -> None:
    ctx = make_context(tmp_path)
    ctx.config = ctx.config.model_copy(update={"n_ablation_plans": 0})
    with pytest.raises(ValueError, match="must be positive"):
        asyncio.run(AblationPlanner(ctx).plan(idea(), best=best()))
    assert ctx.budget.llm_calls == 0


def test_planner_deduplicates_and_rejects_hyperparameter_sweeps(tmp_path: Path) -> None:
    response = {"plans": [
        {"id": "a", "component": "gate", "description": "Remove gate"},
        {"id": "b", "component": "GATE", "description": "Disable gate"},
        {"id": "c", "component": "learning rate sweep", "description": "Sweep"},
    ]}
    ctx = make_context(tmp_path, {"ablation.plan": [response]}, n_ablation_plans=3)
    plans = asyncio.run(AblationPlanner(ctx).plan(idea(), best=best()))
    assert len(plans) == 3
    assert plans[0].component == "gate"
    assert all("sweep" not in plan.component for plan in plans)
    assert len({plan.component.casefold() for plan in plans}) == 3


@pytest.mark.parametrize(("provider_decision", "metric", "expected"), [
    ("good", 0.8, Decision.GOOD),
    ("refine", 0.8, Decision.REFINE),
    ("good", 0.9, Decision.REFINE),
    ("good", 0.95, Decision.REFINE),
    ("bad", 0.8, Decision.REFINE),
])
def test_critic_good_refine_and_dead_weight_paths(tmp_path: Path, provider_decision: str,
                                                metric: float, expected: Decision) -> None:
    ctx = make_context(tmp_path, {"ablation.critic": [{"decision": provider_decision, "feedback": "Assess gate."}]})
    result = AblationResult(plan_id="remove-gate", component="safety gate", metrics={"accuracy": metric})
    verdict = asyncio.run(AblationCritic(ctx).judge(idea(), [result], best=best()))
    assert verdict.decision == expected
    assert "safety gate" in verdict.feedback and "re-measure accuracy" in verdict.feedback
    assert "Remove or merge" in verdict.feedback or "remove or merge" in verdict.feedback
    assert ctx.budget.llm_calls == 1


def test_critic_failed_experiment_never_good(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, {"ablation.critic": [{"decision": "good"}]})
    result = AblationResult(plan_id="failed", component="gate", metrics={"accuracy": 0.8},
                            evidence=Evidence(idea_id="idea", metrics={"accuracy": 0.8},
                                              result=ExperimentResult(status="failed")))
    assert asyncio.run(AblationCritic(ctx).judge(idea(), [result], best=best())).decision == Decision.REFINE


def test_validate_manuscript_well_formed_missing_section_and_unsupported_claim(tmp_path: Path) -> None:
    ctx = make_context(tmp_path)
    paper = manuscript(ctx.config)
    snapshot = paper.model_dump_json()
    assert validate_manuscript(paper, ctx.config, ctx.problem) == []
    assert paper.model_dump_json() == snapshot
    del paper.sections["ablation"]
    paper.claims.append(Claim(text="Unsupported speedup.", metric="speedup", value=2.0, evidence_ref="invented"))
    errors = validate_manuscript(paper, ctx.config, ctx.problem)
    assert any("Missing required section: ablation" in error for error in errors)
    assert any("speedup" in error and "absent from provided evidence" in error for error in errors)


def test_validate_numeric_value_ledger_tolerance_and_optional_ledger(tmp_path: Path) -> None:
    ctx = make_context(tmp_path)
    paper = manuscript(ctx.config)
    paper.claims[0].value = None
    assert any("numeric value" in error for error in validate_manuscript(paper, ctx.config, ctx.problem))
    paper.claims[0].value = 0.9 + 5e-10
    assert validate_manuscript(paper, ctx.config, ctx.problem) == []
    paper.claims[0].value = 0.91
    assert any("does not match" in error for error in validate_manuscript(paper, ctx.config, ctx.problem))
    paper.evidence_ledger = {}
    assert validate_manuscript(paper, ctx.config, ctx.problem) == ["no evidence ledger"]


def test_validate_directions_accept_keywords_and_flag_absence(tmp_path: Path) -> None:
    ctx = make_context(tmp_path)
    paper = manuscript(ctx.config)
    paper.title = "Study"
    paper.sections["method"] = "Replace the human baseline representation."
    assert any("direction mention" in error for error in validate_manuscript(paper, ctx.config, ctx.problem))
    paper.sections["introduction"] = "FFT provides the motivation."
    assert validate_manuscript(paper, ctx.config, ctx.problem) == []
    ctx.problem.directions = []
    paper.sections["introduction"] = "Other motivation."
    assert validate_manuscript(paper, ctx.config, ctx.problem) == []


@pytest.mark.parametrize(("score", "expected"), [(-20.0, 1.0), (99.0, 10.0), (7.0, 7.0), (8.0, 8.0), (float("nan"), 1.0)])
def test_peer_score_bounds_and_low_score_invariants(tmp_path: Path, score: float, expected: float) -> None:
    ctx = make_context(tmp_path, {"review.peer": [{"score": score, "strengths": [" "]}]})
    review = asyncio.run(PeerReviewer(ctx).review(manuscript(ctx.config), round=2))
    assert review.score == expected and 1 <= review.score <= review.scale_max
    assert review.manuscript_id == "paper" and review.round == 2
    assert review.strengths and all(item.strip() for item in review.strengths)
    if expected < ctx.config.review_threshold:
        assert review.weaknesses and review.questions
        assert "accuracy" in review.questions[0]
    assert ctx.budget.llm_calls == 1


def test_peer_honors_custom_scale(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, {"review.peer": [{"score": 9}]}, review_scale_max=5, review_threshold=4)
    review = asyncio.run(PeerReviewer(ctx).review(manuscript(ctx.config)))
    assert review.score == review.scale_max == 5


def test_initial_drafter_populates_sections_directions_and_measured_claims(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, {"write.draft": [{"claims": [
        {"text": "Fabrication", "metric": "speedup", "value": 12, "evidence_ref": "imagined"}
    ]}]})
    ablation = AblationResult(plan_id="no-gate", component="gate", metrics={"accuracy": 0.8})
    paper = asyncio.run(InitialDrafter(ctx).draft(idea=idea(), best=best(), ablations=[ablation],
                                                round=3, reviewer_feedback="Isolate the safety gate."))
    assert validate_manuscript(paper, ctx.config, ctx.problem) == []
    assert paper.round == 3 and paper.format == "iclr2025"
    assert "d1" in paper.sections["method"] and "baseline" in paper.sections["method"]
    assert "Isolate the safety gate" in paper.sections["method"]
    assert paper.evidence_ledger == {"accuracy": 0.9, "ablation:no-gate:accuracy": 0.8}
    assert paper.claims and all(claim.metric != "speedup" for claim in paper.claims)
    assert all(paper.evidence_ledger[claim.metric] == claim.value for claim in paper.claims)


def test_enhancer_drops_unsupported_and_wrong_value_claims(tmp_path: Path) -> None:
    additions = [
        {"text": "Old result", "metric": "accuracy", "value": 0.9, "evidence_ref": "full-run"},
        {"text": "Measured cost", "metric": "latency", "value": 12.0, "evidence_ref": "rebuttal-run"},
        {"text": "Wrong cost", "metric": "latency", "value": 1.0, "evidence_ref": "rebuttal-run"},
        {"text": "Fabricated speedup", "metric": "speedup", "value": 20.0, "evidence_ref": "fake"},
    ]
    ctx = make_context(tmp_path, {"write.enhance": [{"claims": additions, "evidence_ledger": {"speedup": 20}}]})
    paper = manuscript(ctx.config)
    original = paper.model_dump_json()
    supplementary = Evidence(idea_id="idea", scope=Scope.REBUTTAL, metrics={"latency": 12}, label="rebuttal-run")
    enhanced = asyncio.run(PaperEnhancer(ctx).enhance(manuscript=paper, review=Review(score=7), rebuttal=[supplementary]))
    assert [(claim.metric, claim.value) for claim in enhanced.claims] == [("accuracy", 0.9), ("latency", 12)]
    assert "speedup" not in enhanced.evidence_ledger
    assert enhanced.round == paper.round + 1
    assert validate_manuscript(enhanced, ctx.config, ctx.problem) == []
    assert paper.model_dump_json() == original


def test_enhancer_cannot_introduce_claims_from_old_or_failed_evidence(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, {"write.enhance": [{"claims": [
        {"text": "Unclaimed old metric", "metric": "latency", "value": 12, "evidence_ref": "old-run"},
        {"text": "Failed finding", "metric": "robustness", "value": 0.99, "evidence_ref": "failed-run"},
    ]}]})
    paper = manuscript(ctx.config)
    paper.evidence_ledger["latency"] = 12
    failed = Evidence(idea_id="idea", scope=Scope.REBUTTAL, metrics={"robustness": 0.99},
                      result=ExperimentResult(status="failed"))
    enhanced = asyncio.run(PaperEnhancer(ctx).enhance(manuscript=paper, review=Review(score=7), rebuttal=[failed]))
    assert enhanced.claims == []
    assert "robustness" not in enhanced.evidence_ledger


def test_rebuttal_questions_become_executable_tasks(tmp_path: Path) -> None:
    ctx = make_context(tmp_path)
    review = Review(manuscript_id="paper", questions=["Is the gate necessary?", "Does it generalize?"], score=6)
    tasks = asyncio.run(RebuttalPlanner(ctx).plan(review, n=3))
    assert len(tasks) == len({task.id for task in tasks}) == 3
    assert [task.question for task in tasks] == [review.questions[0], review.questions[1], review.questions[0]]
    assert all("held-out" in task.experiment and "accuracy" in task.experiment and "C_best" in task.experiment for task in tasks)
    assert all("held-out-series" in task.experiment and ".json" in task.experiment for task in tasks)
    assert cast(FakeProvider, ctx.llm).calls[0].meta["n"] == 3


@pytest.mark.parametrize(("score", "missing", "model_decision", "expected"), [
    (8.0, False, "accept", "accept"), (7.9, False, "accept", "refine"),
    (9.0, True, "accept", "refine"), (9.0, False, "refine", "refine"),
])
def test_meta_score_and_structural_gates(tmp_path: Path, score: float, missing: bool,
                                        model_decision: str, expected: str) -> None:
    ctx = make_context(tmp_path, {"review.meta": [{"decision": model_decision, "critique": "Polish wording."}]})
    paper = manuscript(ctx.config)
    if missing:
        del paper.sections["ablation"]
    result = asyncio.run(MetaReviewer(ctx).decide(paper, Review(manuscript_id=paper.id, score=score), round=1))
    assert result.decision == expected and result.score == score and result.round == 1
    if expected == "refine":
        assert "Empirical weakness" in result.critique and "re-measure accuracy" in result.critique


def test_meta_unsupported_claim_cannot_accept(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, {"review.meta": [{"decision": "accept"}]})
    paper = manuscript(ctx.config)
    paper.claims[0].value = 0.99
    result = asyncio.run(MetaReviewer(ctx).decide(paper, Review(score=10)))
    assert result.decision == "refine" and "does not match" in result.critique
