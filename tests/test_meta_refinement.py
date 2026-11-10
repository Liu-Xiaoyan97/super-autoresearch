"""§3.6 meta-refinement: adopting vs. declining, side by side.

`examples/meta_refine.json` is the same research problem as the happy-path fixture;
what changes the outcome is whether the meta-refinement actually *measures* better.
The offline provider (unscripted) proposes a refinement that does not, so the system
declines it; `examples/mock_script.json` pins a refinement that does, so the system
adopts it. Neither path bends the empirical gate (I2).

Pinned here so that (a) nobody "fixes" the unscripted path by weakening the gate, and
(b) the fixture's dependency on the script is documented as behaviour, not folklore.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _run(tmp_path: Path, *extra: str):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main([
        "run", str(ROOT / "examples" / "meta_refine.json"),
        "--mock", "--out", str(out), *extra,
    ])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    return code, state


def test_unscripted_refinement_is_declined_when_it_does_not_measure_better(tmp_path: Path) -> None:
    code, state = _run(tmp_path)
    path = state["decision_path"]

    assert code == 0, "declining a refinement is a normal outcome, not an abort"
    assert state["aborted"] is False
    assert "meta.refine" in path, "the fixture must reach §3.6 with a refine verdict"
    assert "meta.keep" in path, "an unmeasured improvement must be declined"
    assert not any(token.startswith("adopt.meta") for token in path)
    assert state["export_reason"] == "meta_refinement_not_strictly_better"


def test_scripted_refinement_is_adopted_when_it_does_measure_better(tmp_path: Path) -> None:
    code, state = _run(tmp_path, "--script", str(ROOT / "examples" / "mock_script.json"))
    path = state["decision_path"]

    assert code == 0
    adopted = [token for token in path if token.startswith("adopt.meta:")]
    assert adopted, f"a strictly better refinement must replace the incumbent, got {path[-6:]}"
    # The adopted hypothesis is the scripted one, and the paper is re-drafted from it.
    assert state["best_idea"] is not None
    assert state["manuscript"]["round"] >= 1, "a meta adoption must re-draft the manuscript"
    assert state["export_reason"] != "meta_refinement_not_strictly_better"
