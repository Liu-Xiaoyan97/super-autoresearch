"""Deterministic, schema-driven offline LLM provider (no network dependencies)."""

from __future__ import annotations

import inspect
import json
import random
import re
import types
import zlib
from collections import Counter
from collections.abc import Callable
from enum import Enum
from typing import Annotated, Any, Literal, Union, get_args, get_origin

from pydantic import BaseModel

from .base import LLMProvider, LLMRequest, LLMResponse, TModel

__all__ = ["MockLLMProvider"]


class MockLLMProvider(LLMProvider):
    """Synthesize arbitrary pydantic outputs, or replay task-keyed JSON scripts.

    Script lists are consumed in order; the last response is repeated after the
    list is exhausted. ``script_dynamic(req)`` may return a dict/model (or an
    awaitable of either); returning ``None`` delegates to the script/synthesizer.
    Identical seeds and call sequences produce identical results in any process.
    """

    name = "mock"

    def __init__(self, script: dict[str, Any] | None = None, seed: int = 7) -> None:
        super().__init__()
        self.script = script or {}
        self.seed = seed
        self.calls: list[LLMRequest] = []
        self.script_dynamic: Callable[[LLMRequest], Any] | None = None
        self._counts: Counter[str] = Counter()
        self._script_positions: Counter[str] = Counter()
        self._text_seq = 0

    def last(self, task: str) -> LLMRequest | None:
        """Return the last recorded request for ``task``, or None."""
        return next((req for req in reversed(self.calls) if req.task == task), None)

    def count(self, task: str) -> int:
        return self._counts[task]

    def _record(self, req: LLMRequest) -> int:
        self.calls.append(req.model_copy(deep=True))
        index = self._counts[req.task]
        self._counts[req.task] += 1
        return index

    async def _scripted(self, req: LLMRequest) -> Any:
        if self.script_dynamic is not None:
            result = self.script_dynamic(req)
            if inspect.isawaitable(result):
                result = await result
            if result is not None:
                return result
        result = self.script.get(req.task)
        if isinstance(result, list):
            index = self._script_positions[req.task]
            self._script_positions[req.task] += 1
            return result[min(index, len(result) - 1)] if result else None
        return result

    async def complete(self, req: LLMRequest) -> LLMResponse:
        """Raw calls replay scripts; unknown tasks produce a JSON object.

        Structured calls use the schema-aware override below: a schema name alone
        cannot resolve locally defined pydantic classes reliably.
        """
        self._record(req)
        data = await self._scripted(req)
        if isinstance(data, BaseModel):
            data = data.model_dump(mode="json")
        return LLMResponse(text=json.dumps(data if data is not None else {}), model="mock-scientist")

    async def structured(self, req: LLMRequest, schema: type[TModel]) -> TModel:
        req = req.model_copy(update={"schema_name": schema.__name__})
        index = self._record(req)
        scripted = await self._scripted(req)
        if scripted is not None:
            if isinstance(scripted, BaseModel):
                scripted = scripted.model_dump(mode="json")
            return schema.model_validate(scripted)
        # Top-level schemas are default-constructible envelopes; their *nested*
        # domain models (Idea, Claim, ...) have required fields, so those are
        # populated recursively too (SPEC §4).
        material = json.dumps([self.seed, req.task, req.meta], sort_keys=True, default=str)
        digest = zlib.crc32(material.encode("utf-8"))
        rng = random.Random(digest)
        prefix = re.sub(r"[^a-zA-Z0-9_-]+", "-", req.task).strip("-") or "mock"
        prefix = f"{prefix}-{digest:08x}-{index}"
        data = self._model(schema, req, rng, prefix, index, "")
        return schema.model_validate(data)

    def _model(
        self, schema: type[BaseModel], req: LLMRequest, rng: random.Random,
        prefix: str, index: int, path: str,
    ) -> dict[str, Any]:
        data = {
            name: self._value(
                field.annotation, name, field.metadata, req, rng, prefix, index,
                f"{path}-{name}" if path else name,
            )
            for name, field in schema.model_fields.items()
        }
        # Manuscript claims must be *auditable*, never invented: when the prompt
        # carries an ``evidence_ledger``, emit claims that quote it exactly. This
        # keeps the offline run honest and lets §3.5/§4.3 verifiers do real work.
        if "claims" in schema.model_fields:
            claims = self._claims_from_prompt(req)
            if claims:
                data["claims"] = claims
        return data

    @staticmethod
    def _claims_from_prompt(req: LLMRequest) -> list[dict[str, Any]]:
        def grab(key: str) -> dict[str, Any]:
            match = re.search(r'"' + key + r'"\s*:\s*(\{[^{}]*\})', req.user)
            if not match:
                return {}
            try:
                loaded = json.loads(match.group(1))
            except json.JSONDecodeError:
                return {}
            return loaded if isinstance(loaded, dict) else {}

        ledger = grab("evidence_ledger")
        refs = grab("evidence_refs")
        method = ""
        match = re.search(r'"mechanism"\s*:\s*"([^"]{0,160})"', req.user)
        if match:
            method = match.group(1)
        out: list[dict[str, Any]] = []
        for metric in sorted(ledger):
            value = ledger[metric]
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            if not method:
                subject = "The proposed mechanism"
            elif "mechanism" in method.lower():
                subject = f"The {method}"
            else:
                subject = f"The {method} mechanism"
            out.append({
                "text": f"{subject} attains {metric} = {value} on the reported benchmark.",
                "metric": metric,
                "value": float(value),
                "evidence_ref": str(refs.get(metric, metric)),
            })
            if len(out) >= 8:
                break
        return out

    def _value(
        self, annotation: Any, name: str, constraints: list[Any], req: LLMRequest,
        rng: random.Random, prefix: str, index: int, path: str,
    ) -> Any:
        origin, args = get_origin(annotation), get_args(annotation)
        if origin is Annotated:
            return self._value(args[0], name, [*constraints, *args[1:]], req, rng, prefix, index, path)
        if origin in (Union, types.UnionType):
            # Optional fields represent references; leave them absent rather than
            # inventing a second, inconsistent Idea/RepoRef inside a wrapper.
            if type(None) in args:
                return None
            return self._value(args[0], name, constraints, req, rng, prefix, index, path)
        if origin is Literal:
            return self._choice(list(args), name, index)
        if isinstance(annotation, type) and issubclass(annotation, Enum):
            return self._choice(list(annotation), name, index)
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            return self._model(annotation, req, rng, prefix, index, path)
        if origin is list:
            # Do not fabricate accusations or absent components. These are
            # optional diagnostics, unlike requested candidate/model batches.
            if name in {"violations", "spec_violations", "ref_violations", "missing"}:
                return []
            n = max(0, int(req.meta.get("n", 1)))
            n = int(self._bounded(float(n), constraints, 0, max(n, 1)))
            return [
                self._value(args[0] if args else str, name, [], req, rng, prefix, index + i, f"{path}-{i}")
                for i in range(n)
            ]
        if origin is dict:
            # No metric values are fabricated here: experiments own all metrics.
            return {}
        if origin is tuple:
            return tuple(
                self._value(arg, name, [], req, rng, prefix, index, f"{path}-{i}")
                for i, arg in enumerate(args) if arg is not Ellipsis
            )
        if annotation is bool:
            return True
        if annotation is int:
            default = int(req.meta.get("round", 0)) if name == "round" else 1
            return int(self._bounded(float(default), constraints, 0, 10))
        if annotation is float:
            lo, hi = (0.0, 1.0)
            if name in {"novelty_score", "domain_fit", "severity"}:
                lo, hi = 0.65, 0.99
            elif name == "score":
                lo, hi = 7.0, 9.5
            elif name == "scale_max":
                lo = hi = 10.0
            lo, hi = self._bounds(constraints, lo, hi)
            value = round(rng.uniform(lo, hi), 3)
            return self._bounded(value, constraints, lo, hi)
        if annotation is str:
            if name == "id" or name.endswith("_id"):
                value = f"{prefix}-{path}"
            else:
                value = self._text(name, prefix, path, index)
            lo, hi = self._bounds(constraints, 1, max(len(value), 1), length=True)
            return value[:int(hi)].ljust(int(lo), "x")
        if annotation is type(None):
            return None
        return f"{req.task}: {path}"

    #: Readable offline prose. Never empty, never claims a result: the mock has no
    #: evidence, so its prose must stay generic while the *numbers* come from the
    #: experiment ledger (see ``_claims_from_prompt``).
    _TEMPLATES = {
        "title": "A Reproducible Empirical Study of the Proposed Mechanism",
        "hypothesis": "Replacing the baseline component with the proposed mechanism improves the primary metric under an identical protocol.",
        "mechanism": "residual-alignment refinement",
        "abstract": "We study whether the proposed mechanism beats the reproduced human baseline under a fixed benchmark protocol.",
        "summary": "The candidate was evaluated on the supplied benchmark split.",
        "rationale": "The proposal targets a diagnosed limitation and stays inside the requested scope.",
        "feedback": "Isolate one component, re-measure the primary metric on the same splits, and adopt only on a strict improvement.",
        "critique": "Component attribution and robustness over the reproduced baseline are not yet established.",
        "question": "Does the reported gain survive a held-out split with the component removed?",
        "description": "Remove one component of the proposed method and re-run the full benchmark.",
        "experiment": "Re-run the primary benchmark with this component ablated and report the same metrics.",
        "plan": "Ablate the named component only; keep data, splits, seeds and the baseline protocol fixed.",
        "expects": "Removing a contributing component should degrade the primary metric.",
        "component": "auxiliary alignment term",
        "strength": "The protocol is reproducible and the baseline is freshly reproduced.",
        "weakness": "Component attribution and multi-dataset robustness are not yet demonstrated.",
        "text": "The proposed mechanism improves the primary metric under an identical protocol.",
        "note": "Offline simulation: no scientific claim is established.",
        "notes": "Offline simulation: no scientific claim is established.",
        "comment": "Recorded for audit.",
        "statement": "Improve the reproduced human baseline under a fixed benchmark protocol.",
        "novelty_ref": "Prior work does not combine these components under this protocol.",
    }

    #: A plausible component inventory, so an offline ablation table reads like a
    #: real one instead of five variants of a single name.
    _COMPONENTS = (
        "primary mechanism",
        "auxiliary alignment term",
        "spectral prior",
        "safety/calibration gate",
        "prototype residual",
        "input representation",
        "regularization schedule",
    )

    def _text(self, name: str, prefix: str, path: str, index: int = 0) -> str:
        """Readable template + a unique variant marker.

        The marker is required: limitations, ideas and reviewer questions are
        de-duplicated downstream, so identical prose would silently collapse a
        batch to a single item.
        """

        base = self._TEMPLATES.get(name)
        if base:
            self._text_seq += 1
            if name == "component":
                # Cycle by *position in the batch* (index is the item index for list
                # fields), so one plan batch covers N distinct components. Repeats
                # across batches are fine: plan IDs stay unique, and two ideas may
                # legitimately ablate the same kind of component.
                return self._COMPONENTS[index % len(self._COMPONENTS)]
            return f"{base} (variant {self._text_seq})"
        return f"{name.replace('_', ' ').strip().capitalize()} for candidate {prefix}."

    @staticmethod
    def _choice(choices: list[Any], name: str, index: int) -> Any:
        if name not in {"decision", "verdict"}:
            return choices[0]
        by_value = {str(getattr(choice, "value", choice)).lower(): choice for choice in choices}
        # Exercise refinement before successful acceptance, while retaining only
        # values actually permitted by this particular enum/Literal.
        cycle = [by_value[key] for key in ("refine", "good", "accept", "bad", "reject", "engineer") if key in by_value]
        return (cycle or choices)[index % len(cycle or choices)]

    @staticmethod
    def _bounds(
        constraints: list[Any], lo: float, hi: float, *, length: bool = False,
    ) -> tuple[float, float]:
        lower, upper = ("min_length", "max_length") if length else ("ge", "le")
        lows = [float(getattr(c, lower)) for c in constraints if getattr(c, lower, None) is not None]
        highs = [float(getattr(c, upper)) for c in constraints if getattr(c, upper, None) is not None]
        if not length:
            lows += [float(c.gt) + 1e-6 for c in constraints if getattr(c, "gt", None) is not None]
            highs += [float(c.lt) - 1e-6 for c in constraints if getattr(c, "lt", None) is not None]
        if lows:
            lo = max(lows)
        if highs:
            hi = min(highs)
        if lo > hi:
            if lows and not highs:
                hi = lo + 1.0
            elif highs and not lows:
                lo = hi - 1.0
        return lo, hi

    @classmethod
    def _bounded(cls, value: float, constraints: list[Any], lo: float, hi: float) -> float:
        lo, hi = cls._bounds(constraints, lo, hi)
        return max(lo, min(hi, value))
