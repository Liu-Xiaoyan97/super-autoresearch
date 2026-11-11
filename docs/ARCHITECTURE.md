# Architecture (as built)

Companion to `docs/SPEC.md` (the contract) and `docs/analysis/*.md` (the paper
extraction). This file describes what the TypeScript Pi package *actually* does.
It is a port of the original Python 3.11 implementation, which is no longer in
this tree; the field names and artifact contract are unchanged.

---

## 1. Layers

```
Pi session (pi-agent) = the one foreground agent
  └─ extensions/rsi.ts                         extension entry
       ├─ rsi_research / rsi_superagent / rsi_inspect / rsi_replay   tools
       ├─ /rsi                                  command
       ├─ src/rsi/superagent/                   the superagent protocol
       │    ├─ model.ts store.ts policy.ts      domain, durability, gate
       │    ├─ sop.ts                           §3.1–§3.6 as stages and rules
       │    ├─ engine.ts                        tickets, assignments, reports
       │    ├─ executor.ts runtime.ts           workers, SOP driver, run session
       │    └─ tools.ts prompts.ts              foreground actions, prompts
       └─ src/rsi/run.ts                        shared run/inspect/replay API
            ├─ providers/superagent.ts          PiWorker + SuperagentLLMProvider
            ├─ providers/pi.ts                  ctx.modelRegistry.complete()
            ├─ providers/mock.ts                deterministic offline provider
            ├─ providers/openai.ts              CLI-only OpenAI-compatible transport
            └─ core/orchestrator.ts             the state machine
```

The extension is a normal Pi package (`package.json` → `pi.extensions`). It has
no runtime npm dependencies; Pi supplies `@earendil-works/pi-coding-agent` and
`typebox`. `npm install` is only for `typescript` and `@types/node` during
development.

Model routing has two modes:

- `agents=subagent` (default): every agent call opens one **task ticket** whose
  Executor is `PiWorker` — a Pi session with its own system prompt, isolated
  in-memory history, the `rsi_report` tool, and an optional tool allowlist.
  `ideas.novelty` and `integrity.refs` get `web_search` (provider-native,
  `pi-web-search`); all other workers stay offline.
- `agents=inline`: the same task tickets get `InlineWorker`, which calls
  `ctx.modelRegistry.complete()` in-process with a one-message context.

A run is a **run ticket** executed by the SOP driver; both ticket kinds share
one Engine, one policy and one durable store. `docs/SUPERAGENT.md` is the
protocol reference.

Both resolve the same route and credential through Pi, and both pass the Pi
session id (opencode-go requires `x-opencode-session`).

---

## 2. Control layer

```
run.ts::runResearch
  └─ Orchestrator.run()                        core/orchestrator.ts
       ├─ limitations()                        §3.1  → stage.limitations / limits.ok:N
       ├─ seedIdeas()                          §3.1  → seeds:N (h0 + ranked pool)
       ├─ baseline()                           §3.2  → baseline.ok + baseline.full.ok
       ├─ ideaSearch()                         §3.2+§3.3
       │    ├─ evaluate(top-N0 seeds, 0)
       │    ├─ for k in 1..K: evolve(R_<k) ∪ next N_e seeds → evaluate
       │    └─ abort when 0 Good after K     ("no_good_ideas")
       ├─ select()                             §3.3  → select:<id> / state.adopt
       ├─ ablations()                          §3.4  → ablation.good|refine → keep|adopt
       ├─ draftAndReview()                     §3.5  → peer.r0:7.3 → peer.r1:8.6
       ├─ metaReview()                         §3.6  → meta.accept | meta.refine → keep|adopt
       └─ exportArtifacts()                    → state.json, traces.jsonl, final.json, *.tex
```

Every transition is one `TraceStore.append(kind, {token, ...})`, which is why
`rsi_replay` / `scientisttwo replay` can rebuild the exact decision path with
**no model and no workspace**.

`core/stage.ts::stage()` is the paper's Listing 1 loop. The orchestrator does not
use `stage()` for every step (the §3.2 flow is a two-tier pipeline, not a single
loop), but the primitive is kept, tested, and used wherever a flat critic/refine
loop applies.

---

## 3. Agents

Every agent is a class in `src/rsi/agents/` with a stable `task` key (offline
dispatch + traces) and a model `role`. In subagent mode, each call opens an
isolated Pi session with the agent's system prompt.

| Agent | task key | Model role | Paper | Decides with |
|---|---|---|---|---|
| `LimitationExtractor` | `limitations.extract` | default | §3.1 | LLM (+ dedupe) |
| `LimitationVerifier` | `limitations.verify` | default | §3.1 | LLM + `minLimitations` floor |
| `InitialIdeaGenerator` | `ideas.initial` | default | §3.1 | LLM |
| `NoveltyChecker` | `ideas.novelty` | default | §3.1 | LLM; `noveltyRefs` |
| `IdeaGenerator` | `ideas.expand` | default | §3.1 | LLM |
| `IdeaEvolver` | `ideas.evolve` | default | §3.3 | LLM over Good **and** Bad traces |
| `BaselineCoder` | `code.baseline` | coding | §3.2 | workspace only |
| `SubsetCoder` | `code.subset` | coding | §3.2 | workspace only |
| `FullSetCoder` | `code.full` | coding | §3.2 | workspace only |
| `IdeaImplementer` | `code.implement` | coding | §3.2 | **pure control flow** |
| `SubsetCritic` | `critic.subset` | default | §3.2 | `isStrictlyBetter` + `subsetMargin` |
| `FullSetCritic` | `critic.full` | default | §3.2 | `isStrictlyBetter` |
| `SubsetEngineer` | `engineer.subset` | coding | §3.2 | LLM patch, ≤ `maxEngRounds` |
| `FullSetEngineer` | `engineer.full` | coding | §3.2/§3.4/§3.6 | LLM patch |
| `ResultComparison` | `critic.compare` | — | §3.4/§3.6 | **no LLM call at all** |
| `Selector` | `critic.selector` | default | §3.3 | deterministic ranking |
| `AblationPlanner` | `ablation.plan` | default | §3.4 | LLM, `nAblationPlans` |
| `AblationCoder` | `code.ablation` | ablation | §3.4 | workspace + component model |
| `AblationCritic` | `ablation.critic` | default | §3.4 | numeric attribution + LLM veto |
| `InitialDrafter` | `write.draft` | default | §3.5 | LLM + evidence ledger |
| `PeerReviewer` | `review.peer` | default | §3.5 | LLM, score ∈ [1,10] |
| `RebuttalPlanner` | `review.rebuttal_plan` | rebuttal | §3.5 | LLM |
| `RebuttalCoder` | `code.rebuttal` | rebuttal | §3.5 | workspace |
| `PaperEnhancer` | `write.enhance` | draft_enhancer | §3.5 | LLM, rebuttal evidence only |
| `SpecAuditor` | `integrity.spec` | default | §4.3 | deterministic first, LLM may add |
| `ReferenceAuditor` | `integrity.refs` | default | §4.3 | deterministic token check first |
| `MethodCodeAuditor` | `integrity.method_code` | default | §4.3 | lexical floor; model may raise |
| `MetaReviewer` | `review.meta` | default | §3.6 | LLM + structural validation |

Model routing follows Appendix A.2: `coding`, `ablation`, `rebuttal`,
`draft_enhancer` map to the coding route; everything else to `default`. In
offline mode both routes point at `MockLLMProvider`.

---

## 4. One idea's life (data flow)

```
Idea(h, mechanism, direction_ids, domain_fit)
  │  SubsetCoder: write_patch(C_base, patch⊃hypothesis+mechanism)
  ▼
RepoRef C_sub ──workspace.run(subset)──► ExperimentResult(metrics) ──► Evidence(E_sub)
  │                                                                       │
  │                                        SubsetCritic ◄───── isStrictlyBetter
  │                                            │ good / engineer / bad
  │                         ┌──────────────────┴───────────────┐
  ▼                         ▼                                  ▼
FullSetCoder          SubsetEngineer (≤2)                  prune (BAD)
  │                         │
  ▼                         └──► back to SubsetCoder
RepoRef C_full ──run(full)──► Evidence(E_full) ──► FullSetCritic ──► Trace(h,E*,d,r)
                                                                     │
                                                     SpecAuditor ────┤ (violation ⇒ forced BAD)
                                                                     ▼
                                                                R (state.traces)
```

`Evidence` is the only carrier of numbers; `Trace` is the unit §3.3 evolves from.

### Git worktrees and executable commits

`SubprocessRunner` runs locally; `RemoteRunner` uses `rsync` to copy the
candidate worktree to a GPU server and `ssh` to execute
`Problem.experiment_command` there, exporting `CUDA_VISIBLE_DEVICES` from
`remote.gpu_ids`. The server never needs network or a git remote. See
`docs/REMOTE.md`.

`GitWorkspace` treats the target project as an **external git repository**. It
creates one `git worktree` per run at `runs/<run_id>/worktree` from
`Problem.repo` / `Problem.repo_ref` (default `HEAD`), and every candidate is a
branch + commit in that repository:

```
target repo (external)                runs/<run_id>/worktree
├── rsi/<run>/h1-subset-1             one checkout, reused per candidate
├── rsi/<run>/h1-full-2
└── ...
```

No per-candidate file copies exist. `RepoRef` records `repo`, `commit`, `branch`
and the parent commit; `diff()` is `git diff parent..commit`. Coding agents get a
bounded source brief from the candidate commit and return a **unified diff**;
`writePatch` applies it with `git apply`, commits the result on a candidate
branch, and leaves the parent untouched on failure. A prose/failing patch creates
no commit and is logged under `patches/`.

The benchmark is decoupled too: RSI core only runs
`Problem.experiment_command` (placeholders `{scope}`, `{out}`, `{repo}`,
`{commit}`) in the worktree, or the default `python3 run_experiment.py ...`.
There is no project-specific import or injected runner in `src/rsi/`.

### Web retrieval

`pi-web-search` is installed in the container and configured through
`container/pi-home/web-search.json` (dedicated `opencode-go/gpt-5.6-luna` search
model). Only retrieval agents load extensions; generation/critique agents run
with `noExtensions` and no tools, so search results cannot leak into the
empirical gates.

---

## 5. Terminations

| Condition | Result | Code |
|---|---|---|
| ≥ `successTarget` Good ideas | proceed to select | `ideaSearch` |
| 0 Good after `maxRefineRounds` | `aborted=true`, `no_good_ideas` | `ScientificAbort` |
| baseline execution failed | `aborted=true`, `baseline_failed` | `baseline` |
| 0 eligible seeds after guidance filtering | `aborted=true`, `no_eligible_seeds` | `seedIdeas` + `run` |
| seed pool short but non-empty | `seeds.partial:N`, **continues** | `seedIdeas` |
| ablation `REFINE` and no strict improvement | keep incumbent, continue to drafting | `ablations` |
| review ≥ threshold or `maxPeerRounds` | stop rebuttal loop | `draftAndReview` |
| meta `Refine` and no strict improvement | `meta.keep`, export incumbent (`accepted=false`) | `metaReview` |
| meta `Accept` | export (`accepted=true` if integrity clean) | `metaReview` |
| budget hit | `aborted=true`, `max_*` | `BudgetExceeded` |

`aborted=true` means *the science dead-ended*. A non-improving refinement is
**not** an abort — it is the paper's "terminate using the previous best outputs"
branch.

---

## 6. Deterministic vs. model-owned decisions

| Purely numeric (no model can flip) | Model may add concerns |
|---|---|
| `ResultComparison` (adoption, I2) | `SubsetCritic` / `FullSetCritic` rationale |
| `Selector` ranking | `AblationCritic` (can veto GOOD) |
| `SpecAuditor.hardViolations` | `SpecAuditor` extra violations |
| `ReferenceAuditor.unknownRefs` | `ReferenceAuditor` extra violations |
| `MethodCodeAuditor.lexicalAlignment` floor | `MethodCodeAuditor` upward refinement |
| `verifyScores` | — |

This asymmetry is deliberate: a model may **block** a promotion, never **cause** one.

---

## 7. Decisions taken where the paper is silent

| Topic | Our choice | Where |
|---|---|---|
| Round-0 batch | exactly top-`n0` seeds | `config.n0` |
| `N_seed`, `N0`, `N_meta` | 8, 2, 2 | `config.ts` |
| Subset screening margin | 2% relative (`subsetMargin`) | `config.ts` |
| "strictly better" | no metric regresses beyond tolerance **and** ≥1 improves | `types.isStrictlyBetter` |
| Exploration guidance | soft weight on ranking, hard only with `strictDirections` | SPEC §2b |
| Offline gain model | `U[-0.10, 0.40)` ⇒ ≈80% positive, calibrated to 80.4% | `runtime/workspace.ts` |
| Bounded metrics | headroom-proportional gain × `HEADROOM_GAIN` | `runtime/workspace.ts` |
| Ablation contribution | deterministic 2–11% drop; rare dead component (~5%) | `agents/coding.ts` |
| Budget charging | only the agent that calls `workspace.run` charges | `agents/coding.ts` |
| Engineering rounds | two per **idea**, shared by subset and full-set loops | `config.engineeringBudgetScope` |
| Review budget across meta rounds | reset per new draft | `core/orchestrator.ts` |
| Manuscript claims | dropped when unsupported (never resurrected) | `agents/writing.ts` |
| Integrity alignment | 0 if the deterministic check finds no support | `agents/integrity.ts` |

Every remaining `CONTRACT-GAP` comment in the Python reference marks a place
where the frozen contract could not express something; the TypeScript port keeps
the same workaround.

---

## 8. Extension points

* **New domain** → drop a `Problem` JSON in `examples/` (see SPEC §7.3). Add
  `bounds` to any metric that has a physical range.
* **New provider/model** → Pi already has it: pass `provider` / `model` to
  `rsi_research`, or add a `ModelRoute` in `config.ts`. The extension never
  stores credentials.
* **New agent** → subclass `BaseAgent`, add it to `AgentBundle` / `buildAgents`,
  and wire it in `Orchestrator`. `MockLLMProvider` synthesizes its envelope.
* **New output envelope** → add a `StructuredSpec` in `schemas.ts` with a
  tolerant parser, a fallback, and a JSON shape instruction.
* **Real execution** → `runner: "subprocess"`; `Problem.experiment_command`
  runs in the candidate worktree and writes `{"metrics": {...}}` to `--out`.
  The target project owns its benchmark harness; RSI core does not import it.
  See `examples/dfm_ssm_external.json` and the optional adapter template in
  `integrations/dfm_ssm/`.
* **One context per problem.** `AgentContext` holds a single `Problem` and
  `scratch.baseline` / `scratch.baseline_full` are deliberately unqualified.
  Reusing a context for a different problem would reuse that problem's baselines.
  Build a fresh context per run.

---

## 9. Port provenance

The TypeScript package is a port of the original Python 3.11 implementation. The
port preserves:

- frozen field names and the JSON artifact contract;
- the deterministic simulated-runner formula (CRC32, headroom compensation,
  80% positive calibration);
- strict adoption, subset margin, engineering-budget scope, ablation
  attribution, integrity checks;
- replay from traces alone.

Intentional differences:

- the offline mock provider is explicit and task-keyed instead of Python
  reflection, so mock ids/values are deterministic but not byte-identical;
- TypeScript uses external git repositories, per-run worktrees, candidate
  branches/commits, and `Problem.experiment_command`; the Python reference copied
  snapshots and recorded patches without executing them;
- the test suite is `node:test`; there is no second language runtime to keep in
  sync.
