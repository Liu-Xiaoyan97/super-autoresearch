---
description: Run the ScientistTwo/RSI closed research loop as a superagent run
argument-hint: "[problem.json] [mode:mock|provider]"
---
Run the RSI superagent on `${1:-tests/fixtures/ood_frozen_encoder.json}`.

Steps:

1. Call `rsi_research` with `problem: "${1:-tests/fixtures/ood_frozen_encoder.json}"`,
   `mode: "mock"`, `out: "runs"`, `seed: 7`, and no `wait`. It returns a
   `run_id` and a `ticket_id` immediately; the SOP runs as task tickets.
2. Tell the user the run id and what the SOP will produce. Do not wait inside
   the turn, and do not narrate progress: a report arrives when the run ends,
   blocks, or fails.
3. When the report arrives, call `rsi_superagent action=status` for that
   `run_id`. Report the outcome (accepted, exported incumbent, aborted), the
   evidence that decided it, and the artifact root. Do not dump `state.json`.
4. If the run asks a question, forward it unchanged and use
   `rsi_superagent action=answer` with the person's answer. A new run does not
   resume blocked work.
5. If the user asked for a real run (`${2:-mock}` is `provider`), confirm the
   spend first. Then call `rsi_research` with `mode: "provider"`, `thinking:
   "low"`, `max_llm_calls: 60`, `max_wall_time_s: 1800`, and the same
   problem/out/seed.
6. After a finished run, call `rsi_replay` and report whether the decision path
   reproduces. State explicitly that the simulated runner is synthetic and that
   acceptance is an internal gate, not scientific validation.
