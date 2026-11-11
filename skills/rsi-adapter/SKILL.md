---
name: rsi-adapter
description: Generate a target-project benchmark adapter and Problem wiring from an examples/*.json fixture. Use when integrating a new repository into RSI, when examples/<project>.json has no working experiment_command, when the target repo needs a bench/run_experiment.py, or when an adapter must honor subset/full scopes, a metric contract, GPU env, and rsync/SSH remote execution.
---

# RSI adapter generator

An adapter is a **thin benchmark harness owned by the target project**. It
turns one candidate checkout into one JSON metric report. RSI core stays
generic: never import the target project into `src/rsi/`, never add a
project-specific branch to the orchestrator, and never copy the target repo
into this repository.

The input is one `examples/*.json` Problem. The output is:

```text
integrations/<project>/
  run_experiment.py       adapter entrypoint
  README.md               target wiring and env reference
  setup.sh                install adapter on the target's rsi-bench ref
examples/<project>.json     updated experiment_command + remote.env
```

## 1. Read the fixture contract first

Read the whole JSON before touching the target repository. Extract:

| Field | Adapter consequence |
|---|---|
| `id`, `repo`, `repo_ref` | names and baseline checkout; `repo_ref` is what RSI reproduces |
| `experiment_command` | the adapter path and the **only** allowed invocation shape |
| `metrics[].name` | exact output keys; do not rename or add proxies |
| `metrics[].direction` | `min` or `max`; adapter reports the raw value, RSI decides |
| `metrics[].tolerance` | relative noise band; never bake it into the adapter |
| `metrics[].bounds` | physical range; keep raw values inside it |
| `datasets`, `subset_datasets` | subset must be a real, cheaper subset |
| `constraints`, `forbidden` | hard boundaries; enforce where possible |
| `remote` | GPU id, python, env, setup, worktree/out templates, timeout |
| `reported_metrics` | human context only; reproduce the baseline yourself |

Canonical command shape:

```json
[
  "{python}",
  "bench/rsi_<project>_train_eval.py",
  "--repo",
  "{repo}",
  "--scope",
  "{scope}",
  "--out",
  "{out}"
]
```

The adapter must accept exactly these contract arguments:

```text
--repo PATH      candidate worktree (may be the current directory)
--scope SCOPE    subset | full | ablation | rebuttal
--out PATH       JSON report destination
```

Put project knobs in `remote.env` (or the shell environment), not duplicated
in `experiment_command`. Explicit command-line flags may override env, but the
adapter's defaults and the fixture's env must not disagree.

## 2. Inspect the target repository read-only

Do this before writing code. Use `rg`, `find`, and `read`; do not run training
yet.

```bash
rg -n "argparse|click|typer|def main|__main__" <target> -g '*.py'
rg -n "train|finetune|evaluate|eval|metric|perplexity|accuracy" <target> -g '*.py'
find <target> -maxdepth 3 -type f \( -name 'README*' -o -name 'pyproject.toml' \
  -o -name 'requirements*.txt' -o -name '*.yaml' -o -name '*.yml' \) | sort
```

Record a short discovery table in your reply:

```text
baseline commit:      <sha and branch>
train entrypoint:     <script + required args>
eval entrypoint:      <script + required args>
checkpoint format:    <path/format>
dataset location:     <local path or env var>
metric source:        <file/stdout key that contains the real metric>
subset definition:    <one dataset/split or smaller step budget>
full definition:      <all datasets/splits>
known baseline value: <from a real run, not invented>
```

If the target has no usable eval, stop and say exactly what is missing. Do not
invent a metric, a split, or a checkpoint loader.

## 3. Scaffold, then fill the TODOs

The skill ships a deterministic scaffold. It validates the fixture and writes
a contract-compliant skeleton plus README, setup script, and manifest:

```bash
python3 skills/rsi-adapter/scripts/scaffold_adapter.py \
  --problem examples/<project>.json \
  --repo /path/to/target \
  --name <project> \
  --out integrations/<project>
```

`--name` controls the slug and the generated `RSI_<PROJECT>_` env prefix; use
the target's existing prefix (for dfm-ssm, `--name dfm` gives `RSI_DFM_`).
If the target already has project-specific env names, keep those instead of
renaming them to the scaffold's defaults.

The scaffold is **not finished adapter code**. Replace its `train`,
`evaluate`, and `parse_metrics` TODOs with the real target commands. A scaffold
that still raises `NotImplementedError` must never be used for a real run.

If you prefer to write from scratch, copy
`skills/rsi-adapter/templates/run_experiment.py.tmpl` and keep the same
contract.

## 4. Implement the adapter

A good adapter is boring and strict:

1. Resolve `--repo` to an absolute path and verify it is the candidate
   checkout. Run every target command with `cwd=repo`.
2. Use `sys.executable` for Python subprocesses so the remote
   `remote.python` interpreter is honored.
3. Build commands from env vars with an `RSI_<PROJECT>_` prefix. Print the
   command with `shlex.join` so failures are reproducible.
4. Map `scope` explicitly:
   - `subset`: the fixture's `subset_datasets` / a genuinely cheaper budget.
   - `full`: every dataset/split the fixture defines.
   - `ablation`: the target's variant path; if unsupported, write a clear
     failure report, not a full-scope number.
   - `rebuttal`: same protocol as full unless the target says otherwise.
5. Train only if a checkpoint is not supplied. If training fails, write
   `status: "failed"` and exit non-zero.
6. Evaluate with the target's own metric implementation. Never re-implement a
   metric with a different tokenizer, context length, split, or normalization.
7. Parse the exact keys in `METRICS`; reject missing, non-finite, or
   out-of-bounds values. Do not clamp a metric to make a gate pass.
8. Write the report atomically:

```json
{
  "metrics": { "<name>": 12.34 },
  "status": "ok",
  "details": {
    "scope": "subset",
    "checkpoint": "/path/checkpoint",
    "seed": 7,
    "wall_time_s": 123.4
  }
}
```

On any failure, still write JSON and exit non-zero:

```json
{ "metrics": {}, "status": "failed", "error": "training failed: ..." }
```

9. Keep logs bounded: print commands and the last ~4 KB of stdout/stderr.
   Write large logs under the `--out` parent, not into the candidate worktree.
10. Respect `CUDA_VISIBLE_DEVICES` from RSI. Do not choose a different GPU,
    and do not hardcode `cuda:0` in library calls. Use
    `RSI_<PROJECT>_DEVICE` if the target needs a device string.

### Environment pattern

```python
PREFIX = "RSI_<PROJECT>"

def env_str(name: str, default: str = "") -> str:
    return os.environ.get(f"{PREFIX}_{name}", default)

# Examples:
# RSI_<PROJECT>_TRAIN_DATA, RSI_<PROJECT>_BASE_MODEL,
# RSI_<PROJECT>_TRAIN_STEPS, RSI_<PROJECT>_BATCH_SIZE,
# RSI_<PROJECT>_EVAL_TASK, RSI_<PROJECT>_OFFLINE
```

Set only what the target needs. For offline servers, set
`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1` and
`TOKENIZERS_PARALLELISM=false` in the adapter, not scattered through the
fixture. Never add networks calls as a fallback.

### Baseline and leakage rules

- The baseline is a fresh run of `repo_ref` through the same adapter, not
  `reported_metrics`.
- Never train on validation/test data.
- Never use extra evaluation data, a different tokenizer, or a different
  context length to improve the number.
- Never cache a result keyed only by scope or seed if the candidate commit can
  change; invalidate on commit.
- A crash is a failed experiment, not a zero-metric improvement.

## 5. Wire the fixture

Keep `experiment_command` to the invocation and placeholders. All knobs move
to `remote.env` (or the adapter's documented env defaults):

```json
"experiment_command": [
  "{python}",
  "bench/rsi_<project>_train_eval.py",
  "--repo", "{repo}",
  "--scope", "{scope}",
  "--out", "{out}"
],
"remote": {
  "gpu_ids": "0",
  "env": {
    "RSI_<PROJECT>_TRAIN_DATA": "/data/...",
    "RSI_<PROJECT>_BASE_MODEL": "/models/...",
    "RSI_<PROJECT>_TRAIN_STEPS": "38000"
  }
}
```

`gpu_ids` is mandatory even for one GPU. Do not omit it or rely on a default.
The adapter lives on the target repo's `rsi-bench` ref (or an equivalent
committed harness). The generated `setup.sh` copies it there; RSI only rsyncs
the candidate worktree.

## 6. Validate before declaring done

Run these checks and paste the evidence:

```bash
# 1. Syntax / contract help
python3 integrations/<project>/run_experiment.py --help

# 2. Failure path: missing required env must fail, not fabricate metrics
env -u RSI_<PROJECT>_TRAIN_DATA python3 integrations/<project>/run_experiment.py \
  --repo /path/to/target --scope subset --out /tmp/missing.json; echo "exit=$?"
test ! -s /tmp/missing.json || python3 -m json.tool /tmp/missing.json

# 3. Tiny real smoke (small checkpoint/data, one step if supported)
python3 integrations/<project>/run_experiment.py \
  --repo /path/to/target --scope subset --out /tmp/report.json
python3 -m json.tool /tmp/report.json
```

Checks that must pass:

- exact metric names, finite values, correct direction/bounds;
- subset is cheaper than full but uses the same metric protocol;
- rerunning with the same seed gives a comparable value;
- nonzero exit + `status: "failed"` on missing data/checkpoint/eval;
- no secrets, absolute local paths, or generated checkpoints committed;
- `git status` in the target repo shows only the intended harness commit.

For remote runs, additionally:

```bash
ssh <remote.host> true
rsync -az --dry-run --exclude-from=<excludes> <worktree>/ <host>:<remote.worktree>/
ssh <remote.host> '<remote.setup>; cd <remote.worktree> && CUDA_VISIBLE_DEVICES=<gpu_ids> <python> bench/... --help'
```

Then run one RSI subprocess experiment with `--runner subprocess`, not
`--mock`; mock never executes the adapter.

## 7. Hand off

Report:

- the generated files and the installed target path;
- the discovery table (entrypoints, metric parser, baseline);
- the exact smoke command and observed JSON;
- env vars the user must set;
- remote host, `gpu_ids`, timeout, and whether the server is offline;
- anything not validated (for example, full 38k-step training).

Do not claim the adapter is scientifically valid from a tiny smoke run. It
only proves the plumbing.

## Files in this skill

```text
skills/rsi-adapter/SKILL.md
skills/rsi-adapter/scripts/scaffold_adapter.py
skills/rsi-adapter/templates/run_experiment.py.tmpl
skills/rsi-adapter/templates/setup.sh.tmpl
```

## Anti-patterns

- Editing `src/rsi/` for one project, or importing `integrations/` from core.
- Returning `reported_metrics` or a constant as the experiment result.
- Catching every exception and writing the baseline metric.
- Adding a new dependency to the target repo without a lock/offline check.
- Running the full benchmark for `subset` because it is easier.
- Putting `--train-steps`, `--batch-size`, or model paths in both
  `experiment_command` and `remote.env`.
- Claiming a remote run works without an SSH/rsync smoke test.
