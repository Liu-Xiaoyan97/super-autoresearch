"""§3.5 rebuttal loop at the orchestrator level.

The unit tests cover PeerReviewer / RebuttalPlanner / PaperEnhancer individually, and
the happy-path fixture scores 8.87 on the first review — so it never enters the loop.
These tests force a low score to verify the *orchestration*: rebuttal experiments are
planned and executed, the manuscript is enhanced with their evidence, review runs
again, and the loop stops exactly at the configured caps (A.2: at most two rounds,
review-based refinement at most once).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scientisttwo.types import FinalArtifacts

ROOT = Path(__file__).resolve().parents[3]


def _script(tmp_path: Path, scores: list[float]) -> Path:
    payload = {
        "review.peer": [
            {
                "score": score,
                "strengths": ["Reproducible protocol."],
                "weaknesses": ["Attribution not established."],
                "questions": ["Does the gain survive removing the gate?"],
                "summary": f"Forced score {score}.",
            }
            for score in scores
        ]
    }
    path = tmp_path / "review_script.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _run(tmp_path: Path, scores: list[float], *extra: str):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    args = [
        "run", str(ROOT / "examples" / "ood_frozen_encoder.json"),
        "--mock", "--script", str(_script(tmp_path, scores)),
        "--out", str(out), "--seed", "7", *extra,
    ]
    code = main(args)
    runs = sorted(p for p in out.iterdir() if p.is_dir())
    assert runs, "run wrote no output directory"
    final = FinalArtifacts.model_validate(
        json.loads((runs[-1] / "artifacts" / "final.json").read_text(encoding="utf-8"))
    )
    return code, runs[-1], final


def test_low_score_triggers_rebuttal_then_accepts(tmp_path: Path) -> None:
    code, run_dir, final = _run(tmp_path, [6.0, 8.5])

    assert code == 0, "a successful rebuttal round must not abort the run"
    peers = [step for step in final.decision_path if step.startswith("peer.")]
    assert len(peers) == 2, f"expected two review rounds, got {peers}"
    assert peers[0].startswith("peer.r0:6"), peers
    assert peers[1].startswith("peer.r1:8.5"), peers
    assert final.review is not None and final.review.score == pytest.approx(8.5)
    assert final.review.round == 1, "the accepted review belongs to round 1"
    # The revision must carry rebuttal evidence (§3.5: experiments, not prose).
    manuscript = final.paper
    assert manuscript.round == 1
    assert "rebuttal" in manuscript.sections
    # and the paper still has auditable claims
    assert manuscript.claims and manuscript.evidence_ledger

    traces = (run_dir / "traces.jsonl").read_text(encoding="utf-8").splitlines()
    kinds = [json.loads(line)["kind"] for line in traces]
    assert "stage.review" in kinds


def test_refinement_budget_binds_before_peer_cap(tmp_path: Path) -> None:
    """A.2 allows two peer rounds but review-based refinement only once."""

    code, _, final = _run(tmp_path, [6.0, 6.0, 6.0, 6.0])

    assert code == 0
    peers = [step for step in final.decision_path if step.startswith("peer.")]
    assert len(peers) == 2, f"one enhancement => reviews r0,r1, got {peers}"
    # Never reaches the venue bar, so the paper is exported but not accepted.
    assert final.extra.get("accepted") is False
    assert final.review is not None and final.review.score < 8.0
    assert final.paper.round == 1


def test_peer_round_cap_binds_when_refinements_are_raised(tmp_path: Path) -> None:
    """With the refinement budget lifted, `max_peer_rounds=2` caps reviews at r0..r2."""

    code, _, final = _run(tmp_path, [6.0, 6.0, 6.0, 6.0], "--max-review-refinements", "9")

    assert code == 0
    peers = [step for step in final.decision_path if step.startswith("peer.")]
    assert len(peers) == 3, f"max_peer_rounds=2 means reviews r0..r2, got {peers}"
    assert peers[-1].startswith("peer.r2:6"), peers
    assert final.extra.get("accepted") is False
