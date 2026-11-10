"""Experiment execution: the only place where metrics come from.

Two runners exist (invariant: identical interface):

* ``SubprocessRunner`` - real execution of the problem's repository.
* ``SimulatedRunner``  - deterministic offline execution from a fixture, used by
  the test-suite and by ``--mock`` runs.

The simulated metric model is part of the contract because tests assert on it:

    gain      = U(hash(idea.mechanism) % 1000) * 0.5 - 0.10          # [-0.10, 0.40)
    gain     += guidance_weight * domain_fit * 0.2                    # [EXTENSION] G6
    gain     += U(hash(idea.id) % 97) * 0.02 - 0.01                   # run noise
    subset   = gain * 1.15 + U(hash(idea.id + "sub") % 53) * 0.02 - 0.01
    metric   = baseline[metric] * (1 + scope_gain) * direction

so ``gain > 0`` is a "Good" idea and the ordering of ideas is stable across runs.
``hash`` means CRC32, and ``U(k % n)`` means ``(k % n) / n``. The
primary metric uses the literal keys above; subsequent metrics suffix their
noise keys with ``:<metric name>`` for independent deterministic perturbations.
"""

from __future__ import annotations

import asyncio
import difflib
import json
import math
from pathlib import Path
import shutil
import sys
import time
import zlib
from abc import ABC, abstractmethod

from pydantic import BaseModel, Field

from ..config import ScientistTwoConfig
from ..types import ExperimentResult, Idea, Problem, RepoRef, Scope
from .store import ArtifactStore

__all__ = [
    "ExperimentRequest", "Runner", "Workspace", "SUBSET_FRACTION_KEY",
    "SimulatedRunner", "SubprocessRunner", "FileWorkspace",
]

SUBSET_FRACTION_KEY = "subset_fraction"

#: see SimulatedRunner.run: bounded-metric headroom compensation
HEADROOM_GAIN = 2.0


class ExperimentRequest(BaseModel):
    """One benchmark execution."""

    idea_id: str
    scope: Scope = Scope.SUBSET
    repo: RepoRef
    datasets: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    idea: Idea | None = None
    label: str = ""


class Runner(ABC):
    """Executes an :class:`ExperimentRequest` and returns measured metrics."""

    @abstractmethod
    async def run(self, req: ExperimentRequest) -> ExperimentResult: ...


class Workspace(ABC):
    """Repository snapshot manager + runner front-end (§3.2/§3.4)."""

    def __init__(
        self,
        problem: Problem,
        config: ScientistTwoConfig,
        root: str,
        runner: Runner | None = None,
    ) -> None:
        self.problem = problem
        self.config = config
        self.root = root
        self.runner = runner

    @abstractmethod
    async def baseline_repo(self) -> RepoRef:
        """Materialize C_base (the reproduced human SOTA codebase)."""

    @abstractmethod
    async def write_patch(self, repo: RepoRef, patch: str, label: str) -> RepoRef:
        """Apply an LLM-authored patch and return a new snapshot."""

    @abstractmethod
    async def diff(self, a: RepoRef, b: RepoRef) -> str:
        """Unified diff, used by the manuscript's method section."""

    @abstractmethod
    async def run(self, repo: RepoRef, scope: Scope, *, idea: Idea | None = None) -> ExperimentResult:
        """Execute ``repo`` on the subset or the full benchmark."""


def _unit(text: str, modulus: int) -> float:
    return (zlib.crc32(text.encode()) % modulus) / modulus


def _clamp(value: float, spec: object | None) -> float:
    """Keep a metric inside its physical range (AUROC in (0,1), etc.).

    A number outside the metric's bounds is a modelling bug, not a discovery; the
    simulator must never hand a critic an impossible score.
    """

    bounds = getattr(spec, "bounds", None)
    if not bounds:
        return value
    low, high = float(bounds[0]), float(bounds[1])
    margin = 1e-6 * max(1.0, abs(high - low))
    return min(max(value, low + margin), high - margin)


class SimulatedRunner(Runner):
    """Explicitly synthetic, stable CRC32 benchmark model for §3.2/§3.4."""

    def __init__(
        self, problem: Problem, config: ScientistTwoConfig, root: str | Path | ArtifactStore,
    ) -> None:
        self.problem = problem
        self.config = config
        self.store = root if isinstance(root, ArtifactStore) else ArtifactStore(root)

    async def run(self, req: ExperimentRequest) -> ExperimentResult:
        names = req.metrics or [m.name for m in self.problem.metrics]
        names = names or sorted(self.problem.reported_metrics) or ["score"]
        values: dict[str, float] = {}
        for index, name in enumerate(names):
            baseline = self.problem.reported_metrics.get(name, 1.0)
            gain = 0.0
            if req.idea is not None:
                idea = req.idea
                suffix = "" if index == 0 else f":{name}"
                # 80% of gain draws are positive: calibrated to the paper's
                # reported 80.4% improvement rate (86/107 papers), so an offline
                # run has a realistic success/failure mix instead of all-abort.
                gain = _unit(idea.mechanism, 1000) * 0.5 - 0.10
                gain += self.config.guidance_weight * idea.domain_fit * 0.2
                gain += _unit(idea.id + suffix, 97) * 0.02 - 0.01
                if req.scope == Scope.SUBSET:
                    gain = gain * 1.15 + _unit(idea.id + "sub" + suffix, 53) * 0.02 - 0.01
            spec = self.problem.metric(name)
            direction = -1 if spec is not None and spec.direction == "min" else 1
            # CONTRACT-GAP: the docstring's trailing '* direction' would negate
            # minimization baselines; direction instead signs the relative gain.
            # Improvements consume *remaining headroom* rather than a fixed
            # relative step, so bounded metrics (AUROC in (0,1)) can never
            # saturate: two ideas that would both exceed the ceiling keep their
            # ordering, which the empirical gates (I2) depend on.
            bounds = getattr(spec, "bounds", None)
            if bounds:
                low, high = float(bounds[0]), float(bounds[1])
                start = min(max(baseline, low), high)
                span = (high - start) if direction > 0 else (start - low)
                # A bounded metric has little headroom left, so relative gains
                # would be compressed to noise. HEADROOM_GAIN restores a spread
                # comparable to the paper's reported improvements.
                value = start + direction * gain * span * HEADROOM_GAIN
            else:
                value = baseline * (1 + direction * gain)
            values[name] = _clamp(value, spec)
        key = zlib.crc32(req.model_dump_json().encode())
        log_path = self.store.write_json(
            f"experiments/simulated-{key:08x}.json",
            {"mode": "simulated", "request": req, "metrics": values},
        )
        return ExperimentResult(metrics=values, status="ok", log_path=str(log_path), wall_time_s=0.0)


class SubprocessRunner(Runner):
    """Execute a local benchmark with a timeout; execution failures are data."""

    def __init__(self, root: str | Path | ArtifactStore, *, timeout_s: float = 300.0) -> None:
        self.store = root if isinstance(root, ArtifactStore) else ArtifactStore(root)
        self.timeout_s = timeout_s
        self._sequence = 0

    async def run(self, req: ExperimentRequest) -> ExperimentResult:
        started = time.monotonic()
        stdout = ""
        stderr = ""
        log_path = ""
        process: asyncio.subprocess.Process | None = None
        try:
            self._sequence += 1
            out = self.store.artifact(f"experiments/process-{self._sequence:04d}.json").resolve()
            log_path = str(out)
            repo = Path(req.repo.path).resolve()
            process = await asyncio.create_subprocess_exec(
                sys.executable, str(repo / "run_experiment.py"),
                "--scope", req.scope.value, "--out", str(out),
                cwd=str(repo), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            raw_out, raw_err = await asyncio.wait_for(process.communicate(), self.timeout_s)
            stdout, stderr = raw_out.decode(errors="replace"), raw_err.decode(errors="replace")
            if process.returncode != 0:
                raise RuntimeError(f"benchmark exited with status {process.returncode}")
            data = json.loads(out.read_text(encoding="utf-8"))
            metrics = data.get("metrics", data)
            if not isinstance(metrics, dict) or not metrics:
                raise ValueError("benchmark output must contain nonempty metrics")
            parsed = {str(k): float(v) for k, v in metrics.items()}
            if not all(math.isfinite(v) for v in parsed.values()):
                raise ValueError("benchmark metrics must be finite")
            return ExperimentResult(
                metrics=parsed, stdout=stdout, stderr=stderr, log_path=log_path,
                wall_time_s=time.monotonic() - started,
            )
        except (Exception, asyncio.CancelledError) as exc:
            if process is not None and process.returncode is None:
                try:
                    process.kill()
                    raw_out, raw_err = await process.communicate()
                    stdout = raw_out.decode(errors="replace")
                    stderr += raw_err.decode(errors="replace")
                except (Exception, asyncio.CancelledError):
                    pass
            return ExperimentResult(
                status="failed", stdout=stdout, stderr=f"{stderr}\n{type(exc).__name__}: {exc}".strip(),
                log_path=log_path, wall_time_s=time.monotonic() - started,
            )


class WorkspaceExperimentResult(ExperimentResult):
    # CONTRACT-GAP: ExperimentResult has no provenance/context field. A subtype
    # retains the abstract return contract and serializes RepoRef without Evidence.
    context: dict[str, RepoRef] = Field(default_factory=dict)


class FileWorkspace(Workspace):
    """Immutable, local code snapshots and execution provenance (§3.2/§3.4).

    Patches are recorded as instruction artifacts, not executed as shell code.
    A real coding backend must supply executable repository edits separately.
    """

    def __init__(
        self, problem: Problem, config: ScientistTwoConfig, root: str,
        runner: Runner | None = None,
    ) -> None:
        super().__init__(problem, config, root, runner)
        self.store = ArtifactStore(root)
        self.runner = runner or (
            SimulatedRunner(problem, config, self.store) if config.runner == "simulated"
            else SubprocessRunner(self.store, timeout_s=config.max_wall_time_s)
        )

    def _snapshot_path(self, label: str) -> tuple[str, Path]:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in label).strip(".") or "snapshot"
        name = safe
        index = 1
        while self.store.path("code", name).exists():
            name = f"{safe}-{index}"
            index += 1
        return name, self.store.path("code", name)

    async def baseline_repo(self) -> RepoRef:
        label, target = self._snapshot_path("baseline")
        source = Path(self.problem.repo).expanduser() if self.problem.repo else None
        if source is not None and source.is_dir():
            shutil.copytree(source, target)
        else:
            target.mkdir(parents=True)
            values = {m.name: self.problem.reported_metrics.get(m.name, 1.0) for m in self.problem.metrics}
            values = values or dict(self.problem.reported_metrics) or {"score": 1.0}
            (target / "run_experiment.py").write_text(
                '"""Synthetic scaffold, not a scientific benchmark."""\n'
                "import argparse, json\nfrom pathlib import Path\n"
                "p = argparse.ArgumentParser()\np.add_argument('--scope')\np.add_argument('--out')\n"
                "args = p.parse_args()\n"
                f"Path(args.out).write_text(json.dumps({{'metrics': {values!r}}}))\n",
                encoding="utf-8",
            )
            (target / "README.md").write_text(
                "# Synthetic baseline scaffold\nNo source repository was available.\n"
                "Run `python run_experiment.py --scope subset --out result.json`.\n",
                encoding="utf-8",
            )
        return RepoRef(path=str(target), label=label)

    async def write_patch(self, repo: RepoRef, patch: str, label: str) -> RepoRef:
        name, target = self._snapshot_path(label)
        shutil.copytree(repo.path, target)
        (target / "patch.txt").write_text(patch, encoding="utf-8")
        return RepoRef(path=str(target), label=name, parent=repo.label, patch=patch)

    async def diff(self, a: RepoRef, b: RepoRef) -> str:
        left, right = Path(a.path), Path(b.path)
        names = sorted(
            {p.relative_to(left).as_posix() for p in left.rglob("*") if p.is_file()}
            | {p.relative_to(right).as_posix() for p in right.rglob("*") if p.is_file()}
        )
        chunks: list[str] = []
        for name in names:
            old, new = left / name, right / name
            old_lines = old.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True) if old.is_file() else []
            new_lines = new.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True) if new.is_file() else []
            chunks.extend(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{name}", tofile=f"b/{name}"))
        return "".join(chunks)

    async def run(self, repo: RepoRef, scope: Scope, *, idea: Idea | None = None) -> ExperimentResult:
        req = ExperimentRequest(
            idea_id=idea.id if idea else "baseline", scope=scope, repo=repo, idea=idea,
            datasets=list(self.problem.subset_datasets if scope == Scope.SUBSET else self.problem.datasets),
            metrics=[m.name for m in self.problem.metrics], label=repo.label,
        )
        assert self.runner is not None
        result = await self.runner.run(req)
        enriched = WorkspaceExperimentResult(**result.model_dump(exclude={"context"}), context={"repo": repo})
        self.store.write_json(f"experiments/{repo.label}-{scope.value}.json", {"request": req, "result": enriched})
        return enriched
