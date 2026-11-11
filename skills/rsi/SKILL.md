---
name: rsi-research
description: Run or inspect the ScientistTwo/RSI closed research loop (limitations → ideas → experiments → ablations → paper) with the rsi_research, rsi_inspect, and rsi_replay tools. Use when the user asks for an autonomous research run, an experiment-backed paper draft, a reproducible research artifact tree, or wants to inspect/replay an existing run.
---

# RSI research loop

Use this skill when the user asks for an autonomous research run, a
ScientistTwo-style loop, an experiment-backed manuscript, or an audit/replay of
an existing run. The pipeline is implemented by this Pi package; the model
calls go through `opencode-go` (default `deepseek-v4.1-flash`).

## Tools

| Tool | Purpose |
|---|---|
| `rsi_research` | Run §3.1–§3.6 end-to-end and export `state.json`, `traces.jsonl`, `final.json`, code snapshots, LaTeX |
| `rsi_inspect` | Summarize a run: incumbent, decision path, review/meta, artifact paths |
| `rsi_replay` | Rebuild the decision path from traces only (no model, no workspace) and compare |
| `/rsi` | Human command: `run`, `inspect`, `replay`, `list`, `models`, `help` |

## Recommended workflow

1. **Dry run first.** Call `rsi_research` with `mode: "mock"` and the fixture
   path. This is deterministic, free, and reaches experiments in seconds.
2. **Inspect.** Call `rsi_inspect` with the returned `run_id` (and the same
   `out`). Confirm `h_best`, review scores, and the decision path.
3. **Real run.** Only after the dry run, call `rsi_research` with
   `mode: "provider"` (or omit `mode`). Set an explicit budget, for example
   `max_llm_calls: 60`, `max_wall_time_s: 1800`, `thinking: "low"`.
   Real runs take ~10–60 s per agent call depending on model and thinking.
4. **Replay.** Call `rsi_replay` to prove the decision path is reproducible
   from traces alone.
5. **Read artifacts** from the returned `root` when you need the manuscript,
   state, code snapshots, or the full trace.

## Minimal problem JSON

```json
{
  "id": "my-problem",
  "statement": "Improve X under constraint Y.",
  "domain": "time series forecasting",
  "source_paper": "the human baseline method",
  "datasets": ["etth1", "ettm1"],
  "subset_datasets": ["etth1"],
  "metrics": [
    { "name": "mse", "direction": "min", "tolerance": 0.01, "bounds": null }
  ],
  "reported_metrics": { "mse": 0.42 },
  "constraints": ["no extra training data"],
  "directions": [
    { "id": "d1", "title": "spectral priors", "description": "DMD/FFT constraints",
      "keywords": ["DMD"], "weight": 1.0, "must_include": false }
  ],
  "forbidden": ["finetuning the backbone"],
  "venue": "ICLR"
}
```

`metrics` drives every empirical gate. `reported_metrics` is context only: the
loop reproduces its own baseline and compares against that. `directions` are a
soft steer unless `strict_directions: true`; then `must_include` is a hard gate.

## Artifacts

```text
runs/<run_id>/
  state.json        full research state (contract: snake_case fields)
  traces.jsonl      append-only: every LLM call, transition, decision
  final.json        paper, review, meta-review, integrity, decision_path
  artifacts/        manuscript .tex, simulated/provenance experiment logs
  code/             baseline / subset / full / ablation snapshots (+ patch.txt)
```

## Guardrails

- Promotion requires a **strict measured improvement** over the reproduced
  baseline. A model can block a promotion but never cause one.
- `runner: "simulated"` is a deterministic synthetic benchmark, **not** a
  scientific result. `runner: "subprocess"` executes the problem repository's
  `run_experiment.py` (`--scope`, `--out`).
- `accepted: true` requires peer score ≥ threshold, meta `accept`, and a clean
  integrity audit. Otherwise the run exports the incumbent with an
  `export_reason`.
- `aborted: true` means a scientific dead end (`no_good_ideas`,
  `no_eligible_seeds`, `baseline_failed`, …) or a hard budget stop. It is an
  honest outcome, not a harness failure.
- Never claim the generated paper is accepted, novel, or empirically valid
  without independent real-benchmark evidence.

## Cost and model control

- Provider: `opencode-go` by default; override with `provider`.
- Default model: `deepseek-v4.1-flash`; coding-heavy roles can use
  `coding_model` (e.g. `kimi-k3`).
- `thinking`: subagent thinking level (default `low`; high values are slower).
- Budgets: `max_llm_calls`, `max_wall_time_s`, `max_refine_rounds`,
  `max_review_refinements`.
- `agents: "subagent"` (default) isolates each agent in its own Pi session;
  `agents: "inline"` uses nested model calls.

## Troubleshooting

- `no credential for opencode-go`: run `./container/up.sh creds` and restart
  the container; see `docs/PROVIDER.md`.
- `model ... is not available`: `pi --list-models`, then pass
  `provider`/`model` explicitly.
- A run stalls in `limits.*`: the limitation stage is still refining; raise the
  call budget or inspect the provider response in `traces.jsonl`.
