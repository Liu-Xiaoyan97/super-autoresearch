# Superagent protocol

RSI used to fan out with bare subagents. Every agent call opened a Pi session,
returned its text, and left no domain record: nothing said who was allowed to
spend the call, what it was working on, whether it was still running, or why it
failed. This layer replaces that with the protocol of
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype).

The result is **one foreground agent**: the Pi session you talk to. It does not
run research. It accepts one request, hands it to the SOP, and relays what comes
back. Everything else is a worker.

```
person ──▶ foreground agent (this Pi session)
                │  rsi_research → accept
                ▼
        run ticket  (the SOP, §3.1 … §3.6, §4.3)
                │  every agent call is a task ticket
                ▼
        worker sessions (Pi or in-process) ──▶ report
                │
                ▼
        foreground agent  ◀── result / question / failure
```

The protocol is a port, not a dependency: no DSH package, no Source for GitHub
or Feishu, no web panel. What was reused is the part that carries the work:
Sources, Triggers, Threads, Policy and gate, Eval and decisions, Mandates,
Tickets, Assignments, Subscriptions, structured Reports and Attentions.

## Vocabulary

| Prototype | RSI |
| --- | --- |
| Source | `human`, `cli`, `schedule`, `experiment`, `review`, `system` |
| Trigger | one immutable event: a request, a benchmark result, a review note, a resume |
| Thread | the request thread, or a run's own thread (`run:<run_id>`) |
| Channel | the chat the foreground agent answers in; run artifacts on disk |
| Policy | the versioned accept mode, Source parts and SOP rules |
| Eval / Decision | the gate over a Trigger; `accept`, `ignore`, `stop`, `unavailable` |
| Mandate | why one ticket may act, and how far: strength, basis, scope, rules, policy version |
| Ticket | `run` (one research request) or `task` (one agent call of the SOP) |
| Assignment | one execution of a ticket: a worker session or the SOP driver |
| Subscription | a ticket following a thread; its triggers fan out as inputs |
| Report | `progress`, `waiting`, `ready`, `blocked`, `failed`, `dropped` |
| Attention | the one question that blocks a ticket until a person answers |
| Executor | `PiWorker` (a Pi session) or `InlineWorker` (an in-process model call) |

One run has one `run` ticket. Its Executor is the **SOP driver**, which runs
`runResearch` and reports progress while it advances. Every model call inside
the SOP is a `task` ticket whose Executor is one worker: the subagent of old, now
with a mandate, an assignment, an attempt count and a structured report.

## Authorization

The gate answers who may originate work. The policy is versioned; a change
re-queues undisposed triggers and reaches every live run.

| Accept mode | Effect |
| --- | --- |
| `off` | nothing inferred starts; explicit requests still do |
| `observe` (default) | an inferred candidate is assessed; a positive assessment is recorded as “would accept” and nothing runs |
| `auto` | a positive assessment of an inferred candidate accepts it |

A Trigger is explicit when a person addresses the agent, or follows up on a
thread that already has a ticket. An automated trigger (a benchmark result, a
review note, a cron) is never explicit: it may continue a subscribed ticket, but
it cannot authorize new work.

### Highest permission (trusted container)

`runner=subprocess` is blocked by `sop.experiment` (`person`). For a trusted
development container, grant the highest profile explicitly:

```text
/rsi policy allow
```

or start Pi with:

```bash
RSI_SUPERAGENT_POLICY=yolo pi
```

`yolo` means `acceptMode: auto`, every SOP rule `auto` (including experiments),
and every Source enabled. It is equivalent to:

```text
rsi_superagent { action: "policy", allow: true }
```

Use it only in an environment you control; the numeric gates are unchanged.

Inside an accepted run, each SOP stage has a rule. The rule's level says who must
be behind the step:

| Level | Meaning |
| --- | --- |
| `auto` | the SOP may do it inside any accepted run |
| `explicit` | only when a person explicitly asked for this run (`sop.spend`) |
| `observe` | recorded as “would do” unless a person explicitly asked (`sop.export`) |
| `person` | never without a fresh answer; the run blocks with an Attention (`sop.experiment`) |

The paper's numeric gates are **outside** the policy. A mandate can allow a
model call or an export; it can never make a candidate strictly better than the
reproduced baseline. `isStrictlyBetter`, `ResultComparison`, `Selector`,
`AblationCritic`, `SpecAuditor`, `ReferenceAuditor`, `MethodCodeAuditor` and
`verify_scores` stay exactly as they were. A model can block a promotion, never
cause one.

## Reports and attention

A worker returns one envelope:

```json
{ "state": "ready", "summary": "one sentence", "output": { "text": "<the answer>" } }
```

or `state: "blocked"` with one `question`, or `state: "failed"` with the real
error. A `ready` or `dropped` report ends the task ticket; `blocked` and
`failed` hold it open for a retry or an answer.

A question becomes an **Attention** on the ticket. It survives later progress
reports and clears only when a person answers (`rsi_superagent action=answer`)
or a report explicitly clears it. The foreground agent forwards the question
unchanged; it never answers a technical question itself.

The foreground agent hears about a run only when it ends, blocks, fails, or asks
something. Task-level progress stays internal — it is in
`runs/<run_id>/superagent/state.json` and `events.jsonl`, not in the chat.

## Tools

| Tool | Purpose |
| --- | --- |
| `rsi_research` | accept a request as one run; returns the run and ticket ids immediately (`wait: true` blocks) |
| `rsi_superagent` | `status`, `tickets`, `ticket`, `events`, `policy`, `answer`, `note`, `retry`, `stop`, `attach` |
| `rsi_inspect` | a finished run's summary, or protocol status while it runs |
| `rsi_replay` | prove the decision path reproduces from traces alone |
| `/rsi` | the same surface for a person at the prompt |

Dispatch is idempotent per session and request; a second identical call returns
the existing run. `retry` starts a new assignment on the same ticket; for a run
ticket that means re-running the SOP in the same directory. `stop` is a person's
stop and withdraws the mandate. A run that ended remains immutable. An
aborted or failed run can be continued with `resume`: a new `-rN` attempt
restores the persisted state/traces, records `resumed_from`, and keeps the old
ticket as the audit record. A partially completed stage is rerun; this is not
automatic mid-turn replay.

## Durability and recovery

Each run writes:

```
runs/<run_id>/superagent/
  state.json     triggers, threads, tickets, decisions, dispositions, policy
  events.jsonl   append-only domain events, in order
```

Every command is one atomic snapshot write, so a crash never leaves half a
decision behind. On restart, a live assignment is recorded as interrupted: a
`run` ticket reports `blocked` with a recovery question, task tickets report
`failed`. Nothing is silently replayed.

## Prompt assembly

| Part | Read by | File |
| --- | --- | --- |
| `orchestrator` | foreground agent | `prompts/superagent/orchestrator.md` |
| `dispatch`, `replies` | foreground agent | `prompts/superagent/dispatch.md`, `replies.md` |
| `worker` | every worker, appended to its task prompt | `prompts/superagent/worker.md` |
| `policy` | generated last from the live policy | `prompts/superagent/policy.md` |
| `environment` | generated per run | `prompts/superagent/environment.md` |

The files are the only source: `src/rsi/superagent/prompts.ts` reads them and
throws when one is missing, so an incomplete package fails loudly instead of
running workers on an empty contract. The policy section is regenerated on every
change, so editing prompt text never freezes a stale rule.

## What is deliberately absent

- **No GitHub or Feishu Source.** RSI's events are research events: a request, a
  benchmark result, a review note, a schedule. A deployment that needs GitHub or
  Feishu adds a Source; the domain does not change.
- **No panel.** The foreground agent and `/rsi` read the same state.
- **No automatic mid-turn replay.** A run is one SOP turn. A manual `resume`
  restores persisted stage state into a new attempt; it does not replay an
  unfinished worker turn.
- **No second authority layer.** The numeric gates remain the only path to an
  incumbent, and policy only decides who may spend or export.

## Code map

| File | Role |
| --- | --- |
| `src/rsi/superagent/model.ts` | domain types and pure helpers (ticket stage, liveness) |
| `src/rsi/superagent/store.ts` | memory and file repositories, `atomic`, event log |
| `src/rsi/superagent/policy.ts` | gate, accept modes, rule verdicts, version hash |
| `src/rsi/superagent/sop.ts` | §3.1–§3.6 + §4.3 as stages, tasks and rules |
| `src/rsi/superagent/engine.ts` | intake, pass, accept, assignments, reports, attention, recover |
| `src/rsi/superagent/executor.ts` | Executor port, task/run/composite executors, inline worker |
| `src/rsi/superagent/runtime.ts` | `RunSession`, the SOP driver, the runtime a tool holds |
| `src/rsi/superagent/tools.ts` | the `rsi_superagent` action handlers |
| `src/rsi/superagent/prompts.ts` | prompt parts and the generated policy section |
| `src/rsi/providers/superagent.ts` | `PiWorker` (Pi sessions) and `SuperagentLLMProvider` |

Tests: `tests/superagent-protocol.test.ts` (domain, gate, store, SOP mapping)
and `tests/superagent-run.test.ts` (provider, runtime, tools). Both are offline.
