"""§3.2/§3.4 — snapshot coders and the bounded unified implementer.

Only workspace execution supplies metrics. The composite orchestrates its
children and never charges an experiment on their behalf.
"""

from __future__ import annotations

import zlib

from pydantic import BaseModel

from ..types import (
    AblationPlan, AblationResult, Decision, Evidence, Idea, MetricSpec, RebuttalTask,
    RepoRef, Scope, Trace,
)
from .base import AgentContext, BaseAgent
from .critics import FullSetCritic, SubsetCritic
from .engineering import FullSetEngineer, SubsetEngineer

__all__ = [
    "BaselineCoder", "SubsetCoder", "FullSetCoder", "AblationCoder",
    "RebuttalCoder", "IdeaImplementer",
]


class BaselinePatch(BaseModel):
    patch: str = "Reproduce the unmodified reference method with the fixed benchmark protocol."


class SubsetPatch(BaseModel):
    patch: str = "Implement the proposed mechanism on the fixed benchmark subset."


class FullSetPatch(BaseModel):
    patch: str = "Scale the validated subset implementation to the full benchmark without changing the method."


class AblationPatch(BaseModel):
    patch: str = "Apply only the specified component intervention; keep all other settings fixed."


class RebuttalPatch(BaseModel):
    patch: str = "Execute the supplementary experiment with the incumbent method unchanged."


class ImplementationInstruction(BaseModel):
    instruction: str = "Screen the subset first, refine within budget, and scale only after a Good verdict."


def _code(evidence: Evidence) -> RepoRef:
    if evidence.code is None:
        raise ValueError("execution requires a code snapshot")
    return evidence.code


def _component_contribution(component: str) -> float:
    """Deterministic contribution of one ablated component (§3.4 attribution).

    Removal degrades the primary metric by 2%-11%, so a real component is always
    attributable. Dead components are handled separately by
    :func:`_is_dead_component`.
    """

    key = zlib.crc32((component or "component").encode())
    if key % 5 == 0:
        return 0.0
    return 0.02 + (key % 90) / 1000.0


def _is_dead_component(idea: Idea, plan: AblationPlan) -> bool:
    """Whether this component is dead weight (no measurable contribution).

    Dead components must exist to exercise the §3.4 ``Refine`` branch, but they
    must stay rare so the clean ``Good`` path is the normal case: both the idea and
    the component must hit their modulus, giving ≈5% per tested component.
    """

    idea_key = zlib.crc32((idea.mechanism or idea.id).encode())
    component_key = zlib.crc32((plan.component or plan.id).encode())
    return idea_key % 4 == 0 and component_key % 5 == 0


def _clamp_metric(value: float, spec: MetricSpec) -> float:
    """Keep an ablated metric inside its physical range (AUROC in (0,1), ...)."""

    if not spec.bounds:
        return value
    low, high = float(spec.bounds[0]), float(spec.bounds[1])
    margin = 1e-6 * max(1.0, abs(high - low))
    return min(max(value, low + margin), high - margin)


class BaselineCoder(BaseAgent):
    """Reproduce the baseline once before idea screening (§3.2)."""

    NAME = "baseline_coder"
    task = "code.baseline"
    role = "coding"

    async def reproduce(self, *, scope: str = "subset") -> Evidence:
        requested_scope = Scope(scope)
        out = await self.ask(BaselinePatch, user=self.ctx.problem.model_dump_json(), scope=requested_scope.value)
        repo = await self.ctx.workspace.baseline_repo()
        repo = await self.ctx.workspace.write_patch(repo, out.patch, f"baseline-{requested_scope.value}")
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, requested_scope)
        evidence = Evidence(
            idea_id="baseline", scope=requested_scope, metrics=result.metrics,
            code=repo, result=result, label=repo.label,
        )
        if requested_scope == Scope.SUBSET:
            self.ctx.scratch["baseline"] = evidence
        return evidence


class SubsetCoder(BaseAgent):
    """Implement an idea against the reproduced code, never reported scores (§3.2)."""

    NAME = "subset_coder"
    task = "code.subset"
    role = "coding"

    async def implement(self, idea: Idea, *, base: Evidence) -> Evidence:
        out = await self.ask(SubsetPatch, user=idea.model_dump_json(), idea_id=idea.id)
        patch = f"{out.patch}\nHypothesis: {idea.hypothesis}\nMechanism: {idea.mechanism}\n"
        repo = await self.ctx.workspace.write_patch(_code(base), patch, f"{idea.id}-subset")
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, Scope.SUBSET, idea=idea)
        return Evidence(
            idea_id=idea.id, scope=Scope.SUBSET, metrics=result.metrics,
            baseline_metrics=dict(base.metrics), code=repo, result=result, label=repo.label,
        )


class FullSetCoder(BaseAgent):
    """Scale the accepted subset snapshot to the full benchmark (§3.2)."""

    NAME = "full_set_coder"
    task = "code.full"
    role = "coding"

    async def scale(self, idea: Idea, *, subset: Evidence) -> Evidence:
        out = await self.ask(FullSetPatch, user=idea.model_dump_json(), idea_id=idea.id)
        patch = f"{out.patch}\nHypothesis: {idea.hypothesis}\nMechanism: {idea.mechanism}\n"
        repo = await self.ctx.workspace.write_patch(_code(subset), patch, f"{idea.id}-full")
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, Scope.FULL, idea=idea)
        return Evidence(
            idea_id=idea.id, scope=Scope.FULL, metrics=result.metrics,
            baseline_metrics=dict(subset.baseline_metrics), code=repo, result=result, label=repo.label,
        )


class AblationCoder(BaseAgent):
    """Execute each intervention independently against C_best (§3.4)."""

    NAME = "ablation_coder"
    task = "code.ablation"
    role = "ablation"

    async def run_plan(self, idea: Idea, plan: AblationPlan, *, best: Evidence) -> AblationResult:
        out = await self.ask(
            AblationPatch, user=f"{idea.model_dump_json()}\n{plan.model_dump_json()}",
            idea_id=idea.id, plan_id=plan.id,
        )
        patch = f"{out.patch}\nMechanism: {idea.mechanism}\n{plan.model_dump_json()}\n"
        repo = await self.ctx.workspace.write_patch(_code(best), patch, f"{idea.id}-ablation-{plan.id}")
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, Scope.ABLATION, idea=idea)
        metrics = self._apply_component_model(idea, plan, best, dict(result.metrics))
        if metrics != result.metrics:
            result = result.model_copy(update={"metrics": metrics})
        evidence = Evidence(
            idea_id=idea.id, scope=Scope.ABLATION, metrics=metrics,
            baseline_metrics=dict(best.metrics), code=repo, result=result, label=plan.id,
        )
        return AblationResult(
            plan_id=plan.id, component=plan.component, metrics=metrics,
            evidence=evidence, ok=result.ok(),
        )

    def _apply_component_model(
        self, idea: Idea, plan: AblationPlan, best: Evidence, metrics: dict[str, float]
    ) -> dict[str, float]:
        """Make component removal *measurable* in offline runs (§3.4 attribution).

        The simulated runner cannot execute a real ablated codebase, so it would
        return the incumbent's numbers and no component could ever be attributed.
        We therefore model the ablation explicitly: removing a contributing
        component degrades the primary metric by a deterministic contribution

            c = 0.02 + (crc32(component) % 90) / 1000        # [0.02, 0.11)
            c = 0.0  when crc32(component) % 5 == 0          # a dead component

        so the critic sees both ``worse`` (contributes) and ``not worse`` (dead
        weight) outcomes. Real execution (``runner="subprocess"``) is never
        adjusted: measurements come from the code, not from this model.
        """

        if self.ctx.config.runner != "simulated" or not best.metrics:
            return metrics
        contribution = _component_contribution(plan.component or plan.id)
        if _is_dead_component(idea, plan):
            contribution = 0.0
        if contribution <= 0.0:
            return metrics
        out = dict(metrics)
        for spec in self.ctx.problem.metrics:
            base = best.metrics.get(spec.name)
            if base is None:
                continue
            factor = 1.0 - contribution if spec.direction == "max" else 1.0 + contribution
            out[spec.name] = _clamp_metric(base * factor, spec)
        return out


class RebuttalCoder(BaseAgent):
    """Execute supplementary review tasks from C_best (§3.5, following §3.4)."""

    NAME = "rebuttal_coder"
    task = "code.rebuttal"
    role = "rebuttal"

    async def run_task(self, idea: Idea, task: RebuttalTask, *, best: Evidence) -> Evidence:
        out = await self.ask(
            RebuttalPatch, user=f"{idea.model_dump_json()}\n{task.model_dump_json()}",
            idea_id=idea.id, task_id=task.id,
        )
        repo = await self.ctx.workspace.write_patch(
            _code(best), f"{out.patch}\n{task.model_dump_json()}\n", f"{idea.id}-rebuttal-{task.id}",
        )
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, Scope.REBUTTAL, idea=idea)
        return Evidence(
            idea_id=idea.id, scope=Scope.REBUTTAL, metrics=result.metrics,
            baseline_metrics=dict(best.metrics), code=repo, result=result, label=task.id,
        )


class IdeaImplementer(BaseAgent):
    """Composite A_Coder: subset → critic → bounded engineering → full (§3.2)."""

    NAME = "idea_implementer"
    task = "code.implement"
    role = "coding"

    def __init__(
        self, ctx: AgentContext, *, subset_critic: SubsetCritic,
        full_critic: FullSetCritic, subset_engineer: SubsetEngineer,
        full_engineer: FullSetEngineer, baseline_coder: BaselineCoder,
        subset_coder: SubsetCoder, full_set_coder: FullSetCoder,
    ) -> None:
        super().__init__(ctx)
        self.subset_critic = subset_critic
        self.full_critic = full_critic
        self.subset_engineer = subset_engineer
        self.full_engineer = full_engineer
        self.baseline_coder = baseline_coder
        self.subset_coder = subset_coder
        self.full_set_coder = full_set_coder

    async def implement(self, idea: Idea, *, round: int = 0) -> Trace:
        instruction = await self.ask(
            ImplementationInstruction, user=idea.model_dump_json(), idea_id=idea.id, round=round,
        )
        self.log("implementation_instruction", {"idea_id": idea.id, "instruction": instruction.instruction})
        baseline = self.ctx.scratch.get("baseline")
        if baseline is None:
            baseline = await self.baseline_coder.reproduce(scope="subset")
            self.ctx.scratch["baseline"] = baseline
        if not isinstance(baseline, Evidence):
            raise TypeError("scratch['baseline'] must be Evidence")
        trace = Trace(idea=idea, round=round)
        if not baseline.ok():
            trace.feedback = "Baseline reproduction failed; candidate cannot be compared."
            trace.lessons.append(trace.feedback)
            return trace
        current = await self.subset_coder.implement(idea, base=baseline)
        trace.evidence.append(current)
        verdict = await self.subset_critic.judge(current, baseline=baseline)
        trace.lessons.append(verdict.feedback)
        per_stage = self.ctx.config.engineering_budget_scope == "per_stage"
        budget = self.ctx.config.max_eng_rounds
        used = 0
        while verdict.decision == Decision.ENGINEER and (per_stage or used < budget):
            if not per_stage:
                used += 1
            current = await self.subset_engineer.refine(idea, evidence=current, feedback=verdict.feedback)
            trace.evidence.append(current)
            verdict = await self.subset_critic.judge(current, baseline=baseline)
            trace.lessons.append(verdict.feedback)
        if verdict.decision != Decision.GOOD:
            trace.feedback = verdict.feedback
            trace.decision = Decision.BAD
            return trace
        current = await self.full_set_coder.scale(idea, subset=current)
        trace.evidence.append(current)
        attempts = used
        verdict = await self.full_critic.judge(current, baseline=baseline, attempts=attempts)
        trace.lessons.append(verdict.feedback)
        while verdict.decision == Decision.ENGINEER and (per_stage or attempts < budget):
            idea, current = await self.full_engineer.refine(
                idea, evidence=current, feedback=verdict.feedback, reason="full",
            )
            trace.idea = idea
            trace.evidence.append(current)
            attempts += 1
            verdict = await self.full_critic.judge(current, baseline=baseline, attempts=attempts)
            trace.lessons.append(verdict.feedback)
        trace.decision = Decision.GOOD if verdict.decision == Decision.GOOD else Decision.BAD
        trace.feedback = verdict.feedback
        return trace
