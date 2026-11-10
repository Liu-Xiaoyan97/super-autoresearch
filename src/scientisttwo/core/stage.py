"""Listing 1 — the single control primitive of the whole system::

    def stage(candidate, critic, refine, max_rounds):
        for _ in range(max_rounds):
            verdict, feedback = critic(candidate)
            if verdict == "accept":
                return candidate
            elif verdict == "refine":
                candidate = refine(candidate, feedback)
            else:
                return None
        return None
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Generic, TypeVar

from ..types import Decision, Verdict

__all__ = ["StageResult", "stage"]


TCandidate = TypeVar("TCandidate")


@dataclass
class StageResult(Generic[TCandidate]):
    """Listing 1's optional artifact, with critic-call accounting for replay."""

    value: TCandidate | None
    verdict: Verdict | None = None
    rounds: int = 0
    history: list[Verdict] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return self.value is not None


async def stage(
    candidate: TCandidate,
    critic: Callable[[TCandidate], Awaitable[Verdict]],
    refine: Callable[[TCandidate, str], Awaitable[TCandidate]],
    max_rounds: int,
) -> StageResult[TCandidate]:
    """Generic critic/refine loop (paper Listing 1).

    Contract:

    * ``critic`` returns a :class:`~scientisttwo.types.Verdict`;
    * ``GOOD``/``ACCEPT`` ⇒ return the candidate immediately;
    * ``REFINE``/``ENGINEER`` ⇒ call ``refine(candidate, verdict.feedback)`` and loop;
    * ``BAD`` ⇒ return an empty :class:`StageResult` (candidate discarded);
    * after ``max_rounds`` iterations ⇒ empty result.

    Must be allocation-cheap, side-effect free, and log nothing itself: callers
    own tracing.
    """

    history: list[Verdict] = []
    for _ in range(max_rounds):
        verdict = await critic(candidate)
        history.append(verdict)
        if verdict.decision in (Decision.GOOD, Decision.ACCEPT):
            return StageResult(candidate, verdict, len(history), history)
        if verdict.decision in (Decision.REFINE, Decision.ENGINEER):
            candidate = await refine(candidate, verdict.feedback)
        else:
            return StageResult(None, verdict, len(history), history)
    return StageResult(None, history[-1] if history else None, len(history), history)
