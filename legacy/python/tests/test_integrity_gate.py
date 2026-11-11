"""§4.3 at the orchestration level: a rule-violating success is discarded on the spot.

Paper (p.14): "we introduce a validation filter that uses the Coding Agent to detect and
discard rule-violating solutions **immediately after experimentation**".

The offline provider never fabricates audit accusations (its violation lists are always
empty), so only the deterministic check can fire offline - which makes this the honest
test of the wiring: same fixture, same seed, only `Problem.forbidden` differs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _fixture(tmp_path: Path, *, forbidden: list[str]) -> Path:
    payload = json.loads((ROOT / "examples" / "ood_frozen_encoder.json").read_text(encoding="utf-8"))
    payload["id"] = "spec-gate"
    payload["forbidden"] = forbidden
    path = tmp_path / "spec_gate.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _run(tmp_path: Path, *, forbidden: list[str]):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main(["run", str(_fixture(tmp_path, forbidden=forbidden)), "--mock",
                 "--out", str(out), "--max-refine-rounds", "2"])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    return code, state


def _verdicts(state: dict) -> list[str]:
    return [tok.rsplit(":", 1)[-1] for tok in state["decision_path"] if tok.startswith("round")]


def test_forbidden_approach_discards_successes_immediately(tmp_path: Path) -> None:
    # The offline mechanisms all read "residual-alignment refinement (variant N)",
    # so this ban matches every proposed patch.
    code, state = _run(tmp_path, forbidden=["residual-alignment refinement"])

    violations = [tok.split(":", 1)[1] for tok in state["decision_path"] if tok.startswith("spec.violation:")]
    assert violations, "no spec violation was recorded: the §4.3 gate is not wired"
    forced = {trace["idea"]["id"]: trace["decision"] for trace in state["traces"]}
    assert all(forced.get(idea_id) == "bad" for idea_id in violations), (
        "every flagged idea must be recorded as BAD, not merely annotated"
    )
    assert any("Specification violation" in lesson for trace in state["traces"]
               for lesson in trace.get("lessons", [])), "the violation must explain itself in the trace"
    assert set(_verdicts(state)) == {"bad"}, "a violating idea must not survive as Good"
    assert code == 2
    assert state["aborted"] is True and state["abort_reason"] == "no_good_ideas"
    # Nothing violating may reach the output.
    assert state["best_idea"] is None
    assert state["manuscript"] is None


def test_without_the_ban_the_same_run_succeeds(tmp_path: Path) -> None:
    """Control: the difference must come from the gate, not from the seed or fixture."""

    code, state = _run(tmp_path, forbidden=[])

    assert not [tok for tok in state["decision_path"] if "spec.violation" in tok]
    assert "good" in _verdicts(state), "the control run must reach at least one Good idea"
    assert code == 0
    assert state["best_idea"] is not None
