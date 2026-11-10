"""§3.5/§3.6 — ScholarPeer-style review, executable rebuttals and meta-review.

Rebuttal is experiment-backed, never text-only. A high peer score alone cannot
bypass deterministic manuscript structure and evidence checks at meta-review.
"""

from __future__ import annotations

import json
import math

from pydantic import BaseModel, Field

from ..types import Manuscript, MetaReview, RebuttalTask, Review
from .base import BaseAgent
from .writing import validate_manuscript

__all__ = ["RebuttalPlanBatch", "PeerReviewer", "RebuttalPlanner", "MetaReviewer"]


class RebuttalPlanBatch(BaseModel):
    """Default-constructible supplementary experimental task batch (§3.5)."""

    tasks: list[RebuttalTask] = Field(default_factory=list)


def _nonempty(items: list[str]) -> list[str]:
    return [item.strip() for item in items if item.strip()]


def _bounded_score(score: float, maximum: float) -> float:
    if not math.isfinite(maximum) or maximum < 1:
        raise ValueError("config.review_scale_max must be finite and at least 1")
    return min(maximum, max(1.0, score)) if math.isfinite(score) else 1.0


class PeerReviewer(BaseAgent):
    NAME = "peer_reviewer"
    task = "review.peer"

    async def review(self, manuscript: Manuscript, *, round: int = 0) -> Review:
        """Return a bounded ScholarPeer-style review with actionable questions (§3.5)."""

        config = self.ctx.config
        output = await self.ask(
            Review,
            user=(
                "Review the current manuscript in ScholarPeer style. Assess methodological novelty, "
                "baseline fairness, empirical validity, component attribution and reproducibility. "
                "Return at least one strength, specific weaknesses, targeted experimental questions, "
                f"and an overall score in [1, {config.review_scale_max}]. A score below "
                f"{config.review_threshold} REQUIRES a weakness and targeted question that an "
                "engineer can resolve with supplementary experiments. Guidance must not inflate the score.\n"
                + self.ctx.guidance() + "\n"
                + json.dumps({"manuscript": manuscript.model_dump(mode="json"),
                              "structural_violations": validate_manuscript(manuscript, config, self.ctx.problem)}, sort_keys=True)
            ),
            manuscript_id=manuscript.id,
            round=round,
        )
        score = _bounded_score(output.score, config.review_scale_max)
        strengths = _nonempty(output.strengths) or ["The manuscript presents a concrete method for empirical assessment."]
        weaknesses = _nonempty(output.weaknesses)
        questions = _nonempty(output.questions)
        metrics = ", ".join(spec.name for spec in self.ctx.problem.metrics) or "the reported benchmark metrics"
        datasets = ", ".join(self.ctx.problem.datasets) or "all full-set evaluation datasets"
        if score < config.review_threshold:
            if not weaknesses:
                weaknesses = ["The core mechanism's contribution and robustness versus the reproduced baseline remain insufficiently established."]
            if not questions:
                questions = [f"Does removing the core mechanism change {metrics} on {datasets} under identical splits and repeated seeds versus the reproduced baseline?"]
        return Review(
            manuscript_id=manuscript.id, strengths=strengths, weaknesses=weaknesses, questions=questions,
            score=score, scale_max=config.review_scale_max,
            summary=output.summary.strip() or "Assessment of methodological and empirical support in the current manuscript.",
            round=round,
        )


class RebuttalPlanner(BaseAgent):
    NAME = "rebuttal_planner"
    task = "review.rebuttal_plan"
    role = "rebuttal"

    async def plan(self, review: Review, *, n: int) -> list[RebuttalTask]:
        """Turn review questions into exactly n executable supplementary tasks (§3.5)."""

        if n < 0:
            raise ValueError("n must be non-negative")
        if n == 0:
            return []
        output = await self.ask(
            RebuttalPlanBatch,
            user=(
                "Turn reviewer questions into exactly n executable supplementary experiments using "
                "the validated C_best without replacing the core method. For each return an id, original "
                "question, targeted plan, and a concrete experiment string specifying control, intervention, "
                "datasets/splits, fixed seeds, measured metrics, and output logs. A prose rebuttal is not "
                "an experiment. Each task must answer a reviewer query.\n"
                + self.ctx.guidance() + "\n"
                + json.dumps({"review": review.model_dump(mode="json"), "n": n,
                              "datasets": self.ctx.problem.datasets,
                              "metrics": [spec.model_dump(mode="json") for spec in self.ctx.problem.metrics],
                              "seed": self.ctx.config.seed}, sort_keys=True)
            ),
            n=n,
            manuscript_id=review.manuscript_id,
        )
        questions = _nonempty(review.questions) or _nonempty(review.weaknesses) or [
            "Does the proposed core mechanism improve on the reproduced baseline under matched evaluation?"
        ]
        metrics = ", ".join(spec.name for spec in self.ctx.problem.metrics) or "all manuscript metrics"
        datasets = ", ".join(self.ctx.problem.datasets) or "the full benchmark datasets"
        tasks: list[RebuttalTask] = []
        for index in range(n):
            question = questions[index % len(questions)]
            proposed = output.tasks[index] if index < len(output.tasks) else None
            identifier = f"{review.manuscript_id or 'paper'}-rebuttal-{index + 1}"
            seed = self.ctx.config.seed + index * 3
            experiment = (
                f"In an isolated copy of validated C_best, implement a controlled test answering: {question} "
                f"Evaluate the complete method, the reproduced human baseline and the targeted component "
                f"intervention on {datasets} using identical held-out splits and seeds [{seed}, {seed + 1}, {seed + 2}]. "
                f"Hold training/data budgets and all unrelated components fixed; measure {metrics} for each "
                f"condition, report per-seed values and mean differences, and save metrics/logs to "
                f"rebuttal/{identifier}.json. Do not adopt a changed core method."
            )
            if proposed is not None and proposed.experiment.strip():
                experiment = proposed.experiment.strip() + "\n" + experiment
            tasks.append(RebuttalTask(
                id=identifier, question=question,
                plan=(proposed.plan.strip() if proposed is not None else "") or f"Resolve reviewer query through matched measurements: {question}",
                experiment=experiment,
            ))
        return tasks


class MetaReviewer(BaseAgent):
    NAME = "meta_reviewer"
    task = "review.meta"

    async def decide(self, manuscript: Manuscript, review: Review, *, round: int = 0) -> MetaReview:
        """Accept only above the score gate with an auditable manuscript (§3.6).

        Every refine carries an algorithmic/empirical engineering instruction;
        an editorial complaint alone never triggers core-method replacement.
        """

        config = self.ctx.config
        violations = validate_manuscript(manuscript, config, self.ctx.problem)
        output = await self.ask(
            MetaReview,
            user=(
                "Assess this manuscript alongside its current peer review against the venue bar. "
                "Return decision accept or refine, critique and score. Accept requires peer score >= "
                f"{config.review_threshold} AND no structural/evidence violations. Refine must identify "
                "an algorithmic or empirical weakness, with a concrete method change and measurements "
                "to repeat; wording or presentation alone is not a refinement strategy.\n"
                + self.ctx.guidance() + "\n"
                + json.dumps({"manuscript": manuscript.model_dump(mode="json"),
                              "review": review.model_dump(mode="json"),
                              "structural_violations": violations}, sort_keys=True)
            ),
            manuscript_id=manuscript.id,
            round=round,
        )
        valid_score = (math.isfinite(review.score) and 1 <= review.score <= config.review_scale_max
                       and review.score >= config.review_threshold)
        matching_review = not review.manuscript_id or review.manuscript_id == manuscript.id
        accept = output.decision == "accept" and valid_score and matching_review and not violations
        critique = output.critique.strip()
        if not accept:
            metrics = ", ".join(spec.name for spec in self.ctx.problem.metrics) or "the claimed benchmark metrics"
            weaknesses = "; ".join(_nonempty(review.weaknesses))
            reasons = "; ".join(violations)
            instruction = (
                "Empirical weakness: the core mechanism's independent contribution and robust advantage "
                "over the reproduced baseline are not yet established to the venue bar. Simplify or "
                f"replace the unsupported component and re-measure {metrics} on the full benchmark with "
                "matched splits/seeds plus component ablations; adopt only after strict measured improvement."
            )
            if weaknesses:
                instruction += f" Reviewer concerns: {weaknesses}"
            if reasons:
                instruction += f" Evidence/coverage deficiencies: {reasons}"
            if not matching_review:
                instruction += " The supplied review is for a different manuscript; repeat peer evaluation."
            critique = f"{critique}\n{instruction}".strip()
        return MetaReview(
            decision="accept" if accept else "refine",
            critique=critique or "The manuscript clears the empirical, structural and peer-review gates.",
            score=_bounded_score(review.score, config.review_scale_max), round=round,
        )
