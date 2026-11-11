"""Shared agent scaffolding.

Every stage of the pipeline is one agent object. Agents are stateless with respect
to the research problem: all mutable state lives in
:class:`scientisttwo.core.state.ResearchState` and in the stores, so a stage can be
replayed or unit-tested in isolation.
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass, field
from typing import Any, ClassVar, TypeVar

from pydantic import BaseModel

from ..config import ScientistTwoConfig
from ..providers.base import LLMProvider, LLMRequest
from ..runtime.budget import Budget
from ..runtime.store import ArtifactStore, TraceStore
from ..runtime.workspace import Workspace
from ..types import Problem

__all__ = ["AgentContext", "BaseAgent", "TModel"]

TModel = TypeVar("TModel", bound=BaseModel)


@dataclass
class AgentContext:
    """Everything an agent may touch."""

    problem: Problem
    config: ScientistTwoConfig
    llm: LLMProvider
    workspace: Workspace
    store: ArtifactStore
    traces: TraceStore
    budget: Budget
    scratch: dict[str, Any] = field(default_factory=dict)

    # ------------------------------------------------------------------ helpers
    def guidance(self) -> str:
        """Domain + reference-direction block injected into generative prompts.

        [EXTENSION] Guidance only ever enters *generation*; critics get numbers.
        """

        return self.problem.direction_text()

    def guidance_active(self) -> bool:
        return bool(self.problem.directions)


class BaseAgent(ABC):
    """Root of every agent.

    Subclasses MUST set a unique ``task`` (mock dispatch key) and a ``role``
    (model routing key, see ``ScientistTwoConfig.route``).
    """

    NAME: ClassVar[str] = "agent"
    task: ClassVar[str] = "agent.task"
    role: ClassVar[str] = "default"

    def __init__(self, ctx: AgentContext) -> None:
        self.ctx = ctx

    # ------------------------------------------------------------------ llm
    async def ask(
        self,
        schema: type[TModel],
        *,
        user: str = "",
        system: str = "",
        **meta: Any,
    ) -> TModel:
        """Structured call. Always charges the budget and writes a trace record."""

        route = self.ctx.config.route(self.role)
        req = LLMRequest(
            task=self.task,
            system=system or self.system_prompt(),
            user=user,
            model=route.model,
            temperature=route.temperature,
            max_tokens=route.max_tokens,
            schema_name=schema.__name__,
            meta=meta,
        )
        self.ctx.budget.charge_llm()
        out = await self.ctx.llm.structured(req, schema)
        self.ctx.traces.append(
            "llm",
            {"agent": self.NAME, "task": self.task, "schema": schema.__name__, "meta": meta},
        )
        return out

    def system_prompt(self) -> str:
        """Default system prompt: role + domain/guidance block."""

        parts = [f"You are {self.NAME}, one agent inside the ScientistTwo research pipeline."]
        guidance = self.ctx.guidance()
        if guidance:
            parts.append(guidance)
        return "\n\n".join(parts)

    # ------------------------------------------------------------------ logging
    def log(self, kind: str, payload: Any = None, **extra: Any) -> None:
        self.ctx.traces.append(kind, {"agent": self.NAME, **(payload or {})}, **extra)
