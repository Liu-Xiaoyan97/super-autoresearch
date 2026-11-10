"""Offline-first command line interface: run, inspect, and trace-only replay."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import traceback
from pathlib import Path
from typing import Any, Sequence

from .agents.base import AgentContext
from .config import ScientistTwoConfig
from .core.orchestrator import Orchestrator
from .providers import build_provider
from .runtime.budget import Budget
from .runtime.store import ArtifactStore, TraceStore, as_jsonable
from .runtime.workspace import FileWorkspace, SimulatedRunner
from .types import FinalArtifacts, Problem

__all__ = ["main", "reconstruct_decision_path"]


def reconstruct_decision_path(records: Sequence[dict[str, Any]]) -> list[str]:
    """Rebuild the state machine's path without a provider or workspace.

    ``state.note`` is authoritative when present; older runs may instead label
    transitions ``stage.*`` or ``state.adopt``. Ordinary generic-stage critic
    telemetry is not a state-machine transition. Snapshots, when provided by a
    producer, replace the accumulated prefix rather than duplicating it.
    """
    have_notes = any(record.get("kind") == "state.note" for record in records)
    path: list[str] = []
    for record in records:
        kind = str(record.get("kind", ""))
        if have_notes and kind != "state.note":
            continue
        if kind not in {"state.note", "state.adopt", "run.abort", "run.done"} and not kind.startswith("stage."):
            continue
        data = record.get("data", {})
        if isinstance(data, str):
            path.append(data)
            continue
        if not isinstance(data, dict):
            continue
        state = data.get("state", {})
        snapshot = data.get("decision_path")
        if snapshot is None and isinstance(state, dict):
            snapshot = state.get("decision_path")
        if isinstance(snapshot, list):
            path = [str(item) for item in snapshot]
            continue
        note = data.get("note", data.get("transition", data.get("decision")))
        if note is None and isinstance(state, dict):
            note = state.get("note")
        if isinstance(note, str):
            path.append(note)
    return path


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _run_root(out: str, run_id: str) -> Path:
    if not run_id or Path(run_id).name != run_id or run_id in {".", ".."}:
        raise ValueError("run_id must be a single directory name")
    return Path(out).expanduser() / run_id


def _new_run_id(out: str, problem: Problem, seed: int) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", problem.id).strip("-") or "problem"
    base = f"{slug}-s{seed}"
    run_id = base
    index = 2
    while _run_root(out, run_id).exists():
        run_id = f"{base}-{index}"
        index += 1
    return run_id


def _write_root_json(store: ArtifactStore, filename: str, value: Any) -> None:
    store.path(filename).write_text(
        json.dumps(as_jsonable(value), indent=2, ensure_ascii=False), encoding="utf-8",
    )


def _summary(
    run_id: str, state: dict[str, Any], final: FinalArtifacts,
    records: list[dict[str, Any]], root: Path,
) -> None:
    print(f"Run: {run_id} (simulated experiments; not scientific validation)")
    print(f"Limitations: {len(state.get('limitations', []))}; seeds: {len(state.get('seeds', []))}")
    for trace in state.get("traces", []):
        idea = trace.get("idea", {})
        print(f"  round {trace.get('round', 0)}: {idea.get('id', '?')} {trace.get('decision', '?')}")
    best = state.get("best_idea") or state.get("h_best") or {}
    print(f"h_best: {best.get('id', 'none')}")
    ablation = state.get("ablation_verdict") or {}
    if not ablation:
        for record in records:
            if "ablation" in str(record.get("kind", "")):
                data = record.get("data", {})
                if isinstance(data, dict) and isinstance(data.get("verdict"), dict):
                    ablation = data["verdict"]
                elif isinstance(data, dict) and "decision" in data and not ablation:
                    ablation = data
    print(f"Ablation verdict: {ablation.get('decision', 'see decision path')}")
    scores: list[Any] = []
    for record in records:
        data = record.get("data", {})
        if isinstance(data, dict) and "review" in str(record.get("kind", "")):
            review = data.get("review", data)
            if isinstance(review, dict) and "score" in review:
                scores.append(review["score"])
    if not scores and final.review:
        scores.append(final.review.score)
    print(f"Review scores: {', '.join(map(str, scores)) or 'none'}")
    print(f"Meta decision: {final.meta_review.decision if final.meta_review else 'none'}")
    print("Decision path: " + " -> ".join(final.decision_path))
    if final.aborted:
        print(f"ABORTED: {final.abort_reason}")
    print(f"Artifacts: {root / 'state.json'}, {root / 'traces.jsonl'}, {root / 'final.json'}")


async def _run(args: argparse.Namespace) -> int:
    problem = Problem.model_validate(_load_json(Path(args.fixture)))
    run_id = _new_run_id(args.out, problem, args.seed)
    overrides: dict[str, Any] = {"run_id": run_id, "out_dir": args.out, "seed": args.seed}
    if args.max_refine_rounds is not None:
        overrides["max_refine_rounds"] = args.max_refine_rounds
    if args.max_review_refinements is not None:
        overrides["max_review_refinements"] = args.max_review_refinements
    config = ScientistTwoConfig(**overrides)
    provider_name = "mock" if args.mock else args.provider
    options: dict[str, Any] = {}
    if args.script:
        if provider_name != "mock":
            raise ValueError("--script is only supported by the mock provider")
        script = _load_json(Path(args.script))
        if not isinstance(script, dict):
            raise ValueError("mock script must be a task-keyed JSON object")
        options["script"] = script
    llm = build_provider(config, provider_name, **options)
    if provider_name != "mock":
        config.model_routes = {
            key: route.model_copy(update={
                "provider": provider_name, "model": getattr(llm, "model", route.model),
            })
            for key, route in config.model_routes.items()
        }
    root = _run_root(args.out, run_id)
    store = ArtifactStore(root)
    traces = TraceStore(store.path("traces.jsonl"))
    budget = Budget(
        max_llm_calls=config.max_llm_calls, max_experiments=config.max_experiments,
        max_wall_time_s=config.max_wall_time_s,
    )
    workspace = FileWorkspace(problem, config, str(root), runner=SimulatedRunner(problem, config, store))
    ctx = AgentContext(
        problem=problem, config=config, llm=llm, workspace=workspace,
        store=store, traces=traces, budget=budget,
    )
    try:
        orchestrator = Orchestrator(ctx)
        final = await orchestrator.run()
        state = orchestrator.state_dict()
        _write_root_json(store, "state.json", state)
        _write_root_json(store, "final.json", final)
        _summary(run_id, state, final, traces.read_all(), root)
        return 2 if final.aborted else 0
    finally:
        await llm.aclose()


def _inspect(args: argparse.Namespace, *, replay: bool) -> int:
    root = _run_root(args.out, args.run_id)
    records = TraceStore(root / "traces.jsonl").read_all()
    if not (root / "traces.jsonl").is_file():
        raise FileNotFoundError(root / "traces.jsonl")
    state = _load_json(root / "state.json")
    recorded = state.get("decision_path", [])
    if replay:
        reconstructed = reconstruct_decision_path(records)
        print("Decision path: " + " -> ".join(reconstructed))
        if reconstructed != recorded:
            print(f"Replay mismatch: recorded={recorded!r}, reconstructed={reconstructed!r}", file=sys.stderr)
            return 1
        print(f"Replay matches ({len(reconstructed)} transitions; no model or workspace used).")
    else:
        print(f"Run: {args.run_id}; traces: {len(records)}; aborted: {state.get('aborted', False)}")
        print("Decision path: " + " -> ".join(recorded))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scientisttwo")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="execute the research pipeline")
    run.add_argument("fixture", help="serialized Problem JSON")
    run.add_argument("--mock", action="store_true", help="force deterministic offline provider")
    run.add_argument("--script", help="optional task-keyed mock JSON script (e.g. examples/mock_script.json)")
    run.add_argument("--provider", default="mock", choices=["mock", "openai", "kimi", "openai_compat"])
    run.add_argument("--out", default="runs")
    run.add_argument("--seed", type=int, default=7)
    run.add_argument("--max-refine-rounds", type=int)
    run.add_argument("--max-review-refinements", type=int,
                     help="cap on review-driven enhancements (§3.5, A.2: at most once)")
    for name in ("inspect", "replay"):
        command = commands.add_parser(name)
        command.add_argument("run_id")
        command.add_argument("--out", default="runs")
    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            return asyncio.run(_run(args))
        return _inspect(args, replay=args.command == "replay")
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
