"""Shared offline test helpers; no pytest-asyncio or network dependency."""

from __future__ import annotations

import io
from collections.abc import Callable, Sequence
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

import pytest

from scientisttwo.config import ScientistTwoConfig


def make_config(**over: Any) -> ScientistTwoConfig:
    return ScientistTwoConfig(**over)


def run_cli(args: Sequence[str]) -> tuple[int, str, str]:
    from scientisttwo.cli import main

    stdout, stderr = io.StringIO(), io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        try:
            code = main(args)
        except SystemExit as exc:
            code = int(exc.code or 0)
    return code, stdout.getvalue(), stderr.getvalue()


@pytest.fixture
def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


@pytest.fixture
def fixture_path(repo_root: Path) -> Callable[[str], Path]:
    def locate(name: str) -> Path:
        return repo_root / "examples" / (name if name.endswith(".json") else f"{name}.json")

    return locate


@pytest.fixture(name="run_cli")
def _run_cli_fixture() -> Callable[[Sequence[str]], tuple[int, str, str]]:
    return run_cli


@pytest.fixture(name="make_config")
def _make_config_fixture() -> Callable[..., ScientistTwoConfig]:
    return make_config
