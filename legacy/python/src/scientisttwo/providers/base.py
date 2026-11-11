"""LLM provider contract (frozen).

Every agent talks to the world through a single ``LLMProvider``. ``task`` is the
stable dispatch key: the offline provider routes on it, and real providers use it
for routing/logging/telemetry.

Contract on schemas:

* top-level schemas passed to :meth:`LLMProvider.structured` must be constructible
  from ``{}`` (envelope models with defaults), so malformed model output degrades to
  a valid empty envelope instead of raising;
* nested domain models (``Idea``, ``Claim``, ...) may have required fields - the
  offline provider synthesizes them, and no agent may assume ``{}`` validates one.

A non-default-constructible top-level schema raises :class:`LLMError` on malformed
output, which is the signal that an envelope model is missing.
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Any, TypeVar

from pydantic import BaseModel, Field

__all__ = [
    "LLMRequest",
    "LLMResponse",
    "LLMProvider",
    "LLMError",
    "TModel",
    "extract_json",
]

TModel = TypeVar("TModel", bound=BaseModel)


class LLMError(RuntimeError):
    """Raised when a provider cannot produce a usable response."""


class LLMRequest(BaseModel):
    task: str
    system: str = ""
    user: str = ""
    model: str | None = None
    temperature: float = 0.2
    max_tokens: int = 8192
    schema_name: str | None = None
    """name of the expected output model, for providers with structured output"""
    meta: dict[str, Any] = Field(default_factory=dict)
    """free-form routing hints: ids, scope, round, ..."""


class LLMResponse(BaseModel):
    text: str = ""
    model: str = ""
    usage: dict[str, int] = Field(default_factory=dict)
    latency_s: float = 0.0
    raw: dict[str, Any] | None = None


_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.S)


def extract_json(text: str) -> Any:
    """Best-effort JSON extraction: fenced block, then first balanced object."""

    if not text:
        return None
    m = _JSON_BLOCK.search(text)
    candidate = m.group(1) if m else None
    if candidate is None:
        start = min((i for i in (text.find("{"), text.find("[")) if i >= 0), default=-1)
        if start < 0:
            return None
        depth = 0
        for i in range(start, len(text)):
            ch = text[i]
            if ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    break
    if candidate is None:
        return None
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


class LLMProvider(ABC):
    """Minimal provider interface. Subclasses implement ``complete`` only."""

    name: str = "base"

    def __init__(self, **kwargs: Any) -> None:
        self.options = kwargs

    @abstractmethod
    async def complete(self, req: LLMRequest) -> LLMResponse:
        """Return a raw completion (optionally JSON-formatted)."""

    async def structured(self, req: LLMRequest, schema: type[TModel]) -> TModel:
        """Return a validated ``schema`` instance.

        Contract: implementations must never raise on malformed model output if a
        default-constructed instance is valid; they fall back to defaults and set
        ``req.meta['fallback']``. Genuine transport errors raise ``LLMError``.
        """

        req = req.model_copy(update={"schema_name": schema.__name__})
        resp = await self.complete(req)
        data = extract_json(resp.text)
        if isinstance(data, dict):
            try:
                return schema.model_validate(data)
            except Exception:  # noqa: BLE001 - degrade, never crash the pipeline
                pass
        try:
            return schema.model_validate({})
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"cannot construct default {schema.__name__}: {exc}") from exc

    async def aclose(self) -> None:
        return None
