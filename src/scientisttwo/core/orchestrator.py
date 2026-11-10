"""§3.1–§3.6 state machine: sequencing, strict adoption, and replayable export."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..agents.ablation import AblationCritic, AblationPlanner
from ..agents.base import AgentContext
from ..agents.coding import (
    AblationCoder, BaselineCoder, FullSetCoder, IdeaImplementer, RebuttalCoder, SubsetCoder,
)
from ..agents.critics import FullSetCritic, ResultComparison, Selector, SubsetCritic
from ..agents.engineering import FullSetEngineer, SubsetEngineer
from ..agents.ideas import (
    IdeaEvolver, IdeaGenerator, InitialIdeaGenerator, NoveltyChecker,
    filter_by_guidance, rank_key,
)
from ..agents.integrity import MethodCodeAuditor, ReferenceAuditor, SpecAuditor, combine
from ..agents.limitations import LimitationExtractor, LimitationVerifier
from ..agents.review import MetaReviewer, PeerReviewer, RebuttalPlanner
from ..agents.writing import InitialDrafter, PaperEnhancer
from ..runtime.budget import BudgetExceeded
from ..types import (
    AblationResult, Decision, Evidence, FinalArtifacts, Idea, IntegrityReport, Manuscript, Scope, Trace,
    is_strictly_better,
)
from .state import ResearchState

__all__ = ["AgentBundle", "Orchestrator", "build_agents"]


@dataclass
class AgentBundle:
    """All pipeline agents, injectable for isolated control-flow tests."""

    limitation_extractor: LimitationExtractor
    limitation_verifier: LimitationVerifier
    initial_idea_generator: InitialIdeaGenerator
    novelty_checker: NoveltyChecker
    idea_generator: IdeaGenerator
    idea_evolver: IdeaEvolver
    baseline_coder: BaselineCoder
    subset_coder: SubsetCoder
    full_set_coder: FullSetCoder
    subset_critic: SubsetCritic
    full_set_critic: FullSetCritic
    subset_engineer: SubsetEngineer
    full_set_engineer: FullSetEngineer
    implementer: IdeaImplementer
    result_comparison: ResultComparison
    selector: Selector
    ablation_planner: AblationPlanner
    ablation_coder: AblationCoder
    ablation_critic: AblationCritic
    initial_drafter: InitialDrafter
    peer_reviewer: PeerReviewer
    rebuttal_planner: RebuttalPlanner
    rebuttal_coder: RebuttalCoder
    paper_enhancer: PaperEnhancer
    meta_reviewer: MetaReviewer
    spec_auditor: SpecAuditor
    reference_auditor: ReferenceAuditor
    method_code_auditor: MethodCodeAuditor


def build_agents(ctx: AgentContext) -> AgentBundle:
    """Wire shared coder/critic dependencies (§3.2 eq. 2), without globals."""

    subset_critic = SubsetCritic(ctx)
    full_critic = FullSetCritic(ctx)
    subset_engineer = SubsetEngineer(ctx)
    full_engineer = FullSetEngineer(ctx)
    baseline_coder = BaselineCoder(ctx)
    subset_coder = SubsetCoder(ctx)
    full_coder = FullSetCoder(ctx)
    return AgentBundle(
        limitation_extractor=LimitationExtractor(ctx),
        limitation_verifier=LimitationVerifier(ctx),
        initial_idea_generator=InitialIdeaGenerator(ctx),
        novelty_checker=NoveltyChecker(ctx),
        idea_generator=IdeaGenerator(ctx),
        idea_evolver=IdeaEvolver(ctx),
        baseline_coder=baseline_coder,
        subset_coder=subset_coder,
        full_set_coder=full_coder,
        subset_critic=subset_critic,
        full_set_critic=full_critic,
        subset_engineer=subset_engineer,
        full_set_engineer=full_engineer,
        implementer=IdeaImplementer(
            ctx, subset_critic=subset_critic, full_critic=full_critic,
            subset_engineer=subset_engineer, full_engineer=full_engineer,
            baseline_coder=baseline_coder, subset_coder=subset_coder,
            full_set_coder=full_coder,
        ),
        result_comparison=ResultComparison(ctx),
        selector=Selector(ctx),
        ablation_planner=AblationPlanner(ctx),
        ablation_coder=AblationCoder(ctx),
        ablation_critic=AblationCritic(ctx),
        initial_drafter=InitialDrafter(ctx),
        peer_reviewer=PeerReviewer(ctx),
        rebuttal_planner=RebuttalPlanner(ctx),
        rebuttal_coder=RebuttalCoder(ctx),
        paper_enhancer=PaperEnhancer(ctx),
        meta_reviewer=MetaReviewer(ctx),
        spec_auditor=SpecAuditor(ctx),
        reference_auditor=ReferenceAuditor(ctx),
        method_code_auditor=MethodCodeAuditor(ctx),
    )


class _ScientificAbort(Exception):
    """A normal scientific dead end rather than an infrastructure failure (§3.3)."""


class Orchestrator:
    """Bounded, empirical-gate-driven research controller (SPEC §2)."""

    def __init__(self, ctx: AgentContext, agents: AgentBundle | None = None) -> None:
        self.ctx = ctx
        self.agents = agents or build_agents(ctx)
        self.state = ResearchState(problem=ctx.problem, config=ctx.config)
        self._spec_reports: dict[str, IntegrityReport] = {}

    async def run(self) -> FinalArtifacts:
        """Execute §3.1–§3.6; scientific dead ends export partial artifacts.

        Only agents actually invoking workspace.run charge experiments; this
        controller checks hard budgets at each loop boundary without double billing.
        """

        try:
            self.ctx.budget.check()
            await self._limitations()
            await self._seed_ideas()
            await self._baseline()
            await self._idea_search()
            await self._select()
            await self._ablations()
            await self._draft_and_review()
            await self._meta_review()
        except (_ScientificAbort, BudgetExceeded) as exc:
            self.state.aborted = isinstance(exc, BudgetExceeded) or str(exc) in {
                "no_good_ideas", "baseline_failed",
            }
            if self.state.aborted:
                self.state.abort_reason = str(exc)
            else:
                self.state.export_reason = str(exc)
        return await self._export()

    def _transition(self, kind: str, token: str, **data: Any) -> None:
        """Persist the exact token consumed by offline replay (SPEC I8)."""

        self.state.note(token)
        self.ctx.traces.append(kind, {"decision": token, "token": token, **data})
        self._persist_state()

    def _persist_state(self) -> None:
        """Persist through ArtifactStore, not direct filesystem access (SPEC I8)."""

        # CONTRACT-GAP: write_json is artifact-relative; SPEC requires run-root
        # state.json. Resolve that fixed location through the store API.
        self.ctx.store.write_json("../state.json", self.state_dict())

    async def _limitations(self) -> None:
        """§3.1: expand/verify, absolutely capped at 16 extraction pairs (A.2)."""

        for index in range(min(16, self.ctx.config.max_limitation_rounds)):
            self.ctx.budget.check()
            new = await self.agents.limitation_extractor.extract(
                round=index, existing=self.state.limitations,
            )
            self.state.limitations = sorted(self.state.limitations + new, key=lambda item: item.id)
            verdict = await self.agents.limitation_verifier.verify(self.state.limitations, round=index)
            sufficient = verdict.accepted and len(self.state.limitations) >= self.ctx.config.min_limitations
            self._transition(
                "stage.limitations", f"limits.{'ok' if sufficient else 'refine'}:{len(self.state.limitations)}",
                round=index, verdict=verdict.model_dump(mode="json"),
            )
            if sufficient:
                return
        raise _ScientificAbort("limitations_exhausted")

    async def _seed_ideas(self) -> None:
        """§3.1: h0, distinct expansion, novelty scoring, then SPEC G2–G4."""

        initial = await self.agents.initial_idea_generator.generate(self.state.limitations)
        pool = [await self.agents.novelty_checker.score(initial)]
        # A short generation round is a *supply* problem, not evidence: retry a
        # bounded number of times, then proceed with what exists (the paper only
        # aborts on zero successful ideas after K rounds, §3.3).
        for _ in range(max(2 * self.ctx.config.n_seed, 1)):
            self.ctx.budget.check()
            if len(pool) >= self.ctx.config.n_seed:
                break
            extra = await self.agents.idea_generator.generate(
                limitations=self.state.limitations, existing=pool,
                n=self.ctx.config.n_seed - len(pool),
            )
            ids = {idea.id for idea in pool}
            extra = [idea for idea in sorted(extra, key=lambda item: item.id) if idea.id not in ids]
            if not extra:
                break
            for idea in extra[: self.ctx.config.n_seed - len(pool)]:
                self.ctx.budget.check()
                pool.append(await self.agents.novelty_checker.score(idea))
        eligible = [idea for idea in pool if idea.hypothesis.strip()
                    and idea.novelty_score >= self.ctx.config.min_novelty]
        self.state.seeds = sorted(
            filter_by_guidance(eligible, self.ctx.problem, self.ctx.config),
            key=lambda item: (-rank_key(item, self.ctx.config.guidance_weight), item.id),
        )
        self._transition("stage.seeds", f"seeds:{len(self.state.seeds)}",
                         ids=[idea.id for idea in self.state.seeds])
        if len(pool) < self.ctx.config.n_seed:
            self._transition("stage.seeds", f"seeds.partial:{len(pool)}")
        if not self.state.seeds:
            raise _ScientificAbort("no_eligible_seeds")

    async def _baseline(self) -> None:
        """§3.2: reproduce once; empirical gates use this measured baseline (I3)."""

        self.ctx.budget.check()
        if self.state.baseline is None:
            self.state.baseline = await self.agents.baseline_coder.reproduce(scope="subset")
        self.ctx.scratch["baseline"] = self.state.baseline
        self._transition("stage.baseline", "baseline.ok" if self.state.baseline.ok() else "baseline.bad",
                         metrics=self.state.baseline.metrics)
        if not self.state.baseline.ok() or not self.state.baseline.metrics:
            raise _ScientificAbort("baseline_failed")

    async def _audit_trace(self, trace: Trace) -> None:
        """Immediately discard specification-violating successes (§4.3, p.14)."""

        if trace.decision != Decision.GOOD:
            return
        try:
            evidence = trace.final_evidence()
            if evidence is None:
                return
            baseline = self.state.baseline
            diff = ""
            if baseline is not None and baseline.code is not None and evidence.code is not None:
                diff = await self.ctx.workspace.diff(baseline.code, evidence.code)
            report = await self.agents.spec_auditor.audit(trace.idea, evidence=evidence, diff=diff)
            self._spec_reports[trace.idea.id] = report
            self.ctx.traces.append("integrity", {"agent": "spec_auditor", "report": report})
            if report.spec_violations:
                trace.decision = Decision.BAD
                trace.lessons.append("Specification violation: " + "; ".join(sorted(report.spec_violations)))
                self._transition("stage.round", f"spec.violation:{trace.idea.id}",
                                 violations=sorted(report.spec_violations))
        except Exception as exc:  # Auditing is advisory infrastructure (§4.3).
            self._spec_reports[trace.idea.id] = IntegrityReport(
                score_verified=False, notes=[f"spec_auditor unavailable: {type(exc).__name__}"],
            )
            self.ctx.traces.append("integrity", {"agent": "spec_auditor", "error": type(exc).__name__})

    async def _evaluate(self, ideas: list[Idea], round: int) -> None:
        """§3.2/§3.3: preserve terminal Good and Bad traces, including audit lessons."""

        self.state.round = round
        for idea in ideas:
            self.ctx.budget.check()
            if idea.id in self.state.evaluated_ids:
                continue
            trace = await self.agents.implementer.implement(idea, round=round)
            await self._audit_trace(trace)
            self.state.record(trace)
            self.state.evaluated_ids.add(idea.id)
            self._transition("stage.round", f"round{round}.{idea.id}:{trace.decision.value}",
                             round=round, idea_id=idea.id, trace=trace.model_dump(mode="json"))

    async def _idea_search(self) -> None:
        """§3.3: top-N0, then evolved ideas mixed with untouched novelty seeds."""

        await self._evaluate(self.state.next_seeds(self.ctx.config.n0), 0)
        for round in range(1, self.ctx.config.max_refine_rounds + 1):
            self.ctx.budget.check()
            if len(self.state.good_traces()) >= self.ctx.config.success_target:
                break
            seeds = self.state.next_seeds(self.ctx.config.n_explore)
            # Depleted untouched seeds are replaced by additional evolved ideas.
            n = self.ctx.config.n_evolved + self.ctx.config.n_explore - len(seeds)
            evolved = await self.agents.idea_evolver.evolve(
                traces=sorted(self.state.traces, key=lambda trace: (trace.round, trace.idea.id)),
                n=n, round=round,
            )
            scored: list[Idea] = []
            for idea in sorted(evolved, key=lambda item: item.id):
                self.ctx.budget.check()
                scored.append(await self.agents.novelty_checker.score(idea, round=round))
            eligible = filter_by_guidance(scored, self.ctx.problem, self.ctx.config)
            evolved_ids = {idea.id for idea in eligible}
            candidates = sorted(eligible, key=lambda item: item.id) + [
                idea for idea in seeds if idea.id not in evolved_ids
            ]
            await self._evaluate(candidates, round)
            if not candidates:
                self._transition("stage.round", f"round{round}.empty", round=round)
        if not self.state.good_traces():
            raise _ScientificAbort("no_good_ideas")

    async def _select(self) -> None:
        """§3.3 eq. 4: select full-set Good traces, adopt only through I2."""

        assert self.state.baseline is not None
        valid: list[Trace] = []
        for trace in self.state.good_traces():
            evidence = trace.final_evidence()
            if evidence is not None and evidence.scope == Scope.FULL:
                valid.append(trace)
        if not valid:
            raise _ScientificAbort("no_valid_full_evidence")
        selected = await self.agents.selector.select(valid, baseline=self.state.baseline)
        evidence = selected.final_evidence()
        self._transition("stage.select", f"select:{selected.idea.id}", idea_id=selected.idea.id)
        if evidence is None or not await self._adopt(selected.idea, evidence, self.state.baseline, "select"):
            raise _ScientificAbort("selection_not_better_than_baseline")

    async def _adopt(self, idea: Idea, evidence: Evidence, base: Evidence, reason: str) -> bool:
        """§3.4/§3.6: enforce strict measured improvement, independent of guidance."""

        verdict = await self.agents.result_comparison.compare(evidence, base)
        better = evidence.ok() and verdict.accepted and is_strictly_better(
            evidence.metrics, base.metrics, self.ctx.problem.metrics,
        )
        if better:
            self.state.adopt(idea, evidence)
            self._transition("state.adopt", f"adopt.{reason}:{idea.id}",
                             idea_id=idea.id, metrics=evidence.metrics)
        return better

    async def _ablations(self) -> None:
        """§3.4: plan/critic, bounded engineering, strict replacement, re-plan."""

        for index in range(self.ctx.config.max_ablation_rounds + 1):
            self.ctx.budget.check()
            self.state.ablation_round = index
            idea, best = self._incumbent()
            plans = await self.agents.ablation_planner.plan(
                idea, best=best, n=self.ctx.config.n_ablation_plans,
            )
            results: list[AblationResult] = []
            for plan in sorted(plans, key=lambda plan: plan.id):
                self.ctx.budget.check()
                results.append(await self.agents.ablation_coder.run_plan(idea, plan, best=best))
            self.state.ablations = results
            verdict = await self.agents.ablation_critic.judge(idea, results, best=best)
            self._transition("stage.ablation", f"ablation.{verdict.decision.value}",
                             round=index, verdict=verdict.model_dump(mode="json"))
            if verdict.accepted or verdict.decision not in (Decision.REFINE, Decision.ENGINEER):
                return
            if index >= self.ctx.config.max_ablation_rounds:
                return
            self.ctx.budget.check()
            revised, evidence = await self.agents.full_set_engineer.refine(
                idea, evidence=best, feedback=verdict.feedback, reason="ablation",
            )
            if not await self._adopt(revised, evidence, best, "ablation"):
                self._transition("stage.ablation", "ablation.keep")
                return

    async def _draft_and_review(self, reviewer_feedback: str = "") -> None:
        """§3.5: manuscript enhancements require new supplementary experiments."""

        idea, best = self._incumbent()
        self.state.peer_round = 0
        self.state.review_refinements = 0
        self.state.rebuttals = []
        self.state.manuscript = await self.agents.initial_drafter.draft(
            idea=idea, best=best, ablations=self.state.ablations,
            round=self.state.meta_round, reviewer_feedback=reviewer_feedback,
        )
        self.state.review = await self.agents.peer_reviewer.review(self.state.manuscript, round=0)
        self._transition("stage.review", f"peer.r0:{self.state.review.score:g}",
                         score=self.state.review.score)
        while (not self.state.review.passes(self.ctx.config.review_threshold)
               and self.state.peer_round < self.ctx.config.max_peer_rounds
               and self.state.review_refinements < self.ctx.config.max_review_refinements):
            self.ctx.budget.check()
            tasks = await self.agents.rebuttal_planner.plan(
                self.state.review, n=max(1, len(self.state.review.questions)),
            )
            rebuttal: list[Evidence] = []
            for task in sorted(tasks, key=lambda task: task.id):
                self.ctx.budget.check()
                evidence = await self.agents.rebuttal_coder.run_task(idea, task, best=best)
                self.state.rebuttals.append(evidence)
                if evidence.ok() and evidence.metrics:
                    rebuttal.append(evidence)
            if not rebuttal:
                self._transition("stage.review", "peer.no_evidence")
                break
            self.state.manuscript = await self.agents.paper_enhancer.enhance(
                manuscript=self.state.manuscript, review=self.state.review, rebuttal=rebuttal,
            )
            self.state.peer_round += 1
            self.state.review_refinements += 1
            self.state.review = await self.agents.peer_reviewer.review(
                self.state.manuscript, round=self.state.peer_round,
            )
            self._transition("stage.review", f"peer.r{self.state.peer_round}:{self.state.review.score:g}",
                             score=self.state.review.score)

    async def _meta_review(self) -> None:
        """§3.6: accept or engineer; losing refinements preserve the incumbent."""

        for index in range(self.ctx.config.max_meta_rounds + 1):
            self.ctx.budget.check()
            self.state.meta_round = index
            assert self.state.manuscript is not None and self.state.review is not None
            self.state.meta_review = await self.agents.meta_reviewer.decide(
                self.state.manuscript, self.state.review, round=index,
            )
            self._transition("stage.meta", f"meta.{self.state.meta_review.decision}", round=index)
            if self.state.meta_review.decision == "accept":
                if not self.state.review.passes(self.ctx.config.review_threshold):
                    raise _ScientificAbort("peer_review_below_threshold")
                return
            if index >= self.ctx.config.max_meta_rounds:
                self.state.export_reason = "meta_refinement_budget_exhausted"
                self._transition("stage.meta", "meta.exhausted")
                return
            idea, best = self._incumbent()
            self.ctx.budget.check()
            revised, evidence = await self.agents.full_set_engineer.refine(
                idea, evidence=best, feedback=self.state.meta_review.critique, reason="meta",
            )
            if not await self._adopt(revised, evidence, best, "meta"):
                self.state.export_reason = "meta_refinement_not_strictly_better"
                self._transition("stage.meta", "meta.keep")
                return
            self.state.meta_round = index + 1
            await self._ablations()
            await self._draft_and_review(reviewer_feedback=self.state.meta_review.critique)

    def _incumbent(self) -> tuple[Idea, Evidence]:
        """Expose only an already adopted hypothesis/evidence pair (I2)."""

        assert self.state.best_idea is not None and self.state.best_evidence is not None
        return self.state.best_idea, self.state.best_evidence

    async def _export_integrity(self) -> IntegrityReport:
        """§4.3: advisory bibliography/method-code audit cannot block export."""

        reports: list[IntegrityReport] = []
        if self.state.best_idea is not None:
            report = self._spec_reports.get(self.state.best_idea.id)
            if report is not None:
                reports.append(report)
        if self.state.manuscript is None:
            return combine(*reports)
        for name in ("reference_auditor", "method_code_auditor"):
            try:
                if name == "reference_auditor":
                    report = await self.agents.reference_auditor.audit(self.state.manuscript)
                else:
                    diff = ""
                    baseline = self.state.baseline
                    if baseline is not None and baseline.code is not None and self.state.best_code is not None:
                        diff = await self.ctx.workspace.diff(baseline.code, self.state.best_code)
                    report = await self.agents.method_code_auditor.audit(
                        self.state.manuscript, diff=diff, evidence=self.state.best_evidence,
                    )
                reports.append(report)
                self.ctx.traces.append("integrity", {"agent": name, "report": report})
            except Exception as exc:  # Advisory auditors must not suppress artifacts.
                reports.append(IntegrityReport(score_verified=False,
                                               notes=[f"{name} unavailable: {type(exc).__name__}"]))
                self.ctx.traces.append("integrity", {"agent": name, "error": type(exc).__name__})
                if isinstance(exc, BudgetExceeded):
                    self.state.aborted = True
                    self.state.abort_reason = str(exc)
                    break
        return combine(*reports)

    async def _export(self) -> FinalArtifacts:
        """Export complete/partial artifacts with explicit acceptance (I7/I8)."""

        accepted = (
            not self.state.aborted and self.state.review is not None
            and self.state.review.passes(self.ctx.config.review_threshold)
            and self.state.meta_review is not None
            and self.state.meta_review.decision == "accept"
        )
        # CONTRACT-GAP: §3.6 exports after a losing meta refinement, although I7
        # forbids calling it accepted. FinalArtifacts has no accepted field;
        # distinguish exported and accepted through extra without weakening I7.
        integrity = await self._export_integrity()
        clean = (not integrity.spec_violations and not integrity.ref_violations
                 and integrity.score_verified and integrity.method_code_alignment >= 0.5)
        accepted = accepted and clean
        extra: dict[str, Any] = {"accepted": accepted}
        if not accepted and not self.state.aborted:
            if not self.state.export_reason:
                self.state.export_reason = "integrity_not_clean" if not clean else "acceptance_gates_not_met"
            extra["export_reason"] = self.state.export_reason
        if integrity.method_code_alignment < 0.5:
            extra["integrity_warning"] = "Method-code alignment is below 0.5."
        terminal = "run.abort" if self.state.aborted else (
            "run.accept" if accepted else "run.export_incumbent"
        )
        self._transition("run.abort" if self.state.aborted else "run.done", terminal,
                         reason=self.state.abort_reason or self.state.export_reason)
        final = FinalArtifacts(
            paper=self.state.manuscript or Manuscript(id=f"{self.ctx.problem.id}-incomplete"),
            code=self.state.best_code, review=self.state.review, meta_review=self.state.meta_review,
            metrics=self.state.best_evidence.metrics if self.state.best_evidence else {},
            decision_path=list(self.state.decision_path), aborted=self.state.aborted,
            abort_reason=self.state.abort_reason, extra=extra, integrity=integrity,
        )
        self._persist_state()
        self.ctx.store.write_json("final.json", final)
        return final

    def state_dict(self) -> dict[str, Any]:
        """JSON-serializable full snapshot, including sorted sets (SPEC I8)."""

        return self.state.to_dict()
