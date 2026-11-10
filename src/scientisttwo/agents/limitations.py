"""§3.1 — iterative, guidance-aware extraction and verification of limitations."""

from __future__ import annotations

import json
import unicodedata

from pydantic import BaseModel, Field

from ..types import Decision, Limitation, Verdict
from .base import BaseAgent

__all__ = ["LimitationBatch", "LimitationExtractor", "LimitationVerifier"]


class LimitationBatch(BaseModel):
    """Default-constructible §3.1 extraction response."""

    limitations: list[Limitation] = Field(default_factory=list)
    rationale: str = ""


def _normalized(text: str) -> str:
    """Canonicalize text for the expanding, duplicate-free §3.1 pool."""

    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


class LimitationExtractor(BaseAgent):
    NAME = "limitation_extractor"
    task = "limitations.extract"

    async def extract(
        self,
        *,
        round: int = 0,
        existing: list[Limitation] | None = None,
    ) -> list[Limitation]:
        """Expand the §3.1 pool, respecting G1 and forbidden approaches.

        IDs and NFKC/case/whitespace-normalized text are both deduplicated,
        including duplicates inside a single provider response.
        """

        previous = sorted(existing or [], key=lambda item: (item.id, _normalized(item.text)))
        forbidden = sorted(self.ctx.problem.forbidden)
        prompt = (
            "Extract new, actionable limitations of the source method (§3.1). "
            "Expand the existing set; never repeat its IDs or normalized text. "
            "Only suggest limitations whose remedies are in scope. Do not propose "
            "or depend on any forbidden approach.\n"
            f"Problem: {self.ctx.problem.statement}\n"
            f"Source: {self.ctx.problem.source_paper}\n"
            f"Constraints: {json.dumps(sorted(self.ctx.problem.constraints))}\n"
            f"Forbidden approaches: {json.dumps(forbidden)}\n"
            f"Existing: {json.dumps([item.model_dump(mode='json') for item in previous], sort_keys=True)}\n"
            f"Guidance:\n{self.ctx.guidance()}"
        )
        batch = await self.ask(
            LimitationBatch,
            user=prompt,
            n=max(1, self.ctx.config.min_limitations - len(previous)),
            round=round,
            existing_ids=sorted(item.id for item in previous),
        )
        seen_ids = {item.id for item in previous}
        seen_text = {_normalized(item.text) for item in previous}
        banned = sorted(filter(None, (_normalized(text) for text in forbidden)))
        new: list[Limitation] = []
        for item in sorted(batch.limitations, key=lambda item: (item.id, _normalized(item.text))):
            text = _normalized(item.text)
            if not text or item.id in seen_ids or text in seen_text:
                continue
            if any(phrase in text for phrase in banned):
                continue
            seen_ids.add(item.id)
            seen_text.add(text)
            new.append(item)
        return new


class LimitationVerifier(BaseAgent):
    NAME = "limitation_verifier"
    task = "limitations.verify"

    async def verify(
        self,
        limitations: list[Limitation],
        *,
        round: int = 0,
    ) -> Verdict:
        """Verify §3.1 sufficiency; the configured floor cannot be LLM-overridden.

        Guidance is deliberately excluded from this critic's system prompt (G1).
        The 16-round extraction cap belongs to the orchestrator, not this agent.
        """

        verdict = await self.ask(
            Verdict,
            system=(
                "You are the Limitation Verifier (§3.1). Judge whether the set "
                "is sufficient to guide novel improvements. Return GOOD if "
                "sufficient, REFINE with missing actionable axes otherwise."
            ),
            user=json.dumps(
                {
                    "problem": self.ctx.problem.statement,
                    "minimum": self.ctx.config.min_limitations,
                    "limitations": [item.model_dump(mode="json") for item in
                                    sorted(limitations, key=lambda item: item.id)],
                },
                sort_keys=True,
            ),
            round=round,
        )
        if len(limitations) < self.ctx.config.min_limitations:
            return verdict.model_copy(update={
                "decision": Decision.REFINE,
                "feedback": f"Need at least {self.ctx.config.min_limitations} limitations. "
                            + verdict.feedback,
            })
        return verdict.model_copy(update={
            "decision": Decision.GOOD if verdict.accepted else Decision.REFINE,
        })
