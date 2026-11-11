#!/usr/bin/env python3
"""Train a DFM-Mamba checkpoint and evaluate wikitext word perplexity.

This adapter belongs to the target project, not to RSI core. It was generated
from examples/dfm_ssm_external.json by the rsi-adapter skill and wired to the
mamba/DFM entrypoints:

  scripts/finetune_dfm.py   training (optionally through accelerate)
  bench/dfm_lm_eval.py      lm-eval wrapper for word_perplexity

RSI's RemoteRunner injects the fixture's remote.env into the SSH command, so
RSI_DFM_TRAIN_DATA and the other RSI_DFM_* values are present for a remote run.
A direct local invocation must set them itself, or pass --checkpoint for
eval-only.

Protocol:
  optional training
  lm-eval --model dfm_mamba --tasks wikitext
  write {"metrics": {"word_ppl": <lower is better>}} to --out
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

PROBLEM_ID = "dfm-ssm-external-wikitext-ppl"
SLUG = "dfm"
ENV_PREFIX = "RSI_DFM"
METRICS = [
    {
        "name": "word_ppl",
        "direction": "min",
        "tolerance": 1.0,
        "weight": 1.0,
        "bounds": None,
    }
]
SCOPES = ["subset", "full", "ablation", "rebuttal"]

SCOPE_TRAIN_STEPS = {
    "subset": 20,
    "full": 100,
    "ablation": 50,
    "rebuttal": 50,
}


def env_str(name: str, default: str = "") -> str:
    return os.environ.get(f"{ENV_PREFIX}_{name}", default)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(f"{ENV_PREFIX}_{name}", default))
    except (TypeError, ValueError):
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(f"{ENV_PREFIX}_{name}", default))
    except (TypeError, ValueError):
        return default


def tail(text: str, limit: int = 4000) -> str:
    return text[-limit:] if len(text) > limit else text


def fail(out: Path, message: str) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"metrics": {}, "status": "failed", "error": message}, indent=2)
        + "\n"
    )
    print(message, file=sys.stderr)
    return 1


def run(
    argv: list[str],
    cwd: Path,
    env: dict[str, str],
    timeout: float | None,
) -> subprocess.CompletedProcess:
    print("+", shlex.join(argv), flush=True)
    return subprocess.run(
        argv,
        cwd=str(cwd),
        env=env,
        timeout=timeout,
        capture_output=True,
        text=True,
    )


def run_shell(
    command: str,
    cwd: Path,
    env: dict[str, str],
    timeout: float | None,
) -> subprocess.CompletedProcess:
    print("+", command, flush=True)
    return subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        timeout=timeout,
        capture_output=True,
        text=True,
        shell=True,
        executable="/bin/bash",
    )


def expand_train_command(
    command: str,
    args: argparse.Namespace,
    checkpoint: Path,
    data_path: str,
) -> str:
    values = {
        "{python}": sys.executable,
        "{repo}": str(Path.cwd()),
        "{data}": str(Path(data_path).expanduser()),
        "{checkpoint}": str(checkpoint),
        "{tokenizer}": args.tokenizer,
        "{base_model}": args.base_model,
        "{device}": args.device,
        "{backend}": args.backend,
        "{steps}": str(args.train_steps or env_int("TRAIN_STEPS", SCOPE_TRAIN_STEPS[args.scope])),
        "{train_batch_size}": str(args.train_batch_size),
        "{grad_accum}": str(args.grad_accum),
        "{max_length}": str(args.max_length),
        "{block_length}": str(args.block_length),
        "{seed}": str(args.seed),
    }
    for key, value in values.items():
        command = command.replace(key, value)
    return command


def find_repo(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    here = Path(__file__).resolve().parent
    if (here.parent / "mamba_ssm").is_dir():
        return here.parent
    if (here / "mamba_ssm").is_dir():
        return here
    return Path.cwd().resolve()


def train(
    repo: Path,
    scope: str,
    work: Path,
    env: dict[str, str],
    args: argparse.Namespace,
) -> Path:
    data_path = args.data or env_str("TRAIN_DATA")
    if not data_path:
        raise RuntimeError(
            "training data is required: pass --data, or set RSI_DFM_TRAIN_DATA. "
            "RSI's RemoteRunner injects the fixture's remote.env on the GPU host; "
            "a direct local invocation must set it itself. "
            "Pass --checkpoint for eval-only."
        )
    if not Path(data_path).expanduser().exists():
        raise FileNotFoundError(f"training data not found: {data_path}")

    steps = args.train_steps or env_int("TRAIN_STEPS", SCOPE_TRAIN_STEPS[scope])
    if steps <= 0:
        raise ValueError("training steps must be positive")
    checkpoint = work / f"checkpoint-{args.out_stem}"
    train_args = [
        "--base-model",
        args.base_model,
        "--tokenizer",
        args.tokenizer,
        "--data",
        str(Path(data_path).expanduser()),
        "--data-format",
        args.data_format,
        "--source-distribution",
        "uniform",
        "--block-length",
        str(args.block_length),
        "--device",
        args.device,
        "--backend",
        args.backend,
        "--precision",
        "fp32",
        "--batch-size",
        str(args.train_batch_size),
        "--grad-accum",
        str(args.grad_accum),
        "--max-length",
        str(args.max_length),
        "--train-steps",
        str(steps),
        "--seed",
        str(args.seed),
        "--save-every",
        str(steps),
        "--output",
        str(checkpoint),
    ]

    if args.train_command:
        command = expand_train_command(args.train_command, args, checkpoint, data_path)
        trained = run_shell(command, repo, env, args.timeout or None)
    else:
        launcher = args.train_launcher or env_str("TRAIN_LAUNCHER")
        script = args.train_script or env_str("TRAIN_SCRIPT", "scripts.finetune_dfm")
        if launcher:
            launcher = launcher.replace("{python}", sys.executable)
            train_cmd = [*shlex.split(launcher), script, *train_args]
        elif script.endswith(".py"):
            train_cmd = [sys.executable, script, *train_args]
        else:
            train_cmd = [sys.executable, "-m", script, *train_args]
        trained = run(train_cmd, repo, env, args.timeout or None)

    if trained.returncode != 0:
        raise RuntimeError(
            "training failed:\n"
            + tail(trained.stdout + trained.stderr)
        )
    if not checkpoint.exists():
        raise FileNotFoundError(f"training did not produce a checkpoint: {checkpoint}")
    return checkpoint


def evaluate(
    repo: Path,
    checkpoint: Path,
    work: Path,
    env: dict[str, str],
    args: argparse.Namespace,
) -> Path:
    helper = repo / "bench/dfm_lm_eval.py"
    if not helper.exists():
        raise FileNotFoundError(
            f"{helper} is missing; install the adapter with "
            "integrations/dfm_ssm/setup.sh"
        )
    eval_json = work / f"lm-eval-{args.out_stem}.json"
    eval_cmd = [
        sys.executable,
        "bench/dfm_lm_eval.py",
        "--model",
        "dfm_mamba",
        "--model_args",
        f"pretrained={checkpoint},max_length={args.eval_max_length},"
        f"backend={args.backend},flow_time={args.flow_time}",
        "--tasks",
        args.lm_eval_task,
        "--device",
        args.device,
        "--batch_size",
        str(args.lm_eval_batch_size),
        "--output_path",
        str(eval_json),
    ]
    evaluated = run(eval_cmd, repo, env, args.timeout or None)
    if evaluated.returncode != 0:
        raise RuntimeError(
            "lm-eval failed:\n"
            + tail(evaluated.stdout + evaluated.stderr)
        )
    candidates = sorted(
        eval_json.parent.glob(f"{eval_json.stem}*.json"),
        key=lambda item: item.stat().st_mtime,
    )
    return candidates[-1] if candidates else eval_json


def parse_metrics(raw: Path) -> dict[str, float]:
    data = json.loads(raw.read_text())
    results = data.get("results", {})
    for task, values in results.items():
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            if key.startswith("word_perplexity") and "stderr" not in key:
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return {"word_ppl": float(value)}
    raise ValueError(
        f"lm-eval output has no word_perplexity metric: "
        f"results={list(results) if isinstance(results, dict) else type(results).__name__}"
    )


def validate_metrics(values: dict[str, float]) -> dict[str, float]:
    expected = {metric["name"]: metric for metric in METRICS}
    missing = sorted(set(expected) - set(values))
    extra = sorted(set(values) - set(expected))
    if missing:
        raise ValueError(f"metric output is missing {missing}")
    if extra:
        raise ValueError(f"metric output has unexpected keys {extra}")
    clean: dict[str, float] = {}
    for name, raw_value in values.items():
        value = float(raw_value)
        if not (value == value and abs(value) != float("inf")):
            raise ValueError(f"metric {name} is not finite: {raw_value!r}")
        bounds = expected[name].get("bounds")
        if bounds is not None and not (bounds[0] <= value <= bounds[1]):
            raise ValueError(f"metric {name}={value} is outside bounds {bounds}")
        clean[name] = value
    return clean


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="mamba/DFM checkout (default: current directory)")
    parser.add_argument("--scope", choices=SCOPES, default="subset")
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--checkpoint",
        default=env_str("CHECKPOINT") or None,
        help="existing checkpoint; skips training",
    )
    parser.add_argument("--device", default=env_str("DEVICE", "cuda"), choices=("cuda", "cpu", "mps"))
    parser.add_argument("--backend", default=env_str("BACKEND", "auto"), choices=("auto", "native", "reference"))
    parser.add_argument("--seed", type=int, default=env_int("SEED", 7))
    parser.add_argument("--data", default=env_str("TRAIN_DATA") or None)
    parser.add_argument("--data-format", default=env_str("DATA_FORMAT", "auto"), choices=("auto", "jsonl", "pile-parquet"))
    parser.add_argument("--tokenizer", default=env_str("TOKENIZER", "EleutherAI/gpt-neox-20b"))
    parser.add_argument("--base-model", default=env_str("BASE_MODEL", "state-spaces/mamba-130m"))
    parser.add_argument("--train-steps", type=int, default=0)
    parser.add_argument("--train-command", default=env_str("TRAIN_CMD") or None)
    parser.add_argument("--train-launcher", default=env_str("TRAIN_LAUNCHER") or None)
    parser.add_argument("--train-script", default=env_str("TRAIN_SCRIPT", "scripts.finetune_dfm"))
    parser.add_argument("--train-batch-size", type=int, default=env_int("TRAIN_BATCH_SIZE", 2))
    parser.add_argument("--grad-accum", type=int, default=env_int("GRAD_ACCUM", 8))
    parser.add_argument("--max-length", type=int, default=env_int("MAX_LENGTH", 512))
    parser.add_argument("--block-length", type=int, default=env_int("BLOCK_LENGTH", 16))
    parser.add_argument("--lm-eval-task", default=env_str("LM_EVAL_TASK", "wikitext"))
    parser.add_argument("--lm-eval-batch-size", type=int, default=env_int("LM_EVAL_BATCH_SIZE", 8))
    parser.add_argument("--eval-max-length", type=int, default=env_int("EVAL_MAX_LENGTH", 2048))
    parser.add_argument("--flow-time", default=env_str("FLOW_TIME", "off"))
    parser.add_argument(
        "--offline",
        action="store_true",
        default=env_str("OFFLINE", "1") == "1",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=env_float("TIMEOUT", 0),
        help="per-subprocess timeout seconds; 0 = no adapter-level timeout",
    )
    args = parser.parse_args()

    out = Path(args.out).expanduser().resolve()
    args.out_stem = out.stem
    started = time.time()
    try:
        repo = find_repo(args.repo)
        if not (repo / "mamba_ssm").is_dir():
            raise FileNotFoundError(
                f"mamba checkout not found at {repo}; "
                "install the adapter with integrations/dfm_ssm/setup.sh"
            )
        work = out.parent / f"rsi-{SLUG}-{args.scope}"
        work.mkdir(parents=True, exist_ok=True)

        env = dict(os.environ)
        env.setdefault("TOKENIZERS_PARALLELISM", "false")
        existing_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = str(repo) + (
            os.pathsep + existing_pythonpath if existing_pythonpath else ""
        )
        if args.offline:
            env.setdefault("HF_HUB_OFFLINE", "1")
            env.setdefault("TRANSFORMERS_OFFLINE", "1")
            env.setdefault("HF_DATASETS_OFFLINE", "1")

        checkpoint = (
            Path(args.checkpoint).expanduser().resolve()
            if args.checkpoint
            else train(repo, args.scope, work, env, args)
        )
        if not checkpoint.exists():
            raise FileNotFoundError(f"checkpoint not found: {checkpoint}")

        raw_metrics = evaluate(repo, checkpoint, work, env, args)
        metrics = validate_metrics(parse_metrics(raw_metrics))

        report = {
            "metrics": metrics,
            "status": "ok",
            "details": {
                "problem": PROBLEM_ID,
                "scope": args.scope,
                "seed": args.seed,
                "repo": str(repo),
                "checkpoint": str(checkpoint),
                "raw_metrics": str(raw_metrics),
                "lm_eval_task": args.lm_eval_task,
                "flow_time": args.flow_time,
                "device": args.device,
                "backend": args.backend,
                "gpu_ids": env.get("CUDA_VISIBLE_DEVICES"),
                "wall_time_s": round(time.time() - started, 3),
            },
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(out.suffix + ".tmp")
        tmp.write_text(json.dumps(report, indent=2) + "\n")
        tmp.replace(out)
        print(json.dumps(report["metrics"]))
        return 0
    except subprocess.TimeoutExpired as exc:
        return fail(out, f"subprocess timeout: {exc}")
    except Exception as exc:  # noqa: BLE001 - failure is data
        return fail(out, f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
