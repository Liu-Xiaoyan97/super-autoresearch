"""The acceptance gate (I7): every condition is necessary, together they suffice.

    accepted = not aborted
               and review.score >= threshold          (§3.5 venue bar)
               and meta_review.decision == "accept"   (§3.6 publication call)
               and integrity is clean                 (§4.3)

Only the negative branches were covered before, so a regression that always returns
`accepted=False` would have passed the whole suite. These tests pin the positive
path and each individual veto.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from scientisttwo.types import FinalArtifacts, IntegrityReport

ROOT = Path(__file__).resolve().parents[3]


def _script(tmp_path: Path, *, score: float, meta: str) -> Path:
    payload = {
        "review.peer": [{
            "score": score,
            "strengths": ["Reproducible protocol."],
            "weaknesses": ["Attribution not extensive."],
            "questions": ["Does the gain survive removing the gate?"],
            "summary": f"Score {score}.",
        }],
        "review.meta": [{"decision": meta, "critique": "none" if meta == "accept" else "weak attribution", "score": score}],
    }
    path = tmp_path / "acceptance_script.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _run(tmp_path: Path, *, score: float, meta: str):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main([
        "run", str(ROOT / "examples" / "ood_frozen_encoder.json"),
        "--mock", "--script", str(_script(tmp_path, score=score, meta=meta)),
        "--out", str(out),
    ])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    final = FinalArtifacts.model_validate(
        json.loads((run_dir / "artifacts" / "final.json").read_text(encoding="utf-8"))
    )
    return code, final


def test_both_gates_pass_marks_the_run_accepted(tmp_path: Path) -> None:
    code, final = _run(tmp_path, score=8.5, meta="accept")

    assert code == 0 and not final.aborted
    assert final.review is not None and final.review.score >= 8.0
    assert final.meta_review is not None and final.meta_review.decision == "accept"
    assert final.integrity is not None and not final.integrity.spec_violations
    assert final.extra.get("accepted") is True, final.extra
    assert final.decision_path[-1] == "run.accept"


def test_meta_refine_vetoes_acceptance_even_with_a_good_score(tmp_path: Path) -> None:
    code, final = _run(tmp_path, score=8.5, meta="refine")

    assert code == 0 and not final.aborted, "a non-improving refinement is not an abort"
    assert final.extra.get("accepted") is False
    assert final.decision_path[-1] == "run.export_incumbent"


def test_meta_review_refuses_to_accept_below_the_venue_bar(tmp_path: Path) -> None:
    """The script asks for `accept` at 7.0; MetaReviewer must downgrade it itself."""

    code, final = _run(tmp_path, score=7.0, meta="accept")

    assert code == 0 and not final.aborted
    assert final.review is not None and final.review.score < 8.0
    assert final.meta_review is not None
    assert final.meta_review.decision == "refine", "§3.6 acceptance requires clearing the bar"
    assert final.extra.get("accepted") is False


def test_integrity_vetoes_acceptance(tmp_path: Path) -> None:
    """A clean review + accept still cannot be called accepted if §4.3 fails."""

    from scientisttwo.agents.base import AgentContext
    from scientisttwo.config import ScientistTwoConfig
    from scientisttwo.core.orchestrator import Orchestrator, build_agents
    from scientisttwo.providers import build_provider
    from scientisttwo.runtime.budget import Budget
    from scientisttwo.runtime.store import ArtifactStore, TraceStore
    from scientisttwo.runtime.workspace import FileWorkspace, SimulatedRunner
    from scientisttwo.types import Problem

    problem = Problem.model_validate(
        json.loads((ROOT / "examples" / "ood_frozen_encoder.json").read_text(encoding="utf-8"))
    )
    config = ScientistTwoConfig(seed=7)
    store = ArtifactStore(tmp_path)
    ctx = AgentContext(
        problem=problem, config=config, llm=build_provider(config, "mock"),
        workspace=FileWorkspace(
            problem, config, str(tmp_path), runner=SimulatedRunner(problem, config, store)
        ),
        store=store, traces=TraceStore(tmp_path / "traces.jsonl"), budget=Budget(),
    )
    agents = build_agents(ctx)

    # Force a passing review and an accepting meta-review, but break method-code
    # alignment below the floor: the gate must still refuse acceptance.
    from scientisttwo.types import MetaReview, Review

    class PassingReviewer:
        async def review(self, manuscript, *, round=0):  # type: ignore[no-untyped-def]
            return Review(manuscript_id=manuscript.id, score=9.0, round=round,
                          strengths=["ok"], weaknesses=[], questions=[])

    class AcceptingMeta:
        async def decide(self, manuscript, review, *, round=0):  # type: ignore[no-untyped-def]
            return MetaReview(decision="accept", critique="", score=9.0, round=round)

    class BrokenAligner:
        async def audit(self, manuscript, *, diff="", evidence=None):  # type: ignore[no-untyped-def]
            return IntegrityReport(score_verified=True, method_code_alignment=0.1)

    agents.peer_reviewer = PassingReviewer()  # type: ignore[assignment]
    agents.meta_reviewer = AcceptingMeta()  # type: ignore[assignment]
    agents.method_code_auditor = BrokenAligner()  # type: ignore[assignment]

    final = asyncio.run(Orchestrator(ctx, agents).run())

    assert final.review is not None and final.review.score == 9.0
    assert final.meta_review is not None and final.meta_review.decision == "accept"
    assert final.extra.get("accepted") is False, "an unclean integrity audit must veto acceptance"
    assert final.extra.get("export_reason") == "integrity_not_clean"
    assert final.extra.get("integrity_warning")
    assert final.decision_path[-1] == "run.export_incumbent"


def test_orchestrator_rejects_an_accept_that_ignores_the_bar(tmp_path: Path) -> None:
    """Defence in depth: a non-conforming reviewer cannot smuggle an acceptance."""

    from scientisttwo.agents.base import AgentContext
    from scientisttwo.config import ScientistTwoConfig
    from scientisttwo.core.orchestrator import Orchestrator, build_agents
    from scientisttwo.providers import build_provider
    from scientisttwo.runtime.budget import Budget
    from scientisttwo.runtime.store import ArtifactStore, TraceStore
    from scientisttwo.runtime.workspace import FileWorkspace, SimulatedRunner
    from scientisttwo.types import MetaReview, Problem, Review

    problem = Problem.model_validate(
        json.loads((ROOT / "examples" / "ood_frozen_encoder.json").read_text(encoding="utf-8"))
    )
    config = ScientistTwoConfig(seed=7)
    store = ArtifactStore(tmp_path)
    ctx = AgentContext(
        problem=problem, config=config, llm=build_provider(config, "mock"),
        workspace=FileWorkspace(
            problem, config, str(tmp_path), runner=SimulatedRunner(problem, config, store)
        ),
        store=store, traces=TraceStore(tmp_path / "traces.jsonl"), budget=Budget(),
    )
    agents = build_agents(ctx)

    class BelowBarReviewer:
        async def review(self, manuscript, *, round=0):  # type: ignore[no-untyped-def]
            return Review(manuscript_id=manuscript.id, score=6.0, round=round,
                          strengths=["ok"], weaknesses=["weak"], questions=["why?"])

    class RecklessMeta:
        async def decide(self, manuscript, review, *, round=0):  # type: ignore[no-untyped-def]
            return MetaReview(decision="accept", critique="", score=6.0, round=round)

    agents.peer_reviewer = BelowBarReviewer()  # type: ignore[assignment]
    agents.meta_reviewer = RecklessMeta()  # type: ignore[assignment]

    final = asyncio.run(Orchestrator(ctx, agents).run())

    assert final.extra.get("accepted") is False
    assert final.extra.get("export_reason") == "peer_review_below_threshold"
    assert final.decision_path[-1] == "run.export_incumbent"
