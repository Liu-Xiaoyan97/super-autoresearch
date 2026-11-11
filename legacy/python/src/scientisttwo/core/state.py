"""Mutable research state: the single source of truth for one run.

Everything a resumed/replayed run needs lives here (invariant I8). The state is a
plain dataclass so tests can construct one by hand.
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from typing import Any

from pydantic import BaseModel

from ..config import ScientistTwoConfig
from ..types import (
    AblationResult,
    Evidence,
    Idea,
    Limitation,
    Manuscript,
    MetaReview,
    Problem,
    RepoRef,
    Review,
    Trace,
)

__all__ = ["ResearchState"]


@dataclass
class ResearchState:
    problem: Problem
    config: ScientistTwoConfig

    # §3.1
    limitations: list[Limitation] = field(default_factory=list)
    seeds: list[Idea] = field(default_factory=list)
    """H0, sorted by rank_key descending"""

    # §3.2 / §3.3
    baseline: Evidence | None = None
    """E_base on the subset, produced by the BaselineCoder"""
    traces: list[Trace] = field(default_factory=list)
    """R: every idea ever evaluated, Good and Bad"""
    round: int = 0
    evaluated_ids: set[str] = field(default_factory=set)

    # incumbent (h_best, E_best, C_best)
    best_idea: Idea | None = None
    best_evidence: Evidence | None = None
    best_code: RepoRef | None = None

    # §3.4
    ablations: list[AblationResult] = field(default_factory=list)
    ablation_round: int = 0

    # §3.5 / §3.6
    manuscript: Manuscript | None = None
    review: Review | None = None
    meta_review: MetaReview | None = None
    peer_round: int = 0
    review_refinements: int = 0
    meta_round: int = 0
    rebuttals: list[Evidence] = field(default_factory=list)

    # bookkeeping
    decision_path: list[str] = field(default_factory=list)
    aborted: bool = False
    abort_reason: str = ""
    export_reason: str = ""
    """Why an unaccepted incumbent was exported instead of aborting (§3.6)."""

    # ------------------------------------------------------------------ helpers
    def good_traces(self) -> list[Trace]:
        return sorted((t for t in self.traces if t.succeeded), key=lambda t: (t.round, t.idea.id))

    def next_seeds(self, n: int) -> list[Idea]:
        """Highest-ranked seeds that were never evaluated (§3.3 exploration)."""
        if n <= 0:
            return []
        out: list[Idea] = []
        for idea in sorted(
            self.seeds,
            key=lambda item: (-(item.novelty_score + self.config.guidance_weight * item.domain_fit), item.id),
        ):
            if idea.id in self.evaluated_ids:
                continue
            out.append(idea)
            if len(out) == n:
                break
        return out

    def record(self, trace: Trace) -> None:
        self.traces.append(trace)
        self.evaluated_ids.add(trace.idea.id)

    def adopt(self, idea: Idea, evidence: Evidence) -> None:
        """Only call through ResultComparison (invariant I2)."""
        self.best_idea = idea
        self.best_evidence = evidence
        self.best_code = evidence.code

    def note(self, decision: str) -> None:
        """Append a stable transition token for offline replay (SPEC I8)."""

        self.decision_path.append(decision)

    def to_dict(self) -> dict[str, Any]:
        """Serialize all state, including sorted ID sets, for SPEC I8 snapshots."""

        def encode(value: Any) -> Any:
            if isinstance(value, BaseModel):
                return encode(value.model_dump(mode="json"))
            if isinstance(value, dict):
                return {key: encode(value[key]) for key in sorted(value)}
            if isinstance(value, set):
                return [encode(item) for item in sorted(value)]
            if isinstance(value, (list, tuple)):
                return [encode(item) for item in value]
            return value

        return {item.name: encode(getattr(self, item.name))
                for item in sorted(fields(self), key=lambda item: item.name)}
