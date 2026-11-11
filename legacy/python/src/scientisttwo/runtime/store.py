"""Append-only artifact + trace persistence (reproducibility, invariant I8)."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from pydantic import BaseModel

__all__ = ["ArtifactStore", "TraceStore", "as_jsonable"]


def as_jsonable(obj: Any) -> Any:
    if isinstance(obj, BaseModel):
        return obj.model_dump(mode="json")
    if isinstance(obj, dict):
        return {k: as_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [as_jsonable(v) for v in obj]
    if isinstance(obj, Path):
        return str(obj)
    return obj


class ArtifactStore:
    """File store rooted at ``<out_dir>/<run_id>/``."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "artifacts").mkdir(exist_ok=True)
        (self.root / "code").mkdir(exist_ok=True)

    # ---------------------------------------------------------------- paths
    def path(self, *parts: str) -> Path:
        p = self.root.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def artifact(self, rel: str) -> Path:
        return self.path("artifacts", rel)

    # ---------------------------------------------------------------- write
    def write_text(self, rel: str, text: str) -> Path:
        p = self.artifact(rel)
        p.write_text(text, encoding="utf-8")
        return p

    def write_json(self, rel: str, obj: Any) -> Path:
        p = self.artifact(rel)
        p.write_text(json.dumps(as_jsonable(obj), indent=2, ensure_ascii=False), encoding="utf-8")
        return p

    def copy_tree(self, src: Path | str, rel: str) -> Path:
        dst = self.path("code", rel)
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        return dst

    # ---------------------------------------------------------------- read
    def read_json(self, rel: str) -> Any:
        return json.loads(self.artifact(rel).read_text(encoding="utf-8"))

    def read_text(self, rel: str) -> str:
        return self.artifact(rel).read_text(encoding="utf-8")


class TraceStore:
    """Append-only JSONL log of every state transition.

    Each record is ``{"seq": int, "kind": str, "ts": float, "data": {...}}``.
    ``load_traces`` must be able to reconstruct the decision path without any
    model access (invariant I8).
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._seq = 0
        if self.path.exists():
            with self.path.open("r", encoding="utf-8") as fh:
                self._seq = sum(1 for line in fh if line.strip())

    def append(self, kind: str, data: Any, **extra: Any) -> dict[str, Any]:
        import time

        self._seq += 1
        rec = {
            "seq": self._seq,
            "kind": kind,
            "ts": time.time(),
            "data": as_jsonable(data),
            **as_jsonable(extra),
        }
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return rec

    def read_all(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self.path.open("r", encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def kinds(self) -> list[str]:
        return [r["kind"] for r in self.read_all()]
