#!/usr/bin/env python3
"""Train a DFM-Mamba checkpoint and evaluate wikitext word perplexity.

This adapter belongs to the target project, not to RSI core. The scaffold was
generated from examples/dfm_ssm_external.json by the rsi-adapter skill and
filled with the mamba/DFM target entrypoints. setup.sh installs it into the
target repository's `rsi-bench` ref as `bench/rsi_dfm_train_eval.py`.

Protocol:
  1. optional training via scripts/finetune_dfm.py
  2. lm-eval --model dfm_mamba --tasks wikitext (bench/dfm_lm_eval.py)
  3. write {"metrics": {"word_ppl": <lower is better>}} to --out

The GPU server is offline: model/tokenizer/data paths must be local, and the
Python environment must already contain torch/transformers/lm-eval.
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

def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


SCOPE_TRAIN_STEPS = {
    "subset": 20,
    "full": 100,
    "ablation": 50,
    "rebuttal": 50,
}


def fail(out: Path, message: str) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"metrics": {}, "status": "failed", "error": message}, indent=2))
    print(message, file=sys.stderr)
    return 1


def run(
    argv: list[str], cwd: Path, timeout: float | None, env: dict[str, str]
) -> subprocess.CompletedProcess:
    print("+", " ".join(shlex.quote(item) for item in argv), flush=True)
    return subprocess.run(
        argv, cwd=str(cwd), timeout=timeout, capture_output=True, text=True, env=env
    )


def run_shell(
    command: str, cwd: Path, timeout: float | None, env: dict[str, str]
) -> subprocess.CompletedProcess:
    print("+", command, flush=True)
    return subprocess.run(
        command, cwd=str(cwd), timeout=timeout, capture_output=True, text=True,
        env=env, shell=True, executable="/bin/bash",
    )


def expand_train_command(
    command: str, args: argparse.Namespace, checkpoint: Path, data_path: str
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
        "{steps}": str(args.train_steps or os.environ.get("RSI_DFM_TRAIN_STEPS", SCOPE_TRAIN_STEPS[args.scope])),
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
        return here.parent  # injected at snapshot root/bench/
    if (here / "mamba_ssm").is_dir():
        return here
    candidate = here.parents[1] / "vendor" / "dfm-ssm"
    return candidate.resolve()


def parse_word_ppl(path: Path) -> tuple[float | None, dict]:
    data = json.loads(path.read_text())
    results = data.get("results", {})
    for task, metrics in results.items():
        if not isinstance(metrics, dict):
            continue
        for key, value in metrics.items():
            if key.startswith("word_perplexity") and "stderr" not in key:
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return float(value), {"task": task, "metric": key}
    return None, {"results_keys": list(results)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="mamba/DFM checkout (default: current directory or snapshot root)")
    parser.add_argument("--scope", choices=sorted(SCOPE_TRAIN_STEPS), default="subset")
    parser.add_argument("--out", required=True)
    parser.add_argument("--device", default=os.environ.get("RSI_DFM_DEVICE", "cuda"),
                        choices=("cuda", "cpu", "mps"))
    parser.add_argument("--backend", default=os.environ.get("RSI_DFM_BACKEND", "auto"),
                        choices=("auto", "native", "reference"))
    parser.add_argument("--seed", type=int, default=env_int("RSI_DFM_SEED", 7))
    parser.add_argument("--checkpoint", default=os.environ.get("RSI_DFM_CHECKPOINT") or None,
                        help="existing DFM checkpoint; skips training")
    parser.add_argument("--data", default=os.environ.get("RSI_DFM_TRAIN_DATA") or None,
                        help="training JSONL file/dir or parquet dir (default: RSI_DFM_TRAIN_DATA)")
    parser.add_argument("--data-format", default=os.environ.get("RSI_DFM_DATA_FORMAT", "auto"),
                        choices=("auto", "jsonl", "pile-parquet"),
                        help="auto: JSONL file/dir -> jsonl, parquet -> pile-parquet")
    parser.add_argument("--tokenizer", default=os.environ.get("RSI_DFM_TOKENIZER", "EleutherAI/gpt-neox-20b"))
    parser.add_argument("--base-model", default=os.environ.get("RSI_DFM_BASE_MODEL", "state-spaces/mamba-130m"))
    parser.add_argument("--train-steps", type=int, default=0, help="0 = RSI_DFM_TRAIN_STEPS or scope default")
    parser.add_argument("--train-command", default=os.environ.get("RSI_DFM_TRAIN_CMD") or None,
                        help="full shell command override; replaces the default training invocation")
    parser.add_argument("--train-launcher", default=os.environ.get("RSI_DFM_TRAIN_LAUNCHER") or None,
                        help="training launcher prefix, e.g. 'accelerate launch --num_processes 1'; default '<python> -m'")
    parser.add_argument("--train-script", default=os.environ.get("RSI_DFM_TRAIN_SCRIPT", "scripts.finetune_dfm"),
                        help="module name or script path passed to the launcher")
    parser.add_argument("--train-batch-size", type=int, default=env_int("RSI_DFM_TRAIN_BATCH_SIZE", 2))
    parser.add_argument("--grad-accum", type=int, default=env_int("RSI_DFM_GRAD_ACCUM", 8))
    parser.add_argument("--max-length", type=int, default=env_int("RSI_DFM_MAX_LENGTH", 512))
    parser.add_argument("--block-length", type=int, default=env_int("RSI_DFM_BLOCK_LENGTH", 16))
    parser.add_argument("--lm-eval-task", default=os.environ.get("RSI_DFM_LM_EVAL_TASK", "wikitext"))
    parser.add_argument("--lm-eval-batch-size", type=int, default=env_int("RSI_DFM_LM_EVAL_BATCH_SIZE", 8))
    parser.add_argument("--eval-max-length", type=int, default=env_int("RSI_DFM_EVAL_MAX_LENGTH", 2048))
    parser.add_argument("--flow-time", default=os.environ.get("RSI_DFM_FLOW_TIME", "off"),
                        help="DFM flow time for logits: off = causal backbone, or 1.0")
    parser.add_argument("--offline", action="store_true", default=os.environ.get("RSI_DFM_OFFLINE", "1") == "1")
    parser.add_argument("--timeout", type=float, default=env_float("RSI_DFM_TIMEOUT", 0),
                        help="per-subprocess timeout seconds (0 = none)")
    args = parser.parse_args()

    out = Path(args.out).expanduser().resolve()
    repo = find_repo(args.repo)
    if not (repo / "mamba_ssm").is_dir():
        return fail(out, f"dfm-ssm checkout not found at {repo}; run integrations/dfm_ssm/setup.sh")

    env = dict(os.environ)
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(repo) + (os.pathsep + existing_pythonpath if existing_pythonpath else "")
    if args.offline:
        env.setdefault("HF_HUB_OFFLINE", "1")
        env.setdefault("TRANSFORMERS_OFFLINE", "1")
        env.setdefault("HF_DATASETS_OFFLINE", "1")

    work = out.parent
    work.mkdir(parents=True, exist_ok=True)
    checkpoint = Path(args.checkpoint).expanduser().resolve() if args.checkpoint else None
    timeout = args.timeout or None
    started = time.time()

    try:
        if checkpoint is None:
            data_path = args.data
            if not data_path:
                return fail(
                    out,
                    "training data is required (--data or RSI_DFM_TRAIN_DATA), "
                    "or pass --checkpoint for eval-only",
                )
            if not Path(data_path).expanduser().exists():
                return fail(out, f"training data not found: {data_path}")
            steps = args.train_steps or int(os.environ.get("RSI_DFM_TRAIN_STEPS", SCOPE_TRAIN_STEPS[args.scope]))
            checkpoint = work / f"checkpoint-{out.stem}"
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
                "--save-every",
                str(steps),
                "--output",
                str(checkpoint),
            ]
            if args.train_command:
                command = expand_train_command(args.train_command, args, checkpoint, data_path)
                trained = run_shell(command, repo, timeout, env)
            else:
                launcher = args.train_launcher or f"{sys.executable} -m"
                launcher = launcher.replace("{python}", sys.executable)
                train_cmd = [*shlex.split(launcher), args.train_script, *train_args]
                trained = run(train_cmd, repo, timeout, env)
            if trained.returncode != 0:
                return fail(
                    out,
                    f"training failed:\n{trained.stdout[-4000:]}\n{trained.stderr[-4000:]}",
                )

        eval_json = work / f"lm-eval-{out.stem}.json"
        eval_cmd = [
            sys.executable,
            "bench/dfm_lm_eval.py",
            "--model",
            "dfm_mamba",
            "--model_args",
            f"pretrained={checkpoint},max_length={args.eval_max_length},backend={args.backend},flow_time={args.flow_time}",
            "--tasks",
            args.lm_eval_task,
            "--device",
            args.device,
            "--batch_size",
            str(args.lm_eval_batch_size),
            "--output_path",
            str(eval_json),
        ]
        evaluated = run(eval_cmd, repo, timeout, env)
        if evaluated.returncode != 0:
            return fail(
                out,
                f"lm-eval failed:\n{evaluated.stdout[-4000:]}\n{evaluated.stderr[-4000:]}",
            )
        candidates = sorted(
            eval_json.parent.glob(f"{eval_json.stem}*.json"),
            key=lambda item: item.stat().st_mtime,
        )
        actual_eval_json = candidates[-1] if candidates else eval_json
        word_ppl, meta = parse_word_ppl(actual_eval_json)
        if word_ppl is None:
            return fail(out, f"lm-eval output has no word_perplexity metric: {meta}")

        report = {
            "metrics": {"word_ppl": word_ppl},
            "details": {
                "scope": args.scope,
                "checkpoint": str(checkpoint),
                "lm_eval_task": args.lm_eval_task,
                "lm_eval_metric": meta,
                "lm_eval_output": str(actual_eval_json),
                "flow_time": args.flow_time,
                "device": args.device,
                "backend": args.backend,
                "gpu_ids": env.get("CUDA_VISIBLE_DEVICES"),
                "seed": args.seed,
                "wall_time_s": round(time.time() - started, 3),
                "runner": "bench/rsi_dfm_train_eval.py",
            },
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report["metrics"]))
        return 0
    except subprocess.TimeoutExpired as exc:
        return fail(out, f"subprocess timeout: {exc}")
    except Exception as exc:  # noqa: BLE001
        return fail(out, f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
