"""§3.4 — executable component ablations and evidence-based attribution critique.

The critic only judges AblationCoder outcomes; engineering and strict incumbent
replacement belong to the orchestrator, never to these agents.
"""

from __future__ import annotations

import json
import math
import re

from pydantic import BaseModel, Field

from ..types import AblationPlan, AblationResult, Decision, Evidence, Idea, Verdict
from .base import BaseAgent

__all__ = ["AblationPlanBatch", "AblationPlanner", "AblationCritic"]


class AblationPlanBatch(BaseModel):
    """Default-constructible structured planner output (§3.4)."""

    plans: list[AblationPlan] = Field(default_factory=list)
    hypothesis: str = ""


class AblationPlanner(BaseAgent):
    NAME = "ablation_planner"
    task = "ablation.plan"

    async def plan(self, idea: Idea, *, best: Evidence, n: int | None = None) -> list[AblationPlan]:
        """Produce exactly configured N_p distinct component interventions (§3.4).

        ``n`` is retained for caller compatibility; the configured N_p is
        authoritative. Offline defaults derive candidate components from the
        idea and clearly label structural controls instead of stalling research.
        """

        count = self.ctx.config.n_ablation_plans
        if count <= 0:
            raise ValueError("config.n_ablation_plans must be positive")
        batch = await self.ask(
            AblationPlanBatch,
            user=(
                "Formulate exactly N_p executable component-level ablations. Each plan must name ONE "
                "distinct removable or replaceable component actually present in the proposed method, "
                "not a hyperparameter/threshold/learning-rate sweep. State remove/replace intervention, "
                "validated code snapshot, fixed datasets/splits/seeds, metrics to re-measure, full-method "
                "control, and output artifacts in description. Set variant_of to the idea id. "
                "Do not invent components.\n"
                + self.ctx.guidance()
                + "\n"
                + json.dumps({"idea": idea.model_dump(mode="json"), "best": best.model_dump(mode="json"),
                              "N_p": count, "datasets": self.ctx.problem.datasets,
                              "seed": self.ctx.config.seed}, sort_keys=True)
            ),
            n=count,
            idea_id=idea.id,
        )
        components: set[str] = set()
        plans: list[AblationPlan] = []
        metrics = ", ".join(spec.name for spec in self.ctx.problem.metrics) or ", ".join(best.metrics) or "all benchmark metrics"
        datasets = ", ".join(self.ctx.problem.datasets) or "the full benchmark"
        snapshot = best.code.path if best.code is not None else "the validated incumbent snapshot"

        def append_component(component: str, proposed: AblationPlan | None = None) -> None:
            key = " ".join(component.casefold().split())
            if (not key or key in components or len(plans) >= count
                    or re.search(r"\b(sweep|hyperparameter|learning[ -]rate|batch[ -]size)\b", key)):
                return
            index = len(plans) + 1
            description = (
                f"Copy {snapshot}; remove only '{component}' (replace with an identity/no-op if required). "
                f"Hold all other components, datasets/splits and seed {self.ctx.config.seed} fixed. "
                f"Run the same full-set evaluation on {datasets}, record {metrics} and logs to "
                f"ablation/{idea.id}-{index}.json, and compare with complete-method metrics {best.metrics}."
            )
            if proposed is not None and proposed.description.strip():
                description = proposed.description.strip() + "\n" + description
            plans.append(AblationPlan(
                id=f"{idea.id}-ablation-{index}", component=component.strip(),
                description=description,
                expects=(proposed.expects.strip() if proposed is not None else "")
                or f"Removing {component} should worsen {metrics}; a tie/improvement indicates redundancy.",
                variant_of=idea.id,
            ))
            components.add(key)

        for proposed in batch.plans:
            fragments = re.split(r"[,;+]|\b(?:and|with|plus)\b", proposed.component, flags=re.IGNORECASE)
            for component in fragments:
                append_component(component, proposed if len(fragments) == 1 else None)
        # CONTRACT-GAP: Idea exposes mechanism prose, not a component inventory.
        # These deterministic structural probes are labelled as such; the coder
        # must report an absent component rather than invent its implementation.
        for text in (idea.mechanism, idea.hypothesis):
            for fragment in re.split(r"[,;+]|\b(?:and|with|plus)\b", text, flags=re.IGNORECASE):
                fragment = fragment.strip(" .:-")
                if fragment:
                    append_component(fragment)
        structural = ["primary mechanism", "auxiliary loss/regularizer", "input representation",
                      "safety/calibration gate", "training-free adaptation"]
        cycle = 0
        while len(plans) < count:
            for component in structural:
                suffix = f" {cycle + 1}" if cycle else ""
                append_component(f"structural ablation: {component}{suffix}")
            cycle += 1
        return plans


class AblationCritic(BaseAgent):
    NAME = "ablation_critic"
    task = "ablation.critic"

    async def judge(
        self,
        idea: Idea,
        results: list[AblationResult],
        *,
        best: Evidence,
    ) -> Verdict:
        """Return only GOOD/REFINE with an engineering instruction (§3.4).

        Component removal that ties or improves the complete method cannot show
        that component contributes. Missing/failed/non-finite outcomes likewise
        cannot justify GOOD. Guidance never changes these numeric checks.
        """

        verdict = await self.ask(
            Verdict,
            user=(
                "Judge whether the component breakdown is clean from AblationCoder results. Return "
                "decision good only if every isolated component contributes; otherwise refine. "
                "Feedback MUST name a component to remove/merge and specify metrics and benchmark "
                "to re-measure, not a wording change. Do not execute experiments.\n"
                + self.ctx.guidance()
                + "\n"
                + json.dumps({"idea": idea.model_dump(mode="json"), "best": best.model_dump(mode="json"),
                              "results": [result.model_dump(mode="json") for result in results]}, sort_keys=True)
            ),
            idea_id=idea.id,
        )
        concerns: list[str] = []
        if not results or not best.ok():
            concerns.append(idea.mechanism or idea.id)
        for result in results:
            metrics = result.evidence.metrics if result.evidence is not None else result.metrics
            valid = result.ok and (result.evidence is None or result.evidence.ok())
            worse = False
            counterproductive = False
            specs = self.ctx.problem.metrics
            if not specs:
                valid = False
            for spec in specs:
                control = best.metrics.get(spec.name)
                variant = metrics.get(spec.name)
                if control is None or variant is None or not math.isfinite(control) or not math.isfinite(variant):
                    valid = False
                    continue
                delta = variant - control if spec.direction == "max" else control - variant
                tolerance = abs(control) * spec.tolerance
                worse = worse or delta < -tolerance
                counterproductive = counterproductive or delta > tolerance
            if not valid or not worse or counterproductive:
                concerns.append(result.component or result.plan_id)
        decision = Decision.GOOD if verdict.decision == Decision.GOOD and not concerns else Decision.REFINE
        component = (concerns or [result.component or result.plan_id for result in results]
                     or [idea.mechanism or idea.id])[0]
        metrics_text = ", ".join(spec.name for spec in self.ctx.problem.metrics) or "all benchmark metrics"
        datasets = ", ".join(self.ctx.problem.datasets) or "the full benchmark"
        instruction = (
            f"Remove or merge component '{component}' in a candidate copy; re-measure {metrics_text} "
            f"on {datasets} with identical splits/seeds against the complete incumbent before adoption."
        )
        if decision == Decision.GOOD:
            instruction = (
                f"Each tested component contributes. As a verification control, {instruction[0].lower() + instruction[1:]}"
            )
        feedback = verdict.feedback.strip()
        return verdict.model_copy(update={"decision": decision,
                                          "feedback": f"{feedback}\n{instruction}".strip()})
