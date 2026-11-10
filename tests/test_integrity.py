"""§4.3 integrity audit: deterministic checks must survive a permissive model."""

from __future__ import annotations

import asyncio
from pathlib import Path

from scientisttwo.agents.base import AgentContext
from scientisttwo.agents.integrity import (
    MethodCodeAuditor,
    ReferenceAuditor,
    SpecAuditor,
    combine,
    verify_scores,
)
from scientisttwo.config import ScientistTwoConfig
from scientisttwo.providers.base import LLMProvider, LLMRequest, LLMResponse
from scientisttwo.runtime.budget import Budget
from scientisttwo.runtime.store import ArtifactStore, TraceStore
from scientisttwo.types import (
    Claim,
    Evidence,
    ExperimentResult,
    Idea,
    IntegrityReport,
    Manuscript,
    MetricSpec,
    Problem,
)


class PermissiveProvider(LLMProvider):
    """Always claims everything is fine — must not clear deterministic violations."""

    name = "permissive"

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls += 1
        return LLMResponse(text='{"violations": [], "alignment": 1.0, "notes": ""}')


def _ctx(tmp_path: Path, problem: Problem | None = None) -> AgentContext:
    problem = problem or Problem(
        id="p",
        statement="improve ood detection",
        source_paper="X-Mahalanobis (Wei et al., 2025)",
        forbidden=["retrain the encoder"],
        constraints=["no extra training data"],
        metrics=[MetricSpec(name="auroc", direction="max")],
    )
    return AgentContext(
        problem=problem,
        config=ScientistTwoConfig(),
        llm=PermissiveProvider(),
        workspace=None,  # type: ignore[arg-type]
        store=ArtifactStore(tmp_path / "run"),
        traces=TraceStore(tmp_path / "run" / "traces.jsonl"),
        budget=Budget(),
    )


def _idea() -> Idea:
    return Idea(id="h1", hypothesis="align features with class prototypes", mechanism="procrustes-alignment")


def _evidence(metrics: dict[str, float] | None = None, status: str = "ok") -> Evidence:
    return Evidence(
        idea_id="h1",
        metrics=metrics if metrics is not None else {"auroc": 0.91},
        result=ExperimentResult(metrics=metrics or {}, status=status),
    )


def test_combine_accumulates_and_takes_min_alignment() -> None:
    a = IntegrityReport(score_verified=True, spec_violations=["v1"], method_code_alignment=0.8)
    b = IntegrityReport(score_verified=True, ref_violations=["r1"], method_code_alignment=0.4)
    merged = combine(a, b)
    assert merged.spec_violations == ["v1"]
    assert merged.ref_violations == ["r1"]
    assert merged.method_code_alignment == 0.4
    assert merged.score_verified is True
    assert combine().score_verified is False


def test_verify_scores_rejects_failed_or_empty_runs() -> None:
    assert verify_scores(True, _evidence()) is True
    assert verify_scores(True, _evidence({"auroc": 0.9}, status="failed")) is False
    assert verify_scores(True, Evidence(idea_id="h1", metrics={})) is False
    assert verify_scores(True, None) is False
    assert verify_scores(True, _evidence({"auroc": float("nan")})) is False


def test_spec_auditor_deterministic_violation_survives_permissive_llm(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    auditor = SpecAuditor(ctx)

    hard = auditor.hard_violations(ctx.problem, diff="we retrain the encoder from scratch", evidence=_evidence())
    assert any("forbidden approach" in v for v in hard)

    report = asyncio.run(
        auditor.audit(_idea(), evidence=_evidence(), diff="we retrain the encoder from scratch")
    )
    assert report.spec_violations, "deterministic violation must not be cleared by the model"
    assert report.score_verified is True
    assert ctx.llm.calls == 1


def test_spec_auditor_flags_crashed_experiment(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    auditor = SpecAuditor(ctx)
    report = asyncio.run(
        auditor.audit(_idea(), evidence=_evidence({"auroc": 0.0}, status="failed"), diff="")
    )
    assert any("reproducible" in v for v in report.spec_violations)
    assert report.score_verified is False


def test_reference_auditor_flags_unknown_citations(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    auditor = ReferenceAuditor(ctx)
    known = ["X-Mahalanobis: out-of-distribution detection with mahalanobis distance"]
    assert auditor.unknown_refs([], known) == []
    assert auditor.unknown_refs(["X-Mahalanobis (Wei et al., 2025)"], known) == []
    bad = auditor.unknown_refs(["Procrustes-DS: a miraculous method (Doe et al., 2049)"], known)
    assert bad == ["Procrustes-DS: a miraculous method (Doe et al., 2049)"]

    manuscript = Manuscript(
        id="m1",
        sections={"references": "X-Mahalanobis (Wei et al., 2025)\nTotally Made Up (Nobody, 2099)"},
    )
    report = asyncio.run(auditor.audit(manuscript, corpus=known))
    assert report.ref_violations == ["Totally Made Up (Nobody, 2099)"]


def test_method_code_alignment_is_lexical_lower_bound(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    auditor = MethodCodeAuditor(ctx)
    manuscript = Manuscript(
        id="m1",
        abstract="procrustes alignment of prototype residuals",
        claims=[Claim(text="procrustes alignment reduces residual norm", metric="auroc", value=0.91)],
    )
    good, missing = auditor.lexical_alignment(
        manuscript, "def procrustes(alignment, residuals): reduce residual norm"
    )
    assert good == 1.0 and missing == []

    bad, missing_bad = auditor.lexical_alignment(manuscript, "print('hello world')")
    assert bad == 0.0 and missing_bad

    report = asyncio.run(auditor.audit(manuscript, diff="print('hello world')", evidence=_evidence()))
    assert 0.0 <= report.method_code_alignment <= 1.0
    assert report.method_code_alignment == 0.0  # model says 1.0, deterministic floor says 0.0
