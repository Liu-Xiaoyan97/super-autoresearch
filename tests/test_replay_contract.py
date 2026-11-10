"""Replay contract: every decision token must exist in the trace stream.

`cli replay` rebuilds the decision path from `traces.jsonl` alone - no model, no
workspace - and fails on mismatch. That only works if every `state.note(token)` is
accompanied by a trace record carrying that token. Today the guarantee is structural
(`state.note` is called from exactly one place, `Orchestrator._transition`); these
tests pin the *observable* property so a refactor cannot break replay silently.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
# state.adopt carries the incumbent-change token; replay consumes it too.
TRANSITION_PREFIXES = ("stage.", "state.", "run.")


def _run(tmp_path: Path, fixture: str = "ood_frozen_encoder", expect: int = 0):
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    code = main(["run", str(ROOT / "examples" / f"{fixture}.json"), "--mock", "--out", str(out)])
    # The CLI contract: 0 = completed, 2 = scientific abort (still replayable).
    assert code == expect, f"expected exit {expect}, got {code}"
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]
    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    records = [
        json.loads(line)
        for line in (run_dir / "traces.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return run_dir, state, records


def _transition_labels(records: list[dict]) -> list[str]:
    labels = []
    for record in records:
        if not str(record.get("kind", "")).startswith(TRANSITION_PREFIXES):
            continue
        data = record.get("data") or {}
        labels.append(data.get("token") or data.get("decision"))
    return labels


def test_every_noted_decision_has_a_trace_payload(tmp_path: Path) -> None:
    _, state, records = _run(tmp_path)

    labels = _transition_labels(records)
    assert state["decision_path"], "the run must record decisions"
    assert all(label for label in labels), "every transition trace needs a token/decision label"
    assert labels == state["decision_path"], (
        "decision_path and the traced labels diverged; replay would not be able to "
        f"rebuild the run.\nstate : {state['decision_path']}\ntraces: {labels}"
    )


def test_aborted_run_is_also_replayable(tmp_path: Path) -> None:
    run_dir, state, records = _run(tmp_path, "abort_case", expect=2)

    assert state["aborted"] is True and state["abort_reason"] == "no_good_ideas"
    assert _transition_labels(records) == state["decision_path"]
    assert state["decision_path"][-1] == "run.abort"


def test_replay_reproduces_the_path_from_traces_alone(tmp_path: Path) -> None:
    from scientisttwo.cli import main

    out = tmp_path / "runs"
    main(["run", str(ROOT / "examples" / "meta_refine.json"), "--mock", "--out", str(out)])
    run_dir = sorted(path for path in out.iterdir() if path.is_dir())[-1]

    # Truncate the trace file mid-run: replay must not depend on state.json content.
    traces = (run_dir / "traces.jsonl").read_text(encoding="utf-8").splitlines()
    code_before = main(["replay", run_dir.name, "--out", str(out)])
    assert code_before == 0

    state = json.loads((run_dir / "state.json").read_text(encoding="utf-8"))
    (run_dir / "traces.jsonl").write_text("\n".join(traces[:-3]) + "\n", encoding="utf-8")
    code_after = main(["replay", run_dir.name, "--out", str(out)])

    assert code_after != 0, "a truncated trace stream must fail replay, not pass silently"
    assert state["decision_path"], "the recorded path is what replay compares against"
