"""Listing 1 acceptance, refinement, rejection, and exact critic-call budgets."""

from __future__ import annotations

import asyncio

import pytest

from scientisttwo.core.stage import StageResult, stage
from scientisttwo.types import Decision, Verdict


@pytest.mark.parametrize("decision", [Decision.GOOD, Decision.ACCEPT])
def test_accept_returns_current_candidate(decision: Decision) -> None:
    calls: list[int] = []

    async def critic(value: int) -> Verdict:
        calls.append(value)
        return Verdict(decision=decision)

    async def refine(value: int, feedback: str) -> int:
        raise AssertionError("Accepted candidates must not be refined")

    result = asyncio.run(stage(4, critic, refine, 3))
    assert isinstance(result, StageResult)
    assert result.accepted
    assert result.value == 4
    assert result.rounds == 1
    assert calls == [4]
    assert result.history == [result.verdict]
    assert result.verdict is not None and result.verdict.decision == decision


@pytest.mark.parametrize("decision", [Decision.REFINE, Decision.ENGINEER])
def test_refine_then_accept(decision: Decision) -> None:
    values: list[int] = []
    refinements: list[tuple[int, str]] = []

    async def critic(value: int) -> Verdict:
        values.append(value)
        return Verdict(decision=Decision.ACCEPT if value == 2 else decision, feedback="fix")

    async def refine(value: int, feedback: str) -> int:
        refinements.append((value, feedback))
        return value + 1

    result = asyncio.run(stage(1, critic, refine, 2))
    assert result.value == 2
    assert result.rounds == 2
    assert len(result.history) == 2
    assert [item.decision for item in result.history] == [decision, Decision.ACCEPT]
    assert values == [1, 2]
    assert refinements == [(1, "fix")]


def test_bad_discards_candidate_immediately() -> None:
    async def critic(value: str) -> Verdict:
        return Verdict(decision=Decision.BAD, feedback="dead end")

    async def refine(value: str, feedback: str) -> str:
        raise AssertionError("Bad candidates must not be refined")

    result = asyncio.run(stage("candidate", critic, refine, 8))
    assert not result.accepted
    assert result.value is None
    assert result.rounds == 1
    assert len(result.history) == 1
    assert result.verdict is not None and result.verdict.feedback == "dead end"


def test_exhaustion_refines_last_round_without_rechecking() -> None:
    checked: list[int] = []
    refined: list[int] = []

    async def critic(value: int) -> Verdict:
        checked.append(value)
        return Verdict(decision=Decision.REFINE)

    async def refine(value: int, feedback: str) -> int:
        refined.append(value)
        return value + 1

    result = asyncio.run(stage(0, critic, refine, 3))
    assert result.value is None
    assert not result.accepted
    assert result.rounds == 3
    assert len(result.history) == 3
    assert checked == [0, 1, 2]
    assert refined == [0, 1, 2]
    assert result.verdict == result.history[-1]


@pytest.mark.parametrize("rounds", [0, -1])
def test_empty_budget_does_not_call_agents(rounds: int) -> None:
    async def critic(value: int) -> Verdict:
        raise AssertionError("No critic budget")

    async def refine(value: int, feedback: str) -> int:
        raise AssertionError("No refinement budget")

    result = asyncio.run(stage(1, critic, refine, rounds))
    assert result.value is None
    assert result.verdict is None
    assert result.rounds == 0
    assert result.history == []


def test_infrastructure_errors_are_not_swallowed() -> None:
    async def critic(value: int) -> Verdict:
        raise RuntimeError("transport unavailable")

    async def refine(value: int, feedback: str) -> int:
        return value

    with pytest.raises(RuntimeError, match="transport unavailable"):
        asyncio.run(stage(0, critic, refine, 1))
