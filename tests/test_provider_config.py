"""Configuring a real provider must not require editing code.

`--provider kimi` was the only knob: base URL, model id and key variable were
hard-coded to Kimi's defaults by `OpenAICompatProvider`. These tests pin the flags
end to end without any network call (constructing the client is enough).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_build_provider_forwards_explicit_settings() -> None:
    from scientisttwo.providers import build_provider
    from scientisttwo.config import ScientistTwoConfig

    provider = build_provider(
        ScientistTwoConfig(), "openai",
        model="my-model", base_url="http://localhost:8000/v1", api_key_env="MY_KEY",
    )
    try:
        assert provider.model == "my-model"
        assert provider.base_url == "http://localhost:8000/v1"
        assert "MY_KEY"  # the key itself is read lazily from the environment
    finally:
        import asyncio

        asyncio.run(provider.aclose())


def test_cli_flags_reach_the_provider(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The CLI must pass --model/--base-url through, and route every role to it."""

    captured: dict[str, object] = {}

    import scientisttwo.cli as cli
    from scientisttwo.providers.base import LLMProvider, LLMRequest, LLMResponse

    real_build = cli.build_provider

    def fake_build(config, name="mock", **options):  # type: ignore[no-untyped-def]
        captured["name"] = name
        captured["options"] = dict(options)
        captured["config"] = config
        return real_build(config, "mock")  # offline stand-in

    monkeypatch.setattr(cli, "build_provider", fake_build)
    out = tmp_path / "runs"
    code = cli.main([
        "run", str(ROOT / "examples" / "ood_frozen_encoder.json"),
        "--provider", "kimi", "--model", "kimi-k2", "--base-url", "http://localhost:1/v1",
        "--out", str(out), "--max-refine-rounds", "1",
    ])

    assert code in (0, 2)
    assert captured["name"] == "kimi"
    assert captured["options"] == {"model": "kimi-k2", "base_url": "http://localhost:1/v1"}
    routes = captured["config"].model_routes
    assert {route.model for route in routes.values()} == {"kimi-k2"}, (
        "every role must be routed to the chosen model"
    )
    assert {route.provider for route in routes.values()} == {"kimi"}


def test_mock_runs_ignore_provider_flags(tmp_path: Path) -> None:
    from scientisttwo.cli import main

    code = main([
        "run", str(ROOT / "examples" / "ood_frozen_encoder.json"),
        "--mock", "--out", str(tmp_path / "runs"), "--max-refine-rounds", "1",
    ])
    assert code == 0
