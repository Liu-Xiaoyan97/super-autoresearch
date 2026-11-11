---
description: Run the ScientistTwo/RSI closed research loop on a problem JSON
argument-hint: "[problem.json] [mode:mock|provider]"
---
Run the RSI research loop on `${1:-examples/ood_frozen_encoder.json}`.

Steps:

1. Call `rsi_research` with `problem: "${1:-examples/ood_frozen_encoder.json}"`,
   `mode: "mock"`, `out: "runs"`, `seed: 7`. Report the run_id, h_best, review
   score, meta decision, and decision path.
2. Call `rsi_inspect` for that run_id. Do not dump `state.json` into the
   conversation.
3. Call `rsi_replay` and report whether the decision path reproduces.
4. If the user asked for a real run (`${2:-mock}` is `provider`), ask before
   spending model calls. Then call `rsi_research` again with
   `mode: "provider"`, `thinking: "low"`, `max_llm_calls: 60`,
   `max_wall_time_s: 1800`, and the same problem/out/seed.
5. Summarize the artifact root and the manuscript path. State explicitly that
   the simulated runner is synthetic and that acceptance is an internal gate,
   not scientific validation.
