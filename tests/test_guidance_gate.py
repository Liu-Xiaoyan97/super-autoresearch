"""SPEC G4: `must_include` only becomes a hard gate when `strict_directions` is on.

Guidance is soft by default (a ranking weight) and hard only on request. `filter_by_guidance`
is unit-tested; these tests cover the wiring from the CLI flag through the seed pool, which
is the difference between "documented rule" and "rule the product can actually apply".
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _fixture(tmp_path: Path, *, must_include: bool) -> Path:
    payload = {
        "id": "strict-guidance",
        "statement": "Improve the reproduced baseline inside a mandated direction.",
        "domain": "synthetic",
        "metrics": [{"name": "score", "direction": "max", "tolerance": 0.002}],
        "reported_metrics": {"score": 1.0},
        "datasets": ["a", "b"],
        "subset_datasets": ["a"],
        "directions": [
            {"id": "core", "title": "core mechanism", "description": "must be pursued",
             "keywords": ["core"], "weight": 1.0, "must_include": must_include},
        ],
    }
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _run(tmp_path: Path, fixture: Path, *extra: str):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main(["run", str(fixture), "--mock", "--out", str(out), *extra])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    return code, json.loads((run_dir / "state.json").read_text(encoding="utf-8"))


def test_soft_direction_does_not_block_seeds(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path, must_include=True)

    code, state = _run(tmp_path, fixture)  # no --strict-directions
    assert state["seeds"], "a soft direction must never empty the seed pool"
    assert state["abort_reason"] != "no_eligible_seeds"
    assert code in (0, 2)


def test_strict_directions_enforced_end_to_end(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path, must_include=True)

    # The offline provider's generic ideas carry direction ids that cannot match the
    # problem's, so a hard gate legitimately leaves nothing to test.
    code, state = _run(tmp_path, fixture, "--strict-directions")

    assert code == 2
    assert state["aborted"] is True
    assert state["abort_reason"] == "no_eligible_seeds"
    assert state["seeds"] == []
    assert state["traces"] == [], "nothing may be executed once the hard gate emptied the pool"


def test_strict_flag_is_inert_without_must_include(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path, must_include=False)

    code, state = _run(tmp_path, fixture, "--strict-directions")

    assert state["seeds"], "no direction is hard, so nothing may be filtered"
    assert state["abort_reason"] != "no_eligible_seeds"
