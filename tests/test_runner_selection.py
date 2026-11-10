"""`--runner` must actually switch the execution backend.

`FileWorkspace` selects SimulatedRunner or SubprocessRunner from `config.runner`, but
the CLI used to hard-code the simulator, so `runner="subprocess"` (documented in the
README) silently did nothing. These tests assert the observable consequence of each
backend: which measurement records land on disk, and what a real execution can
achieve on the synthetic scaffold.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _run(tmp_path: Path, *extra: str):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main([
        "run", str(ROOT / "examples" / "ood_frozen_encoder.json"),
        "--out", str(out), *extra,
    ])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    measurements = sorted(p.name for p in (run_dir / "artifacts" / "experiments").glob("*.json"))
    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    return code, measurements, state


def test_default_runner_is_the_deterministic_simulator(tmp_path: Path) -> None:
    code, measurements, state = _run(tmp_path, "--max-refine-rounds", "1")

    assert code == 0
    assert any(name.startswith("simulated-") for name in measurements)
    assert not any(name.startswith("process-") for name in measurements)
    assert state["decision_path"], "the simulated run must reach decisions"


def test_subprocess_flag_executes_the_repository(tmp_path: Path) -> None:
    code, measurements, state = _run(tmp_path, "--runner", "subprocess", "--max-refine-rounds", "1")

    assert any(name.startswith("process-") for name in measurements), (
        "--runner subprocess produced no process records: the flag was ignored"
    )
    assert not any(name.startswith("simulated-") for name in measurements)
    # The synthetic scaffold returns the same metrics for every idea, so nothing can
    # be *strictly* better than the reproduced baseline - an honest, observable abort.
    assert code == 2
    assert state["aborted"] is True and state["abort_reason"] == "no_good_ideas"
