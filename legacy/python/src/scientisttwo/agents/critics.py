"""§3.2/§3.4 empirical gates: model opinion can never override arithmetic."""

from __future__ import annotations

import math

from ..types import (
    Decision, Evidence, Trace, Verdict, is_strictly_better, metric_deltas,
)
from .base import BaseAgent

__all__ = ["SubsetCritic", "FullSetCritic", "ResultComparison", "Selector"]


def _valid(evidence: Evidence, baseline: Evidence, names: list[str]) -> bool:
    return (
        evidence.ok() and baseline.ok() and bool(names)
        and all(
            name in evidence.metrics and name in baseline.metrics
            and math.isfinite(evidence.metrics[name]) and math.isfinite(baseline.metrics[name])
            for name in names
        )
    )


class SubsetCritic(BaseAgent):
    """Screen relative to the reproduced baseline, with a primary margin (§3.2)."""

    NAME = "subset_critic"
    task = "critic.subset"

    async def judge(self, evidence: Evidence, *, baseline: Evidence) -> Verdict:
        specs = self.ctx.problem.metrics
        deltas = metric_deltas(evidence.metrics, baseline.metrics, specs)
        if not _valid(evidence, baseline, [s.name for s in specs]):
            decision, feedback = Decision.BAD, "Subset run failed or lacks valid paired metrics."
        elif any(deltas[s.name] < -s.tolerance for s in specs):
            decision, feedback = Decision.BAD, "Subset metrics regress beyond tolerance; prune the idea."
        elif (
            is_strictly_better(evidence.metrics, baseline.metrics, specs)
            and deltas[specs[0].name] >= self.ctx.config.subset_margin
        ):
            decision, feedback = Decision.GOOD, "Subset primary gain meets the margin with no material regression."
        else:
            decision, feedback = Decision.ENGINEER, "Subset gain is below the required margin; inspect and tune the implementation."
        return Verdict(decision=decision, feedback=feedback, metrics=deltas)


class FullSetCritic(BaseAgent):
    """Accept strict empirical improvement; otherwise bound engineering (§3.2)."""

    NAME = "full_set_critic"
    task = "critic.full"

    async def judge(self, evidence: Evidence, *, baseline: Evidence, attempts: int = 0) -> Verdict:
        specs = self.ctx.problem.metrics
        deltas = metric_deltas(evidence.metrics, baseline.metrics, specs)
        if not _valid(evidence, baseline, [s.name for s in specs]):
            decision, feedback = Decision.BAD, "Full-set run failed or lacks valid paired metrics."
        elif is_strictly_better(evidence.metrics, baseline.metrics, specs):
            decision, feedback = Decision.GOOD, "Full benchmark strictly improves on the reproduced baseline."
        elif max(0, attempts) < self.ctx.config.max_eng_rounds:
            decision, feedback = Decision.ENGINEER, "Full benchmark is not strictly better; refine within the remaining engineering budget."
        else:
            decision, feedback = Decision.BAD, "Full-set engineering budget exhausted without strict improvement."
        return Verdict(decision=decision, feedback=feedback, metrics=deltas)


class ResultComparison(BaseAgent):
    """The no-LLM strict adoption gate for §3.4/§3.6."""

    NAME = "result_comparison"
    task = "critic.compare"

    async def compare(self, new: Evidence, base: Evidence) -> Verdict:
        specs = self.ctx.problem.metrics
        better = (
            _valid(new, base, [s.name for s in specs])
            and is_strictly_better(new.metrics, base.metrics, specs)
        )
        return Verdict(
            decision=Decision.GOOD if better else Decision.REFINE,
            feedback="Strict empirical improvement; candidate may replace incumbent." if better
                     else "No strict empirical improvement; retain the incumbent.",
            metrics=metric_deltas(new.metrics, base.metrics, specs),
        )


class Selector(BaseAgent):
    """Rank successful traces deterministically before §3.4 (selection, §3.3)."""

    NAME = "selector"
    task = "critic.selector"

    async def select(self, traces: list[Trace], *, baseline: Evidence) -> Trace:
        candidates = [t for t in traces if t.succeeded and t.final_evidence() is not None]
        if not candidates:
            raise ValueError("selection requires at least one GOOD trace with evidence")
        specs = self.ctx.problem.metrics

        def rank(trace: Trace) -> tuple[float, int, float]:
            evidence = trace.final_evidence()
            assert evidence is not None
            primary = float("-inf")
            if specs:
                spec = specs[0]
                value = evidence.metrics.get(spec.name)
                if value is not None and math.isfinite(value):
                    primary = value if spec.direction == "max" else -value
            deltas = metric_deltas(evidence.metrics, baseline.metrics, specs)
            improved = sum(deltas.get(s.name, float("-inf")) > s.tolerance for s in specs)
            return primary, improved, trace.idea.novelty_score

        # max preserves input order for exact ties; no randomized hash tie-break.
        return max(candidates, key=rank)
