# Implementation contract: ablation, drafting, and meta-review

## 0. Authority, notation, and scope

- **[PAPER]** ScientistTwo, §§3.4–3.6 (PDF/printed pp.8–9), with §§3.1–3.3 (pp.6–8), Table 1 and Listing 1 (**p.5, not p.4**), Figure 7 (p.9), and A.2 (p.30). PDF page numbers and printed page numbers agree. Related evidence: pp.4, 10, 13–15, 30–33, 43–47, 51–55, 56–71. Whole-document text search covered all 71 pages.
- **[PAPER]** `h_best`, `E_best`, `C_best` are the selected hypothesis, full-benchmark results, and validated codebase. `E_abl` is component-ablation evidence; `E_reb` is supplementary rebuttal evidence; `P_new`, `R_new` are the current manuscript and its current peer review. Final products are `P+`, `C+`.
- **[INFERENCE]** This note distinguishes literal paper requirements from implementation decisions needed to make underspecified branches executable. An inferred fallback is not a reported algorithmic guarantee. All schema representations and deterministic/mock checks below are implementation proposals, not published schemas.
- **[PAPER]** The unified experiment interface is `(h, E_h, C_h, d_h, r_h) = A_Coder(G, h)` (§3.2, p.7). The Selector operates only on full-benchmark ideas with `d_h = Good` (§3.3, p.8).

## 1. Shared critic/refinement abstraction

**[PAPER]** Table 1 (p.5) specifies these stage contracts:

| Stage | Candidate | Critic question | Refinement |
|---|---|---|---|
| Ablation study | Idea, Ablation results | “Is the component breakdown clean?” | “Refine the method” |
| Initial drafting | Manuscript | None | None |
| Peer-Review | Manuscript | “Is review score good enough?” | “Run rebuttal experiments” |
| Meta-Review | Manuscript, Review | “Does it meet the venue bar?” | “Refine idea and analyze again” |

**[PAPER]** Listing 1 (p.5) calls `critic(candidate)` inside `for _ in range(max_rounds)`: `accept` returns the candidate; `refine` calls `refine(candidate, feedback)`; any other verdict returns `None`; exhausting the loop also returns `None`. Its caption states: “If accepted, the artifact is returned; if rejected, it is discarded; otherwise, it is iteratively refined based on the critic’s feedback up to a maximum number of rounds.”

**[INFERENCE]** Listing 1 is an abstraction, not sufficient orchestration code. In particular, its final refinement can go unreviewed; §3.5 explicitly forwards a manuscript when the review budget ends; §3.6 explicitly exports the previous best on an unsuccessful refinement. Stage-specific prose overrides the generic `None` outcome. Do not add an ablation `Bad` or meta-review `Reject` label: their published enums are two-way.

**[PAPER]** Figure 7 caption (p.9): “ScientistTwo conducts ablation studies and simulates the peer-review and rebuttal processes. Beyond this, ScientistTwo dynamically refines the idea and enhances paper quality using feedback from each stage (see § 3.4, § 3.5, § 3.6).” Its diagram places separate Result Comparison/Full-Set Engineer branches at ablation and meta-review; rebuttal is a different branch through planning, coding, and draft enhancement.

## 2. §3.4: ablation studies

### 2.1 Planning and execution

**[PAPER, p.8]** The planner “automatically formulates a set of N_p executable ablation plans” tailored to `h_best`. For each `p_i`, the Ablation Coding Agent “modifies the validated codebase C_best to execute, yielding an ablation outcome c_i.” Aggregate `E_abl = {c_1, …, c_N_p}`.

- **[PAPER]** `N_p` is a symbolic plan count. Neither §3.4 nor A.2 fixes its numerical value, minimum, maximum, scheduling, or plan serialization.
- **[PAPER]** The scientific objective is systematic component-level isolation of sources of gain. Appendix B says ScientistTwo “additionally requires the gain to be attributable to the proposed mechanism in ablation” (Table 15 caption, p.30). Table 15 reports **5–6 ablations per paper in five comparison cases**, not a global `N_p` setting. The example manuscript describes six focused ablations but also includes a seventh cutoff-sensitivity ablation (pp.64–65, 71); do not turn observed counts into hard caps.
- **[INFERENCE]** An executable plan is a bounded, unambiguous experiment specification: exact source candidate/code revision; hypothesis and component intervention; control and variant; datasets/splits/metrics; fixed evaluation protocol; run commands/configuration/seeds; expected artifact locations; resource/timeout constraints; and the contrast to compute. A vague instruction such as “test the components” is not executable.
- **[INFERENCE]** Plan data should declare what is removed/replaced/varied, what is held fixed, and how to compare with the complete method. Use independent workspaces derived from immutable `C_best`; do not serially accumulate unrelated ablation edits or replace production `C_best` with an ablated variant. `N_p` equals the number of submitted plans, and each receives an outcome, including explicit failed execution status.

### 2.2 Critique, engineering, and strict acceptance

**[PAPER, p.8]** `A_AblCritic` inspects the component breakdown and produces `(d_abl, r_abl)`, with “d_abl ∈ {Good, Refine}.” `Good` finalizes the hypothesis for drafting. `Refine` invokes the **Full-Set Engineering Agent**, not the Ablation Coding Agent, to produce `(h_new, E_new, C_new)` guided by `r_abl`.

**[PAPER, p.8]** “Because structural refinements do not guarantee improved performance, ScientistTwo verifies whether E_new strictly outperforms E_best.” The state is updated “if and only if E_new is preferred than E_best by the Result Comparison Agent”:

`(h_best, E_best, C_best) ← (h_new, E_new, C_new)`.

**[PAPER, p.8]** “When an update occurs, ScientistTwo re-executes the ablation planning phase on the updated candidate.” The loop repeats “for a maximum of N_abl iterations or until A_AblCrit emits d_abl = Good.” A.2 (p.30): “when the Ablation Critic Agent recommends refinement based on ablation results, we refine the idea at most once.”

- **[PAPER]** The three core variables change together and only after preference is established. Simplification or improved explanation alone does not authorize an update.
- **[INFERENCE]** Interpret the A.2 cap as at most **one Full-Set Engineer refinement attempt per invocation of §3.4**, with initial planning/execution/critique plus fresh planning/execution/critique after a successful update. Thus `ablation_refinements_used ≤ 1`; this is clearer than conflating attempts with the number of critic calls.
- **[INFERENCE]** Tied, inferior, invalid, or incomparable results do not pass strict comparison. Preserve the incumbent and its matching ablation evidence. A failed refinement consumes its attempt budget. If more attempts are configured, solicit revised critique/plans against the unchanged incumbent; do not rebase on the rejected candidate.
- **[INFERENCE]** The prose does not explicitly define what happens when the critic still says `Refine` at exhaustion or the comparison fails without update. This contract rejects that contribution when no attempt remains, rather than silently drafting a scientifically unsupported result. This choice is supported, but not algorithmically fully specified, by the TeCh example: despite beating the baseline on 5/6 metrics, it was rejected because “the gains were primarily driven by general training controls (EMA and label smoothing) rather than the multi-core architectural innovation itself” (p.31; also Table 16, p.32). No paper text prescribes selecting the next-best hypothesis after this rejection.
- **[PAPER]** A qualitative ablation critique identifies redundant alignment, near-uniform proposed weights, harmful gating, bad regularization scaling, and an unjustified fusion interpretation (p.46). This illustrates scientific/mechanistic scrutiny, not merely checking that result files exist.

## 3. §3.5: manuscript drafting and simulated peer review

### 3.1 Initial manuscript

**[PAPER, p.8]** Initial Drafter `A_Draft` incorporates **PaperOrchestra** and “synthesizes the selected idea h_best, main benchmark results E_best, and component ablation studies E_abl into a full, conference-formatted manuscript P_new.” A.2 (p.30): “We use the ICLR 2025 format for drafting, following the PaperOrchestra.” The related-work description calls PaperOrchestra a system compiling experiment logs and ideas into **LaTeX manuscripts** (p.4).

**[INFERENCE]** Bind every manuscript version to the exact core candidate revision and evidence bundle used to create it. Provide code/experiment provenance and any prior manuscript only as explicitly recorded auxiliary context; `h_best`, `E_best`, and `E_abl` are the paper’s explicit drafting inputs.

### 3.2 Review and rebuttal dataflow

**[PAPER, pp.8–9]** Peer Reviewer `A_Reviewer` is **ScholarPeer**. It evaluates `P_new` and returns `R_new` containing:

1. identified strengths;
2. identified weaknesses;
3. targeted questions;
4. an overall numerical score `s_review ∈ [1, 10]`, “based on the standard ICLR grading scale.”

**[PAPER, p.9]** If the score is “below the acceptance threshold (e.g., 8),” initiate rebuttal. The subsequent stopping rule explicitly says the cycle repeats until the score is at least **8** or `N_peer` is reached. A.2 also fixes early stopping at **8**. Therefore the configured gate is `score ≥ 8`, inclusive, not `score > 8`.

**[PAPER, p.9]** Rebuttal Planner `A_RebPlan` analyzes `R_new`, producing `N_t` supplementary experimental tasks `{t_1, …, t_N_t}` “designed to resolve reviewer queries.” Rebuttal Coding Agent `A_RebCoder` implements and executes **each** task using `C_best`, producing `{e_1, …, e_N_t} = E_reb`. No numerical `N_t` is specified.

**[PAPER, p.9]** Paper Enhancer `A_Enhancer` “integrates the R_new and supplementary findings E_reb into P_new, revising narrative claims and updating empirical tables and figures.” Thus its explicit inputs are **the current manuscript `P_new`, its current review `R_new`, and actual supplementary experimental findings `E_reb`**—not reviewer text alone, not unexecuted task descriptions, and not only a score. The updated manuscript is evaluated again, replacing `R_new` and `s_review` with the matching review and score.

- **[INFERENCE]** Associate each task with stable weakness/question IDs and associate every supplementary result with its task, code snapshot, run, metric, and artifact. Enhancement should receive task-to-concern mapping and failure statuses as evidence context; do not fabricate successful findings for failed tasks.
- **[PAPER]** The rebuttal branch does not specify a core-state replacement or a Result Comparison Agent invocation. Its product is supplementary evidence and a revised manuscript.
- **[INFERENCE]** Rebuttal scripts may be added to a supplementary artifact bundle without changing the scientific identity of `C_best`; changing the core method must instead follow a verified idea-refinement branch. Preserve scripts necessary to reproduce new manuscript tables in the final code package.

### 3.3 Budgets and low-score exit

**[PAPER, p.9]** “This review-rebuttal cycle repeats until … ≥ 8 or the maximum budget of N_peer review iterations is reached,” producing `P_new`. A.2 (p.30): “the peer-review simulation runs for at most two rounds and terminates early if the ScholarPeer review score reaches 8, with review-based refinement conducted at most once.”

- **[INFERENCE, adopted convention]** Count **review evaluations**: initial review counts as 1; at most one rebuttal/enhancement follows; final review counts as 2. Set `peer_evaluations_max = 2`, `peer_rebuttal_refinements_max = 1`. Always review the enhanced manuscript before meta-review.
- **[PAPER]** Reaching the review cap is an alternate stop condition even if the score remains below 8; it is not a specified abort and does not imply meta-review acceptance. Forward the latest `P_new` and its latest `R_new` to §3.6.
- **[PAPER / ambiguity]** Table 5 (p.13) presents Review Round **0, 1, 2**, suggesting an initial draft plus two subsequent review/rebuttal rounds. A.2’s wording does not explicitly define whether its two rounds include the initial review; “review-based refinement … at most once” may instead refer to §3.6 deep refinement. Do not claim the adopted counting convention is uniquely determined by the paper. An alternative reproduction mode must name its counters explicitly and document why it permits three evaluations.
- **[INFERENCE]** Score improvement is not itself an enhancement acceptance gate. A tied/decreased review score still becomes the current review; continue if budget remains, otherwise go to meta-review. Retaining the historically highest-scored manuscript would be an additional policy not stated in §3.5.

## 4. §3.6: meta-review and review-driven idea refinement

**[PAPER, p.9]** `A_Meta` evaluates the **revised manuscript `P_new` alongside generated peer review `R_new`**. It returns decision `d_meta` and actionable strategic meta-critique `r_meta`, with “d_meta ∈ {Accept, Refine}.” No numeric meta-score or meta-score threshold is given.

### Accept

**[PAPER, p.9]** If `Accept`, finalize and export `P+ ← P_new`, `C+ ← C_best`. The decision judges the manuscript to meet top-tier conference standards; a peer score ≥8 alone does not replace it.

### Refine

**[PAPER, p.9]** `Refine` indicates “a critical algorithmic or empirical weakness.” Full-Set Engineer uses `r_meta` to construct `(h_new, E_new, C_new)`. Result Comparison Agent compares against `E_best`:

- **Strictly superior:** atomically update `(h_best, E_best, C_best)`. The framework “re-executes downstream ablation planning, ablation execution, manuscript re-drafting, and simulated peer-review cycles.” Thus re-enter **§3.4, then §3.5, then §3.6**, not just the enhancer and not the seed-evolution search.
- **Not superior:** “the refinement is discarded, and ScientistTwo terminates the process using the previous best outputs (P+ ← P_new, C+ ← C_best).” This is an explicit terminal branch, not a retry, not a return to §3.3, and not export of `C_new`.

**[PAPER, p.9]** “This meta-refinement loop repeats for a maximum of N_meta iterations or until d_meta = Accept.” A.2 does not assign a number to the symbol `N_meta`; it states that “review-based refinement” occurs at most once (p.30).

- **[INFERENCE, adopted convention]** Set `meta_refinement_attempts_max = 1`, interpreting A.2’s review-based cap as also limiting this branch. Initial meta-review plus one final meta-review after an improved revision are permitted; the counter counts engineer attempts, not initial assessments. This binding is a declared interpretation, not an explicit A.2 equation `N_meta = 1`.
- **[INFERENCE]** At `Refine` with no meta-attempt budget remaining, terminate and export the latest fully ablated, drafted, and reviewed manuscript/code pair, with termination reason `meta_budget_exhausted` and `meta_accepted = false`. The prose gives a bounded loop but not an explicit exhausted-loop export assignment; this extends its previous-best fallback instead of treating budget exhaustion as acceptance.
- **[INFERENCE]** Save a complete coherent checkpoint before every deep refinement: core state, ablations, manuscript, peer review, and supplementary artifacts. Comparison failure exports that checkpoint. After strict improvement, invalidate old manuscript/evidence bindings and regenerate downstream artifacts. If renewed ablation cannot validate the changed candidate, abort that candidate; if a pre-refinement completed checkpoint exists, export that checkpoint as a nonaccepted fallback. This rollback policy fills an unstated nested-failure case.
- **[PAPER]** Table 6 and discussion (p.14) demonstrate meta-review transforming LFR-Engram into FCD-Engram after the first, already state-of-the-art method was deemed insufficient. This is methodological refinement, not purely editorial revision.

## 5. Complete operational state machine

### 5.1 State and nesting conventions

**[INFERENCE]** The table below is one complete operational interpretation. `[P]` edges follow paper prose; `[I]` edges complete missing behavior. Conditions in each state are mutually exclusive and ordered as indicated. Terminal states never restart the run automatically.

- Core immutable-versioned state: `B = (h_best, E_best, C_best)`; candidate engineering output `B_new`; append-only idea execution traces; current candidate queue; manuscript/review/evidence version bindings; optional `completed_checkpoint`.
- Idea search: batch `k=0` plus at most `K` refinement batches under §3.3’s mathematical indexing; successes are cumulative full-set `Good` traces. A.2’s **four total experimentation rounds** is the operational default; use explicit `max_experiment_batches=4` rather than silently interpreting this as initial + four. `S=4`; two candidates per configured batch, one seed and one evolved, subject to the initial-round ambiguity below.
- Per-candidate subset and full-set engineering loops are nested inside `A_Coder`; default at most two engineering attempts. Candidate evaluation loops sit inside idea-evolution batches. Selection occurs when `S` is reached or the search cap is reached with at least one success.
- After selection, ablation has its own bounded engineer/comparison loop. Peer review has a separate bounded rebuttal/enhancement loop. Meta-review wraps the **entire ablation → draft → peer-review sequence** on successful deep refinement. Reset ablation and peer counters on a new verified core candidate; never reset the outer meta counter.
- Terminals: `EXPORT_ACCEPTED`, `EXPORT_FALLBACK` (valid artifacts, not declared accepted), `ABORT_NO_ARTIFACTS`. A rejected idea can be preserved in logs, but not counted as a successful contribution.

| State | Condition / outcome | Action and next state | Basis |
|---|---|---|---|
| Limitation extraction/verification (§3.1) | Sufficient | Freeze limitation set → Seed generation | [P] p.6 |
| Same | Insufficient, attempts remain | Extract missing limitations → same state | [P] p.6 |
| Same | Insufficient, cap reached | Abort without final artifacts | [I]; bounded loop stated p.6; A.2 cap 16, p.30 |
| Seed generation/novelty (§3.1) | Fewer than configured `N_seed`, valid generation possible | Add distinct scored idea → same state | [P] p.6 |
| Same | `N_seed` reached | Sort descending novelty, prepare top-`N_0` initial queue → Subset baseline | [P] p.6 |
| Subset baseline (§3.2) | Reproduction succeeds | Save `E_base`, `C_base` → Candidate scheduling | [P] p.6 |
| Candidate scheduling | Current batch has candidate | Pop candidate, reset engineering counters → Subset coding/critic | [P] pp.6–7 |
| Subset coding/critic | `Good` | Scale corresponding subset code → Full-set coding/critic | [P] p.7 |
| Same | `Bad`, or `Engineer` and engineering cap exhausted | Record `Bad` trace → Candidate scheduling | [P] p.7 |
| Same | `Engineer` and attempts remain | Subset Engineer, increment attempt, rerun experiment/critic → same state | [P] p.7 |
| Full-set coding/critic | `Good`, protocol valid | Record full-set `Good` trace → Candidate scheduling | [P] pp.7–8; validation p.14 |
| Same | `Bad`, or `Engineer` and engineering cap exhausted | Record full-set `Bad` trace → Candidate scheduling | [I] symmetric exhaustion semantics; full-set engineer/critic stated p.7 |
| Same | `Engineer` and attempts remain | Full-Set Engineer, increment attempt, rerun full benchmark/critic → same state | [P] full-set loop p.7; exact symmetry [I] |
| Candidate scheduling | Batch drained | → Search termination check | [I] explicit batch boundary |
| Search termination check (§3.3) | Cumulative successes ≥ `S` | → Selector | [P] p.7 |
| Same | Successes < `S`, search budget remains | Evolve from all prior success/failure traces; add next `N_e` unevaluated seeds → Candidate scheduling for next batch | [P] p.7 |
| Same | Search exhausted, successes = 0 | Terminate entire process → `ABORT_NO_ARTIFACTS` | [P] p.7 |
| Same | Search exhausted, 0 < successes < `S` | → Selector | [P] selection of at least one success, p.8 |
| Selector | At least one full-set `Good` trace | Select `B`; reset ablation attempts → Ablation planning/execution | [P] p.8 |
| Ablation planning/execution (§3.4) | All `N_p` planned runs produce valid evidence | Bind `E_abl` to current `B` → Ablation critic | [P] p.8; validity binding [I] |
| Ablation critic | `Good` | → Initial drafting | [P] p.8 |
| Same | `Refine`, ablation attempt remains | Increment attempt → Ablation Full-Set Engineer | [P] p.8; counting [I] |
| Same | `Refine`, ablation budget exhausted | Reject contribution → `EXPORT_FALLBACK` if completed checkpoint exists, otherwise `ABORT_NO_ARTIFACTS` | [I]; attribution rejection example pp.31–32 |
| Ablation Full-Set Engineer | Produces valid `B_new` guided by `r_abl` | → Ablation result comparison | [P] p.8 |
| Ablation result comparison | `E_new` strictly preferred | Atomically commit `B_new`, invalidate old ablations → Ablation planning/execution | [P] p.8 |
| Same | Not strictly preferred and attempts remain | Discard `B_new`; retain incumbent evidence → Ablation critic with failed-attempt feedback | [I]; update forbidden by p.8 |
| Same | Not strictly preferred and no attempts remain | Reject unresolved contribution → fallback checkpoint if any, otherwise abort | [I]; no published ablation fallback assignment |
| Initial drafting (§3.5) | Valid draft created | `P_new = Draft(h_best, E_best, E_abl)`; reset peer counts → Peer review | [P] p.8; counter reset [I] |
| Peer review | Review valid, score ≥ 8 | Save matching `R_new` → Meta-review | [P] p.9 |
| Same | Review valid, score < 8, evaluation/rebuttal budget remains | → Rebuttal planning | [P] p.9; precise counter convention [I] |
| Same | Review valid, score < 8, either peer budget exhausted | Keep latest `P_new`, `R_new` → Meta-review | [P] p.9 |
| Rebuttal planning | `N_t` well-formed supplementary tasks ready | → Rebuttal coding/execution | [P] p.9 |
| Rebuttal coding/execution | Every task has a recorded outcome | Aggregate `E_reb` → Paper enhancement | [P] p.9; failure records [I] |
| Paper enhancement | Revised draft valid | Integrate current `P_new`, `R_new`, `E_reb`; increment rebuttal counter → Peer review | [P] p.9 |
| Meta-review (§3.6) | `Accept` | Export current coherent `P_new`, `C_best` → `EXPORT_ACCEPTED` | [P] p.9 |
| Same | `Refine`, meta attempt remains | Save completed checkpoint; increment global meta attempt → Meta Full-Set Engineer | [P] p.9; checkpoint/counting [I] |
| Same | `Refine`, no meta attempt remains | Export latest completed pair → `EXPORT_FALLBACK`, reason `meta_budget_exhausted` | [I]; cap stated p.9 |
| Meta Full-Set Engineer | Produces valid `B_new` guided by `r_meta` | → Meta result comparison | [P] p.9 |
| Meta result comparison | Strictly superior | Commit `B_new`; clear old draft/review/evidence; reset ablation/peer counters only → Ablation planning/execution | [P] p.9; counter reset [I] |
| Same | Not strictly superior | Discard proposed refinement; export pre-refinement `P_new`, `C_best` → `EXPORT_FALLBACK`, reason `meta_no_strict_improvement` | [P] p.9 |
| Any experimental candidate state | Specification violation detected | Immediately discard offending solution; record failed trace if in search; otherwise use stage failure path below | [P] immediate discard p.14; routing [I] |
| Any nonterminal state | Unhandled execution/validation failure, malformed output, missing prerequisite, insufficient candidate pool, timeout, or cancellation | Do not treat as `Good`/`Accept`. Record failure; discard candidate; if a completed checkpoint exists export it as fallback, else abort | [I] total failure policy; paper supplies no retry/time-limit rules |

**[INFERENCE]** The global failure row is used only when no stage-specific outcome applies. Within `A_Coder`, an unusable candidate can be recorded as `Bad` and the scheduler can continue; a failed baseline cannot. Empty `N_p`/`N_t` outputs fail validation when evidence is required. No automatic return from a rejected ablation to Selector or from meta-review to seed evolution is authorized by the prose.

## 6. Hard gates and bounds

All quoted wording is from the indicated PDF page; mathematical notation is normalized outside quotations.

| Gate | Condition | Threshold / exact wording | Source page |
|---|---|---|---|
| Generic stage accept/reject | Critic accepts / rejects | “If accepted, the artifact is returned; if rejected, it is discarded” | 5, Listing 1 caption |
| Generic stage budget | No acceptance within `max_rounds` | Listing 1 ends with `return None`; a generic abstraction, not every stage’s literal fallback | 5 |
| Limitation extraction | Enough actionable limitations, or cap | “until … all actionable limitations have been thoroughly extracted or maximum number of iterations is reached”; A.2 “maximum of 16 rounds” | 6, 30 |
| Seed ordering | Enough scored seed ideas | `N_seed`, top `N_0`; descending novelty; no numeric novelty cutoff specified | 6 |
| Subset `Bad` | Baseline comparison | “performance is substantially inferior to the baseline”; no numeric margin | 7 |
| Subset `Good` | Baseline comparison | “consistently outperforms the baseline”; no numeric consistency/statistical definition | 7 |
| Engineering exhaustion | No `Good` within engineering allowance | “If N_eng is reached without achieving d = Good, h is designated as Bad and pruned”; A.2 “at most two rounds” | 7, 30 |
| Full-set validation | Full-benchmark evidence | Table 1: “Is it better than the original SOTA result?”; no multi-metric comparator formula | 5, 7 |
| Search success | Cumulative full-set `Good` ideas | `≥ S`; A.2 “terminating early once four successful ideas are obtained” | 7, 30 |
| Search cap | Refinement limit `K` / configured batches | §3.3 initial `k=0` and refinement limit `K`; A.2 “up to four rounds” | 7, 30 |
| Entire search abort | At cap, no successes | “If round K is reached with zero successful ideas … ScientistTwo terminates the entire process.” | 7 |
| Selection eligibility | Successful full-set idea exists | “Upon discovering at least one successful idea”; select among `d_h = Good` | 8 |
| Ablation plan count | Planner emits executable plans | `N_p`, unspecified numerical count | 8 |
| Ablation gate | Critic judges breakdown | “d_abl ∈ {Good, Refine}”; `Good` proceeds to drafting | 8 |
| Attribution | Proposed mechanism explains gain | “requires the gain to be attributable to the proposed mechanism in ablation”; no numerical attribution cutoff | 30, Table 15 caption |
| Ablation core-state update | Result Comparison Agent prefers new results | “if and only if E_new is preferred than E_best by the Result Comparison Agent”; strict outperformance required | 8 |
| Ablation budget | Bounded idea refinement | `N_abl` symbolic; “we refine the idea at most once” | 8, 30 |
| Review score validity | ScholarPeer numerical output | `s_review ∈ [1,10]`; not explicitly declared integer-valued | 8–9 |
| Peer-review threshold | Stop rebuttal if score sufficient | “below the acceptance threshold (e.g., 8)”; later explicit stop at `≥8`; A.2 “score reaches 8” | 9, 30 |
| Rebuttal task count | Planned supplementary tasks | `N_t`, unspecified numerical count | 9 |
| Peer budget | Review cap or sufficient score | `N_peer`; “at most two rounds”; round counting ambiguous | 9, 30 |
| Review-based refinement budget | Review-guided refinement | “with review-based refinement conducted at most once”; exact loop referent unspecified | 30 |
| Meta decision | Final publication assessment | “d_meta ∈ {Accept, Refine}”; no numeric threshold | 9 |
| Meta state update | New result verified better | “If E_new is verified as strictly superior”; otherwise “the refinement is discarded” and previous best exported | 9 |
| Meta budget | Stop on accept or cap | “maximum of N_meta iterations or until d_meta = Accept”; no explicitly named numerical `N_meta` in A.2 | 9, 30 |
| Rule compliance | Experimental code violates task specification | “detect and discard rule-violating solutions immediately after experimentation” | 14 |
| Integrity | Final scientific claims and artifacts | Papers/code “must be rigorously verifiable across all four dimensions”: score, specification, references, method–code alignment | 14–15 |

**[INFERENCE]** Additional engineering validations—nonempty plans, finite metrics, score type, complete result coverage, timeouts, and evidence references—are deterministic safeguards, not new paper-derived scientific thresholds. There is no published p-value, minimum percentage gain, score-delta gate, or fixed figure/table count.

## 7. Manuscript quality contract and offline/mock verification

### 7.1 What the paper actually requires

- **[PAPER, p.6]** `P+` should identify and resolve key methodological or empirical bottlenecks in `G`; `C+` should correctly implement the idea, maintain execution reproducibility, and demonstrate measurable gains.
- **[PAPER, p.8]** Draft synthesis must include the selected idea, main benchmark evidence, and component ablations in a full conference-formatted manuscript; **ICLR 2025 format** is specified on p.30.
- **[PAPER, pp.8–9]** Ablations must analyze sources of gain; enhancement revises narrative claims and updates empirical tables and figures using review and supplementary evidence.
- **[PAPER, p.10]** Multi-metric evaluation across diverse datasets and extensive baseline comparison are described as publication-ready design. The example with **9 figures and 12 tables** is an observation, not a mandated minimum. Full-benchmark verification appears throughout §§3.2–3.3 and Appendix B.
- **[PAPER, pp.14–15]** Claims must be supported by code, empirical outputs, and bibliography. Required integrity dimensions are reproducibility of reported scores, compliance with task rules, real references, and method–code alignment. Experimentation should produce “self-contained, reproducible scripts and execution instructions” (p.14). Writer-side refinements correct citations from search and rectify method discrepancies from a code audit report (p.15).
- **[PAPER]** No exhaustive mandatory manuscript section-name list is specified in §§3.4–3.6 or A.2. The generated DynaSpec-RAG manuscript illustrates Abstract, Introduction, Related Work, Methodology, Experiments, Ablation Studies, Conclusion, References, and appendices including full ablation tables (pp.56–71). Table 10 additionally evaluates motivation/related work, methodological rigor, benchmark/baseline evidence, ablations, and insights/limitations (p.16). These are evidence of intended completeness, not a literal universal template checklist.

### 7.2 Deterministic surrogate checks

Everything in this subsection is **[INFERENCE]**. An offline pass must be labeled **structural/evidence validation**, not proof of novelty, scientific soundness, reproducibility, or conference acceptance.

| Target | Deterministic mock/offline check | Limitation |
|---|---|---|
| Conference formatting | LaTeX source exists; declared ICLR 2025 template files/version; required style import; optional local compile succeeds | Template use does not imply venue readiness |
| Manuscript completeness | Require Abstract, Introduction, Related Work, Method/Methodology, Experiments, Ablation Studies, Conclusion, References; require limitations discussion and reproducibility details somewhere; permit heading aliases and nested ablation sections | Exact checklist is inferred, not a paper-prescribed section enumeration |
| Core-state consistency | Manuscript candidate ID, code revision/hash, and main/ablation evidence IDs all match | Hashes do not prove correctness |
| Main evidence table | At least one main-results table; expected benchmark/metric/baseline cells covered or explicit omission reasons; metric directions and units declared | Cannot establish fair baseline choice |
| Ablation evidence | Every proposed core component has an executed intervention/contrast or documented exemption; outcome table includes full-method control and variant metrics | Coverage does not prove causality |
| Claims grounded in evidence | Every empirical/quantitative performance claim has resolvable metric/run/table-cell references; method claims link to code locations; background claims link to citations | Requiring *every* claim to have a metric is inappropriate for conceptual claims; typed references are preferable |
| Numeric consistency | Table cells and numeric narrative values match referenced result records within declared display rounding; no unmarked mock values, NaN, or infinity | No re-execution means no true score verification |
| Review completeness | Strengths, weaknesses, targeted questions, bounded score; review points to exact current manuscript revision | Does not assess review expertise |
| Rebuttal accounting | Tasks link to questions/weaknesses; each task has an outcome; revised text/tables link to actual supplementary evidence or failure disclosure | Not every question necessarily admits an experiment |
| Code export | Final manifest includes main, ablation, and cited rebuttal scripts/configs/environment instructions; all referenced paths exist | File existence is not execution reproducibility |
| Bibliography | Keys resolve; no duplicate/missing references; match identifiers against an offline trusted registry | Offline checks cannot establish all references are genuine without trusted records |
| Method–code alignment | Explicit method-component-to-code map and recorded audit findings; rejected theoretical mechanisms no longer claimed as implemented | String/path checks cannot verify semantic equivalence |
| No benchmark manipulation | Immutable evaluation protocol hash and restricted-path diff; require compliance report | A mock audit cannot rule out all reward hacking |
| Termination honesty | Export reason and `meta_accepted` agree; low-score/exhausted/fallback exports are not marked accepted | Acceptance remains a model judgment in real execution |

**[INFERENCE]** Mock reviewers/comparators must use scripted verdicts or documented deterministic policies. Record `execution_mode = mock` and never present fabricated metrics or a deterministic score as empirical validation.

## 8. Pydantic-style data contracts

**[INFERENCE]** The following are schema specifications, not executable code. All fields are proposed; `[P]` in a purpose indicates underlying content explicitly required by the paper. Use strict schemas, forbid unknown enum values, validate cross-record references, and version all artifacts. `ID = str`; `ArtifactRef = {uri: str, sha256: str}`; `CodeRef = {artifact: ArtifactRef, revision: str}`. `MetricRecord` contains stable metric ID, dataset/split, metric name, direction (`min`/`max`), unit, finite numeric value, run ID, and source artifact. `EvidenceRef` points to a metric/run/table cell/code/citation. `ResultBundleRef` points to an immutable set of run/metric/artifact records. Referenced types are shared contracts, not hidden free-form objects.

### AblationPlan

| Field | Type | Purpose |
|---|---|---|
| `id` | `ID` | Stable `p_i` identity [P] |
| `candidate_id` | `ID` | Bind plan to `h_best` [P] |
| `source_code` | `CodeRef` | Validated `C_best` to modify [P] |
| `research_question` | `str` | Component-level interpretation sought [P] |
| `component_ids` | `list[ID]` | Components being isolated |
| `intervention` | `Literal['remove','replace','vary','control']` | Operation to perform |
| `control_config` | `dict[str, JsonValue]` | Full-method comparison condition |
| `variant_config` | `dict[str, JsonValue]` | Exact experimental modification |
| `held_fixed` | `list[str]` | Confound-control declarations |
| `benchmark_cases` | `list[ID]` | Dataset/split/settings to evaluate |
| `metric_ids` | `list[ID]` | Requested measurements |
| `evaluation_protocol` | `ArtifactRef` | Immutable evaluation definition |
| `commands` | `list[str]` | Run instructions; commands are data, not automatically trusted |
| `seeds` | `list[int]` | Repeatability settings |
| `resource_limits` | `dict[str, Union[int, float, str]]` | Time/GPU/memory bounds |
| `expected_outputs` | `list[str]` | Result/log files expected |
| `contrast_definition` | `str` | Control-versus-variant interpretation |

### AblationResult

| Field | Type | Purpose |
|---|---|---|
| `id` | `ID` | Stable `c_i` identity [P] |
| `plan_id` | `ID` | Link outcome to `p_i` [P] |
| `candidate_id` | `ID` | Prevent stale cross-candidate evidence |
| `executed_code` | `CodeRef` | Exact ablation workspace revision |
| `status` | `Literal['succeeded','failed','invalid']` | Distinguish evidence from failed execution |
| `metrics` | `list[MetricRecord]` | Observed component-ablation measurements [P] |
| `control_evidence` | `list[EvidenceRef]` | Matching full-method baseline |
| `artifacts` | `list[ArtifactRef]` | Logs, tables, plots, configs |
| `interpretation` | `str` | Component contribution/limitation summary |
| `error` | `Optional[str]` | Failure reason, mandatory unless succeeded |

`E_abl: list[AblationResult]`; cardinality equals `N_p`. Ablation critic output is a separate `{decision: Literal['Good','Refine'], critique: str, evidence: list[EvidenceRef]}`; it is not the same object as one ablation result.

### Manuscript

| Field | Type | Purpose |
|---|---|---|
| `id` | `ID` | Manuscript revision identity |
| `parent_id` | `Optional[ID]` | Enhancement/redrafting lineage |
| `candidate_id` | `ID` | Exact selected/refined hypothesis [P] |
| `code` | `CodeRef` | Corresponding validated implementation |
| `format` | `Literal['ICLR_2025']` | Configured conference format [P] |
| `latex_sources` | `list[ArtifactRef]` | LaTeX manuscript and included source files [P] |
| `pdf` | `Optional[ArtifactRef]` | Compiled reviewable output |
| `section_index` | `dict[str, str]` | Canonical section names to labels/locations |
| `main_results` | `ResultBundleRef` | `E_best` [P] |
| `ablation_result_ids` | `list[ID]` | `E_abl` [P] |
| `supplementary_results` | `list[ResultBundleRef]` | Integrated `E_reb` when present [P] |
| `claim_evidence` | `dict[ID, list[EvidenceRef]]` | Claims to empirical/code/citation support |
| `table_evidence` | `dict[str, list[EvidenceRef]]` | Table cells to result sources |
| `figure_artifacts` | `dict[str, ArtifactRef]` | Plot/diagram assets |
| `bibliography` | `ArtifactRef` | Cited references for integrity verification |
| `execution_mode` | `Literal['real','mock']` | Prevent misrepresenting offline outputs |

### ReviewScore

| Field | Type | Purpose |
|---|---|---|
| `value` | `Annotated[float, Field(ge=1, le=10)]` | Numerical overall `s_review` [P]; finite only |
| `scale` | `Literal['ICLR_1_TO_10']` | Named grading scale [P] |
| `rationale` | `Optional[str]` | Explain assigned value; optional in paper |

Acceptance is computed as `value ≥ 8`; do not store a contradictory separately editable boolean. Floating-point scores are permitted because the paper says numerical, not integer. A stricter integer policy is optional and must be disclosed.

### Review

| Field | Type | Purpose |
|---|---|---|
| `id` | `ID` | Current `R_new` identity [P] |
| `manuscript_id` | `ID` | Exact reviewed draft revision |
| `reviewer` | `Literal['ScholarPeer','mock']` | Real configured reviewer or explicit surrogate |
| `evaluation_index` | `int` | One-based review-count bookkeeping |
| `strengths` | `list[str]` | Identified strengths [P] |
| `weaknesses` | `dict[ID, str]` | Stable concern IDs plus content [P] |
| `targeted_questions` | `dict[ID, str]` | Stable question IDs plus content [P] |
| `score` | `ReviewScore` | Overall numeric evaluation [P] |
| `raw_report` | `Optional[ArtifactRef]` | Preserve detailed original reviewer response |

### RebuttalTask

| Field | Type | Purpose |
|---|---|---|
| `id` | `ID` | Stable `t_i` identity [P] |
| `review_id` | `ID` | Review that prompted task [P] |
| `concern_ids` | `list[ID]` | Weaknesses/questions addressed [P] |
| `question` | `str` | Supplementary experimental objective [P] |
| `candidate_id` | `ID` | Bind to current hypothesis |
| `source_code` | `CodeRef` | `C_best` used for execution [P] |
| `experiment_spec` | `dict[str, JsonValue]` | Datasets, controls, interventions, seeds, metrics |
| `commands` | `list[str]` | Executable task instructions |
| `expected_outputs` | `list[str]` | Evidence artifacts to collect |
| `status` | `Literal['planned','running','succeeded','failed','invalid']` | Task lifecycle |
| `result` | `Optional[ResultBundleRef]` | Actual supplementary `e_i` [P] |
| `error` | `Optional[str]` | Failure disclosure |

`E_reb` consists of task-linked supplementary results, not task prose. `N_t = len(tasks)`.

### MetaReview

| Field | Type | Purpose |
|---|---|---|
| `id` | `ID` | Stable assessment identity |
| `manuscript_id` | `ID` | Input `P_new` [P] |
| `peer_review_id` | `ID` | Matching input `R_new` [P] |
| `decision` | `Literal['Accept','Refine']` | `d_meta` [P] |
| `critique` | `str` | `r_meta`, actionable strategic feedback [P] |
| `critical_weaknesses` | `list[str]` | Algorithmic/empirical concerns motivating refinement [P] |
| `assessment_index` | `int` | Meta assessment count, distinct from attempts |
| `evidence` | `list[EvidenceRef]` | Traceable reasons for assessment |

### FinalArtifacts

| Field | Type | Purpose |
|---|---|---|
| `paper` | `Manuscript` | Exported `P+` [P] |
| `code` | `CodeRef` | Exported `C+`, the matching incumbent `C_best` [P] |
| `supplementary_code` | `list[CodeRef]` | Rebuttal/ablation scripts needed for reported findings |
| `reproduction_manifest` | `ArtifactRef` | Environment, commands, seeds, evidence locations |
| `last_peer_review` | `Review` | Exact exported manuscript’s review |
| `last_meta_review` | `Optional[MetaReview]` | Assessment for exported manuscript, never a mismatched revision |
| `meta_accepted` | `bool` | True only for an `Accept` of the exported version |
| `termination_reason` | `Literal['meta_accept','meta_no_strict_improvement','meta_budget_exhausted','nested_refinement_failed','execution_failure']` | Distinguish successful acceptance from fallback |
| `core_results` | `ResultBundleRef` | Final main evidence |
| `ablation_results` | `list[AblationResult]` | Final matching component evidence |
| `supplementary_results` | `list[ResultBundleRef]` | Integrated rebuttal evidence |
| `execution_mode` | `Literal['real','mock']` | Export provenance |

**[INFERENCE]** No-artifact abort is a separate terminal run status, not an invalid `FinalArtifacts` object with missing paper/code. Enforce revision consistency across every nested object; no old manuscript paired with newly accepted code. `meta_accepted` must be false for any non-`meta_accept` termination reason.

## 9. Ambiguities and explicit implementer decisions

| Issue | Paper boundary | Decision in this contract [INFERENCE] |
|---|---|---|
| Multiple metrics and “strictly better” | Agent preference required, but no weighting, dominance, significance, or tie rule | Comparator consumes the identical benchmark grid, directions, validity/audit status, and a versioned comparison policy; returns `preferred_new`, `preferred_incumbent`, `tie`, or `incomparable` with rationale. Only `preferred_new` can update. Conservative mock default: all required cells nonworse within declared tolerances and at least one strictly better beyond tolerance; trade-offs remain incomparable unless an explicit task policy resolves them. This is not a claim that the paper uses Pareto dominance. |
| No predefined numeric target | Appendix B distinguishes this from target-driven optimization | Do not invent a universal percentage-gain threshold. Numerical tolerances address measurement/rounding, not a hidden research target. |
| `N_p`, `N_t` | Symbolic only | Require positive configurable counts when the stage is needed, or accept a validated planner-generated nonempty list; record actual count. Observed 5–6 ablations is not a default requirement. |
| “Executable” plans | No published schema | Validate concrete intervention, run configuration, controls, expected metrics/artifacts, and exact source revision before dispatch. |
| Ablation budget semantics | `N_abl` iterations versus A.2 one refinement | Count engineer attempts; allow a post-update replan/run/critic pass without another engineer attempt. |
| Ablation non-improvement/exhaustion | Update forbidden without superiority; exhausted-loop endpoint unstated | Retain incumbent, consume attempt, and reject unresolved contribution at cap; rollback to an already completed manuscript checkpoint only if one exists. Do not invent an ablation third verdict. |
| Review round numbering | A.2 two rounds; Table 5 initial 0 plus rounds 1 and 2 | Default two evaluations and one enhancement; expose a named alternative for experimental-table reproduction. Do not silently use both meanings of `N_peer`. |
| “Review-based refinement” | A.2 does not name its loop | Conservatively cap both rebuttal enhancement and deep meta-refinement at one each; document this as interpretation. Numeric `N_meta` is otherwise unspecified. |
| Score exactly 8 | Threshold wording initially says “e.g.” but later fixes ≥8 | Pass peer gate at exactly 8. No rebuttal required solely to exceed it. |
| Score ties/decreases between drafts | No manuscript-score improvement gate | Latest enhanced/reviewed draft remains current; below 8 follows remaining budget. No implicit historical-best-score rollback. |
| Rebuttal changes core method | Only supplementary tasks on `C_best` described | Keep core identity fixed; package supplementary scripts separately. Route algorithmic changes through verified engineer/comparison flow. |
| Meta budget exhausted | Bounded loop, no explicit last assignment | Export latest completed coherent pair as unaccepted fallback; never label exhausted `Refine` as `Accept`. |
| Re-drafting from scratch | Paper explicitly says manuscript re-drafting after fundamental idea change | Re-enter Initial Drafter with updated state. Old prose can be auxiliary context, but create a new draft revision and invalidate old claims/evidence; paper does not require blank-context generation. |
| Nested budgets on meta success | Reset policy unstated | Reset local ablation and peer counters for new candidate; keep global meta attempts consumed. |
| Search stop after one success versus `S` | Selection paragraph says “upon discovering at least one”; evolution paragraph says stop at `S` or `K` | Complete search to `S`/cap, then select if at least one exists. Interpret “at least one” as selection eligibility, not an independent early-stop override. |
| Initial batch and `K` | §3.3 starts with top-`N_0` seeds at `k=0`; A.2 says one seed plus one evolved per experimentation round and four rounds | Default four total batches, initial batch drawn from seeds per §3.3; subsequent batches mix evolved/seed candidates. If enforcing A.2’s literal initial one-evolved mix, define the bootstrap evolver input explicitly. Record convention instead of claiming exact reproduction. |
| Full-set engineering exhaustion | Full-set critic/engineer described without restating subset rules | Apply bounded `Good`/`Bad`/`Engineer` symmetry and two-attempt cap; mark inherited semantics as implementation interpretation. |
| Failures, retries, cancellation | No universal operational policy | Fail closed, preserve provenance, and use an already completed coherent checkpoint if available; never invent scientific success. Infrastructure retries must be separately bounded and do not reset scientific budgets. |
| Integrity audit placement | pp.14–15 add agents/filtering, but §§3.4–3.6 do not place every audit in Figure 7 | Enforce experiment-time specification filtering and export-time integrity validation; keep explicit audit records. Precise scheduling is inferred; deterministic checks do not substitute for real audits. |
| Acceptance versus exported fallback | §3.6 explicitly exports previous best even after unsuccessful deep refinement | `FinalArtifacts` means exported artifacts, not necessarily accepted artifacts. Preserve termination reason and assessment metadata. |

## 10. Default configuration summary

| Parameter | Value / policy | Status |
|---|---|---|
| Limitation extraction cap | 16 rounds | [PAPER] A.2 p.30 |
| Experimentation batches | Up to 4 total | [PAPER] A.2; initial/refinement indexing mapping [INFERENCE] |
| Candidates per experimentation batch | 2; seed + evolved in A.2 | [PAPER] p.30; initial bootstrap ambiguous |
| Successful-idea target | 4 | [PAPER] A.2 |
| Engineering attempts | At most 2 | [PAPER] A.2; subset/full-set counting interpretation noted above |
| `N_p`, `N_t` | Planner/config supplied; no published numeric defaults | [PAPER] symbolic only |
| Ablation engineering attempts | At most 1 per ablation invocation | [PAPER] at most once; invocation/reset convention [INFERENCE] |
| Reviewer / score gate | ScholarPeer / score ≥ 8 on [1,10] | [PAPER] pp.8–9, 30 |
| Peer evaluations / enhancement attempts | 2 / 1 | [INFERENCE] adopted reading of A.2 |
| Meta engineering attempts | 1 | [INFERENCE] mapping of A.2 review-based refinement; symbol `N_meta` not numerically assigned |
| Initial drafter / format | PaperOrchestra / ICLR 2025 | [PAPER] pp.8, 30 |
| Agent backends | Gemini 3.6 Flash generally; listed Idea Experiment Coding, Ablation Study, Rebuttal, and Draft Enhancer roles use Claude Code with Opus 4.8 | [PAPER] A.2 p.30; no finer per-subagent backend mapping given |
| Final export | `P+ = P_new`, `C+ = C_best`, coherent revision pair | [PAPER] p.9 |
