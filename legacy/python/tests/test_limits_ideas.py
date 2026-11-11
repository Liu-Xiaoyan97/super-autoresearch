"""Offline §3.1/§3.3 contracts without pytest-asyncio or providers.mock."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import pytest

from scientisttwo.agents.base import AgentContext
from scientisttwo.agents.ideas import (
    IdeaEvolver, IdeaGenerator, InitialIdeaGenerator, NoveltyChecker,
    filter_by_guidance, rank_key,
)
from scientisttwo.agents.limitations import LimitationExtractor, LimitationVerifier
from scientisttwo.config import ScientistTwoConfig
from scientisttwo.core.state import ResearchState
from scientisttwo.providers.base import LLMProvider, LLMRequest, LLMResponse
from scientisttwo.runtime.budget import Budget
from scientisttwo.runtime.store import ArtifactStore, TraceStore
from scientisttwo.runtime.workspace import Workspace
from scientisttwo.types import Decision, Evidence, Idea, Limitation, Problem, ResearchDirection, Trace


class FakeProvider(LLMProvider):
    """Small JSON provider exercising the real structured-validation contract."""

    def __init__(self, *responses: dict[str, Any]) -> None:
        super().__init__()
        self.responses = list(responses)
        self.calls: list[LLMRequest] = []

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls.append(req)
        assert self.responses, "Unexpected extra LLM call"
        return LLMResponse(text=json.dumps(self.responses.pop(0)))


def context(
    root: Path, provider: FakeProvider, *, problem: Problem | None = None,
    config: ScientistTwoConfig | None = None,
) -> AgentContext:
    """Use real budget/stores; these text agents do not access a workspace."""

    return AgentContext(
        problem=problem or Problem(id="p", statement="Improve the baseline", domain="forecasting"),
        config=config or ScientistTwoConfig(), llm=provider,
        workspace=cast(Workspace, None), store=ArtifactStore(root),
        traces=TraceStore(root / "traces.jsonl"), budget=Budget(),
    )


def test_extraction_deduplicates_ids_and_normalized_text(tmp_path: Path) -> None:
    provider = FakeProvider({"limitations": [
        {"id": "new1", "text": "  EXISTING\tweakness "},
        {"id": "old", "text": "Another weakness"},
        {"id": "b", "text": "New weakness"},
        {"id": "c", "text": "new   WEAKNESS"},
        {"id": "b", "text": "Same ID different text"},
        {"id": "z", "text": "Distinct weakness"},
    ]})
    ctx = context(tmp_path, provider)
    existing = [Limitation(id="old", text="Existing weakness")]
    new = asyncio.run(LimitationExtractor(ctx).extract(round=2, existing=existing))
    assert [item.id for item in new] == ["b", "z"]
    assert existing == [Limitation(id="old", text="Existing weakness")]
    assert ctx.guidance() in provider.calls[0].user
    assert provider.calls[0].meta["round"] == 2
    assert ctx.budget.llm_calls == 1


def test_extraction_respects_forbidden_even_without_guidance(tmp_path: Path) -> None:
    provider = FakeProvider({"limitations": [
        {"id": "bad", "text": "Try finetuning the backbone"},
        {"id": "ok", "text": "Poor calibration"},
    ]})
    problem = Problem(id="p", statement="Improve", forbidden=["finetuning the backbone"])
    ctx = context(tmp_path, provider, problem=problem)
    limitations = asyncio.run(LimitationExtractor(ctx).extract())
    assert [item.id for item in limitations] == ["ok"]
    assert "finetuning the backbone" in provider.calls[0].user


@pytest.mark.parametrize("decision", ["good", "accept"])
def test_verifier_cannot_override_minimum_floor(tmp_path: Path, decision: str) -> None:
    provider = FakeProvider({"decision": decision, "feedback": "Looks sufficient"})
    ctx = context(tmp_path, provider, config=ScientistTwoConfig(min_limitations=3))
    verdict = asyncio.run(LimitationVerifier(ctx).verify([Limitation(id="l", text="weakness")]))
    assert verdict.decision == Decision.REFINE
    assert "3" in verdict.feedback
    assert ctx.guidance() not in provider.calls[0].system


@pytest.mark.parametrize("decision, expected", [
    ("good", Decision.GOOD), ("accept", Decision.GOOD),
    ("bad", Decision.REFINE), ("engineer", Decision.REFINE), ("refine", Decision.REFINE),
])
def test_verifier_returns_only_sufficiency_decisions(
    tmp_path: Path, decision: str, expected: Decision,
) -> None:
    provider = FakeProvider({"decision": decision})
    ctx = context(tmp_path, provider, config=ScientistTwoConfig(min_limitations=1))
    verdict = asyncio.run(LimitationVerifier(ctx).verify([Limitation(id="l", text="weakness")]))
    assert verdict.decision == expected


def test_rank_key_can_trade_novelty_for_alignment() -> None:
    novel = Idea(id="novel", hypothesis="A", novelty_score=0.9, domain_fit=0.1)
    aligned = Idea(id="aligned", hypothesis="B", novelty_score=0.6, domain_fit=1.0)
    assert rank_key(novel, 0) == 0.9
    assert rank_key(novel, 0) > rank_key(aligned, 0)
    assert rank_key(novel, 0.5) < rank_key(aligned, 0.5)


def test_guidance_filters_alignment_and_must_include_intersection() -> None:
    problem = Problem(id="p", statement="Improve", directions=[
        ResearchDirection(id="hard", title="Safety", must_include=True),
        ResearchDirection(id="other-hard", title="Spectral", must_include=True),
        ResearchDirection(id="soft", title="Efficiency"),
    ])
    ideas = [
        Idea(id="low", hypothesis="A", domain_fit=0.29, direction_ids=["hard"]),
        Idea(id="off", hypothesis="B", domain_fit=0.9, direction_ids=["soft"]),
        Idea(id="pass", hypothesis="C", domain_fit=0.3, direction_ids=["hard"]),
        Idea(id="empty", hypothesis="D", domain_fit=1.0),
    ]
    config = ScientistTwoConfig(strict_directions=True, min_domain_fit=0.3)
    assert [idea.id for idea in filter_by_guidance(ideas, problem, config)] == ["pass"]
    config.strict_directions = False
    assert [idea.id for idea in filter_by_guidance(ideas, problem, config)] == ["empty", "off", "pass"]
    assert filter_by_guidance(ideas, Problem(id="p", statement="Improve"), config) == sorted(ideas, key=lambda idea: idea.id)


def test_zero_weight_hard_direction_does_not_become_a_gate() -> None:
    problem = Problem(id="p", statement="Improve", directions=[
        ResearchDirection(id="disabled", title="Disabled", weight=0, must_include=True),
    ])
    idea = Idea(id="i", hypothesis="A", domain_fit=0.9)
    assert filter_by_guidance([idea], problem, ScientistTwoConfig(strict_directions=True)) == [idea]


@pytest.mark.parametrize("count", [0, 1, 2, 4])
def test_novelty_refs_have_exact_cardinality_and_scores_are_bounded(tmp_path: Path, count: int) -> None:
    provider = FakeProvider({"novelty_score": 4.0, "domain_fit": -3.0,
                             "novelty_refs": ["Paper B", "Paper A", "Paper A"],
                             "direction_ids": ["d1", "invented", "d1"]})
    problem = Problem(id="p", statement="Improve", directions=[ResearchDirection(id="d1", title="Direction")])
    ctx = context(tmp_path, provider, problem=problem, config=ScientistTwoConfig(novelty_refs=count))
    idea = Idea(id="h0", hypothesis="H", mechanism="M")
    scored = asyncio.run(NoveltyChecker(ctx).score(idea))
    assert len(scored.novelty_refs) == count
    assert scored.novelty_score == 1.0
    assert scored.domain_fit == 0.0
    assert scored.direction_ids == ["d1"]
    assert scored.id == idea.id and scored.mechanism == idea.mechanism
    assert idea.novelty_score == 0.0
    assert provider.calls[0].meta["n"] == count
    if count > 2:
        assert "unavailable" in scored.novelty_refs[-1]


def test_novelty_accepts_nested_scored_idea(tmp_path: Path) -> None:
    provider = FakeProvider({"idea": {"id": "changed", "hypothesis": "Do not change identity",
                                       "novelty_score": 0.8, "domain_fit": 0.6,
                                       "novelty_refs": ["Ref 1", "Ref 2"]}})
    scored = asyncio.run(NoveltyChecker(context(tmp_path, provider)).score(Idea(id="h0", hypothesis="Original")))
    assert scored.id == "h0" and scored.hypothesis == "Original"
    assert scored.novelty_score == 0.8 and scored.domain_fit == 0.6
    assert len(scored.novelty_refs) == 2


def test_initial_and_expansion_use_defaultable_envelopes_and_distinct_ids(tmp_path: Path) -> None:
    provider = FakeProvider(
        {"ideas": [{"id": "provider-id", "hypothesis": "Initial", "mechanism": "M"}]},
        {"ideas": [{"id": "h0", "hypothesis": "ID duplicate"},
                   {"id": "h1", "hypothesis": " INITIAL "},
                   {"id": "h2", "hypothesis": "Distinct"}]},
    )
    ctx = context(tmp_path, provider)
    initial = asyncio.run(InitialIdeaGenerator(ctx).generate([]))
    assert initial.id == "h0"
    expanded = asyncio.run(IdeaGenerator(ctx).generate(limitations=[], existing=[initial], n=3))
    assert [idea.id for idea in expanded] == ["h2"]
    assert all(call.schema_name == "IdeaBatch" for call in provider.calls)
    assert ctx.guidance() in provider.calls[-1].user


@pytest.mark.parametrize("guided", [True, False])
def test_evolver_consumes_good_and_bad_metrics_feedback(tmp_path: Path, guided: bool) -> None:
    provider = FakeProvider({"ideas": [{"id": "e1", "hypothesis": "Evolved", "parent_ids": ["bad", "good"]}]})
    ctx = context(tmp_path, provider, config=ScientistTwoConfig(guidance_in_evolution=guided))
    traces = [
        Trace(idea=Idea(id="good", hypothesis="Success"), decision=Decision.GOOD,
              evidence=[Evidence(idea_id="good", metrics={"accuracy": 0.9})], feedback="success feedback"),
        Trace(idea=Idea(id="bad", hypothesis="Failure"), decision=Decision.BAD,
              evidence=[Evidence(idea_id="bad", metrics={"accuracy": 0.2})], feedback="failure feedback"),
    ]
    evolved = asyncio.run(IdeaEvolver(ctx).evolve(traces=traces, n=1, round=2))
    prompt = provider.calls[0].user
    assert "Successful traces" in prompt and "Failed traces" in prompt
    assert "success feedback" in prompt and "failure feedback" in prompt
    assert '"accuracy": 0.9' in prompt and '"accuracy": 0.2' in prompt
    assert (ctx.guidance() in prompt) is guided
    assert ctx.guidance() not in provider.calls[0].system
    assert evolved[0].origin == "evolved" and evolved[0].round == 2
    assert evolved[0].parent_ids == ["bad", "good"]


def test_zero_generation_budget_avoids_provider_calls(tmp_path: Path) -> None:
    provider = FakeProvider()
    ctx = context(tmp_path, provider)
    assert asyncio.run(IdeaGenerator(ctx).generate(limitations=[], existing=[], n=0)) == []
    assert asyncio.run(IdeaEvolver(ctx).evolve(traces=[], n=0, round=1)) == []
    assert provider.calls == []


def test_state_snapshot_serializes_sets_and_zero_seed_request() -> None:
    state = ResearchState(Problem(id="p", statement="Improve"), ScientistTwoConfig())
    state.evaluated_ids = {"z", "a"}
    state.seeds = [Idea(id="unused", hypothesis="H")]
    assert state.next_seeds(0) == []
    snapshot = state.to_dict()
    assert snapshot["evaluated_ids"] == ["a", "z"]
    assert json.loads(json.dumps(snapshot))["problem"]["id"] == "p"
