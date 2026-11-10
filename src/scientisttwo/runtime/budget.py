"""Hard budget accounting. Every agent call and every experiment is charged."""

from __future__ import annotations

import time
from typing import Any

__all__ = ["Budget", "BudgetExceeded"]


class BudgetExceeded(RuntimeError):
    """Raised when a hard stop in ``ScientistTwoConfig`` is hit."""


class Budget:
    def __init__(
        self,
        *,
        max_llm_calls: int = 10_000,
        max_experiments: int = 10_000,
        max_wall_time_s: float = 86_400.0,
    ) -> None:
        self.max_llm_calls = max_llm_calls
        self.max_experiments = max_experiments
        self.max_wall_time_s = max_wall_time_s
        self.llm_calls = 0
        self.experiments = 0
        self.started = time.monotonic()

    # ------------------------------------------------------------------ charge
    def charge_llm(self, n: int = 1) -> None:
        self.llm_calls += n
        self.check()

    def charge_experiment(self, n: int = 1) -> None:
        self.experiments += n
        self.check()

    # ------------------------------------------------------------------ state
    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def exhausted(self) -> str | None:
        if self.llm_calls >= self.max_llm_calls:
            return f"max_llm_calls={self.max_llm_calls}"
        if self.experiments >= self.max_experiments:
            return f"max_experiments={self.max_experiments}"
        if self.elapsed >= self.max_wall_time_s:
            return f"max_wall_time_s={self.max_wall_time_s}"
        return None

    def check(self) -> None:
        reason = self.exhausted()
        if reason:
            raise BudgetExceeded(reason)

    def snapshot(self) -> dict[str, Any]:
        return {
            "llm_calls": self.llm_calls,
            "experiments": self.experiments,
            "elapsed_s": round(self.elapsed, 3),
            "limits": {
                "max_llm_calls": self.max_llm_calls,
                "max_experiments": self.max_experiments,
                "max_wall_time_s": self.max_wall_time_s,
            },
        }
