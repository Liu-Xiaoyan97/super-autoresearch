"""Provider factory: ``mock`` (offline) or ``openai_compat`` (Kimi/vLLM/OpenAI)."""

from __future__ import annotations

from typing import Any

from ..config import ScientistTwoConfig
from .base import LLMError, LLMProvider, LLMRequest, LLMResponse

__all__ = ["build_provider", "LLMProvider", "LLMRequest", "LLMResponse", "LLMError"]


def build_provider(config: ScientistTwoConfig, name: str = "mock", **options: Any) -> LLMProvider:
    if name == "mock":
        from .mock import MockLLMProvider

        return MockLLMProvider(seed=config.seed, **options)
    if name in {"openai", "kimi", "openai_compat"}:
        from .openai_compat import OpenAICompatProvider

        return OpenAICompatProvider(**options)
    raise ValueError(f"Unknown provider {name!r}; valid names: mock, openai, kimi, openai_compat")
