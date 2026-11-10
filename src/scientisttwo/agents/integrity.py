"""§4.3 — Integrity audit (paper pp.13-15, Table 7).

Paper: "papers and their corresponding codebases must be rigorously verifiable
across all four dimensions. To guarantee these properties, we introduce three
dedicated refinement agents ... For score verification, the Coding Agent is
prompted ... to output self-contained, reproducible scripts ... For specification
compliance, we introduce a validation filter that uses the Coding Agent to detect
and discard rule-violating solutions immediately after experimentation. For
reference verification, a search-augmented LLM identifies ...".

This module implements the three auditors plus the deterministic glue:

* :class:`SpecAuditor`          - §4.3 spec compliance, runs *right after* an
  experiment (a violating idea is discarded before it can win).
* :class:`ReferenceAuditor`     - §4.3 reference verification of citations.
* :class:`MethodCodeAuditor`    - §4.3 Method-Code alignment, runs at export.
* :func:`combine`               - folds partial reports into one
  :class:`~scientisttwo.types.IntegrityReport`.

Design rule: the auditors are *evidence* checks first and LLM judgements second.
A model can add a violation, but it can never clear a deterministic one.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from ..types import Evidence, Idea, IntegrityReport, Manuscript, Problem
from .base import BaseAgent

__all__ = [
    "SpecAuditResult",
    "ReferenceAuditResult",
    "MethodCodeAuditResult",
    "SpecAuditor",
    "ReferenceAuditor",
    "MethodCodeAuditor",
    "combine",
    "verify_scores",
]


_TOKEN = re.compile(r"[a-z0-9_]{3,}")


def _tokens(text: str) -> set[str]:
    return {t for t in _TOKEN.findall(text.lower()) if t not in _STOP}


_STOP = {
    "the", "and", "for", "with", "that", "this", "from", "into", "our", "are", "was",
    "were", "has", "have", "not", "but", "all", "any", "can", "its", "their", "than",
    "then", "use", "used", "using", "via", "per", "each", "over", "under", "between",
}


class SpecAuditResult(BaseModel):
    violations: list[str] = Field(default_factory=list)
    notes: str = ""


class ReferenceAuditResult(BaseModel):
    violations: list[str] = Field(default_factory=list)
    notes: str = ""


class MethodCodeAuditResult(BaseModel):
    alignment: float = 0.0
    missing: list[str] = Field(default_factory=list)
    notes: str = ""


def verify_scores(claims_ok: bool, evidence: Evidence | None) -> bool:
    """Score verification (§4.3): every claimed number must be reproducible.

    Offline this reduces to: the experiment ran successfully and produced a finite
    number for every metric the manuscript cites.
    """

    if evidence is None or not evidence.ok():
        return False
    if not evidence.metrics:
        return False
    return all(_finite(v) for v in evidence.metrics.values())


def _finite(v: object) -> bool:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return f == f and abs(f) != float("inf")


def combine(*reports: IntegrityReport | None) -> IntegrityReport:
    """Merge partial reports; violations accumulate, alignment takes the minimum."""

    merged = IntegrityReport(score_verified=True, method_code_alignment=1.0)
    seen = False
    for rep in reports:
        if rep is None:
            continue
        seen = True
        merged.score_verified = merged.score_verified and rep.score_verified
        merged.spec_violations.extend(rep.spec_violations)
        merged.ref_violations.extend(rep.ref_violations)
        merged.method_code_alignment = min(merged.method_code_alignment, rep.method_code_alignment)
        merged.checked_claims += rep.checked_claims
        merged.notes.extend(rep.notes)
    if not seen:
        merged.score_verified = False
    return merged


class SpecAuditor(BaseAgent):
    """Detects rule-violating solutions and reward hacking (§4.3)."""

    NAME = "spec_auditor"
    task = "integrity.spec"

    def hard_violations(self, problem: Problem, diff: str, evidence: Evidence | None) -> list[str]:
        """Deterministic gate: forbidden approaches appearing in the code diff.

        Runs before any LLM call; a hit here cannot be talked away.
        """

        violations: list[str] = []
        haystack = (diff or "").lower()
        for ban in problem.forbidden:
            keys = [k for k in _tokens(ban)]
            if keys and all(k in haystack for k in keys):
                violations.append(f"forbidden approach used: {ban!r}")
        if evidence is not None and evidence.result is not None:
            if evidence.result.status == "failed":
                violations.append("experiment crashed: no reproducible result")
            elif not evidence.metrics:
                violations.append("experiment produced no metrics")
        return violations

    async def audit(
        self,
        idea: Idea,
        *,
        evidence: Evidence,
        diff: str = "",
    ) -> IntegrityReport:
        """Return a report with ``spec_violations`` filled (and ``score_verified``).

        Any non-empty ``spec_violations`` means the idea must be discarded
        *immediately after experimentation* — before it can be compared or
        selected (paper p.14).
        """

        violations = self.hard_violations(self.ctx.problem, diff, evidence)
        result = await self.ask(
            SpecAuditResult,
            user=self._prompt(idea, evidence, diff),
            meta={"idea_id": idea.id, "n": 1},
        )
        violations.extend(v for v in result.violations if v not in violations)
        return IntegrityReport(
            score_verified=verify_scores(bool(evidence.metrics), evidence),
            spec_violations=violations,
            method_code_alignment=1.0,
            notes=[result.notes] if result.notes else [],
        )

    def _prompt(self, idea: Idea, evidence: Evidence, diff: str) -> str:
        constraints = "\n".join(f"- {c}" for c in self.ctx.problem.constraints) or "- (none)"
        return (
            "Audit whether this experimental solution violates the task specification "
            "or games the evaluation (reward hacking).\n\n"
            f"HYPOTHESIS: {idea.hypothesis}\nMECHANISM: {idea.mechanism}\n"
            f"CONSTRAINTS:\n{constraints}\n"
            f"OUT OF SCOPE: {', '.join(self.ctx.problem.forbidden) or '(none)'}\n"
            f"METRICS: {evidence.metrics}\nDIFF (truncated):\n{diff[:4000]}\n\n"
            "Report only concrete violations (leaked test data, disabled checks, "
            "unfair baselines, spec breaches). Empty list = compliant."
        )


class ReferenceAuditor(BaseAgent):
    """Flags hallucinated citations (§4.3 reference verification)."""

    NAME = "reference_auditor"
    task = "integrity.refs"

    def unknown_refs(self, refs: list[str], corpus: list[str]) -> list[str]:
        """Deterministic check against a local bibliography.

        A reference is unverified when none of its significant tokens appear in
        any corpus entry. Offline runs pass ``corpus=problem.source_paper`` so no
        external search is required.
        """

        if not refs:
            return []
        corpus_tokens: set[str] = set()
        for entry in corpus:
            corpus_tokens |= _tokens(entry)
        bad: list[str] = []
        for ref in refs:
            if not ref.strip():
                continue
            ref_tokens = _tokens(ref)
            if not ref_tokens or not (ref_tokens & corpus_tokens):
                bad.append(ref)
        return bad

    async def audit(
        self,
        manuscript: Manuscript,
        *,
        corpus: list[str] | None = None,
    ) -> IntegrityReport:
        refs = list(dict.fromkeys(_refs_from(manuscript)))
        known = corpus if corpus is not None else [self.ctx.problem.source_paper]
        unverified = self.unknown_refs(refs, [k for k in known if k])
        result = await self.ask(
            ReferenceAuditResult,
            user=(
                "Check these citations for hallucination. Flag only references that cannot "
                f"exist or contradict the cited claim.\nCITATIONS:\n"
                + "\n".join(f"- {r}" for r in refs[:50])
                + f"\nKNOWN BIBLIOGRAPHY:\n{chr(10).join(known)[:3000] or '(empty)'}"
            ),
            meta={"n": 1},
        )
        violations = list(unverified)
        violations.extend(v for v in result.violations if v not in violations)
        return IntegrityReport(
            score_verified=True,
            ref_violations=violations,
            method_code_alignment=1.0,
            checked_claims=len(refs),
            notes=[result.notes] if result.notes else [],
        )


class MethodCodeAuditor(BaseAgent):
    """Measures paper-methodology ↔ code alignment (§4.3, Table 7)."""

    NAME = "method_code_auditor"
    task = "integrity.method_code"

    def lexical_alignment(self, manuscript: Manuscript, diff: str) -> tuple[float, list[str]]:
        """Deterministic lower bound: fraction of claimed components present in the diff."""

        claims = [c.text for c in manuscript.claims] or [manuscript.abstract]
        if not claims:
            return 0.0, ["manuscript has no claims to align"]
        diff_tokens = _tokens(diff)
        missing: list[str] = []
        hit = 0
        for claim in claims:
            toks = _tokens(claim)
            if toks and len(toks & diff_tokens) / len(toks) >= 0.25:
                hit += 1
            else:
                missing.append(claim[:120])
        return hit / len(claims), missing

    async def audit(
        self,
        manuscript: Manuscript,
        *,
        diff: str,
        evidence: Evidence | None = None,
    ) -> IntegrityReport:
        lower, missing = self.lexical_alignment(manuscript, diff)
        result = await self.ask(
            MethodCodeAuditResult,
            user=(
                "Score how faithfully the code diff implements the manuscript's method. "
                "0 = unrelated, 1 = every claimed component is implemented.\n\n"
                f"METHOD:\n{manuscript.sections.get('method', manuscript.abstract)[:3000]}\n\n"
                f"DIFF:\n{diff[:4000]}"
            ),
            meta={"n": 1},
        )
        alignment = max(lower, min(1.0, max(0.0, result.alignment))) if lower > 0.0 else 0.0
        """A model may refine a partially-supported score upward, but it can never
        manufacture alignment when the deterministic check found *no* textual
        support (absence of evidence cannot be talked away)."""
        notes = [result.notes] if result.notes else []
        if missing:
            notes.append(f"{len(missing)} claims not lexically supported by the diff")
        return IntegrityReport(
            score_verified=verify_scores(bool(manuscript.claims), evidence),
            method_code_alignment=round(alignment, 3),
            checked_claims=len(manuscript.claims),
            notes=notes,
        )


def _refs_from(manuscript: Manuscript) -> list[str]:
    """Citations the manuscript actually makes.

    Stored in ``sections['references']`` as one-per-line, so the check works
    without changing the frozen model.
    """

    raw = manuscript.sections.get("references", "")
    return [line.strip(" -\t") for line in raw.splitlines() if line.strip(" -\t")]
