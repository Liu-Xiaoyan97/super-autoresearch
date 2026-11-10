# Architecture (as built)

Companion to `docs/SPEC.md` (the contract) and `docs/analysis/*.md` (the paper extraction).
This file describes what the code *actually* does.

---

## 1. Control layer

```
cli.run
  └─ Orchestrator.run()                       core/orchestrator.py
       ├─ _limitations()                      §3.1  → stage.limitations / limits.ok:N
       ├─ _seed_ideas()                       §3.1  → seeds:N (h0 + ranked pool)
       ├─ _baseline()                         §3.2  → baseline.ok
       ├─ _idea_search()                      §3.2+§3.3
       │    ├─ _evaluate(top-N0 seeds, 0)
       │    ├─ for k in 1..K: A_Evolve(R_<k) ∪ next N_e seeds → _evaluate
       │    └─ abort when 0 Good after K     ("no_good_ideas")
       ├─ _select()                            §3.3  → select:<id> / adopt.select:<id>
       ├─ _ablations()                         §3.4  → ablation.good|refine → ablation.keep|adopt
       ├─ _draft_and_review()                  §3.5  → peer.r0:7.3 → peer.r1:8.6
       ├─ _meta_review()                       §3.6  → meta.accept | meta.refine → meta.keep|adopt.meta
       └─ _export()                            → state.json, traces.jsonl, final.json, *.tex
```

Every transition is one `TraceStore.append(kind, {token, ...})`, which is why
`scientisttwo replay <run>` can rebuild the exact decision path with **no model and no
workspace**.

`core/stage.py::stage()` is the paper's Listing 1 loop. The orchestrator does not use
`stage()` for every step (the §3.2 flow is a two-tier pipeline, not a single loop), but the
primitive is kept, tested, and used wherever a flat critic/refine loop applies.

---

## 2. Agents

| Agent | task key | Model role | Paper | Decides with |
|---|---|---|---|---|
| `LimitationExtractor` | `limitations.extract` | default | §3.1 | LLM (+ dedupe) |
| `LimitationVerifier` | `limitations.verify` | default | §3.1 | LLM + `min_limitations` floor |
| `InitialIdeaGenerator` | `ideas.initial` | default | §3.1 | LLM |
| `NoveltyChecker` | `ideas.novelty` | default | §3.1 | LLM; `novelty_refs = 2` |
| `IdeaGenerator` | `ideas.expand` | default | §3.1 | LLM |
| `IdeaEvolver` | `ideas.evolve` | default | §3.3 | LLM over Good **and** Bad traces |
| `BaselineCoder` | `code.baseline` | coding | §3.2 | workspace only |
| `SubsetCoder` | `code.subset` | coding | §3.2 | workspace only |
| `FullSetCoder` | `code.full` | coding | §3.2 | workspace only |
| `IdeaImplementer` | `code.implement` | coding | §3.2 | **pure control flow** |
| `SubsetCritic` | `critic.subset` | default | §3.2 | `is_strictly_better` + `subset_margin` |
| `FullSetCritic` | `critic.full` | default | §3.2 | `is_strictly_better` |
| `SubsetEngineer` | `engineer.subset` | coding | §3.2 | LLM patch, ≤ `max_eng_rounds` |
| `FullSetEngineer` | `engineer.full` | coding | §3.2/§3.4/§3.6 | LLM patch |
| `ResultComparison` | `critic.compare` | — | §3.4/§3.6 | **no LLM call at all** |
| `Selector` | `critic.selector` | default | §3.3 | deterministic ranking |
| `AblationPlanner` | `ablation.plan` | default | §3.4 | LLM, `n_ablation_plans` |
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

Model routing follows Appendix A.2: `coding`, `ablation`, `rebuttal`, `draft_enhancer` map to
the "Claude Opus" route; everything else to the default ("Gemini Flash") route. In offline
mode both routes point at `MockLLMProvider`.

---

## 3. One idea's life (data flow)

```
Idea(h, mechanism, direction_ids, domain_fit)
  │  SubsetCoder: write_patch(C_base, patch⊃hypothesis+mechanism)
  ▼
RepoRef C_sub ──workspace.run(SUBSET)──► ExperimentResult(metrics) ──► Evidence(E_sub)
  │                                                                       │
  │                                        SubsetCritic ◄───── is_strictly_better
  │                                            │ good / engineer / bad
  │                         ┌──────────────────┴───────────────┐
  ▼                         ▼                                  ▼
FullSetCoder          SubsetEngineer (≤2)                  prune (BAD)
  │                         │
  ▼                         └──► back to SubsetCoder
RepoRef C_full ──run(FULL)──► Evidence(E_full) ──► FullSetCritic ──► Trace(h,E*,d,r)
                                                                     │
                                                     SpecAuditor ────┤ (violation ⇒ forced BAD)
                                                                     ▼
                                                                R (state.traces)
```

`Evidence` is the only carrier of numbers; `Trace` is the unit §3.3 evolves from.

---

## 4. Terminations

| Condition | Result | Code |
|---|---|---|
| ≥ `success_target` Good ideas | proceed to select | `_idea_search` |
| 0 Good after `max_refine_rounds` | `aborted=True`, reason `no_good_ideas` | raises `_ScientificAbort` |
| baseline execution failed | `aborted=True`, `baseline_failed` | `_baseline` |
| 0 eligible seeds after guidance filtering | `aborted=True`, `no_eligible_seeds` | `_seed_ideas` |
| seed pool short but non-empty | `seeds.partial:N`, **continues** | `_seed_ideas` |
| ablation `REFINE` and no strict improvement | keep incumbent, continue to drafting | `_ablations` |
| review ≥ 8 or `max_peer_rounds` | stop rebuttal loop | `_draft_and_review` |
| meta `Refine` and no strict improvement | `meta.keep`, export incumbent (`accepted=False`) | `_meta_review` |
| meta `Accept` | export (`accepted=True` if integrity clean) | `_meta_review` |
| budget hit | `aborted=True` | `BudgetExceeded` |

`aborted=True` means *the science dead-ended*. A non-improving refinement is **not** an
abort — it is the paper's "terminate using the previous best outputs" branch.

---

## 5. Deterministic vs. model-owned decisions

| Purely numeric (no model can flip) | Model may add concerns |
|---|---|
| `ResultComparison` (adoption, I2) | `SubsetCritic` / `FullSetCritic` rationale |
| `Selector` ranking | `AblationCritic` (can veto GOOD) |
| `SpecAuditor.hard_violations` | `SpecAuditor` extra violations |
| `ReferenceAuditor.unknown_refs` | `ReferenceAuditor` extra violations |
| `MethodCodeAuditor.lexical_alignment` floor | `MethodCodeAuditor` upward refinement |
| `verify_scores` | — |

This asymmetry is deliberate: a model may **block** a promotion, never **cause** one.

---

## 6. Decisions taken where the paper is silent (and where to change them)

| Topic | Our choice | Where |
|---|---|---|
| Round-0 batch | exactly top-`n0` seeds, not all `H0` (§3.3 set-builder is inconsistent with its own prose) | `config.n0` |
| `N_seed`, `N0`, `N_meta` | 8, 2, 2 | `config.py` |
| Subset screening margin | 2% relative (`subset_margin`) | `config.py` |
| "strictly better" | no metric regresses beyond tolerance **and** ≥1 improves | `types.is_strictly_better` |
| Exploration guidance | soft weight on ranking, hard only when `strict_directions` | SPEC §2b |
| Offline gain model | `U[-0.10,0.40)` ⇒ ≈80% positive, calibrated to the paper's 80.4% | `runtime/workspace.py` |
| Bounded metrics | headroom-proportional gain × `HEADROOM_GAIN`, never a hard ceiling | `runtime/workspace.py` |
| Ablation contribution | deterministic 2–11% drop; rare dead component (~5%) | `agents/coding.py` |
| Budget charging | only the agent that calls `workspace.run` charges | `agents/coding.py` |
| Engineering rounds | two per **idea**, shared by the subset and full-set loops (A.2 literal) | `config.engineering_budget_scope` |
| Review budget across meta rounds | `max_peer_rounds` / `max_review_refinements` reset per new draft | `core/orchestrator.py` |
| Manuscript claims | dropped when unsupported (never resurrected) | `agents/writing.py` |
| Integrity alignment | 0 if the deterministic check finds no textual support | `agents/integrity.py` |

Every remaining `# CONTRACT-GAP:` comment in the tree marks a place where the frozen
contract could not express something; each one also states the workaround.

---

## 7. Extension points

* **New domain** → drop a `Problem` JSON in `examples/` (see SPEC §7.3). Add `bounds` to any
  metric that has a physical range.
* **New model provider** → implement `LLMProvider.complete`, register in
  `providers.build_provider`, and add a `ModelRoute` per role in `ScientistTwoConfig`.
* **Real execution** → `runner="subprocess"` (`--runner subprocess`); the repo needs
  `run_experiment.py` that writes `{"metrics": {...}}` to `--out`. `SubprocessRunner` never raises;
  a crash becomes `status="failed"` evidence. `FileWorkspace` owns the choice — the CLI never
  imports a runner type.
* **New agent** → subclass `BaseAgent` (unique `NAME`, `task`, `role`), add it to
  `AgentBundle`, and wire it in `Orchestrator` — the mock provider synthesizes its outputs
  automatically for offline runs.
