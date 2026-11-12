# ScientistTwo — Reimplementation Spec (v0)

Faithful reimplementation of **ScientistTwo: Pioneering the Human Knowledge Frontier with
Autonomous AI** (arXiv:2609.19644, Google Cloud AI Research, 2026).

Scope: the full §3.1 → §3.6 closed-loop pipeline (the "recursive self-improvement" core: every
stage = `candidate → critic → refine`, and the outer loops are gated by *strict empirical
improvement*, never by the model's own opinion).

Implementation status (v1): the runnable product is a **deeply integrated native Pi
(pi-agent) extension**, not a standalone application, in
TypeScript under `extensions/` + `src/rsi/`. It has no runtime npm dependencies; model calls go
through Pi's provider registry (inheriting the active session's selected provider/model and
thinking unless explicitly overridden) or the deterministic offline provider. It is a port of the original Python 3.11 implementation (no longer kept in this
tree); field names, artifact JSON, and the invariants below are unchanged.

---

## 0. Non-negotiable design invariants

| # | Invariant | Paper source |
|---|---|---|
| I1 | Every stage is `stage(candidate, critic, refine, max_rounds)` with verdicts `{accept, refine, reject}` | Listing 1 |
| I2 | A candidate is only adopted into core state `(h_best, E_best, C_best)` if it is **strictly better** than the incumbent on the benchmark metrics (Result Comparison Agent) | §3.4, §3.6 |
| I3 | Improvement is judged against the **measured** baseline (a reproduction or a validated incumbent), never the paper's reported number | §3.2 |
| I4 | Subset before full-set (cost control), and an idea that cannot pass the subset is pruned after `N_eng` engineering rounds | §3.2 |
| I5 | Exploration is preserved: every evolution round mixes evolved ideas with untouched top-novelty seeds | §3.3 |
| I6 | Abort the whole run when 0 ideas reach `Good` after `K` rounds | §3.3 |
| I7 | Manuscript acceptance requires reviewer score ≥ 8 **and** meta-review `Accept`; rebuttal is experiment-backed, not text-only | §3.5, §3.6 |
| I8 | All state transitions are logged as append-only JSONL traces so any run is replayable off-line | reproducibility requirement |

---

## 1. Module layout and file ownership

```
package.json                        Pi package manifest (pi.extensions/skills/prompts)
extensions/rsi.ts                   extension entry: rsi_* tools + /rsi command
docs/SPEC.md                        contract (frozen)
docs/analysis/*.md                  paper analysis
src/rsi/
  types.ts                          CONTRACT: domain models (frozen)
  config.ts                         CONTRACT: all hyperparameters (frozen)
  schemas.ts                        tolerant model-output envelopes + JSON shapes
  providers/base.ts                 CONTRACT: LLMProvider + StructuredSpec
  providers/pi.ts                   Pi model-registry provider
  providers/superagent.ts           PiWorker (Pi sessions) + SuperagentLLMProvider
  providers/mock.ts                 deterministic offline provider
  providers/openai.ts               CLI-only OpenAI-compatible transport
  runtime/workspace.ts              experiment execution (simulated + subprocess)
  runtime/store.ts                  ArtifactStore / TraceStore (JSONL)
  runtime/budget.ts                 counters + hard stops
  core/stage.ts                     generic critic/refine loop
  core/state.ts                     ResearchState + transitions
  core/orchestrator.ts              the §3.1→§3.6 state machine
  agents/base.ts                    CONTRACT: BaseAgent + AgentContext
  agents/limitations.ts             LimitationExtractor, LimitationVerifier
  agents/ideas.ts                   InitialIdeaGenerator, NoveltyChecker, IdeaGenerator, IdeaEvolver
  agents/coding.ts                  BaselineCoder, SubsetCoder, FullSetCoder, RebuttalCoder, AblationCoder, IdeaImplementer
  agents/critics.ts                 SubsetCritic, FullSetCritic, ResultComparison, Selector
  agents/engineering.ts             SubsetEngineer, FullSetEngineer
  agents/ablation.ts                AblationPlanner, AblationCritic
  agents/writing.ts                 InitialDrafter, PaperEnhancer
  agents/review.ts                  PeerReviewer, RebuttalPlanner, MetaReviewer
  agents/integrity.ts               §4.3 Integrity audit (score / spec / refs / method-code)
  run.ts                            shared run/inspect/replay API
  cli.ts                            `rsi run|replay|inspect|list`
tests/                              node:test suite (offline, no network)
tests/fixtures/*.json               synthetic offline fixtures
examples/*.json                     real/external project fixtures
skills/rsi-research/SKILL.md        agent operating instructions + superagent protocol
skills/rsi-adapter/SKILL.md         directly complete target code + generate target-owned adapter
prompts/rsi-research.md             /rsi-research template
container/                          pi-agent container + Kiri helpers
```

**Ownership rule for parallel implementers:** you may only edit the files assigned to you, and you
must not change any signature in a CONTRACT file. If a contract looks wrong, add a `# CONTRACT-GAP:`
comment and implement around it — do not edit the contract.

### Target-owned integration contract [EXTENSION]

- RSI ships generic native Pi tools, skills and runtime contracts, not
  project-specific integrations. Existing `examples/*.json` remain examples.
- `/skill:rsi-adapter examples/<project>.json --repo /path/to/independent/target`
  directly inspects target code and fills incomplete real data, training,
  checkpoint save/reload, and lm-eval metric paths on an independent candidate
  branch/ref. A wrapper around missing functionality is not a completed adapter.
- The target owns its canonical bench command, project evaluator helpers,
  regression tests and `.rsi/adapter/<project>.json` / `<project>.md`. No project
  helper implementation or tests are copied into RSI.
- Optional deterministic generation:

  ```bash
  python3 skills/rsi-adapter/scripts/scaffold_adapter.py \
    --problem examples/<project>.json \
    --repo /path/to/independent/target \
    --name project
  ```

  This writes the canonical target command path (normally
  `bench/rsi_project_train_eval.py`) and target `.rsi/adapter/project.json` /
  `project.md`. It does not certify readiness or install RSI-side integrations.
- After committing the implementation, point the test Problem's `repo_ref` at
  that candidate. Only a remote real-data tiny end-to-end pass makes the tested
  commit/ref deliverable as a usable `repo_ref`.

### Native adapter smoke contract [EXTENSION]

```text
/rsi smoke examples/<project>.json --repo /path/to/independent/target --timeout 900 --env RSI_PROJECT_TRAIN_STEPS=1 --env RSI_PROJECT_TRAIN_BATCH_SIZE=1
```

The native extension tool `rsi_adapter_smoke` accepts `problem`, `repo`,
`timeout_s`, optional fresh evidence directory `out`, and an `env` object.
Repeated command `--env KEY=VALUE` flags are per-smoke overrides, not fixture
edits. Budget variables must be supported by the target; the tool does not guess
or automatically shrink training/evaluation budgets.

The gate uses real GitWorkspace worktree creation, rsync, SSH RemoteRunner and
raw JSON collection/metric validation without an LLM. It must cover real-data
tiny training, checkpoint save and reload in a fresh evaluation process, and
real lm-eval metrics with the declared keys and finite values. Missing assets,
failed training/reload/evaluation or invalid metrics fail the gate; help, mocks,
dry-runs and evaluation-only of an existing checkpoint cannot substitute.

Explicit `out` must not exist; configured remote worktree/out templates must
include `{run_id}`. Evidence records the tested commit/ref, expanded command,
original metric output, train/eval logs and checkpoint paths. Failed delivery
remains `blocked / remote not verified`; success is `remote-smoke-passed`, not
proof of scientific improvement or a formal baseline. See `docs/REMOTE.md` for
preflight and artifact details. These readiness gates do not weaken I2/I3 or
replace the full §3.1–§3.6 SOP below.

---

### Native bounded iteration contract [EXTENSION]

`rsi_iteration` (or `/rsi iterate <problem>`) is an explicitly bounded alternative
to the full SOP, not an automatic shortcut inside it. Required: `problem` (exact
JSON path/inline JSON with `repo_ref`). Optional: `repo`, `out` (fresh directory),
`env` (string-valued overrides), `provider`/`model`/`thinking` (active Pi session),
`max_tokens` (all-role output cap), `coding_max_tokens` (coding-role override),
`seed` (7), `protected_paths`
(additional repo-relative immutable paths/globs). Command flags use hyphens;
repeat `--env KEY=VALUE` / `--protected-path PATH`. No public `mode`, `runner`,
mock, transport override or background dispatch parameter exists.

The extension injects the session's real `PiLLMProvider` registry route and abort
signal into `runIteration`. Live spending/coding/experiment policy must permit
the call; person-level authority requires fresh UI confirmation (or an explicit
policy grant before headless execution). It runs only immutable baseline subset
and one genuinely changed candidate subset, both under identical authorized
small-budget env, metrics, dataset, evaluator/tokenizer and data protocols.
No full benchmark, ablation, paper, retry cycle or simulated fallback is allowed.
The target remains responsible for real train → checkpoint save/reload → eval.

The synchronous result reports actual `executed`/`failed` status and
`accepted`/`rejected`/`error` outcome with summary, iteration, protocol and evidence
paths. Rejection is successful execution (`isError: false`), never an improvement
claim. Failure retains available evidence (`isError: true`). Bounded subset
acceptance is not manuscript acceptance and does not weaken I2/I3/I7.

### Native model inheritance and output-cap contract [EXTENSION]

- `rsi_research`, `rsi_iteration`, `/rsi run` and `/rsi iterate` inherit the
  current Pi provider/model/thinking unless explicitly overridden. `RSI_MODEL`
  and `RSI_CODING_MODEL` are user route preferences, not forced package defaults.
- Optional positive-integer `max_tokens` (`--max-tokens N`) sets the all-role
  output cap; `coding_max_tokens` (`--coding-max-tokens N`) overrides coding.
  Omitted caps retain ordinary Pi native request policy/model capability with
  no RSI 8192 default or arbitrary 131072 ceiling. `0` / `null` do not mean max.
- Explicit caps work in native `PiWorker` children and inline/bounded calls,
  within the selected model's output capability. The historical 8k inline cap
  must not be attributed to children that previously ignored the payload cap.
- Regression expectations: inherited DeepSeek metadata stays at configured
  **1M context / 384000 max output**, with no default model-object mutation;
  omitted caps do not introduce an RSI 8k cap; explicit `8192` and `384000` are
  honored subject to model capability; session thinking reaches inner calls.
  A lower-capacity selected model must still bound an explicit larger request.
- Capacity is not required output length: audited Pi 1.5.2 defaults to model.maxTokens
  and clamps to remaining context. No promise of 384k generated tokens on
  every call, mandatory full-source loading, or a new passed real-model test.
- Task isolation, protected protocols, tool scopes, wall/call budgets and
  spending/GPU experiment authority are preserved. A training budget of two
  steps is independent of LLM capacity; it neither shrinks the model nor grants
  all workers shell/GPU rights.

## Agent output style: STE-RSI

Every non-code agent output is held to a deterministic subset of ASD-STE100
(Simplified Technical English). The aerospace dictionary is not applied; the
three writing rules are:

1. **One term for one thing.** Metric names, ids, paths and component names are
   copied exactly. `word ppl` for `word_ppl` is a violation.
2. **One claim per sentence.** Descriptive sentences have at most 25 words;
   actions and feedback at most 20. A semicolon that joins two claims is a
   violation.
3. **Active, explicit wording.** No vague quantities (`significantly`, `several`,
   … without a number), no unsupported comparisons (`better` without a metric and
   value), no marketing terms, and prose fields must not contain JSON or code.

Mechanics: agents answer with one JSON object whose keys are the requested
schema. The three rules apply to the human-readable **string values** inside
that JSON (hypotheses, feedback, evidence, questions), not to the JSON keys or
the report envelope. A statement that states an unmeasured expectation or
comparison must start with `Hypothesis:`; that marker exempts it from the
number and comparison rules (it is not a measured claim), while term
consistency, sentence length, active voice and the marketing ban still apply. The rules are injected into each agent
system prompt and the worker prompt, then linted after parsing. Two targeted
repair attempts receive the exact violation list and must leave compliant
values unchanged; a third violation raises `StyleViolationError` and fails the
task. Every check is recorded as `style.ok` / `style.violation` in
`traces.jsonl`, so replay covers style as well.

Exemptions: `code.*` patch outputs (they are unified diffs). For the manuscript,
academic prose is exempt; only `claims[].text` and their `evidence_ref` are
checked. Unmeasured statements must be labelled `hypothesis`.

## 2. Pipeline state machine

```
                      ┌─────────────── §3.2 ───────────────┐
 problem G  ─────────►│ baseline on subset  → E_base, C_base│
                      │ optional diagnose_command → findings│──► measured defect ranking
                      └────────────────────────────────────┘
                                     │
                      ┌─────────────── §3.1 ───────────────┐
                      │ findings + limitation loop (≤16)   │──► H0 (depth: 1; breadth: N_seed)
                      └────────────────────────────────────┘
                                     │
                      ┌─────────────── §3.2 ───────────────┐
                      │ for h in top-N0:  A_Coder(G,h)      │──► R0
                      └────────────────────────────────────┘
                                     │
                ┌──────────────────── §3.3 ────────────────────┐
                │ k = 1..K:  Hk = A_Evolve(R_<k) ∪ next N_e seeds│
                │            A_Coder for each h in Hk           │
                │ stop when |{d=Good}| ≥ S  → A_Selector → h_best│
                │ stop when k = K and 0 Good → ABORT            │
                └───────────────────────────────────────────────┘
                                     │
                ┌──────────────────── §3.4 ────────────────────┐
                │ A_Plan → N_p ablations → A_AblCoder → E_abl   │
                │ d_abl = Good → finalize                       │
                │ d_abl = Refine → A_FullEng → A_Compare        │
                │   if E_new > E_best: replace state, re-plan   │
                │   else: keep incumbent, stop                  │
                │ (≤ N_abl refinement passes)                   │
                └───────────────────────────────────────────────┘
                                     │
                ┌──────────────────── §3.5 ────────────────────┐
                │ A_Draft → P;  s_i = A_Reviewer_i(P), i=1..3   │
                │ while any(s_i < 8) and round < N_peer:        │
                │   A_RebPlan → A_RebCoder → E_reb              │
                │   P = A_Enhancer(P, R, E_reb); s_i = review_i │
                └───────────────────────────────────────────────┘
                                     │
                ┌──────────────────── §3.6 ────────────────────┐
                │ d_meta = A_Meta(P, R)                         │
                │ Accept → export (P⁺, C⁺)                      │
                │ Refine → A_FullEng(r_meta) → A_Compare        │
                │   better → update state, redo §3.4+§3.5       │
                │   not better → discard, export incumbent      │
                │ (≤ N_meta)                                    │
                └───────────────────────────────────────────────┘
```

`A_Coder` (unified idea implementer) is the composition
`BaselineCoder → SubsetCoder → SubsetCritic → (SubsetEngineer ≤ N_eng) → FullSetCoder → FullSetCritic/Engineer`
and returns `(idea, Evidence, RepoRef, Decision, feedback)` — one record per idea, appended to `R`.
Subset screening runs `subset_seeds` independent seeds (default 3) at the same
95-step screen budget; a candidate is `bad` only when **every** seed is worse
than the subset baseline on the primary metric. A failed or invalid run is an
implementation repair (`max_repairs`, default 2), not a scientific engineering
round: it enters the coding loop without consuming `max_eng_rounds`.

### Two loops and the data gate

- **Code loop**: baseline → limitations/seeds → idea search → select → ablations.
  It keeps searching until the **data gate** is met: at least `minGoodTraces`
  independent full-set Good traces across at least two rounds, **and** the
  ablation critic accepts the attribution. A candidate is never compared
  against an unreproduced or unpromoted number.
- **Paper loop**: only after the data gate. Draft → three independent reviewers
  (novelty, empirical validity, reproducibility) → rebuttal mini-experiments →
  manuscript enhancement → re-review. The loop stops only when **every**
  reviewer score reaches `reviewThreshold` and meta-review accepts, or the
  `maxPeerRounds` / `maxReviewRefinements` budget is exhausted.
- **Gate failure**: if the code loop exhausts its budget before the gate, the
  run aborts (`data_gate_not_met`) and writes no paper. Evidence, incumbent
  metrics and traces are still exported.

---

## 2b. Exploration guidance [EXTENSION — not in the paper]

The paper lets the agent wander freely. We add a first-class steering layer so a researcher can say
*"work in this domain, along these reference directions"* without weakening any empirical gate.

```json
{
  "domain": "time series forecasting",
  "subfield": "zero-shot / retrieval-augmented",
  "directions": [
    {"id": "d1", "title": "spectral priors", "description": "DMD/FFT constraints on the forecast",
     "keywords": ["DMD", "spectral"], "weight": 1.0, "must_include": false},
    {"id": "d2", "title": "safety gating", "description": "no-harm fallback vs frozen backbone",
     "keywords": ["gate", "calibration"], "weight": 0.8, "must_include": true}
  ],
  "forbidden": ["finetuning the backbone"]
}
```

Rules:

| G# | Rule |
|---|---|
| G1 | Guidance is **injected into generation only** (§3.1 idea gen, §3.3 evolver, §3.4 planner, §3.5 framing). It never touches a critic's arithmetic. |
| G2 | `NoveltyChecker` emits `domain_fit ∈ [0,1]` alongside `novelty_score`; ranking is `novelty_score + guidance_weight * domain_fit` (paper: novelty only, so `guidance_weight=0` reproduces the paper). |
| G3 | Ideas with `domain_fit < min_domain_fit` are dropped when directions exist. |
| G4 | `must_include: true` + `strict_directions: true` (`--strict-directions`) ⇒ an idea that touches none of the hard directions is rejected at seed time, regardless of novelty; if nothing survives, the run aborts with `no_eligible_seeds` rather than exporting an untested incumbent. |
| G5 | Guidance must be **auditable**: every `Idea` records `direction_ids`, and the manuscript must state which direction it advances. |
| G6 | The offline `SimulatedRunner` includes a deterministic `domain_fit` term in its metric model, so guided vs. unguided runs are observably different in tests. |

---

## 2c. §4.3 Integrity audit (paper pp.13-15, Table 7)

The paper verifies papers/codebases on four dimensions and introduces three auditors:

| Dimension | Metric | Where | Rule |
|---|---|---|---|
| Score verification | reproducible claims (↑) | `integrity.verify_scores` | every claimed number must come from an `Evidence` that ran successfully with finite metrics |
| Specification compliance | spec violations (↓) | `SpecAuditor` | checked **immediately after** an experiment; a violating idea is discarded before it can win (p.14) |
| Reference verification | hallucinated refs (↓) | `ReferenceAuditor` | a citation with no token overlap against the known bibliography is unverified |
| Method-Code alignment | alignment (↑) | `MethodCodeAuditor` | fraction of manuscript claims lexically supported by the code diff, floored by the deterministic score, capped at 1.0 |

Rules: deterministic checks run first and cannot be cleared by a model; `combine()` accumulates
violations and takes the **minimum** alignment. Alignment < 0.5 only warns — it never blocks export,
because blocking is a scientific judgement, not an integrity one. `FinalArtifacts.integrity` carries
the merged report (`types.IntegrityReport`).

---

## 3. Frozen domain models (`types.py`)

See code. Summary:

| Model | Purpose |
|---|---|
| `MetricSpec(name, direction, tolerance)` | metric + optimize direction + noise tolerance |
| `ResearchDirection(id, title, weight, must_include, keywords)` | user-provided steer for exploration [EXTENSION] |
| `Problem` | task G: statement, domain, directions, datasets, metrics, subset spec |
| `Limitation` | one diagnosed weakness of the human SOTA |
| `Idea` | hypothesis + mechanism + novelty score + `domain_fit` + `direction_ids` + lineage |
| `Evidence` | one measured result (scope, metrics, code ref, log ref) |
| `Trace` | `(Idea, [Evidence], Decision, feedback)` — unit of §3.3 evolution |
| `Verdict` | critic output: decision + feedback + optional metrics |
| `AblationPlan` / `AblationResult` | component-level experiments |
| `Review` / `MetaReview` | reviewer artifacts (1–10 scale) |
| `Manuscript` / `Claim` | drafted paper + verifiable claims |
| `FinalArtifacts` | `P⁺`, `C⁺`, reviews, metric summary |

`is_strictly_better(new, base, metrics, tol)` in `types.py` is the **single** definition of I2.

---

## 4. Frozen LLM contract (`providers/base.py`)

```python
class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, req: LLMRequest) -> LLMResponse: ...
    async def structured(self, req: LLMRequest, schema: type[TModel]) -> TModel: ...
```

`LLMRequest.task` is a **stable string key** (defined as `BaseAgent.task` on every agent). The mock
provider dispatches on it, so every agent MUST set a unique `task` classvar.

Output-schema rule, stated precisely:

* every **top-level** schema an agent passes to `ask()` MUST be constructible from `{}` (envelope
  models such as `IdeaBatch`, `AblationPlanBatch`, `_DraftOutput`, `Verdict` — all verified by
  `tests/`), so a malformed model reply degrades instead of crashing;
* **nested domain models** (`Idea`, `Claim`, `Limitation`, ...) legitimately have required fields.
  The offline provider synthesizes those fields; an agent must never rely on `{}` validating a
  domain model directly.

---

## 5. Agent contract

Every agent:
- subclasses `BaseAgent`, sets `NAME` and `task`,
- exposes **typed async methods** (no stringly-typed dispatch),
- never touches the filesystem directly (use `ctx.store` / `ctx.workspace`),
- returns pydantic models from `types.py`,
- charges `ctx.budget` for every LLM call.

---

## 6. Hyperparameters (paper-grounded)

From §3 and Appendix A.2 (page 30):

| Param | Value | Source |
|---|---|---|
| `max_limitation_rounds` | 16 | "We extract limitations for a maximum of 16 rounds" |
| `n_candidates_per_round` | 2 (1 seed + 1 evolved) | "we evaluate two candidates: one selected from the seed ideas and the other an evolved idea" |
| `max_refine_rounds` K | 4 | "for up to four rounds" |
| `success_target` S | 4 | "terminating early once four successful ideas are obtained" |
| `max_eng_rounds` N_eng | 2 | "engineering techniques for at most two rounds"; invalid-run repairs do not consume it |
| `max_repairs` | 2 | [CHOICE] bounded code/interface repairs for invalid runs |
| `max_ablation_rounds` N_abl | 1 | "we refine the idea at most once"; the TypeScript port records one subset-only attribution pass and never refines via a full run |
| `review_threshold` | 8.0 / 10 | "terminates early if the ScholarPeer review score reaches 8" |
| `max_peer_rounds` | 2 | "peer-review simulation runs for at most two rounds" |
| `max_review_refinements` | 1 | "review-based refinement conducted at most once" |
| `novelty_refs` | 2 | "retrieves two reference papers" |
| `n_ablation_plans` N_p | 5 | [INFERENCE] from §B Table 15 ("5–6 ablations per paper"); the paper never states N_p. `AblationPlanner.plan(n=...)` overrides it per call |
| `venue_format` | ICLR 2025 | A.2 |

Unspecified in the paper (our choice, documented in `config.py`): `N_seed = 8`, `N0 = 2`,
`N_k = 1`, `N_e = 1`, `N_meta = 2`, `N_t = max(1, len(review.questions))`.

**Citation note:** Listing 1 and Table 1 are on **p.5** (the stage abstraction); Figure 3 is on
p.4; Figure 7 and the meta-review prose are on p.9; A.2 is on p.30.

### 6b. Paper ambiguities and how we pin them

| Ambiguity | Resolution |
|---|---|
| §3.3 writes `R0` over all of `H0` but the prose evaluates only top-`N0` | round 0 evaluates **exactly** top-`n0`; unevaluated seeds stay available for exploration |
| A.2 says every round is "one seed + one evolved", but round 0 cannot evolve (no traces exist yet) | round 0 is seed-only (`n0` seeds); rounds `k >= 1` are `n_evolved` evolved + `n_explore` untouched seeds |
| A.2's "up to four rounds" vs §3.3's `k = 0` bootstrap | `max_refine_rounds = 4` counts **refinement** rounds (`k >= 1`), so a full run has up to 5 evaluation batches / 10 candidates; set `--max-refine-rounds 3` for the "4 total rounds" reading |
| Novelty cutoff exists ("filtering for those with high novelty", p.5) but no number is given | `min_novelty = 0.35` (`[CHOICE]`); the gate itself is paper-grounded, the threshold is ours |
| `N_p`, `N_t`, numeric `N_meta` never stated | `[INFERENCE]`/`[CHOICE]` defaults above, all overridable |
| A.2 caps peer review at 2 rounds, but Table 5 numbers rounds beyond 2 | config value is authoritative (`max_peer_rounds=2`); the table is treated as a variant setting |
| Which reference does the full-set gate compare against? | **a measured full-benchmark baseline**, not the subset one (Table 1: subset → "reproduced baseline", full-set → "original SOTA"). The orchestrator measures the subset baseline at `baseline.ok` and the full baseline lazily on the first candidate that passes subset (`baseline.full.ok`, or at `select` on resume); unit tests that drive `IdeaImplementer` alone fall back to `ctx.scratch["baseline"]` |
| A.2's two engineering rounds: per idea, or per stage (subset + full-set)? | **per idea, shared** by both loops (`engineering_budget_scope="per_idea"`, the literal reading of "the Idea Critic Agent ... at most two rounds"); `"per_stage"` restores 2+2 |
| Ablation `Refine` before the paper | no full refinement; the attribution gate blocks drafting (`data_gate_not_met`) |
| Meta `Refine` exhausted / not strictly better | keep incumbent, export with `accepted=False` (paper: "termination using the previous best outputs") |
| "consistently outperforms" / "substantially inferior" have no numeric definition | `subset_margin` + `is_strictly_better` tolerances, both configurable |
| Reviewer score scale (integer vs real) | real-valued in `[1, 10]`; threshold inclusive (`>= 8`) |
| A.2's "review-based refinement conducted at most once" — per run, or per manuscript? | **per peer-review cycle**: each §3.6 meta-refine produces a new draft, so the §3.5 budgets (`max_peer_rounds`, `max_review_refinements`) reset for it. Aggregate enhancements are bounded by `(max_meta_rounds+1) * max_review_refinements` |
| Metadata says `Accept` but the review score is below the venue bar | never claim acceptance: export with `accepted=False`, reason `peer_review_below_threshold` (I7) |

---

## 7. Offline determinism requirements

The suite must pass with **no network and no API key**.

### 7.1 `MockLLMProvider`

1. Dispatches on `LLMRequest.task`. A JSON script (`examples/mock_script.json`, shape
   `{task: {...}}` or `{task: [{...}, ...]}`) may pin exact outputs; **unscripted tasks must
   still produce valid, non-empty, deterministic output** so the pipeline runs end-to-end.
2. Generic synthesizer: introspect the target pydantic schema and fill it deterministically from
   `hash(seed, task, meta)`:
   * `list[Model]` fields get `meta.get("n", 1)` items (agents MUST pass `n=` in `ask(..., n=...)`);
   * `id` fields get `f"{prefix}-{i}"`; `float` fields get `round(rng.uniform(lo, hi), 3)` bounded by
     field constraints; `str` fields get short task-specific templates (never `""` for text fields);
   * enums/`Literal`s use their first member, except where the field name implies a decision
     (`decision`, `verdict`) — those cycle deterministically so both accept and refine paths are
     exercised across a run.
3. `MockLLMProvider.calls` must record `(task, meta)` for assertions; `last(task)` returns the last
   request.

### 7.2 `SimulatedRunner`

The metric model is specified in `runtime/workspace.py`'s module docstring and is **part of the
contract**: tests assert on it. Baseline values come from `Problem.reported_metrics` (falling back
per metric if absent). `domain_fit` participates, so a guided run and an unguided run differ.

### 7.3 Fixtures (`examples/*.json`)

A fixture is a plain serialized `Problem` (see `types.Problem`), e.g.:

```json
{
  "id": "ood-frozen-encoder",
  "statement": "Improve out-of-distribution detection for a frozen encoder.",
  "domain": "OOD detection",
  "source_paper": "X-Mahalanobis (Wei et al., 2025)",
  "datasets": ["cifar10", "cifar100", "imagenet-r"],
  "subset_datasets": ["cifar10"],
  "metrics": [{"name": "auroc", "direction": "max", "tolerance": 0.002}],
  "reported_metrics": {"auroc": 0.87},
  "directions": [{"id": "d1", "title": "geometric alignment", "weight": 1.0}],
  "forbidden": ["retraining the encoder"]
}
```

Required fixtures: `tests/fixtures/ood_frozen_encoder.json` (happy path), `tests/fixtures/abort_case.json`
(0 Good ideas ⇒ abort), `tests/fixtures/meta_refine.json` (meta-review Refine that improves the metric).

The TypeScript extension extends the fixture with project-neutral fields:

- `repo` — path to an **external git repository** (never a copy inside RSI);
- `repo_ref` — baseline ref, default `HEAD`; `code.baseline` treats it as the
  unmodified reference, so an empty patch is the normal answer. If the worker
  cannot write a diff, `baseline.patch.skipped` is recorded and the base commit
  still runs; a `blocked` report still waits for a person;
- `experiment_command` — command template executed in the candidate worktree
  (`{scope}`, `{out}`, `{repo}`, `{commit}`, `{python}`), default
  `python3 run_experiment.py --scope {scope} --out {out}`;
- `diagnose_command` — optional read-only analysis on the reproduced baseline,
  same placeholders and execution surface (local or rsync/SSH). It must write
  `{"status":"ok","findings":[{"id","title","axis","evidence","severity",
  "actionable","measured",...}]}`; at least one `measured: true` finding is
  mandatory. The stage runs before limitations and seeds; with
  `searchPolicy: "depth"` (default) only the highest-severity defect is pursued.
  Project-specific math stays in the target repository; RSI core never imports it;
- `remote` — optional rsync + SSH GPU execution (`host`, `dir`, `python`,
  `gpu_ids`, `env`, `timeout_s`);
- `budget` — target-declared screening budget:
  `{ "full_steps": 954, "subset_fraction": 0.1, "subset_max_steps": 200,
  "steps_env": "RSI_CORAL_TRAIN_STEPS", "seed_env": "RSI_CORAL_SEED" }`. The
  subset command receives
  `max(1, min(floor(full_steps * subset_fraction), subset_max_steps))` in
  `steps_env` (95 for the Coral fixture) and each screen seed in `seed_env`;
  subset and component ablations share the screen budget, while full/rebuttal
  keep the complete budget. Ablations run only at the subset budget and compare
  against the candidate's subset control; they never launch a full 954-step run.
  Without `budget`, the target adapter's own default applies.
- `remote.timeout_s` also bounds the local SSH client; an abort or timeout
  terminates the remote process group, not just the local client.

Baseline reuse: `rsi_research`/`runResearch` accept `baseline` (a trusted
baseline JSON or incumbent ledger) and otherwise load a protocol-matching
`incumbent-<problem>-<scope>.json` from the **project baseline store**, not from
a run directory. The default is `~/.rsi/projects/<project-key>/` (project key =
problem id + repo hash); `RSI_BASELINE_DIR` points at an external cache; a
repo-less simulated problem falls back to `<out>/.rsi/baseline`. The initial
measured subset/full baseline is persisted there, and adopting a better
candidate promotes it to that scope. All runs for the project share the same
store; old run-local ledgers are migrated on first load. The full baseline is
lazy: it is measured only when a candidate first reaches full. The paper's
`reported_metrics` is never used as a baseline.

Each candidate is a branch + commit in that repository, checked out through one
per-run `git worktree`; `RepoRef` records `repo`, `commit`, `branch`, and the
parent commit. RSI core never imports the target project. `repo_ref` must
contain the target-owned bench command and its dependencies; a generated but
unimplemented or remotely unverified adapter is not a usable ref.

**These fixtures are synthetic.** The task framing of the first one mirrors the paper's
Procrustes-DS case study, but its numbers are placeholders and it is *not* a reproduction of that
run. See README §"Fidelity: what the case study actually shows".

### 7.4 CLI

```
node src/rsi/cli.ts run <fixture.json> [--mock] [--out runs] [--seed 7] [--max-refine-rounds N]
node src/rsi/cli.ts inspect <run_id>
node src/rsi/cli.ts replay <run_id>
```

`run` flags: `--runner {simulated,subprocess}`, `--strict-directions`,
`--max-refine-rounds N`, `--max-review-refinements N`, `--script <json>`, `--provider`.

`run` prints a one-screen summary: limitations found, seeds, per-round `id → decision`, chosen
`h_best`, ablation verdict, review scores per round, meta decision, and artifact paths.
`replay` must reproduce the same `decision_path` from `traces.jsonl` alone (no model calls) and
exit non-zero on mismatch.

---

## 8. Definition of done (v0)

- [x] `npm test` green offline — 101 tests, no network, no API key.
- [x] `node src/rsi/cli.ts run tests/fixtures/ood_frozen_encoder.json --mock` completes §3.1→§3.6 and
      prints the decision path + review scores.
- [x] Abort path (`0 Good after K rounds`) covered: `tests/fixtures/abort_case.json`, exit code 2.
- [x] Meta-review `Refine` that improves E updates the state (`adopt.meta:*`) — scripted fixture test.
- [x] Meta-review `Refine` that does **not** improve E discards the refinement (I2) — covered.
- [x] `replay` rebuilds the decision path from `traces.jsonl` alone and fails on mismatch.
- [x] Integrity audit wired: spec violations force `BAD` right after experimentation; refs +
      method-code alignment merged into `FinalArtifacts.integrity`.
- [x] Exploration guidance (domain + reference directions) threaded through §3.1/§3.3 and the offline
      simulator, with `guidance_weight = 0` reproducing the paper's pure-novelty ordering.
- [x] `docs/ARCHITECTURE.md` maps module → agent → paper section, including the decisions taken
      where the paper is silent.
