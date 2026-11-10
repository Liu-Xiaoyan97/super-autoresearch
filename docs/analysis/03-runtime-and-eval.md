# ScientistTwo: runtime and evaluation contract

## Evidence conventions and critical qualifications

- **[PAPER]** denotes a statement/artifact actually present in *ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI*, arXiv:2609.19644v1. Page numbers below are the PDF's printed pages, not the stale cross-references in Appendix C. Image-only appendix artifacts were read using OCR in addition to text extraction.
- **[INFERENCE]** denotes a proposed local implementation, operationalization, formula not explicitly specified by the authors, or synthetic fixture data. These are not claims about the released implementation.
- **[PAPER]** Appendix C explicitly says: “since Procrustes-DS did not undergo this process, the example of TABHARMONY is presented” for rebuttal (p. 33). Consequently, there is **no observed Procrustes-DS limitation → subset → full-set → review → rebuttal → meta transcript** in this PDF. There are representative, non-exhaustive artifacts, including a feedback-refined full-set report. Do not invent missing subset measurements, review ratings, rebuttals, or meta-decisions.
- **[PAPER]** The Appendix C index on p. 33 is offset: limitations actually appear on pp. 34–35, proposal on pp. 36–39, experiment report on pp. 40–42, ablation on pp. 43–45, critic feedback on p. 46, reproduction audit on p. 47, specification/alignment audit on pp. 48–50, and TABHARMONY rebuttal on pp. 51–55. The final DynaSpec-RAG manuscript starts on p. 56.

## 1. Models, roles, and tools

**[PAPER] Exact runtime statement:** “Unless otherwise specified, we employ Gemini 3.6 Flash for all agents, except for the Idea Experiment Coding Agent, the Ablation Study Agent, the Rebuttal Agent, and the Draft Enhancer, which use Claude Code with Opus 4.8.” (A.2, p. 30.)

The following table applies A.2 literally. Tool descriptions distinguish explicit external integrations from logical artifact inputs/outputs; the paper does not publish a per-agent tool-permission manifest.

| Agent role | Model/backend [PAPER] | Tools / artifact operations [PAPER unless qualified] |
|---|---|---|
| Limitation Extractor; Limitation Verifier | Gemini 3.6 Flash | Analyze scientific problem/reference method; iterative extraction and verification (§3.1, p. 6). No external tool API specified. |
| Initial Idea Generator; Idea Generator | Gemini 3.6 Flash | Generate seed methods addressing limitations; rank through novelty feedback (§3.1). |
| Novelty Checker | Gemini 3.6 Flash | Google Search, retrieving **two reference papers** (A.2). Retrieval API, query policy, deduplication, and document loader unspecified. |
| Idea Evolver; Selector | Gemini 3.6 Flash | Read all historical experimental traces; generate evolved candidates; select among successful full-set candidates (§3.3, pp. 7–8). |
| Idea Experiment Coding Agent / unified idea implementer | Claude Code + Opus 4.8 | Modify and execute baseline/subset/full-set experiment code; self-contained scripts and execution instructions (§3.2; §4.2, p. 14). |
| Baseline Coder; Subset Coder; Full-Set Coder; Subset/Full-Set Engineer | Subroles of the coding pipeline; see qualification below | Repository editing, experiment execution, engineering, checkpoint/data reuse (§3.2, pp. 6–7). |
| Idea Critic / Subset Critic / Full-Set Critic | Gemini 3.6 Flash | Compare metrics and logs; emit `Bad`, `Good`, or `Engineer` plus feedback (§3.2). |
| Ablation Planner; Ablation Critic; Result Comparison Agent | Gemini 3.6 Flash | Plan component interventions; interpret ablations; compare old/new full-set results (§3.4, p. 8). |
| Ablation Study Agent / Ablation Coding Agent | Claude Code + Opus 4.8 | Execute planned component changes against the validated codebase (§3.4; A.2). |
| Initial Drafter / Writer | Gemini 3.6 Flash | PaperOrchestra; synthesize method, main results, and ablations into an ICLR 2025 manuscript (§3.5; A.2). |
| Peer-Reviewer | ScholarPeer; internal model not specified | External review system producing strengths, weaknesses, questions, and score (§3.5, pp. 8–9). Do not substitute the default model for ScholarPeer's undisclosed internals. |
| Rebuttal Planner | Gemini 3.6 Flash | Turn review concerns into supplementary experiment tasks (§3.5). |
| Rebuttal Agent / Rebuttal Coding Agent | Claude Code + Opus 4.8 | Implement and execute supplementary experiments against the best codebase (§3.5; A.2). |
| Draft Enhancer / Paper Enhancer | Claude Code + Opus 4.8 | Integrate reviews and supplementary results; update claims, tables, figures (§3.5; A.2). |
| Meta-Review Agent | Gemini 3.6 Flash | Read manuscript and reviews; emit `Accept` or `Refine` with strategic critique (§3.6, p. 9). |
| Specification/alignment refinement | Coding Agent; Writer consumes audit | Detect/discard rule-breaking solutions; audit method against implementation; repair method description (§4.2, pp. 14–15). |
| Reference-verification refinement | Search-augmented LLM; Writer | Identify hallucinated citations and correct bibliography using live search (§4.2). Exact search backend for this audit not specified. |
| Held-out evaluator, not a pipeline refinement agent | Stanford Agentic Reviewer | Review service at `https://paperreview.ai/`; underlying model unspecified (§4 common setup, p. 10). |

**[PAPER] Naming ambiguity:** §3 decomposes the implementation pipeline into multiple coders/engineers, whereas A.2 names the umbrella “Idea Experiment Coding Agent.” Additionally p. 15 says “we leverage Claude Code with Opus 4.8 whenever coding capabilities are required.” **[INFERENCE]** Route executable coding/engineering/audit subroles through the Claude coding backend; retain Gemini for reasoning/planning/critics. Record this mapping explicitly rather than claiming A.2 separately enumerates every subrole.

**[PAPER]** The backend-generalization experiment is a separate variant: Antigravity + **Gemini 3.8 Flash**, not the Gemini 3.6 Flash default, replaces Claude Code on five ICLR tasks; success is 60% versus Claude's 80% (Table 8, p. 15).

**[PAPER]** “To evaluate novelty, ScientistTwo retrieves two reference papers via Google Search.” “We use the ICLR 2025 format for drafting, following the PaperOrchestra.” (p. 30.) No global GPU allocation, temperature, token budget, API retry policy, container image, or sandbox specification is given in A.2.

## 2. Exact A.2 configuration contract

All quotations in this table are from p. 30. Config keys are **[INFERENCE]** names; values and quoted constraints are **[PAPER]**.

| Proposed config key | Value | Exact wording |
|---|---:|---|
| `limitations.max_rounds` | 16 | “We extract limitations for a maximum of 16 rounds.” |
| `novelty.reference_papers` | 2 | “To evaluate novelty, ScientistTwo retrieves two reference papers via Google Search.” |
| `experiments.candidates_per_round` | 2 | “In each idea experimentation round, we evaluate two candidates: one selected from the seed ideas and the other an evolved idea.” |
| `experiments.seed_candidates_per_round` | 1 | Same quotation immediately above. |
| `experiments.evolved_candidates_per_round` | 1 | Same quotation immediately above. |
| `experiments.max_rounds` | 4 | “We run this experimentation loop for up to four rounds, terminating early once four successful ideas are obtained.” |
| `experiments.early_stop_success_count` | 4 | Same quotation immediately above. |
| `engineering.max_rounds` | 2 | “If the Idea Critic Agent flags an idea for engineering refinement, we apply engineering techniques for at most two rounds.” |
| `ablation.max_refinements` | 1 | “Similarly, when the Ablation Critic Agent recommends refinement based on ablation results, we refine the idea at most once.” |
| `peer_review.max_rounds` | 2 | “Finally, the peer-review simulation runs for at most two rounds and terminates early if the ScholarPeer review score reaches 8, with review-based refinement conducted at most once.” |
| `peer_review.early_stop_score` | 8 | Same quotation immediately above. |
| `review_driven.max_refinements` | 1 | Same quotation immediately above; covers the stated review-based refinement cap. |
| `draft.format` | `iclr_2025` | “We use the ICLR 2025 format for drafting, following the PaperOrchestra.” |

**[PAPER] Additional transition rules:**

- Engineering exhaustion: “If N_eng is reached without achieving d = Good, h is designated as Bad and pruned” (§3.2, p. 7).
- Candidate success accumulation is stated as `sum(i=0..k) sum(h in H_i) I(d^h = Good) >= S`; if there are zero successes by round `K`, terminate the entire process (§3.3, p. 7).
- Following ablation refinement, replace the best hypothesis/results/code **only** when the Result Comparison Agent prefers the new result; a replacement requires ablations to run again (§3.4, p. 8).
- Peer review repeats until score ≥8 or its budget expires (§3.5, p. 9).
- Meta-review outputs `Accept` or `Refine`. On successful deeper refinement, rerun downstream ablation, drafting, and peer review. On non-improving refinement, retain/export previous best paper/code and terminate (§3.6, p. 9). This fallback is not necessarily a meta-accepted paper.

**[INFERENCE] Ambiguities to resolve in configuration, not silently invent:** A.2's one-seed/one-evolved wording does not explain round zero before traces exist; §3.3 instead starts with top seed ideas. A.2 does not specify total seed-pool size, ablation-plan count, supplementary-task count, exact `K` index convention, or whether two review rounds count the initial review. Interpret the final one-refinement cap as `meta_review.max_refinements=1` only with an explicit implementation note; the sentence does not separately enumerate rebuttal, draft enhancement, and meta-refinement budgets. Use two total review evaluations and at most one intervening rebuttal/enhancement in the mock. Do not apply a two-round budget independently to every nested phase and claim that multiplication is specified.

## 3. Benchmark protocol and executable artifacts

### Task population

**[PAPER]** The evaluation contains **107 scientific problems** (p. 10): **38 NeurIPS 2025 papers**, **5 ICLR 2026 papers**, and **64 ICML 2026 Spotlight papers** (A.1, pp. 28–29). The first two sets come from AutoSOTA benchmarks; ICML papers were selected by “strictly adhering to AutoSOTA's filtering process (e.g., verifying reproducibility)” (p. 28). These are paper/problem counts, **not 107 datasets**. A.1 lists paper titles, not a cross-task dataset inventory or total dataset count. It does not spell out all filtering commands or tolerances.

**[PAPER]** Accepted papers' “problem specifications and codebases serve as benchmark tasks” (p. 11). A task supplies the research problem and existing state-of-the-art method; the system must produce an improved paper plus reproducible implementation, not merely clear a registered scalar target (§3, p. 6; Appendix B, p. 30).

**[INFERENCE] Task manifest:** represent each problem as `{reference_paper, reference_repo, benchmark_protocol, datasets_and_splits, metric_definitions, baseline_references, task_rules}`. “Paper + repository + benchmark + metrics” is an operationalization of the workflow, not a formally published JSON input schema.

### Subset versus full-set

**[PAPER]** “ScientistTwo first employs a Baseline Coding Agent to reproduce the primary experiments of G on the benchmark subset,” producing `E_base` and `C_base` (§3.2, p. 6). Candidate subset code modifies that reproducible baseline. Critics compare candidate and reproduced baseline; `Good` scales to the entire benchmark suite, `Bad` is discarded, and `Engineer` enters bounded refinement (pp. 6–7). Successful full-set traces contain hypothesis, results, codebase, decision, and feedback (§3.3).

**[PAPER]** Appendix B says ScientistTwo evaluates on “the paper's full benchmark grid rather than the single registered split” (p. 31). In the five-ICLR comparison, four accepted gains are evaluated on the full benchmark; those papers have 5–6 ablations each (Table 15, p. 30). Examples include Pinet's four DC3 datasets, DMSQD's eleven-domain grid, and RALI's seven datasets (p. 32). This is evidence for benchmark breadth, not a common dataset-count requirement across tasks.

**[INFERENCE]** Freeze subset membership before candidate evaluation, pair baseline/candidate split and seed, and never treat subset success as final research success. The PDF provides no universal subset fraction, number of examples, or fixed train/validation/test sizes; those must be task-specific manifest fields.

### What “fully verified, executable codebases” means here

**[PAPER]** The four CoE integrity dimensions (§4.2, pp. 14–15) are:

1. **Score verification:** compare claimed scores with a re-execution of the repository.
2. **Specification compliance:** solution adheres to task rules without reward hacking; a Coding Agent filter detects and discards violating solutions immediately after experimentation.
3. **Reference verification:** bibliography has no hallucinated citations; live-search-grounded correction is used.
4. **Method–code alignment:** manuscript accurately describes the actual implemented method; Coding Agent produces an audit, Writer corrects discrepancies.

The execution requirement is to output “self-contained, reproducible scripts and execution instructions” (p. 14). There is **no universal byte-identical-output requirement, no 72/72 executable check, and no published universal numerical tolerance** in this paper. Its specific Procrustes-DS audit reruns `python final.py`, matches the displayed “Ours” numbers exactly, and independently regenerates cached features from the checkpoint (p. 47). That concrete bit-exact cache check must not be generalized to all 107 tasks. It explicitly states: “I only audited the Ours method (not the baseline).”

**[PAPER]** Table 7's final integrity results are **49/49 score verification**, **0/49 specification violations**, **0/1814 hallucinated references**, and **49/49 method–code aligned papers** (p. 14). These are audit-cohort counts, not the 86-paper overall generation cohort. No sandbox, network-isolation policy, filesystem jail, process timeout, or container-level security mechanism is described in the inspected setup/audit material.

## 4. Evaluation metrics, review scales, and denominators

### Research gain

**[PAPER]** The paper reports relative performance gain over human state-of-the-art baselines, median and average across successful cases. Table 4 gives ScientistTwo **7.7% median / 25.2% mean overall gain**, **7.0% / 13.9% for NeurIPS**, and **2.2% / 3.8% for ICLR** (p. 12). For shared NeurIPS/ICLR comparisons, it uses the same 33 and 4 input papers, respectively. AutoSOTA's overall successful-paper count is 105; ScientistTwo's is 86. These overall populations are not a paired common-hardware comparison.

**[PAPER]** Extraction procedure: “we parse the main tables for 10 times using Gemini 3.6 Flash and averaged them” (p. 12). The paper does **not** state an explicit universal formula for handling multiple metrics, negative/zero baselines, or aggregating gains within a heterogeneous task. Appendix B warns that the systems use their own reproduced baselines on different hardware; the two delta columns “are not a head-to-head on a common metric” (p. 30).

**[INFERENCE] Local transparent convention:** for positive baseline `b`, value `x`, and direction `s` equal to +1 for maximize or −1 for minimize, use `gain_pct = 100*s*(x-b)/abs(b)`. Mark zero baselines undefined; do not replace their denominator silently. Report per-metric gains first; explicitly declare any metric weights and averaging. Keep human-published baseline and locally reproduced baseline separate. This convention is **not** asserted to reproduce the paper's Gemini-extracted 25.2%.

### Automated review

**[PAPER]** Both review systems' reported ratings use a **1–10 scale**, summarized as mean ± standard deviation and acceptance percentage (Tables 2–5, pp. 10–13). ScholarPeer is **in-distribution**, because it also guides refinement; Stanford Agentic Reviewer is **held out**, unseen in development by method and baselines (p. 10).

**[PAPER]** The operational ScholarPeer review-loop threshold is **8** (A.2; §3.5). The score is described as `s_review ∈ [1,10]` using the standard ICLR grading scale (p. 9).

**[PAPER] Reporting gap:** the paper does **not separately specify numeric acceptance-rate cutoffs** for Table 2/3/5 ScholarPeer or Stanford decisions. Do not assume that the loop's target of 8 is the table's acceptance threshold, or invent a Stanford cutoff. The reported ScholarPeer mean 7.5 with 91.9% acceptance especially should not be converted into “91.9% scored at least 8.” Preserve evaluator decisions separately from numeric scores.

| Cohort [PAPER, Table 3, p. 12] | Generated / attempted | ScholarPeer rating / accept % | Stanford rating / accept % |
|---|---:|---:|---:|
| ICLR-derived | 4/5 | 7.0±1.2 / 100.0 | 5.4±0.2 / 75.0 |
| NeurIPS-derived | 33/38 | 7.3±1.7 / 87.9 | 5.6±0.7 / 75.8 |
| ICML Spotlight-derived | 49/64 | 7.6±1.0 / 93.9 | 5.7±0.6 / 69.4 |
| Overall | 86/107 | 7.5±1.3 / 91.9 | 5.7±0.6 / 72.1 |

**[INFERENCE]** Compute local success rate as `100*n_exported_improvements/n_attempted_tasks`; compute each review acceptance rate as `100*n_evaluator_accepts/n_reviewed_generated_papers`. Thus overall research success is 80.4%, whereas acceptance percentages are conditional on generated papers. Keep missing reviews and unsuccessful tasks visible instead of collapsing these denominators.

**[PAPER] Review ablation:** on 49 ICML-derived tasks, no simulated review yields ScholarPeer **5.2±2.2 / 46.9%**, Stanford **5.6±0.5 / 49.0%**; one round with rebuttal yields **6.9±1.6 / 79.6%** and **5.8±0.6 / 73.5%**; two rounds yield **7.6±1.0 / 93.9%** and **5.7±0.6 / 69.4%** (Table 5, p. 13). The second round is not monotonically better on held-out acceptance; an offline evaluator must not encode inevitable review improvement.

### Method–code alignment and other integrity metrics

**[PAPER] Exact definition:** “Method-Code (↑) measures alignment between paper methodology and code implementation.” (Table 7, p. 14.) The accompanying prose says it ensures “the paper faithfully and accurately describes the codebase implementation.” It is reported as aligned papers / audited papers, **not** a 1–10 review score or token-similarity metric. The worked audit emits `method_code_alignment = true` (pp. 48–50).

**[INFERENCE]** Aggregate Boolean alignment as `sum(alignment_pass)/n_audited`; require component-by-component method claims linked to code evidence. Do not invent an embedding/cosine alignment formula. Record score verification and violation checks separately, with their own denominators. Reference verification counts references, not manuscripts.

**[PAPER]** Without all refiners, Table 7 reports **50/50 reproducible, 1/50 specification violations, 19/1840 hallucinated references, 39/50 aligned**. With specification refinement only: **49/49, 0/49, 19/1817, 38/49**. Adding reference refinement: **49/49, 0/49, 0/1814, 38/49**. Adding alignment refinement gives the all-pass row above. The p. 15 footnote explains the lost task: an apparent additional success without specification refinement contained reward hacking and **must be filtered**.

## 5. Failure taxonomy and demo acceptance criteria

### Observed failures and bounded recovery

| Failure [PAPER] | Evidence | Required local behavior [INFERENCE] |
|---|---|---|
| Idea substantially underperforms; engineering does not rescue it | `Bad` and bounded `Engineer` flow, p. 7 | Retain diagnostic logs; prune after budget; feed failed traces into evolution. |
| No idea succeeds | Entire process terminates when zero successes remain at refinement limit, p. 7 | Return an explicit unsuccessful task, not a fabricated paper. |
| Metric gain is not attributable to proposed mechanism | DMC-TeCh improves 5/6 metrics but critic attributes gain to EMA/label smoothing, not multi-core innovation, p. 31 | Reject as a scientific contribution despite scalar improvement. |
| Statistically inert new component | Earlier RALI variant rejected by critic, Table 16, p. 32 | Log attribution/robustness failure independently of execution success. |
| Draft is not yet strong enough | Reviewer queries trigger supplementary experiments; meta-refinement example LFR-Engram → FCD-Engram, pp. 9, 14 | Preserve reviews and draft versions; run planned tasks; do not equate “draft exists” with acceptance. |
| Proposed refinement fails to improve best result | Ablation and meta result-comparison gates, pp. 8–9 | Roll back best-state pointer; do not overwrite better validated artifacts. |
| Reward hacking/specification violations | One extra apparent task success filtered, pp. 14–15 | Invalidate result even if reproducible and numerically better. |
| Hallucinated references or narrative/code mismatch | Table 7, p. 14 | Ground citations; repair method description against implemented code; rerun audit. |
| Fragile, harmful, or redundant theoretical components | Procrustes-DS critic, p. 46 | Remove or redesign components; reflect actual final method in paper. |

**[PAPER] Headline outcome:** “ScientistTwo improves 86 out of 107 papers (an 80.4% success rate) with an average relative improvement of 25.2% over human state-of-the-art methods” (p. 2). Twenty-one tasks do not become successful papers; the paper does not provide a complete per-cause breakdown of those 21. The final successful papers do not all receive evaluator acceptance. General limitations include not reaching spotlight-level quality and roughly $3,800/task expense (p. 18).

**[INFERENCE] Offline-demo contract:**

1. A deterministic positive fixture produces a complete paper/code artifact manifest, subset/full-set results, attributable ablations, review history, and all four integrity outputs.
2. Negative fixtures cover `Bad`, engineering exhaustion, zero-success termination, non-attributable gains, specification violation, low-scoring draft/rebuttal, non-improving refinement rollback, and citation/alignment repair. All stage budgets are enforced.
3. A separate **historical replay** may contain 107 task outcomes, 86 successes, and reported summary statistics. Reproducing those constants verifies aggregation/replay only; it does not establish scientific performance or reproduce real experiments.
4. A calibrated synthetic scoring suite may target 80.4% success and +25.2% mean gain, but those are explicitly mock calibration targets, not evidence that local code matches the paper. Do not require an invented single Procrustes-DS fixture to equal the cross-task 25.2% gain.
5. Preserve separate `exported`, `improves_baseline`, `mechanism_attributed`, `spec_compliant`, `peer_decision`, and `meta_decision` fields. A previous-best fallback is not a demonstrated meta-acceptance.

## 6. Canonical Procrustes-DS artifact trajectory

The following numbered sequence distinguishes the **shown** trajectory from unshown generic pipeline stages. The appendix prints a refined report before the critic report; its text establishes a feedback dependency, not a full chronological event log.

1. **Limitation extraction — shown, pp. 34–35.** X-Mahalanobis uses class-blind total-variance weights, direct addition of potentially misaligned layer representations, global static rather than instance-dependent weighting, tied covariance despite class heteroscedasticity/long tails, and uncalibrated Mahalanobis/VLM score fusion. **Artifact:** five-item limitation report with flaw, impact, and improvement opportunities.
2. **Novel method proposal — shown, pp. 36–39.** Propose HSKP class-aware kernel-polarization weights; orthogonal Procrustes alignment; class-subspace nullspace-residual instance gates; sample-count-scaled graphical elastic-net precision; and Dempster–Shafer fusion of sigmoid-calibrated evidence. **Artifacts:** method description/equations and illustrative implementation functions. These are the *initial* proposal, not the implemented final method audited later.
3. **Baseline and subset screening — prescribed by §3.2, but no subset record shown for this case.** **Artifact expected in a fixture [INFERENCE]:** subset manifest, paired baseline/candidate measurements, code snapshot, critic decision, and failure logs. **Do not fill these with paper numbers:** all six-dataset figures below belong to the full CIFAR-100 evaluation.
4. **Initial experimental/ablation feedback — shown retrospectively, pp. 40 and 46.** HSKP values near 0.11–0.13 make softmax nearly uniform; Procrustes gives only **+0.01% AUROC**; feature-level gating at β=0.5 reduces CIFAR-10 AUROC **96.83 → 88.02**; λ₀=μ₀=0.1 causes **79.89% AUROC on CIFAR-100-LT**; sigmoid-DS collapses to an unweighted linear sum in logit space. **Artifact:** five-point critic report identifying redundant/harmful components. This is not evidence of a separately documented subset result.
5. **Engineering / feedback-driven redesign — shown, p. 40; audited pp. 48–50.** Replace HSKP with Fisher-discriminability weights `w_l ∝ trace_l*(S_b/S_w)_l^2`; remove Procrustes; directly blend normalized features; replace fixed regularization with scale-matched shrinkage `Σ_hat=(1-s)Σ+s*(tr(Σ)/d)I`, `s=0.01`; use relative-Mahalanobis (`γ=0.5`); move residuals to a score-level asymmetric gate `min(0,z−θ)`, `θ=−3`; replace DS by additive standardized semantic/logit-energy/residual evidence, with energy and residual weights 0.5. Fit calibration only on ID-train. **Artifacts:** revised hypothesis and `logs/code_final_refine/final.py`, later renamed `logs/code_final/final.py`. The audit identifies `procrustes_ds.py` as an earlier round-zero variant, not the final implementation.
6. **Full-set evaluation — shown, pp. 40–42.** Balanced CIFAR-100 ID; ImageNet-21K-pretrained ViT-B/16 (`vit_base_patch16_224`), AdaptFormer PEFT, LogitAdjusted loss, **10 epochs, learning rate 0.01, batch 64, seed 0**. The post-hoc method reuses the same baseline checkpoint. Evaluate **all six** SCOOD OOD sets. ID top-1 is **92.95%**, versus the reference paper's 93.47%. **Artifacts:** full-set report, checkpoint/cached 12-layer L2-normalized features, per-dataset comparison, component table, and reproduction instructions.

   | OOD set | Final Procrustes-DS AUROC / FPR95 (%) | Reproduced X-Maha | Published X-Maha |
   |---|---:|---:|---:|
   | Texture | 100.00 / 0.00 | 100.00 / 0.00 | 100.00 / 0.00 |
   | SVHN | 99.89 / 0.36 | 99.25 / 1.66 | 99.50 / 1.91 |
   | CIFAR-10 | 97.51 / 12.61 | 95.91 / 22.30 | 96.47 / 19.52 |
   | Tiny ImageNet | 99.98 / 0.06 | 99.77 / 1.04 | 99.80 / 1.11 |
   | LSUN | 100.00 / 0.00 | 100.00 / 0.00 | 100.00 / 0.00 |
   | Places365 | 100.00 / 0.00 | 100.00 / 0.00 | 100.00 / 0.00 |
   | Reported average | **99.56 / 2.17** | **99.16 / 4.17** | **99.30 / 3.76** |

   **[PAPER]** Higher AUROC and lower FPR95 are better. Reported rounded means/differences are not perfectly arithmetically consistent: p. 42 says FPR95 improvement **1.99pp / 1.58pp**, while subtracting printed means gives 2.00pp / 1.59pp. **[INFERENCE]** Preserve reported and recomputed values separately rather than silently rewriting the evidence.
7. **Final controlled ablation — shown, pp. 43–45.** Vary only the 12-layer weighting vector; hold covariance, residual, energy, fusion, checkpoint, and six OOD datasets fixed. Uniform gives average **99.32/3.30**; trace-only **99.52/2.46**; HSKP-softmax **99.32/3.27**; pure Fisher **99.49/2.60**; Fisher-discriminability exponents 0.5/1/2/3 give **99.53/2.37**, **99.55/2.29**, **99.56/2.17**, **99.58/2.13**. **Artifacts:** ablation report and `logs/code_ablation0/ablation.py`. Default remains exponent 2; exponent 3 is best in this sweep, not automatically promoted. The ablation trace-only row includes all other refined components and therefore differs from the main report's original X-Maha row.
8. **Reproduction and integrity verification — shown, pp. 47–50.** Rerun `python final.py`; reproduce every final “Ours” result exactly; regenerate checkpoint features for layers 0/5/11 and obtain max absolute difference 0.0 against caches; verify 92.95% ID accuracy. Audit ID-train-only calibration, no hardcoded scoring answers, unmodified `get_measures`, shared-feature baseline, and seeding. **Artifacts:** `logs/eval_result/repro_check.json` with `"reproduction": true`, audit report with `spec_violation=false`, `method_code_alignment=true`, and method-to-code links. Printed paper-reference constants are used only in report comparison columns, not scoring.
9. **Review — not shown for Procrustes-DS.** **[INFERENCE] Mock continuation:** generate initial ICLR-format draft from final method/results/ablations, then scripted ScholarPeer review with questions and score. Artifacts: versioned draft and review JSON. Do not label a scripted score as a reported result.
10. **Rebuttal — explicitly absent for Procrustes-DS.** **[PAPER] Alternate exemplar:** TABHARMONY transfers from TabSwift to frozen TabPFN v2 on **50 TALENT datasets** (30 classification, 20 regression), five seeds, paired support/test samples; support ≤3000, test ≤2000, inner-CV support ≤1000. Mean classification AUC **0.8938→0.8942**, regression R² **0.7589→0.7625**, mean RMSE ratio **0.9787** (pp. 51–55). Artifacts include `rebuttal.py`, cached paired results, and pinned requirements. **[INFERENCE]** A Procrustes-themed mock rebuttal can exercise the same stage interface, but must be tagged synthetic and cannot reuse TABHARMONY outcomes as OOD evidence.
11. **Meta-review — generic mechanism only, no case-specific decision shown.** **[PAPER]** §3.6 defines `Accept`/`Refine`, deeper full-set engineering, result comparison, downstream reruns, and previous-best fallback (p. 9). **[INFERENCE] Mock artifact:** final meta-decision/critique plus an export manifest; test both direct accept and bounded refine/rollback paths.

## 7. Local execution and reproducibility implications

**[INFERENCE] Executable workspace contract:**

- An immutable **task manifest** contains reference paper/repository revision, benchmark evaluator revision/hash, dataset/split identifiers and counts, metric units/directions, reference and reproduced baselines, calibration restrictions, and acceptance rules.
- Each attempt has isolated writable code and run directories, explicit parent snapshot and hypothesis ID, method/component manifest, exact command/cwd/environment, dependency lock, seed, inputs/checkpoint/cache hashes, stdout/stderr, exit status, timing, and structured metrics. Baseline and candidate share an immutable evaluator, not a writable copied metric script.
- Keep separate `subset`, `engineering`, `full_set`, `ablation`, `rebuttal`, and `audit` run manifests. Snapshot every candidate; update a `best` pointer only after validated comparison. Never reuse stale caches without checking dataset, checkpoint, feature-extraction, and code provenance.
- Every claimed number links to run ID, raw artifact, aggregation rule, split, and metric implementation. Every method component links to implementing source/symbol and ablation. Retain paper versions, citations and retrieval timestamps, model IDs, prompts, tool calls/results, budget counters, review decisions, and repair reports.
- For real execution, add a subprocess/container sandbox, filesystem allowlists, resource limits, network policy, evaluator immutability checks, and timeouts. These are safety additions, **not paper-described security guarantees**.

**[PAPER] Resource evidence:** mean execution is about **2.5 days** (2–3 days in discussion), mean cost **$3,765** including token and virtual-machine costs; experimentation/idea refinement dominates (pp. 15–16). The TABHARMONY appendix gives an actual execution environment: `tabpfn==2.0.9`, `torch==2.6.0+cu124`, `scikit-learn==1.6.1`, `numpy==1.26.4`, one worker per GPU, about one hour on **8×V100** (p. 55). It says TabPFN checkpoints download openly without a license token; this case must not be called a proprietary-repository requirement. The generated DynaSpec-RAG paper reports an A100 timing measurement (p. 65); it is not a global ScientistTwo runtime specification.

| Dependency | Local reproducibility limitation | Proposed stub [INFERENCE] |
|---|---|---|
| Gemini/Claude models and Claude Code | Paid/proprietary services; exact version access and nondeterminism | Scripted typed agent responses, fixed model metadata, trace replay. Never claim equivalent scientific reasoning. |
| Google Search and retrieved papers | Live network/index changes | Frozen two-reference result bundle with titles, identifiers, excerpts, queries, and provenance. |
| ScholarPeer / Stanford reviewer | External systems, hidden model details and missing numeric acceptance cutoffs | Distinct deterministic reviewer adapters with explicit mock `decision`; keep Stanford-style fixture hidden from refinement. |
| GPU training and full benchmark data | Hardware, downloads, checkpoint storage, wall-clock/cost | Small synthetic data plus deterministic experiment executor; report `execution_mode=mock`. Optional CPU smoke test is a different performance regime. |
| Reference repositories | Access, versions, dependencies and dataset licensing vary; blanket proprietary-repo dependency is not established by the paper | Vendor/license-permitting tiny workspace or repository manifest stub; mark unavailable sources rather than invent access. |
| Paper formatting | PaperOrchestra/LaTeX environment may be unavailable | Emit deterministic ICLR-style Markdown/LaTeX artifact; mark PDF compilation separately. |
| Verification | Replay cannot establish real code execution or scientific truth | Validate fixture consistency, unchanged evaluator, provenance, stage transitions, and synthetic method/code mapping; label integrity evidence as mock. |

## 8. Proposed deterministic offline fixture

**[INFERENCE] Entire JSON below is synthetic schema/example data**, including dataset sizes and scoring coefficients. The six OOD identifiers and published/reproduced/final metric anchors are borrowed from the worked example, but proposed mock sizes are **not** appendix-reported sample counts. Each size field is explicitly marked as a mock count. The fixture is designed to be interpreted by a fixed scoring adapter, not executed as arbitrary embedded code.

```json
{
  "schema_version": "scientisttwo.offline.v1",
  "metadata": {
    "task_id": "mock-x-maha-001",
    "title": "Procrustes-inspired deterministic pipeline exercise",
    "execution_mode": "mock",
    "seed": 0,
    "paper": {"id": "2609.19644v1", "evidence_pages": [30, 40, 41, 42, 43, 44, 45, 47, 48, 49, 50]},
    "reference_method": "X-Mahalanobis",
    "repository": {"uri": "fixture://x-maha", "revision": "mock-r1"},
    "protocol_revision": "ood-fixed-v1",
    "size_provenance": "synthetic mock sizes, not paper measurements"
  },
  "datasets": {
    "id": {
      "name": "cifar100",
      "mock_train_size": 120,
      "mock_validation_size": 20,
      "mock_test_size": 60,
      "calibration_split": "train"
    },
    "ood": [
      {"name": "texture", "mock_subset_size": 10, "mock_full_size": 60},
      {"name": "svhn", "mock_subset_size": 10, "mock_full_size": 60},
      {"name": "cifar10", "mock_subset_size": 10, "mock_full_size": 60},
      {"name": "tiny_imagenet", "mock_subset_size": 10, "mock_full_size": 60},
      {"name": "lsun", "mock_subset_size": 10, "mock_full_size": 60},
      {"name": "places365", "mock_subset_size": 10, "mock_full_size": 60}
    ],
    "subset_membership": "fixed-prefix-indices",
    "paired_baseline_and_candidate": true
  },
  "metrics": [
    {"name": "auroc", "direction": "maximize", "unit": "percent", "bounds": [0, 100]},
    {"name": "fpr95", "direction": "minimize", "unit": "percent", "bounds": [0, 100]}
  ],
  "baseline_reference_values": {
    "published": {
      "average": {"auroc": 99.30, "fpr95": 3.76},
      "provenance": "paper p41; rounded reported average"
    },
    "reproduced": {
      "per_dataset": {
        "texture": {"auroc": 100.00, "fpr95": 0.00},
        "svhn": {"auroc": 99.25, "fpr95": 1.66},
        "cifar10": {"auroc": 95.91, "fpr95": 22.30},
        "tiny_imagenet": {"auroc": 99.77, "fpr95": 1.04},
        "lsun": {"auroc": 100.00, "fpr95": 0.00},
        "places365": {"auroc": 100.00, "fpr95": 0.00}
      },
      "reported_average": {"auroc": 99.16, "fpr95": 4.17}
    }
  },
  "scoring_function": {
    "type": "bounded_linear_quality_delta_v1",
    "quality_range": [-1, 1],
    "equation": "raw_value[d,m]=clamp(baseline[d,m]+quality*phase_scale*delta_at_quality_one[d,m],bounds[m])",
    "display_rounding": {"digits": 2, "mode": "half_even"},
    "phase_scale": {"subset": 0.8, "full_set": 1.0},
    "delta_at_quality_one": {
      "texture": {"auroc": 0.00, "fpr95": 0.00},
      "svhn": {"auroc": 0.64, "fpr95": -1.30},
      "cifar10": {"auroc": 1.60, "fpr95": -9.69},
      "tiny_imagenet": {"auroc": 0.21, "fpr95": -0.98},
      "lsun": {"auroc": 0.00, "fpr95": 0.00},
      "places365": {"auroc": 0.00, "fpr95": 0.00}
    },
    "aggregation": "unweighted_mean_of_unrounded_per_dataset_values",
    "comparison": "no_metric_regresses_and_at_least_one_strictly_improves",
    "noise": "none",
    "quality_one_anchor": "paper p41 final per-dataset values; not an actual experiment"
  },
  "budgets": {
    "limitation_rounds": 16,
    "candidates_per_round": 2,
    "experiment_rounds": 4,
    "successful_ideas_early_stop": 4,
    "engineering_rounds": 2,
    "ablation_refinements": 1,
    "review_evaluations": 2,
    "review_early_stop_score": 8,
    "meta_refinements": 1
  },
  "ideas": [
    {
      "id": "seed-harmful",
      "origin": "seed",
      "quality": -0.5,
      "mechanism_attributed": false,
      "engineering_quality_increments": [0.1, 0.1]
    },
    {
      "id": "seed-promising",
      "origin": "seed",
      "quality": 0.4,
      "mechanism_attributed": true,
      "engineering_quality_increments": [0.3]
    },
    {
      "id": "seed-neutral",
      "origin": "seed",
      "quality": 0.0,
      "mechanism_attributed": false,
      "engineering_quality_increments": [0.0, 0.0]
    },
    {
      "id": "evolved-final",
      "origin": "evolved",
      "parents": ["seed-harmful", "seed-promising"],
      "quality": 1.0,
      "mechanism_attributed": true,
      "components": ["fisher_weights", "relative_maha", "energy", "residual_gate"]
    },
    {"id": "seed-weak", "origin": "seed", "quality": -0.3, "mechanism_attributed": false, "engineering_quality_increments": []},
    {"id": "evolved-regression", "origin": "evolved", "parents": ["seed-harmful"], "quality": -0.2, "mechanism_attributed": false, "engineering_quality_increments": []},
    {"id": "seed-no-gain", "origin": "seed", "quality": 0.0, "mechanism_attributed": false, "engineering_quality_increments": []},
    {"id": "evolved-stalled", "origin": "evolved", "parents": ["seed-neutral"], "quality": 0.0, "mechanism_attributed": false, "engineering_quality_increments": []}
  ],
  "scripted_schedule": [
    {"round": 0, "candidates": ["seed-harmful", "seed-promising"], "initial_round_convention": "seeds_only_as_in_section_3_3"},
    {"round": 1, "seed_candidate": "seed-neutral", "evolved_candidate": "evolved-final"},
    {"round": 2, "seed_candidate": "seed-weak", "evolved_candidate": "evolved-regression"},
    {"round": 3, "seed_candidate": "seed-no-gain", "evolved_candidate": "evolved-stalled"}
  ],
  "novelty_retrieval": {
    "provider": "frozen_google_search_fixture",
    "references": [{"id": "mock-ref-a"}, {"id": "mock-ref-b"}]
  },
  "ablation": {
    "quality_decrements_when_removed": {"fisher_weights": 0.15, "relative_maha": 0.20, "energy": 0.10, "residual_gate": 0.35},
    "minimum_attributed_gain": 0.01
  },
  "review_script": {
    "provenance": "synthetic continuation; not observed for Procrustes-DS",
    "scholarpeer": [
      {"score": 6, "decision": "revise", "questions": ["demonstrate attribution"]},
      {"score": 8, "decision": "accept", "questions": []}
    ],
    "rebuttal_tasks": [{"id": "attribution-check", "outcome": "supporting_evidence"}],
    "held_out_stanford": {"score": 5.7, "decision": "accept"},
    "meta": [{"decision": "Accept", "critique": "mock evidence sufficient"}]
  },
  "integrity_expectations": {
    "score_verification": true,
    "spec_violation": false,
    "hallucinated_reference_count": 0,
    "method_code_alignment": true,
    "verification_mode": "mock-consistency-only"
  },
  "expected_artifacts": [
    "limitations.json", "ideas.json", "workspace-manifest.json", "subset-results.json",
    "engineering-report.md", "full-results.json", "ablation-results.json", "draft-v1.md",
    "review-1.json", "rebuttal-results.json", "draft-v2.md", "review-2.json",
    "integrity-audit.json", "meta-review.json", "export-manifest.json"
  ]
}
```

**[INFERENCE] Fixture semantics:** the schedule declares candidate IDs and makes the round-zero seed-only convention explicit. Qualities are mock ground truth hidden from the agents, not numerical targets exposed to idea generation. Critics receive only metrics/logs and independent attribution/compliance evidence. The scripted promising seed receives `Engineer` once before scale-up, while harmful and neutral candidates are pruned; additional typed response scripts supply the reasoning text and decisions. Engineering adds the declared increment to effective quality, clamped to [−1,1]; ablation subtracts its declared decrement. This schedule reaches the four-round cap with two successful ideas, selects `evolved-final`, and continues downstream (it does not falsely trigger the four-success early stop). Test malformed schedules as validation failures. Use a declared round-half-even policy and keep full-precision results before display rounding. A run should emit byte-stable **mock** artifacts for the same fixture, a stronger local test property that is not attributed to ScientistTwo's scientific benchmark. Preserve reported historical averages separately from recomputed mock averages.
