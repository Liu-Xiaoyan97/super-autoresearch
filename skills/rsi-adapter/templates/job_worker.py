#!/usr/bin/env python3
"""Detached per-job executor owned by the target repository.

The RSI client writes ``request.json`` into a job directory, then launches this
script over SSH with ``setsid nohup``. The script claims the job atomically,
takes the GPU lock, runs the adapter command and publishes ``events.jsonl`` and
an atomic ``result.json``. No network input, no project math, stdlib only.

    python3 bench/rsi_job_worker.py --spec /home/sl/rsi-jobs/<job>/request.json
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

VERSION = 1


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def tail(path: Path, limit: int = 4000) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            handle.seek(max(0, size - limit))
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


class Events:
    """Append-only publisher; each line is one event with a monotonic seq."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.seq = 0
        self.lock = threading.Lock()

    def emit(self, event: str, **data: object) -> int:
        with self.lock:
            self.seq += 1
            line = json.dumps({"seq": self.seq, "at": now(), "event": event, **data}, ensure_ascii=False)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            return self.seq


def kill_group(pid: int, sig: int = signal.SIGTERM) -> None:
    try:
        os.killpg(os.getpgid(pid), sig)
    except ProcessLookupError:
        pass


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    args = parser.parse_args(argv)
    spec_path = Path(args.spec).expanduser().resolve()
    job = spec_path.parent
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if spec.get("version") != VERSION:
        print(f"unsupported spec version: {spec.get('version')!r}", file=sys.stderr)
        return 2
    work = Path(spec["cwd"]).resolve()
    out = Path(spec["out"]).resolve()
    if not work.is_dir():
        print(f"cwd is not a directory: {work}", file=sys.stderr)
        return 2
    if not inside(work, job) or not inside(out, job):
        print("cwd/out must stay inside the job directory", file=sys.stderr)
        return 2

    try:
        (job / "claimed").mkdir()
    except FileExistsError:
        print("job already claimed", file=sys.stderr)
        return 0

    events = Events(job / "events.jsonl")
    events.emit("claimed", pid=os.getpid(), host=os.uname().nodename)
    lock_dir = Path(spec["lock_dir"]).resolve()
    lock_dir.mkdir(parents=True, exist_ok=True)
    gpu = str(spec.get("gpu_ids") or "0").replace(",", "_")
    lock = (lock_dir / f"gpu-{gpu}.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    events.emit("started", gpu=spec.get("gpu_ids"), commit=spec.get("commit"))
    started = time.time()
    timeout = float(spec.get("timeout_s") or 0)
    log = job / "worker.log"
    env = dict(os.environ)
    for key, value in (spec.get("env") or {}).items():
        env[str(key)] = str(value)
    env.setdefault("PYTHONUNBUFFERED", "1")
    cancel = job / "cancel"
    process: subprocess.Popen | None = None
    cancelled = timed_out = False

    with log.open("ab") as handle:
        process = subprocess.Popen(
            [str(part) for part in spec["command"]],
            cwd=str(work),
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        events.emit("running", pid=process.pid, timeout_s=timeout)
        stop = threading.Event()

        def heartbeat() -> None:
            while not stop.wait(30):
                events.emit("heartbeat", pid=process.pid, elapsed_s=round(time.time() - started, 1))

        beat = threading.Thread(target=heartbeat, daemon=True)
        beat.start()
        try:
            while process.poll() is None:
                if cancel.exists():
                    cancelled = True
                    kill_group(process.pid)
                    wait_until_exit(process)
                    break
                if timeout and time.time() - started > timeout:
                    timed_out = True
                    kill_group(process.pid)
                    wait_until_exit(process)
                    break
                time.sleep(0.5)
            code = process.wait()
        finally:
            stop.set()
            beat.join(timeout=2)

    elapsed = round(time.time() - started, 3)
    status = "cancelled" if cancelled else "timeout" if timed_out else "ok" if code == 0 else "failed"
    report = None
    error = None
    if status == "ok":
        if not out.is_file():
            status, error = "failed", f"adapter report not found: {out}"
        else:
            try:
                report = json.loads(out.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                status, error = "failed", f"adapter report is not JSON: {exc}"
            else:
                if not isinstance(report, dict) or report.get("status") != "ok":
                    status, error = "failed", f"adapter report status is not ok: {report.get('status')!r}"
    result = {
        "version": VERSION,
        "job_id": spec.get("job_id"),
        "commit": spec.get("commit"),
        "protocol_digest": spec.get("protocol_digest"),
        "status": status,
        "exit": code,
        "error": error,
        "report": report,
        "report_sha256": sha256(out) if out.is_file() else None,
        "stdout_tail": tail(log),
        "elapsed_s": elapsed,
        "started_at": spec.get("created_at"),
        "finished_at": now(),
    }
    atomic_json(job / "result.json", result)
    events.emit(
        "completed" if status == "ok" else "failed",
        exit=code,
        status=status,
        result_sha256=sha256(job / "result.json"),
        elapsed_s=elapsed,
    )
    return 0 if status == "ok" else 1


def wait_until_exit(process: subprocess.Popen, timeout: float = 10.0) -> None:
    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    kill_group(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
