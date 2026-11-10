"""Optional OpenAI-compatible transport (Kimi, vLLM, or local endpoints)."""

from __future__ import annotations

import os
import time
from typing import Any

from .base import LLMError, LLMProvider, LLMRequest, LLMResponse

__all__ = ["OpenAICompatProvider"]


class OpenAICompatProvider(LLMProvider):
    name = "openai_compat"

    def __init__(
        self, *, api_key: str | None = None, api_key_env: str = "KIMI_API_KEY",
        base_url: str = "https://api.moonshot.cn/v1", model: str = "kimi-k2-0905-preview",
        timeout: float = 120.0,
    ) -> None:
        super().__init__()
        try:
            import httpx
        except ImportError as exc:
            raise LLMError("OpenAI-compatible providers require optional dependency httpx") from exc
        self.base_url = base_url.rstrip("/")
        self.model = model
        key = api_key if api_key is not None else os.environ.get(api_key_env, "")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        self._client = httpx.AsyncClient(headers=headers, timeout=timeout)

    async def complete(self, req: LLMRequest) -> LLMResponse:
        messages: list[dict[str, str]] = []
        if req.system:
            messages.append({"role": "system", "content": req.system})
        messages.append({"role": "user", "content": req.user})
        payload: dict[str, Any] = {
            "model": req.model or self.model,
            "messages": messages,
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        if req.schema_name:
            payload["response_format"] = {"type": "json_object"}
        started = time.monotonic()
        try:
            response = await self._client.post(f"{self.base_url}/chat/completions", json=payload)
            response.raise_for_status()
            data = response.json()
            text = data["choices"][0]["message"]["content"] or ""
            usage = {key: int(value) for key, value in data.get("usage", {}).items() if isinstance(value, (int, float))}
            return LLMResponse(
                text=text, model=data.get("model", req.model or self.model),
                usage=usage, latency_s=time.monotonic() - started, raw=data,
            )
        except Exception as exc:
            raise LLMError(f"OpenAI-compatible completion failed ({self.base_url}): {exc}") from exc

    async def aclose(self) -> None:
        await self._client.aclose()
