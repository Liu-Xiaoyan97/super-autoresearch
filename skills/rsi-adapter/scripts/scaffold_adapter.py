#!/usr/bin/env python3
"""Create a skeleton directly in an independent target git checkout.

Invoked by the rsi-adapter Pi skill; generated project code never belongs in RSI.
A skeleton is NOT usable until implemented and remotely accepted via native tools.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path, PurePosixPath
import pprint
import re
import subprocess

SKILL_DIR = Path(__file__).resolve().parents[1]
SCOPES = ["subset", "full", "ablation", "rebuttal"]


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "adapter"


def validate_metrics(raw: object) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("problem.metrics must be a non-empty list")
    metrics = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
            raise ValueError("each metric requires a name")
        name = item["name"]
        if name in seen:
            raise ValueError(f"duplicate metric name: {name}")
        seen.add(name)
        direction = item.get("direction", "max")
        if direction not in ("min", "max"):
            raise ValueError("metric direction must be min or max")
        tolerance = float(item.get("tolerance", 0))
        weight = float(item.get("weight", 1))
        if not math.isfinite(tolerance) or tolerance < 0 or not math.isfinite(weight):
            raise ValueError("metric tolerance/weight must be finite; tolerance >= 0")
        bounds = item.get("bounds")
        if bounds is not None:
            if not isinstance(bounds, list) or len(bounds) != 2 or any(type(v) not in (float, int) or not math.isfinite(v) for v in bounds) or bounds[0] > bounds[1]:
                raise ValueError("metric bounds must be finite [low, high]")
        metrics.append(dict(name=name, direction=direction, tolerance=tolerance, weight=weight, bounds=bounds))
    return metrics


def adapter_rel_path(command: object, slug: str) -> str:
    if command is not None and (not isinstance(command, list) or any(not isinstance(t, str) for t in command)):
        raise ValueError("experiment_command must be a string array")
    script = next((t for t in (command or []) if t.endswith(".py")), f"bench/rsi_{slug.replace('-', '_')}_train_eval.py")
    path = PurePosixPath(script)
    if path.is_absolute() or ".." in path.parts or "{" in script or "\\" in script:
        raise ValueError("adapter script must be a safe relative target path")
    return str(path)


def render(template: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        template = template.replace(key, value)
    if re.search(r"@@[A-Z_]+@@", template):
        raise ValueError("unreplaced template tokens")
    return template


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--problem", required=True)
    parser.add_argument("--repo", required=True, help="existing independent target git checkout")
    parser.add_argument("--name", help="project slug / RSI_<PROJECT> env prefix")
    parser.add_argument("--force", action="store_true", help="overwrite generated files; never implies acceptance")
    args = parser.parse_args()
    try:
        problem_path = Path(args.problem).expanduser().resolve()
        problem = json.loads(problem_path.read_text())
        if not isinstance(problem, dict):
            raise ValueError("problem fixture must be an object")
        metrics = validate_metrics(problem.get("metrics"))
        repo = Path(args.repo).expanduser().resolve()
        check = subprocess.run(["git", "-C", str(repo), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if check.returncode or Path(check.stdout.rstrip("\r\n")).resolve() != repo:
            raise ValueError("--repo must be the root of an existing target git checkout")
        source_root = SKILL_DIR.parents[1]
        if repo == source_root:
            raise ValueError("generate into the target repository, not the RSI extension repository")
        slug = slugify(args.name or problem.get("id", "adapter"))
        prefix = "RSI_" + slug.replace("-", "_").upper()
        command = problem.get("experiment_command") or []
        adapter_path = adapter_rel_path(command, slug)
        worker_rel = "bench/rsi_job_worker.py"
        paths = [repo / adapter_path, repo / worker_rel, repo / ".rsi/adapter" / f"{slug}.json", repo / ".rsi/adapter" / f"{slug}.md"]
        for dest in paths:
            if not dest.resolve().is_relative_to(repo):
                raise ValueError(f"generated path escapes target via symlink: {dest}")
            if dest.exists() and not args.force:
                raise ValueError(f"generated file exists: {dest}; use --force only when intended")
        values = {
            "@@PROBLEM_ID@@": repr(problem.get("id", slug)), "@@SLUG@@": repr(slug),
            "@@ENV_PREFIX@@": repr(prefix), "@@METRICS@@": pprint.pformat(metrics, sort_dicts=False),
            "@@SCOPES@@": repr(SCOPES), "@@DEFAULT_REPO@@": repr(""),
            "@@EXPERIMENT_COMMAND@@": repr(command),
        }
        adapter = render((SKILL_DIR / "templates/run_experiment.py.tmpl").read_text(), values)
        worker = (SKILL_DIR / "templates/job_worker.py").read_text()
        manifest = dict(problem=problem.get("id", slug), source_fixture=problem_path.name,
                        slug=slug, env_prefix=prefix, target_repo=".", adapter_path=adapter_path,
                        metrics=metrics, scopes=SCOPES, experiment_command=command,
                        diagnose_command=problem.get("diagnose_command") or None,
                        job_worker=worker_rel,
                        protected_paths=[adapter_path, worker_rel, ".rsi/adapter"],
                        acceptance="scaffolded; NOT remote verified")
        readme = f"""# Target-owned RSI adapter: {problem.get('id', slug)}

Generated by the `rsi-adapter` Pi skill. All project code belongs in this target,
not in the RSI extension repository. The integration may and should modify the
target to complete missing real train/data/checkpoint/eval/metric paths.

- adapter: `{adapter_path}`
- env prefix: `{prefix}`
- metrics: {', '.join(m['name'] for m in metrics)}
- scope: subset | full | ablation | rebuttal
- invocation: Python adapter --repo PATH --scope SCOPE --out REPORT.json

Replace train/evaluate/parse_metrics TODOs with actual target implementations.
Add the real evaluator/protocol paths to manifest protected_paths. Add target
regression tests. Commit all required files on an independent candidate ref;
never reset or commit unrelated source working-tree changes.

## Mandatory remote acceptance gate

Scaffold generation, --help and mock tests are not completion. Use native Pi
`rsi_adapter_smoke` or `/rsi smoke <problem.json> --repo <target> --timeout 900`
with explicit target-supported tiny-budget env overrides. Execute complete real
small-budget training, checkpoint save/reload and real lm-eval inference, then
validate exact finite metric keys/status. Existing-checkpoint-only evaluation
cannot pass. Keep actual command, host/GPU, commit, original report and train/eval
logs in run artifacts and record evidence here. Remote outputs must be isolated
and outside the synced worktree (rsync --delete).

Add a real `bench/rsi_<project>_diagnose.py` script** and declare `diagnose_command` in the
fixture so the SOP measures the reproduced baseline before generating ideas.
It must emit evidence-backed findings with at least one `measured: true`; the
default depth policy then targets the highest-severity measured defect. Without
it the SOP keeps the original paper-first breadth search.

A usable version only follows real remote end-to-end `remote-smoke-passed`.
Before that report `blocked / remote not verified` on errors; never fabricate a
baseline. A tiny smoke proves plumbing, not full-budget scientific validity.

For regeneration, delete only generated adapter/metadata on an independent
checkout, invoke `/skill:rsi-adapter` afresh, implement and repeat the real gate.
"""
        for dest, content in zip(paths, [adapter, worker, json.dumps(manifest, indent=2) + "\n", readme]):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content)
        paths[0].chmod(0o755)
        paths[1].chmod(0o755)
        for dest in paths:
            print(f"wrote target file: {dest}")
        print("NOT DONE: implement target pipeline, commit candidate, then pass native rsi_adapter_smoke.")
        return 0
    except (OSError, ValueError, TypeError, KeyError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
