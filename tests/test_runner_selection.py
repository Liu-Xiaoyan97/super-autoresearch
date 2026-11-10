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


# --------------------------------------------------------------------------- #
# "Execution failures are data": a crashing benchmark must never raise
# --------------------------------------------------------------------------- #
def _repo_with(tmp_path: Path, body: str) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    (repo / "run_experiment.py").write_text(body, encoding="utf-8")
    return repo


def _workspace(tmp_path: Path, repo: Path, *, timeout_s: float = 10.0):
    import asyncio

    from scientisttwo.config import ScientistTwoConfig
    from scientisttwo.runtime.workspace import FileWorkspace, SubprocessRunner
    from scientisttwo.types import MetricSpec, Problem, Scope

    problem = Problem(
        id="crash", statement="s", repo=str(repo),
        metrics=[MetricSpec(name="score")], reported_metrics={"score": 1.0},
        datasets=["a"], subset_datasets=["a"],
    )
    config = ScientistTwoConfig(runner="subprocess")
    workspace = FileWorkspace(problem, config, str(tmp_path / "store"),
                              runner=SubprocessRunner(tmp_path / "store", timeout_s=timeout_s))
    ready = asyncio.run(workspace.baseline_repo())
    return workspace, ready, Scope


def test_nonzero_exit_becomes_failed_evidence(tmp_path: Path) -> None:
    import asyncio

    repo = _repo_with(tmp_path, "raise SystemExit(3)\n")
    workspace, ready, scope = _workspace(tmp_path, repo)

    result = asyncio.run(workspace.run(ready, scope.SUBSET))
    assert result.status == "failed"
    assert result.metrics == {}
    assert "exited with status 3" in result.stderr


def test_malformed_output_becomes_failed_evidence(tmp_path: Path) -> None:
    import asyncio

    repo = _repo_with(tmp_path, "print('not json')\n")
    workspace, ready, scope = _workspace(tmp_path, repo)

    result = asyncio.run(workspace.run(ready, scope.SUBSET))
    assert result.status == "failed", "a missing/unparsable artifact must not crash the pipeline"
    assert result.metrics == {}


def test_timeout_becomes_failed_evidence(tmp_path: Path) -> None:
    import asyncio

    repo = _repo_with(tmp_path, "import time\ntime.sleep(30)\n")
    workspace, ready, scope = _workspace(tmp_path, repo, timeout_s=0.3)

    result = asyncio.run(workspace.run(ready, scope.SUBSET))
    assert result.status == "failed"
    assert result.wall_time_s < 10, "the timeout must actually cut the process"


def test_crashing_baseline_aborts_the_run_instead_of_raising(tmp_path: Path) -> None:
    repo = _repo_with(tmp_path, "raise SystemExit(9)\n")
    fixture = tmp_path / "crash.json"
    fixture.write_text(json.dumps({
        "id": "crash-fixture",
        "statement": "s",
        "repo": str(repo),
        "metrics": [{"name": "score", "direction": "max"}],
        "reported_metrics": {"score": 1.0},
        "datasets": ["a"],
        "subset_datasets": ["a"],
    }), encoding="utf-8")

    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main(["run", str(fixture), "--out", str(out), "--runner", "subprocess"])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))

    assert code == 2, "a broken baseline is a scientific dead end, not a traceback"
    assert state["aborted"] is True and state["abort_reason"] == "baseline_failed"
