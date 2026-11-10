# ScientistTwo — Reimplementation Spec (v0)

Faithful reimplementation of **ScientistTwo: Pioneering the Human Knowledge Frontier with
Autonomous AI** (arXiv:2609.19644, Google Cloud AI Research, 2026).

Scope: the full §3.1 → §3.6 closed-loop pipeline (the "recursive self-improvement" core: every
stage = `candidate → critic → refine`, and the outer loops are gated by *strict empirical
improvement*, never by the model's own opinion).

Stack: Python 3.11+, asyncio, pydantic v2, zero required third-party runtime deps beyond pydantic.

---

## 0. Non-negotiable design invariants

| # | Invariant | Paper source |
|---|---|---|
| I1 | Every stage is `stage(candidate, critic, refine, max_rounds)` with verdicts `{accept, refine, reject}` | Listing 1 |
| I2 | A candidate is only adopted into core state `(h_best, E_best, C_best)` if it is **strictly better** than the incumbent on the benchmark metrics (Result Comparison Agent) | §3.4, §3.6 |
| I3 | Improvement is judged against the **reproduced** baseline, never the paper's reported number | §3.2 |
| I4 | Subset before full-set (cost control), and an idea that cannot pass the subset is pruned after `N_eng` engineering rounds | §3.2 |
| I5 | Exploration is preserved: every evolution round mixes evolved ideas with untouched top-novelty seeds | §3.3 |
| I6 | Abort the whole run when 0 ideas reach `Good` after `K` rounds | §3.3 |
| I7 | Manuscript acceptance requires reviewer score ≥ 8 **and** meta-review `Accept`; rebuttal is experiment-backed, not text-only | §3.5, §3.6 |
| I8 | All state transitions are logged as append-only JSONL traces so any run is replayable off-line | reproducibility requirement |

---

## 1. Module layout and file ownership

```
pyproject.toml                      infra
docs/SPEC.md                        contract (frozen)
docs/analysis/*.md                  paper analysis (3 research agents)
src/scientisttwo/
  types.py                          CONTRACT: domain models (frozen)
  config.py                         CONTRACT: all hyperparameters (frozen)
  providers/base.py                 CONTRACT: LLMProvider ABC (frozen)
  providers/mock.py                 impl: deterministic offline provider
  providers/openai_compat.py        impl: Kimi / vLLM / OpenAI-compatible
  runtime/workspace.py              impl: experiment execution (real + simulated)
  runtime/store.py                  impl: ArtifactStore / TraceStore (JSONL)
  runtime/budget.py                 impl: counters + hard stops
  core/stage.py                     impl: generic critic/refine loop
  core/state.py                     impl: ResearchState + transitions
  core/orchestrator.py              impl: the §3.1→§3.6 state machine
  agents/base.py                    CONTRACT: BaseAgent + AgentContext (frozen)
  agents/limitations.py             impl: LimitationExtractor, LimitationVerifier
  agents/ideas.py                   impl: InitialIdeaGenerator, NoveltyChecker, IdeaGenerator, IdeaEvolver
  agents/coding.py                  impl: BaselineCoder, SubsetCoder, FullSetCoder, RebuttalCoder, AblationCoder, IdeaImplementer
  agents/critics.py                 impl: SubsetCritic, FullSetCritic, ResultComparison, Selector
  agents/engineering.py             impl: SubsetEngineer, FullSetEngineer
  agents/ablation.py                impl: AblationPlanner, AblationCritic
  agents/writing.py                 impl: InitialDrafter, PaperEnhancer
  agents/review.py                  impl: PeerReviewer, RebuttalPlanner, MetaReviewer
  agents/integrity.py               §4.3 Integrity audit (score / spec / refs / method-code)
  cli.py                            impl: `scientisttwo run|replay|inspect`
tests/                              impl: pytest suite (offline, no network)
examples/*.json                     impl: offline fixtures
```

**Ownership rule for parallel implementers:** you may only edit the files assigned to you, and you
must not change any signature in a CONTRACT file. If a contract looks wrong, add a `# CONTRACT-GAP:`
comment and implement around it — do not edit the contract.

---

## 2. Pipeline state machine

```
                      ┌─────────────── §3.1 ───────────────┐
 problem G  ─────────►│ limitation loop (≤16)              │──► H0 (N_seed, novelty-sorted)
                      └────────────────────────────────────┘
                                     │
                      ┌─────────────── §3.2 ───────────────┐
                      │ baseline on subset  → E_base, C_base│
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
                │ A_Draft → P;  s = A_Reviewer(P)               │
                │ while s < 8 and round < N_peer:               │
                │   A_RebPlan → A_RebCoder → E_reb              │
                │   P = A_Enhancer(P, R, E_reb); s = review(P)  │
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
| G4 | `must_include: true` + `strict_directions: true` ⇒ an idea that touches none of the hard directions is rejected at seed time, regardless of novelty. |
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
| `max_eng_rounds` N_eng | 2 | "engineering techniques for at most two rounds" |
| `max_ablation_rounds` N_abl | 1 | "we refine the idea at most once" |
| `review_threshold` | 8.0 / 10 | "terminates early if the ScholarPeer review score reaches 8" |
| `max_peer_rounds` | 2 | "peer-review simulation runs for at most two rounds" |
| `max_review_refinements` | 1 | "review-based refinement conducted at most once" |
| `novelty_refs` | 2 | "retrieves two reference papers" |
| `n_ablation_plans` N_p | 5 | [INFERENCE] from §B Table 15 ("5–6 ablations per paper"); the paper never states N_p |
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
| A.2's two engineering rounds: per idea, or per stage (subset + full-set)? | **per idea, shared** by both loops (`engineering_budget_scope="per_idea"`, the literal reading of "the Idea Critic Agent ... at most two rounds"); `"per_stage"` restores 2+2 |
| Ablation `Refine` exhausted without improvement | keep incumbent, continue to drafting (no abort) |
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

Required fixtures: `examples/ood_frozen_encoder.json` (happy path), `examples/abort_case.json`
(0 Good ideas ⇒ abort), `examples/meta_refine.json` (meta-review Refine that improves the metric).

**These fixtures are synthetic.** The task framing of the first one mirrors the paper's
Procrustes-DS case study, but its numbers are placeholders and it is *not* a reproduction of that
run. See README §"Fidelity: what the case study actually shows".

### 7.4 CLI

```
scientisttwo run <fixture.json> [--mock] [--out runs] [--seed 7] [--max-refine-rounds N]
scientisttwo inspect <run_id>
scientisttwo replay <run_id>
```

`run` prints a one-screen summary: limitations found, seeds, per-round `id → decision`, chosen
`h_best`, ablation verdict, review scores per round, meta decision, and artifact paths.
`replay` must reproduce the same `decision_path` from `traces.jsonl` alone (no model calls) and
exit non-zero on mismatch.

---

## 8. Definition of done (v0)

- [x] `pytest` green offline — 103 tests, no network, no API key.
- [x] `python -m scientisttwo.cli run examples/ood_frozen_encoder.json --mock` completes §3.1→§3.6 and
      prints the decision path + review scores.
- [x] Abort path (`0 Good after K rounds`) covered: `examples/abort_case.json`, exit code 2.
- [x] Meta-review `Refine` that improves E updates the state (`adopt.meta:*`) — scripted fixture test.
- [x] Meta-review `Refine` that does **not** improve E discards the refinement (I2) — covered.
- [x] `replay` rebuilds the decision path from `traces.jsonl` alone and fails on mismatch.
- [x] Integrity audit wired: spec violations force `BAD` right after experimentation; refs +
      method-code alignment merged into `FinalArtifacts.integrity`.
- [x] Exploration guidance (domain + reference directions) threaded through §3.1/§3.3 and the offline
      simulator, with `guidance_weight = 0` reproducing the paper's pure-novelty ordering.
- [x] `docs/ARCHITECTURE.md` maps module → agent → paper section, including the decisions taken
      where the paper is silent.
