"""§3.2/§3.4/§3.6 bounded engineering: patches and actual execution only."""

from __future__ import annotations

import zlib

from pydantic import BaseModel

from ..types import Evidence, Idea, Scope
from .base import BaseAgent

__all__ = ["SubsetEngineer", "FullSetEngineer"]


class SubsetEngineeringPatch(BaseModel):
    patch: str = "Inspect implementation bugs and tune hyperparameters without changing the evaluation protocol."


class FullSetEngineeringPatch(BaseModel):
    patch: str = "Refine the mechanism to address the critique; preserve the benchmark protocol."
    hypothesis: str = ""
    mechanism: str = ""


class SubsetEngineer(BaseAgent):
    """One measured tuning pass for a promising subset candidate (§3.2)."""

    NAME = "subset_engineer"
    task = "engineer.subset"
    role = "coding"

    async def refine(self, idea: Idea, *, evidence: Evidence, feedback: str) -> Evidence:
        if evidence.code is None:
            raise ValueError("subset engineering requires a code snapshot")
        out = await self.ask(
            SubsetEngineeringPatch,
            user=f"{idea.model_dump_json()}\nCritique: {feedback}\n{evidence.model_dump_json()}",
            idea_id=idea.id,
        )
        repo = await self.ctx.workspace.write_patch(
            evidence.code, f"{out.patch}\nCritique: {feedback}\n", f"{idea.id}-subset-engineered",
        )
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, Scope.SUBSET, idea=idea)
        return Evidence(
            idea_id=idea.id, scope=Scope.SUBSET, metrics=result.metrics,
            baseline_metrics=dict(evidence.baseline_metrics), code=repo, result=result, label=repo.label,
        )


class FullSetEngineer(BaseAgent):
    """Produce a new hypothesis and full evidence, never adopt it (§3.2/§3.4)."""

    NAME = "full_set_engineer"
    task = "engineer.full"
    role = "coding"

    async def refine(
        self, idea: Idea, *, evidence: Evidence, feedback: str, reason: str = "ablation",
    ) -> tuple[Idea, Evidence]:
        if evidence.code is None:
            raise ValueError("full-set engineering requires a code snapshot")
        out = await self.ask(
            FullSetEngineeringPatch,
            user=f"{idea.model_dump_json()}\nReason: {reason}\nCritique: {feedback}\n"
                 f"{evidence.model_dump_json()}\n{self.ctx.guidance()}",
            idea_id=idea.id, reason=reason,
        )
        token = zlib.crc32(f"{evidence.code.label}|{reason}|{feedback}|{out.patch}".encode())
        refined = idea.model_copy(update={
            "id": f"{idea.id}-eng-{token:08x}",
            "hypothesis": out.hypothesis or idea.hypothesis,
            "mechanism": out.mechanism or f"{idea.mechanism}|{reason}:{token:08x}",
            "parent_ids": [idea.id], "notes": feedback,
        })
        repo = await self.ctx.workspace.write_patch(
            evidence.code, f"{out.patch}\nCritique: {feedback}\nMechanism: {refined.mechanism}\n",
            f"{refined.id}-full",
        )
        self.ctx.budget.charge_experiment()
        result = await self.ctx.workspace.run(repo, Scope.FULL, idea=refined)
        measured = Evidence(
            idea_id=refined.id, scope=Scope.FULL, metrics=result.metrics,
            baseline_metrics=dict(evidence.baseline_metrics), code=repo, result=result, label=repo.label,
        )
        return refined, measured
