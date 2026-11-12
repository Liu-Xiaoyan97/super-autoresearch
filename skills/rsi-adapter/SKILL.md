---
name: rsi-adapter
description: Complete a target repository's real training, checkpoint and evaluation paths, generate its target-owned benchmark adapter from a Problem fixture, then verify the entire small-budget train/save/reload/lm-eval pipeline on the remote execution host through native RSI Pi tools. Use for new or incomplete target integrations, CLI/data mapping failures, and adapter regeneration.
---

# Target-owned adapter integration for the RSI Pi extension

RSI is a **Pi extension**, not a collection of project-specific launch scripts.
This skill runs inside Pi and uses Pi's file/bash tools and native RSI tools.
Generate all project-specific code **directly in the target repository**. Do not
create `integrations/<project>` in RSI, import target code into `src/rsi/`, or
require a standalone Node driver as the public workflow.

The user authorizes this skill to modify the target repository: complete missing
real data loading, CLI wiring, training, checkpoint save/reload, evaluation,
metric artifacts and validation so it works with the current harness. Do not
stop at "the project has no eval" if its specified metric can be implemented
with the real official/existing evaluator. Do not invent a metric, split,
checkpoint format, placeholder score or proxy. Ask only when the scientific
protocol is genuinely unspecified or a resource decision is needed.

**Definition of done:** real data → complete small-budget training → newly
saved checkpoint → load that checkpoint → real lm-eval (or the fixture's real
equivalent) inference → finite, exact metric report, through actual rsync/SSH.
`--help`, mock tests, an existing checkpoint, and checkpoint-only eval cannot
satisfy this gate. Small budget means a complete short run, not skipped stages.

## 1. Read the fixture and inspect the target

Read the entire Problem JSON first. Extract `repo`, `repo_ref`, the exact
`experiment_command`, scopes/datasets, metric names/direction/bounds, forbidden
changes, `remote` host/Python/GPU/env/setup/excludes/timeouts and output paths.
Use fixture paths as hints, not proof that they match the actual target.

Inspect actual train/eval CLI, data loader/schema/split, model and checkpoint
loader, metric implementation/artifact and existing tests **before writing**.
Use structural navigation where available, then file reads/search. Record:

```text
source commit / dirty changes:
real train command and required arguments:
real eval command and metric JSON key:
dataset schema, split and path on execution host:
checkpoint save and reload format:
tokenizer/model/cache assets on execution host:
subset and full budgets / unchanged metric protocol:
missing implementation and compatibility repairs:
```

Never assume old HEAD matches the user's current working tree. Preserve dirty
changes: use an independent integration branch/worktree. If current worktree
and committed source differ materially, confirm which is the intended baseline.
Snapshot authorized changes on the independent branch without resetting,
cleaning, stashing or committing the source working tree.

## 2. Implement the target-owned pipeline

Typical target layout (exact adapter path comes from `experiment_command`):

```text
<target>/
  bench/rsi_<project>_train_eval.py
  bench/rsi_job_worker.py          detached job executor (protected, synced)
  <project train/data/checkpoint/eval modules and tests>
  .rsi/adapter/<project>.json     contract, protected protocol paths
  .rsi/adapter/<project>.md       commands, env, repairs, acceptance evidence
```

Use the deterministic skeleton if useful (resolve this script relative to the
skill directory; the command below assumes an RSI checkout):

```bash
python3 skills/rsi-adapter/scripts/scaffold_adapter.py \
  --problem examples/<project>.json \
  --repo /path/to/independent/target --name <project>
```

The helper writes directly into the **existing target git repository**; it does
not install a second copy into RSI or create a `setup.sh`. A skeleton still has
TODOs and is not implemented. Fill them and repair missing target code. Keep
helper evaluators, project-specific regression tests and docs in the target.

The adapter contract is:

```text
<remote.python> bench/rsi_<project>_train_eval.py --repo PATH --scope subset|full|ablation|rebuttal --out REPORT.json
```

1. Resolve repo and run every target command with `cwd=repo`. Use
   `sys.executable` for Python children; print shell-quoted commands. Verify
   target imports resolve to the synced candidate, not an older server checkout.
2. Put project knobs in `RSI_<PROJECT>_*` env (`remote.env` injects on execution
   host); do not duplicate budget/path flags in `experiment_command`.
3. Map scopes explicitly. Subset must be cheaper but retain metric definition,
   tokenizer, context and test split. Full/rebuttal use declared full budgets;
   unsupported ablation fails clearly. Both subset and full must actually work
   under the harness's normal invocation, not require an undocumented smoke flag.
4. Preserve training schedule meaning for short runs (e.g. early-stop budget
   rather than invalidating warmup). Save the **requested final step**, not an
   older convenient checkpoint. Reload it for evaluation and verify step/state
   consistency. An explicit existing checkpoint is supplementary eval-only work.
5. If an old evaluator hardcodes a training budget incompatible with legitimate
   subset scope, add explicit validated per-scope budget configuration; record
   actual budget. Keep the original real scoring math, task and normalization.
   Never rename checkpoints or bypass integrity checks to make it pass.
6. For lm-eval use the fixed real task and its own metric, e.g.
   `results[task]["word_perplexity,none"]`, mapped to the exact fixture key.
   Reject missing/extra keys, booleans, strings, nonfinite or out-of-bounds
   values; do not clamp, reuse stale reports or substitute reported_metrics.
7. Keep offline dependencies/assets local; no implicit network fallback. Respect
   `CUDA_VISIBLE_DEVICES`; device indices are relative to the assigned devices.
8. Write success and failure reports atomically; any failure exits nonzero with
   empty metrics. Keep bounded command output and persisted train/eval logs
   outside the candidate source. Handle timeout/cancellation without orphaning
   GPU subprocesses.

Success report includes auditable pipeline details:

```json
{
  "status": "ok",
  "metrics": {"<exact-fixture-name>": 12.34},
  "details": {
    "scope": "subset",
    "training_skipped": false,
    "executed_train_steps": 1,
    "checkpoint": "/remote/output/train/checkpoint-1",
    "checkpoint_step": 1,
    "raw_metrics": "/remote/output/eval.json",
    "logs": {"train": "/remote/output/train.log", "eval": "/remote/output/eval.log"}
  }
}
```

The numbers above are schema examples, never measurement evidence. On failure:
`{"status":"failed","metrics":{},"error":"actual cause"}`.

Also add a **real measured diagnosis** owned by the target:
`bench/rsi_<project>_diagnose.py` (or an existing analysis command) that reads
the reproduced baseline and writes `{"status":"ok","findings":[{"id","title",
"axis","evidence","severity","actionable","measured","metric","value",
"artifact"}]}`. It must measure actual signals on real data (loss decomposition,
activation/gradient statistics, error slices, throughput, …), not restate the
paper. At least one finding must be `measured: true`; explicitly label
unmeasured ideas `measured: false`. Declare it in the fixture's
`diagnose_command` with the same `{python}/{repo}/{out}` placeholders as
`experiment_command`. Read-only and bounded; project math never moves into RSI.
The stage runs after baseline reproduction and before limitations/seeds; the
default depth policy then pursues only the highest-severity measured defect.

Ship `bench/rsi_job_worker.py` (the skill template) unchanged: RSI submits a job,
launches that worker with `setsid nohup`, and reads `events.jsonl` plus the atomic
`result.json`. The worker owns claim/GPU-lock/heartbeat/timeout/cancel only; it
contains no project math. Add it to `protected_paths`; candidates must not edit it.

Declare `env_prefix` and nonempty `protected_paths` in the target's
`.rsi/adapter/<project>.json`: adapter,
evaluation/scoring implementation, protocol configs and manifest. Freeze these
for downstream optimization. Honor `<env_prefix>_SEED` (or generic `RSI_SEED`)
and record the actual seed in report details; paired iteration rejects a seed
that differs from the requested seed, rather than merely labeling it differently.
Integration repairs happen before acceptance;
candidates may not quietly change the acceptance test to manufacture gains.
Do **not** freeze the entire research implementation: model and optimizer code
normally remain mutable under the fixture's scientific constraints. List intended
research files in `mutable_paths` for clarity, keep them out of `protected_paths`,
and verify at least one meaningful allowed change is possible before handoff.
If stronger checkpoint/trace validation is added, update positive mocked fixtures
to provide those explicitly synthetic artifacts; negative tests must reach their
intended failure stage. Failing contract tests are a blocker, not an acceptable
"mock-only" caveat.

## 3. Preflight and commit a reproducible candidate

Run target regression tests, syntax/help and missing-asset failure checks.
On the **execution host**, verify SSH, actual Python imports and CLI, readable
real data batches/schema/split, tokenizer/model/cache loading, writable output
and free assigned GPU capacity. Existing path != loadable data. Never print
credentials, install packages/download assets without authority, overwrite a
server project or kill unrelated jobs.

Remote sync uses `rsync --delete`: use unique normalized per-run worktree and
output paths; output must be **outside** the synced worktree so later candidate
syncs do not erase baseline evidence. Do not use path traversal or shared output
filenames/directories across runs. Validate fixture excludes do not omit required
source files; datasets/checkpoints are remote assets, not source to sync.

Commit target code/tests/manifest on an independent **candidate integration**
ref. Verify the resolved commit contains every required adapter/helper file.
Untracked files in another checkout are not part of the deployed candidate.
Use a candidate fixture/reference until acceptance; a candidate commit is not
already a usable baseline.

## 4. Mandatory remote acceptance gate — native Pi tool

Call **`rsi_adapter_smoke`** in the current Pi session, or use the human command:

```text
/rsi smoke examples/<project>.json --repo /path/to/target --timeout 900 --env RSI_<PROJECT>_TRAIN_STEPS=1 --env RSI_<PROJECT>_TRAIN_BATCH_SIZE=1
```

Tool equivalent:

```json
{
  "problem": "examples/<project>.json",
  "repo": "/path/to/target",
  "timeout_s": 900,
  "env": {"RSI_<PROJECT>_TRAIN_STEPS": "1", "RSI_<PROJECT>_TRAIN_BATCH_SIZE": "1"}
}
```

Use only knobs implemented by the target. Explicitly configure a safe complete
small training budget and supported evaluation limit when needed; never silently
launch the fixture's full training schedule. A limited lm-eval inference still
uses real test data and real metric math; identify it as plumbing-only, not a
formal performance score. If no safe short run exists, ask for budget.

This tool creates a fresh git worktree from `repo_ref`, performs actual rsync,
executes one real SSH experiment and fetches the original report. No LLM or
simulated runner produces the metric. The tool validates transport/report; the
skill must additionally inspect evidence that training was not skipped, the
new checkpoint exists and was reloaded, and real lm-eval inference ran.

Retain `artifacts/smoke-summary.json`, `artifacts/smoke-report.json`, expanded
remote invocation and target train/eval/checkpoint metadata. Test missing assets
**remotely** too: require nonzero exit and failed/empty-metrics report. On error,
fix target code/wiring, commit and rerun in a fresh output directory.

Acceptance states are separate: `scaffolded` → `implemented` → `candidate
committed` → **`remote-smoke-passed`**. Do not proceed to downstream optimization
or promote a usable `repo_ref` before the entire gate passes. SSH/GPU/assets or
ambiguous scientific protocol blockers are `blocked / remote not verified`, with
exact failed command/error, not "done; user can test later".

**Adapter acceptance ends at `remote-smoke-passed`.** Do not launch
`rsi run`, `rsi iterate`, subset screening, full benchmarking, ablations or
paper writing as part of this skill. Those are separate RSI research stages and
require a new, human-authorized run. The adapter's subset/full scope support is
implemented and contract-tested here; it is not validated by running the
research loop in this skill.

## 5. Handoff and regeneration test

Report the target-only files/repairs/tests, exact validated commit/ref, host/GPU,
small-budget settings, measured JSON, evidence locations and untested scope.
After acceptance identify/promote the **same tested commit** as the usable ref.
A tiny smoke proves compatibility, not scientific validity/full training quality.

If asked to delete and regenerate, back up evidence, delete only generated
adapter files in an independent target checkout from inside the container, then
invoke this skill afresh through Pi. Do not restore/copy the old adapter as the
"regeneration". Reinspect target APIs, generate/implement again, commit and rerun
real train → checkpoint save/reload → lm-eval before the regenerated version is
usable. Do not delete source/user changes, datasets, checkpoints or prior evidence.

RSI optimization is then invoked separately through the native Pi extension with
a real provider and subprocess runner, never mock, and the accepted target-owned
ref. That invocation is outside adapter acceptance: do not run it from this
skill. If the person only wants adapter usability, stop after `remote-smoke-passed`.
