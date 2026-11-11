"""Offline synthesis, scripts, and cross-process reproducibility."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal

import pytest
from pydantic import BaseModel, Field, ValidationError

from scientisttwo.config import ScientistTwoConfig
from scientisttwo.providers import build_provider
from scientisttwo.providers.base import LLMError, LLMRequest
from scientisttwo.providers.mock import MockLLMProvider
from scientisttwo.types import Idea, MetaReview, Review, Verdict


class Item(BaseModel):
    id: str
    hypothesis: str
    gain: float = Field(ge=2.0, le=3.0)
    probability: float = Field(ge=-0.2, le=-0.1)


class Batch(BaseModel):
    items: list[Item] = Field(default_factory=list)
    rationale: str = ""


class Judgment(BaseModel):
    decision: Literal["accept", "refine"] = "accept"
    feedback: str = ""


def test_structured_deterministic_and_unique() -> None:
    async def run() -> None:
        left, right = MockLLMProvider(seed=19), MockLLMProvider(seed=19)
        req = LLMRequest(task="brand.new.task", meta={"n": 4, "round": 2})
        outputs = [await left.structured(req, Batch) for _ in range(3)]
        repeated = [await right.structured(req, Batch) for _ in range(3)]
        assert outputs == repeated
        assert all(len(batch.items) == 4 for batch in outputs)
        ids = [item.id for batch in outputs for item in batch.items]
        assert len(ids) == len(set(ids))
        assert all(item.hypothesis and 2 <= item.gain <= 3 and -0.2 <= item.probability <= -0.1
                   for batch in outputs for item in batch.items)
        assert all(batch.rationale for batch in outputs)
        assert left.count(req.task) == 3
        assert left.count("missing") == 0
        assert left.last(req.task).meta == req.meta  # type: ignore[union-attr]
        assert left.last("missing") is None
        assert left.calls[0].schema_name == "Batch"

    asyncio.run(run())


def test_independent_python_processes(repo_root: Path) -> None:
    program = '''
import asyncio, json
from pydantic import create_model
from scientisttwo.providers.mock import MockLLMProvider
from scientisttwo.providers.base import LLMRequest
from scientisttwo.types import Idea, MetaReview
Batch = create_model("Batch", ideas=(list[Idea], []))
async def main():
    provider = MockLLMProvider(seed=23)
    out = []
    for i in range(3):
        req = LLMRequest(task="unknown.ideas", meta={"n": 3, "round": i})
        out.append((await provider.structured(req, Batch)).model_dump(mode="json"))
        out.append((await provider.structured(LLMRequest(task="review.meta"), MetaReview)).model_dump(mode="json"))
    print(json.dumps(out, sort_keys=True))
asyncio.run(main())
'''
    results: list[str] = []
    for hash_seed in ("1", "731"):
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"), "PYTHONHASHSEED": hash_seed}
        results.append(subprocess.check_output([sys.executable, "-c", program], env=env, text=True))
    assert results[0] == results[1]
    assert len(json.loads(results[0])) == 6


def test_list_length_zero_and_required_domain_fields() -> None:
    async def run() -> None:
        provider = MockLLMProvider()
        empty = await provider.structured(LLMRequest(task="empty", meta={"n": 0}), Batch)
        assert empty.items == []
        idea = await provider.structured(LLMRequest(task="unregistered"), Idea)
        assert idea.id and idea.hypothesis and idea.mechanism
        response = await provider.complete(LLMRequest(task="unknown.raw", schema_name="Anything"))
        assert json.loads(response.text) == {}

    asyncio.run(run())


def test_decisions_cycle_within_schema() -> None:
    async def run() -> None:
        provider = MockLLMProvider()
        judgments = [await provider.structured(LLMRequest(task="judge"), Judgment) for _ in range(4)]
        assert [out.decision for out in judgments] == ["refine", "accept", "refine", "accept"]
        verdicts = [await provider.structured(LLMRequest(task="critic"), Verdict) for _ in range(3)]
        assert len({out.decision for out in verdicts}) > 1
        assert all(out.feedback for out in verdicts)
        meta = await provider.structured(LLMRequest(task="meta"), MetaReview)
        assert meta.decision in {"accept", "refine"}

    asyncio.run(run())


def test_scripted_override_and_dynamic_hook() -> None:
    async def run() -> None:
        provider = MockLLMProvider(script={
            "judge": [{"decision": "accept", "feedback": "pinned"}, {"decision": "refine"}],
            "idea": {"id": "pinned-id", "hypothesis": "pinned hypothesis"},
        })
        first = await provider.structured(LLMRequest(task="judge"), Judgment)
        assert first.feedback == "pinned" and first.decision == "accept"
        assert (await provider.structured(LLMRequest(task="judge"), Judgment)).decision == "refine"
        assert (await provider.structured(LLMRequest(task="judge"), Judgment)).decision == "refine"
        assert (await provider.structured(LLMRequest(task="idea"), Idea)).id == "pinned-id"
        provider.script_dynamic = lambda req: {"decision": "accept", "feedback": req.task}
        assert (await provider.structured(LLMRequest(task="judge"), Judgment)).feedback == "judge"

        async def dynamic(req: LLMRequest) -> dict[str, str] | None:
            return {"decision": "refine"} if req.meta.get("dynamic") else None

        provider.script_dynamic = dynamic
        assert (await provider.structured(LLMRequest(task="judge", meta={"dynamic": True}), Judgment)).decision == "refine"
        provider.script_dynamic = None
        assert provider.count("judge") == 5
        assert provider.last("idea").task == "idea"  # type: ignore[union-attr]

    asyncio.run(run())


def test_scripts_are_validated() -> None:
    provider = MockLLMProvider({"bad": {"decision": "not-an-allowed-value"}})
    with pytest.raises(ValidationError):
        asyncio.run(provider.structured(LLMRequest(task="bad"), Judgment))


def test_synthesis_never_opens_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("offline provider attempted networking")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)

    async def run() -> None:
        provider = build_provider(ScientistTwoConfig(seed=7))
        assert isinstance(provider, MockLLMProvider)
        result = await provider.structured(LLMRequest(task="unknown.review"), Review)
        assert result.summary
        assert 1 <= result.score <= 10
        await provider.complete(LLMRequest(task="also.unknown"))

    asyncio.run(run())


def test_factory_rejects_unknown_provider(make_config: Callable[..., ScientistTwoConfig]) -> None:
    with pytest.raises(ValueError, match="mock, openai, kimi, openai_compat"):
        build_provider(make_config(), "missing")


def test_openai_module_does_not_import_httpx(repo_root: Path) -> None:
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
    program = "import sys; import scientisttwo.providers.openai_compat; assert 'httpx' not in sys.modules"
    subprocess.run([sys.executable, "-c", program], env=env, check=True)


def test_openai_compatible_transport_with_offline_client(monkeypatch: pytest.MonkeyPatch) -> None:
    from scientisttwo.providers.openai_compat import OpenAICompatProvider

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "model": "local-model", "choices": [{"message": {"content": '{"decision":"accept"}'}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            }

    class Client:
        def __init__(self, **options: Any) -> None:
            self.options = options
            self.posted: tuple[str, dict[str, Any]] | None = None
            self.closed = False
            self.fail = False

        async def post(self, url: str, *, json: dict[str, Any]) -> Response:
            self.posted = (url, json)
            if self.fail:
                raise OSError("offline transport failure")
            return Response()

        async def aclose(self) -> None:
            self.closed = True

    monkeypatch.setitem(sys.modules, "httpx", SimpleNamespace(AsyncClient=Client))
    monkeypatch.setenv("KIMI_API_KEY", "environment-key")

    async def run() -> None:
        provider = OpenAICompatProvider(base_url="http://localhost/v1/", model="configured-model")
        assert provider._client.options["headers"] == {"Authorization": "Bearer environment-key"}
        req = LLMRequest(task="judge", system="system", user="user")
        result = await provider.structured(req, Judgment)
        assert result.decision == "accept"
        url, payload = provider._client.posted
        assert url == "http://localhost/v1/chat/completions"
        assert payload["model"] == "configured-model"
        assert payload["response_format"] == {"type": "json_object"}
        assert payload["messages"][0] == {"role": "system", "content": "system"}
        provider._client.fail = True
        with pytest.raises(LLMError, match="offline transport failure"):
            await provider.complete(req)
        await provider.aclose()
        assert provider._client.closed
        explicit = OpenAICompatProvider(api_key="explicit-key")
        assert explicit._client.options["headers"] == {"Authorization": "Bearer explicit-key"}
        await explicit.aclose()

    asyncio.run(run())
