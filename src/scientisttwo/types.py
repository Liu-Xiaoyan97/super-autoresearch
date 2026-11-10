"""Frozen domain models for the ScientistTwo reimplementation.

Every model here is a *contract* shared by all agents, the orchestrator, and the
offline fixtures. Implementers must not change field names or semantics; add new
optional fields only when a paper section demonstrably requires them.

Paper mapping
-------------
MetricSpec / Problem          ->  §3 "Problem Setup", eq. (1)
Limitation / Idea             ->  §3.1
Evidence / Trace / Verdict    ->  §3.2
AblationPlan / AblationResult ->  §3.4
Manuscript / Claim / Review   ->  §3.5
MetaReview / FinalArtifacts   ->  §3.6
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Sequence

from pydantic import BaseModel, Field

__all__ = [
    "Decision",
    "Scope",
    "MetricSpec",
    "ResearchDirection",
    "Problem",
    "Limitation",
    "Idea",
    "Evidence",
    "Trace",
    "Verdict",
    "RepoRef",
    "ExperimentResult",
    "AblationPlan",
    "AblationResult",
    "Claim",
    "Manuscript",
    "Review",
    "RebuttalTask",
    "MetaReview",
    "IntegrityReport",
    "FinalArtifacts",
    "is_strictly_better",
    "metric_deltas",
]


# --------------------------------------------------------------------------- #
# enums
# --------------------------------------------------------------------------- #
class Decision(str, Enum):
    """Critic verdicts used across the pipeline.

    GOOD / BAD / ENGINEER   - §3.2 subset & full-set critic
    REFINE                  - §3.4 ablation critic, §3.6 meta-review
    ACCEPT                  - Listing 1 generic stage + §3.6 meta-review
    """

    GOOD = "good"
    BAD = "bad"
    ENGINEER = "engineer"
    REFINE = "refine"
    ACCEPT = "accept"


class Scope(str, Enum):
    """Benchmark regime. §3.2 requires subset before full-set."""

    SUBSET = "subset"
    FULL = "full"
    ABLATION = "ablation"
    REBUTTAL = "rebuttal"


# --------------------------------------------------------------------------- #
# metrics
# --------------------------------------------------------------------------- #
class MetricSpec(BaseModel):
    """One benchmark metric plus how to judge improvement.

    tolerance is the relative noise band: a difference smaller than
    ``tolerance * |baseline|`` is not counted as an improvement (§3.4 requires a
    *strict* improvement before adopting a new hypothesis).
    """

    name: str
    direction: Literal["max", "min"] = "max"
    tolerance: float = 1e-3
    weight: float = 1.0
    bounds: tuple[float, float] | None = None
    """physical range of the metric (e.g. (0.0, 1.0) for AUROC). Runners must
    clamp reported values into it; anything outside is a bug, not a discovery."""


class ResearchDirection(BaseModel):
    """A human-provided steer for exploration [EXTENSION, beyond the paper].

    The paper lets the agent choose its own research direction freely; real users
    usually have a lab strategy, a funding axis, or a domain they care about.
    Directions are soft by default (they bias generation and ranking) and become
    hard when ``must_include`` is set.
    """

    id: str
    title: str
    description: str = ""
    keywords: list[str] = Field(default_factory=list)
    weight: float = 1.0
    """soft preference weight in [0, 1+]; 0 disables the direction"""
    must_include: bool = False
    """if True, every accepted idea must align with this direction"""


class Problem(BaseModel):
    """A scientific problem G, per eq. (1): ``(P+, C+) = A(G)``.

    ``domain`` + ``directions`` are the *exploration guidance* surface: they are
    injected into §3.1 generation, §3.3 evolution, novelty scoring, and the
    manuscript framing, while never overriding the empirical gates of §3.2/§3.4.
    """

    id: str
    statement: str
    domain: str = ""
    """e.g. "time series forecasting", "mechanistic interpretability"""
    subfield: str = ""
    source_paper: str = ""
    repo: str | None = None
    datasets: list[str] = Field(default_factory=list)
    subset_datasets: list[str] = Field(default_factory=list)
    metrics: list[MetricSpec] = Field(default_factory=list)
    """Primary metrics, in reporting order. Section 3.2 compares on these."""
    reported_metrics: dict[str, float] = Field(default_factory=dict)
    """Human SOTA numbers *as reported in the paper* — context only, never the
    comparison target (§3.2 requires comparing against the reproduced baseline).
    The offline SimulatedRunner also uses them as the baseline values."""
    constraints: list[str] = Field(default_factory=list)
    """e.g. "no extra training data", "same parameter budget"."""
    directions: list[ResearchDirection] = Field(default_factory=list)
    """reference research directions that steer exploration (§3.1, §3.3)"""
    forbidden: list[str] = Field(default_factory=list)
    """approaches explicitly out of scope (e.g. "no LLM finetuning")"""
    venue: str = "ICLR"
    audience_note: str = ""

    def metric(self, name: str) -> MetricSpec | None:
        return next((m for m in self.metrics if m.name == name), None)

    def hard_directions(self) -> list[ResearchDirection]:
        return [d for d in self.directions if d.must_include and d.weight > 0]

    def direction_text(self) -> str:
        """Render the guidance block injected into every generative prompt."""

        if not self.domain and not self.directions:
            return ""
        lines: list[str] = []
        if self.domain:
            lines.append(f"Domain: {self.domain}" + (f" / {self.subfield}" if self.subfield else ""))
        if self.directions:
            lines.append("Reference research directions (stay inside them unless evidence demands otherwise):")
            for d in self.directions:
                tag = " [REQUIRED]" if d.must_include else ""
                kw = f" (keywords: {', '.join(d.keywords)})" if d.keywords else ""
                lines.append(f"- {d.id}. {d.title}{tag}{kw}: {d.description}")
        if self.forbidden:
            lines.append(f"Out of scope: {'; '.join(self.forbidden)}")
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# §3.1 ideas
# --------------------------------------------------------------------------- #
class Limitation(BaseModel):
    """One diagnosed weakness of the human state-of-the-art method."""

    id: str
    text: str
    axis: str = "method"
    """method | evaluation | efficiency | theory | data"""
    evidence: str = ""
    severity: float = 0.5
    actionable: bool = True


class Idea(BaseModel):
    """A hypothesis h. ``mechanism`` is the short, unique handle used by the
    simulation fixtures to derive deterministic metrics."""

    id: str
    hypothesis: str
    mechanism: str = ""
    target_limitations: list[str] = Field(default_factory=list)
    novelty_score: float = 0.0
    novelty_refs: list[str] = Field(default_factory=list)
    parent_ids: list[str] = Field(default_factory=list)
    round: int = 0
    origin: Literal["seed", "evolved", "meta"] = "seed"
    expected_gain: float = 0.0
    direction_ids: list[str] = Field(default_factory=list)
    """which Problem.directions this idea pursues (§3.1 guidance)"""
    domain_fit: float = 0.0
    """0-1 alignment with the user's domain + directions, set by NoveltyChecker"""
    notes: str = ""

    def short(self) -> str:
        return f"{self.id}:{self.mechanism or self.hypothesis[:40]}"


# --------------------------------------------------------------------------- #
# §3.2 evidence and traces
# --------------------------------------------------------------------------- #
class RepoRef(BaseModel):
    """A reproducible codebase snapshot (C_base / C_sub / C_full)."""

    path: str
    label: str = ""
    parent: str | None = None
    patch: str = ""


class ExperimentResult(BaseModel):
    """Raw execution output of one benchmark run."""

    metrics: dict[str, float] = Field(default_factory=dict)
    status: Literal["ok", "failed", "timeout"] = "ok"
    log_path: str = ""
    stdout: str = ""
    stderr: str = ""
    wall_time_s: float = 0.0

    def ok(self) -> bool:
        return self.status == "ok"


class Evidence(BaseModel):
    """A measured result: the only thing that may justify a Decision (I2/I3)."""

    idea_id: str
    scope: Scope = Scope.SUBSET
    metrics: dict[str, float] = Field(default_factory=dict)
    baseline_metrics: dict[str, float] = Field(default_factory=dict)
    code: RepoRef | None = None
    result: ExperimentResult | None = None
    label: str = ""

    def ok(self) -> bool:
        return self.result is None or self.result.ok()


class Verdict(BaseModel):
    """Critic output. ``feedback`` is the refinement strategy r."""

    decision: Decision = Decision.BAD
    feedback: str = ""
    metrics: dict[str, float] = Field(default_factory=dict)
    notes: str = ""

    @property
    def accepted(self) -> bool:
        return self.decision in (Decision.GOOD, Decision.ACCEPT)


class Trace(BaseModel):
    """Execution trace R_k entry: (h, E, C, d, r). Consumed by §3.3 evolution."""

    idea: Idea
    evidence: list[Evidence] = Field(default_factory=list)
    decision: Decision = Decision.BAD
    feedback: str = ""
    round: int = 0
    lessons: list[str] = Field(default_factory=list)

    def final_evidence(self) -> Evidence | None:
        return self.evidence[-1] if self.evidence else None

    @property
    def succeeded(self) -> bool:
        return self.decision == Decision.GOOD


# --------------------------------------------------------------------------- #
# §3.4 ablations
# --------------------------------------------------------------------------- #
class AblationPlan(BaseModel):
    """One executable component-level experiment derived from h_best."""

    id: str
    component: str
    description: str
    expects: str = ""
    variant_of: str = ""
    """which part of the method to remove/replace"""


class AblationResult(BaseModel):
    plan_id: str
    component: str = ""
    metrics: dict[str, float] = Field(default_factory=dict)
    evidence: Evidence | None = None
    ok: bool = True


# --------------------------------------------------------------------------- #
# §3.5 manuscript
# --------------------------------------------------------------------------- #
class Claim(BaseModel):
    """A manuscript claim bound to the metric value that supports it."""

    text: str
    metric: str = ""
    value: float | None = None
    evidence_ref: str = ""


class Manuscript(BaseModel):
    id: str
    title: str = ""
    abstract: str = ""
    sections: dict[str, str] = Field(default_factory=dict)
    claims: list[Claim] = Field(default_factory=list)
    evidence_ledger: dict[str, float] = Field(default_factory=dict)
    """metric name -> measured value for every number the manuscript may cite;
    claims are only valid if their metric appears here (auditable, no invention)"""
    latex_path: str = ""
    format: str = "iclr2025"
    round: int = 0


class Review(BaseModel):
    """ScholarPeer-style review, ICLR 1-10 scale (§3.5)."""

    manuscript_id: str = ""
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    score: float = 1.0
    scale_max: float = 10.0
    summary: str = ""
    round: int = 0

    def passes(self, threshold: float) -> bool:
        return self.score >= threshold


class RebuttalTask(BaseModel):
    """One supplementary experiment t_i answering a reviewer query."""

    id: str
    question: str
    plan: str
    experiment: str = ""


class MetaReview(BaseModel):
    decision: Literal["accept", "refine"] = "refine"
    critique: str = ""
    score: float = 0.0
    round: int = 0


class IntegrityReport(BaseModel):
    """§4.3 Integrity Audit (paper p.13-15, Table 7).

    Four dimensions: score verification (claims are reproducible), specification
    compliance (no rule violation / reward hacking), reference verification (no
    hallucinated citations), method-code alignment (paper matches the code).
    """

    score_verified: bool = False
    spec_violations: list[str] = Field(default_factory=list)
    ref_violations: list[str] = Field(default_factory=list)
    method_code_alignment: float = 0.0
    """fraction of manuscript-claimed components found in the code diff, in [0,1]"""
    checked_claims: int = 0
    notes: list[str] = Field(default_factory=list)

    def clean(self) -> bool:
        return self.score_verified and not self.spec_violations and not self.ref_violations


class FinalArtifacts(BaseModel):
    """(P+, C+) of eq. (1)."""

    paper: Manuscript
    code: RepoRef | None = None
    review: Review | None = None
    meta_review: MetaReview | None = None
    integrity: IntegrityReport | None = None
    metrics: dict[str, float] = Field(default_factory=dict)
    decision_path: list[str] = Field(default_factory=list)
    aborted: bool = False
    abort_reason: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# improvement semantics (single definition of invariant I2)
# --------------------------------------------------------------------------- #
def metric_deltas(
    new: dict[str, float],
    base: dict[str, float],
    metrics: Sequence[MetricSpec],
) -> dict[str, float]:
    """Signed relative improvement per metric (+ = better, - = worse).

    Uses ``direction`` to normalise, so every value can be compared directly.
    Metrics missing on either side are skipped.
    """

    out: dict[str, float] = {}
    for spec in metrics:
        if spec.name not in new or spec.name not in base:
            continue
        b = base[spec.name]
        n = new[spec.name]
        denom = abs(b) if abs(b) > 1e-12 else 1.0
        raw = (n - b) / denom
        out[spec.name] = raw if spec.direction == "max" else -raw
    return out


def is_strictly_better(
    new: dict[str, float],
    base: dict[str, float],
    metrics: Sequence[MetricSpec],
    *,
    require_all: bool = True,
) -> bool:
    """The one definition of "E_new strictly outperforms E_best" (§3.4/§3.6).

    Semantics (INFERENCE, since the paper does not spell this out):
      * every metric present on both sides must not regress beyond its tolerance;
      * at least one metric must improve beyond its tolerance.

    With ``require_all=False`` only the primary (first) metric is checked, which
    is useful for early subset screening.
    """

    specs = list(metrics)
    if not specs:
        return False
    if not require_all:
        specs = specs[:1]

    deltas = metric_deltas(new, base, specs)
    if not deltas:
        return False

    improved = False
    for spec in specs:
        if spec.name not in deltas:
            continue
        d = deltas[spec.name]
        if d < -spec.tolerance:
            return False
        if d > spec.tolerance:
            improved = True
    return improved
