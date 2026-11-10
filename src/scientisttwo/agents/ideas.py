"""§3.1/§3.3 — guided seed generation, novelty ranking, and trace evolution."""

from __future__ import annotations

import json
import math
import unicodedata

from pydantic import BaseModel, Field

from ..config import ScientistTwoConfig
from ..types import Idea, Limitation, Problem, Trace
from .base import BaseAgent

__all__ = [
    "IdeaBatch", "IdeaLibrary", "rank_key", "filter_by_guidance",
    "InitialIdeaGenerator", "NoveltyChecker", "IdeaGenerator", "IdeaEvolver",
]


class IdeaBatch(BaseModel):
    """Default-constructible generation response (§3.1/§3.3)."""

    ideas: list[Idea] = Field(default_factory=list)
    rationale: str = ""


class IdeaLibrary(BaseModel):
    """Novelty check and retrieved references (§3.1, Appendix A.2)."""

    idea: Idea | None = None
    novelty_score: float = 0.0
    domain_fit: float = 0.0
    direction_ids: list[str] = Field(default_factory=list)
    novelty_refs: list[str] = Field(default_factory=list)
    closest_prior_work: str = ""


def rank_key(idea: Idea, guidance_weight: float) -> float:
    """Descending ranking score (SPEC G2); weight zero gives paper novelty only."""

    return idea.novelty_score + guidance_weight * idea.domain_fit


def _is_synthetic(ctx, idea_id: str) -> bool:
    """True when the id came from the offline provider's synthesizer.

    The mock invents ids like ``ideas-expand-103fd03a-0``; real models (and the
    scripted fixtures the tests use) supply domain ids such as ``h2``. Only the
    former are normalised, so scripted ids keep their meaning.
    """

    if getattr(ctx.llm, "name", "") != "mock":
        return False
    return idea_id.startswith(("ideas-", "idea-")) or "-ideas-" in idea_id


def _normalize_ids(ctx, ideas, *, prefix: str, base: int):
    """Give provider-generated ideas readable, collision-free trace ids (§3.1/§3.3)."""

    counter = int(ctx.scratch.get("idea_id_seq", max(base - 1, 0)))
    out = []
    for idea in ideas:
        if _is_synthetic(ctx, idea.id):
            counter += 1
            idea = idea.model_copy(update={"id": f"{prefix}{counter}"})
        out.append(idea)
    ctx.scratch["idea_id_seq"] = counter
    return out


def filter_by_guidance(
    ideas: list[Idea], problem: Problem, config: ScientistTwoConfig,
) -> list[Idea]:
    """Apply SPEC G3/G4 without altering any empirical comparison.

    G4 requires intersection with at least one positive-weight hard direction,
    not every hard direction. Explicit ID sorting makes ties reproducible.
    """

    hard_ids = {direction.id for direction in problem.hard_directions()}
    return [
        idea for idea in sorted(ideas, key=lambda item: item.id)
        if (not problem.directions or idea.domain_fit >= config.min_domain_fit)
        and (not config.strict_directions or not hard_ids
             or bool(hard_ids.intersection(idea.direction_ids)))
    ]


def _text_key(text: str) -> str:
    """Normalize hypotheses when expanding the distinct §3.1/§3.3 pool."""

    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _distinct(ideas: list[Idea], existing: list[Idea], n: int) -> list[Idea]:
    """Keep at most n distinct hypotheses and IDs (§3.1)."""

    ids = {idea.id for idea in existing}
    hypotheses = {_text_key(idea.hypothesis) for idea in existing}
    result: list[Idea] = []
    for idea in sorted(ideas, key=lambda item: (item.id, _text_key(item.hypothesis))):
        key = _text_key(idea.hypothesis)
        if len(result) >= max(0, n):
            break
        if not key or idea.id in ids or key in hypotheses:
            continue
        result.append(idea)
        ids.add(idea.id)
        hypotheses.add(key)
    return result


def _unit(value: float) -> float:
    """Bound model-provided alignment/novelty scores (SPEC G2)."""

    return min(1.0, max(0.0, value)) if math.isfinite(value) else 0.0


class InitialIdeaGenerator(BaseAgent):
    NAME = "initial_idea_generator"
    task = "ideas.initial"

    async def generate(self, limitations: list[Limitation]) -> Idea:
        """Generate h0 targeting a diagnosed weakness (§3.1, SPEC G1)."""

        # Idea has required fields, so it is returned inside the defaultable
        # IdeaBatch envelope (SPEC §4: envelopes default-construct, domain models
        # may require fields).
        batch = await self.ask(
            IdeaBatch,
            user=(
                "Generate exactly one initial idea h0, with a testable hypothesis "
                "and concrete mechanism addressing the limitations. Record target_limitations "
                "and direction_ids. Never use a forbidden approach.\n"
                f"Problem: {self.ctx.problem.statement}\n"
                f"Limitations: {json.dumps([item.model_dump(mode='json') for item in sorted(limitations, key=lambda item: item.id)], sort_keys=True)}\n"
                f"Forbidden: {json.dumps(sorted(self.ctx.problem.forbidden))}\n"
                f"Guidance:\n{self.ctx.guidance()}"
            ),
            n=1,
            prefix="h",
            round=0,
        )
        ideas = sorted(batch.ideas, key=lambda item: item.id)
        initial = ideas[0] if ideas else Idea(id="h0", hypothesis="")
        return initial.model_copy(update={"id": "h0", "origin": "seed", "round": 0})


class NoveltyChecker(BaseAgent):
    NAME = "novelty_checker"
    task = "ideas.novelty"

    async def score(self, idea: Idea, *, round: int = 0) -> Idea:
        """Score novelty/alignment and record exactly N_ref slots (§3.1, A.2).

        An unavailable reference is explicitly marked, never fabricated as a
        publication. Such slots do not establish a scientific novelty claim.
        """

        count = self.ctx.config.novelty_refs
        library = await self.ask(
            IdeaLibrary,
            user=(
                "Evaluate novelty against prior literature and domain alignment, "
                "both in [0,1]. Return the scored idea and top-level novelty_score, "
                "domain_fit, direction_ids and novelty_refs. "
                f"Retrieve exactly {count} relevant reference papers; never invent citations.\n"
                f"Idea: {idea.model_dump_json()}\nGuidance:\n{self.ctx.guidance()}"
            ),
            n=count,
            novelty_refs=count,
            idea_id=idea.id,
            round=round,
        )
        scored = library.idea
        fields = library.model_fields_set
        novelty = library.novelty_score if "novelty_score" in fields or scored is None else scored.novelty_score
        fit = library.domain_fit if "domain_fit" in fields or scored is None else scored.domain_fit
        directions = library.direction_ids if "direction_ids" in fields or scored is None else scored.direction_ids
        refs = library.novelty_refs if "novelty_refs" in fields or scored is None else scored.novelty_refs
        refs = sorted({ref.strip() for ref in refs if ref.strip()})[:count]
        # CONTRACT-GAP: the provider contract has no retrieval tool or reference
        # availability field. Preserve required cardinality with explicit missing
        # reference slots rather than hallucinated paper titles/URLs.
        refs.extend(f"Reference unavailable (slot {index + 1})" for index in range(len(refs), count))
        valid_directions = {direction.id for direction in self.ctx.problem.directions}
        return idea.model_copy(update={
            "novelty_score": _unit(novelty),
            "domain_fit": _unit(fit),
            "novelty_refs": refs,
            "direction_ids": sorted(valid_directions.intersection(directions)),
        })


class IdeaGenerator(BaseAgent):
    NAME = "idea_generator"
    task = "ideas.expand"

    async def generate(
        self, *, limitations: list[Limitation], existing: list[Idea], n: int,
    ) -> list[Idea]:
        """Expand with distinct, higher-novelty seeds (§3.1; generation-only G1)."""

        if n <= 0:
            return []
        batch = await self.ask(
            IdeaBatch,
            user=(
                f"Propose {n} distinct, higher-novelty testable ideas with unique IDs. "
                "Do not repeat existing hypotheses or IDs. Address limitations, "
                "supply direction_ids, and avoid all forbidden approaches.\n"
                f"Problem: {self.ctx.problem.statement}\n"
                f"Limitations: {json.dumps([item.model_dump(mode='json') for item in sorted(limitations, key=lambda item: item.id)], sort_keys=True)}\n"
                f"Existing: {json.dumps([item.model_dump(mode='json') for item in sorted(existing, key=lambda item: item.id)], sort_keys=True)}\n"
                f"Forbidden: {json.dumps(sorted(self.ctx.problem.forbidden))}\n"
                f"Guidance:\n{self.ctx.guidance()}"
            ),
            n=n,
            prefix="h",
            offset=len(existing),
            existing_ids=sorted(idea.id for idea in existing),
        )
        return [idea.model_copy(update={"origin": "seed", "round": 0})
                for idea in _normalize_ids(
                    self.ctx, _distinct(batch.ideas, existing, n), prefix="h", base=len(existing)
                )]


class IdeaEvolver(BaseAgent):
    NAME = "idea_evolver"
    task = "ideas.evolve"

    async def evolve(self, *, traces: list[Trace], n: int, round: int) -> list[Idea]:
        """Learn from BOTH successful and failed traces (§3.3, eq. 3).

        Every trace includes its metrics, feedback, and intermediate evidence.
        Guidance is fully absent (including system prompt) when disabled.
        """

        if n <= 0:
            return []
        ordered = sorted(traces, key=lambda trace: (trace.round, trace.idea.id))
        successful = [trace.model_dump(mode="json") for trace in ordered if trace.succeeded]
        failed = [trace.model_dump(mode="json") for trace in ordered if not trace.succeeded]
        prompt = (
            f"Evolve {n} new hypotheses in round {round} from ALL historical traces. "
            "Amalgamate successful mechanisms and diagnose failures using measured "
            "metrics and feedback. Supply unique IDs, parent_ids and direction_ids.\n"
            f"Problem: {self.ctx.problem.statement}\n"
            f"Successful traces (metrics + feedback): {json.dumps(successful, sort_keys=True)}\n"
            f"Failed traces (metrics + feedback): {json.dumps(failed, sort_keys=True)}\n"
            f"Forbidden approaches: {json.dumps(sorted(self.ctx.problem.forbidden))}"
        )
        if self.ctx.config.guidance_in_evolution:
            prompt += f"\nGuidance:\n{self.ctx.guidance()}"
        batch = await self.ask(
            IdeaBatch,
            system="You are the Idea Evolver (§3.3). Propose empirical improvements from execution traces.",
            user=prompt,
            n=n,
            prefix=f"e{round}",
            round=round,
            existing_ids=sorted(trace.idea.id for trace in ordered),
        )
        return [idea.model_copy(update={"origin": "evolved", "round": round})
                for idea in _normalize_ids(
                    self.ctx, _distinct(batch.ideas, [trace.idea for trace in ordered], n),
                    prefix=f"e{round}-", base=0,
                )]
