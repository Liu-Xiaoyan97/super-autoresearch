# ScientistTwo: implementation contract for idea generation, execution, and evolution

**Source:** *ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI*, §§3–3.3, Listing 1, Table 1, Figures 3–6, and Appendix A.2. Related passages in §§1, 3.4–3.6, 4.2–4.3 and Appendix B are used only to clarify interfaces and constraints. Page numbers below are the paper's printed pages, which match PDF page numbers. Listing 1/Table 1 are on **p.5**, not p.4; Figure 3 is on p.4.

**Labels:** **[PAPER]** means stated or directly represented in the paper. **[INFERENCE]** means an implementation interpretation, proposed schema, or necessary decision not fixed by the paper. An unspecified parameter is not a license to silently choose a value.

## 1. Boundary and common stage abstraction

### 1.1 Problem and artifact boundary

**[PAPER]** Given scientific problem \(G\), the complete system returns a paper and reproducible codebase:

\[
(P^+,C^+)=\mathcal A(G),\qquad
\mathcal A=\{\mathcal A_1,\ldots,\mathcal A_{N_a}\}. \tag{1}
\]

The problem setup requires that the paper identify and resolve methodological or empirical bottlenecks, and that the code correctly implement the idea, preserve reproducibility, and demonstrate measurable gains (p.6). This note ends with the selected \((h_{\mathrm{best}},E_{\mathrm{best}},C_{\mathrm{best}})\); ablation and writing are downstream consumers, not part of ACoder.

### 1.2 Exact Listing 1 semantics

**[PAPER]** Listing 1 (p.5), transcribed exactly in executable-style pseudocode:

```python
def stage(candidate, critic, refine, max_rounds):
    for _ in range(max_rounds):
        verdict, feedback = critic(candidate)
        if verdict == "accept":
            return candidate
        elif verdict == "refine":
            candidate = refine(candidate, feedback)
        else:
            return None
    return None
```

The caption states: “If accepted, the artifact is returned; if rejected, it is discarded; otherwise, it is iteratively refined based on the critic’s feedback up to a maximum number of rounds” (p.5).

**[PAPER: consequences of the listing]**

- `candidate` is an existing artifact, not an agent or constructor. Initial generation is outside `stage`.
- `critic(candidate)` returns `(verdict, feedback)`. The intended verdict domain is `{accept, refine, reject}`.
- `accept`: return the **current** candidate immediately; do not refine or call the critic again.
- `refine`: call `refine(current_candidate, feedback)` and replace the current candidate with its return value.
- `reject`: return `None` immediately. The literal `else` also treats any unrecognized verdict as rejection.
- `max_rounds` budgets **critic calls**, not just refinement operations. At most `max_rounds` critic calls and `max_rounds` refinement calls occur.
- A refinement on the last permitted round is **not re-evaluated**. The function falls through and returns `None`, even if that last refinement might have succeeded.
- With a zero or negative integer budget, Python `range` is empty and the result is `None`; no critic call occurs.
- No candidate history, feedback history, rejection reason, or partial result is returned. No exception handling, asynchronous execution, retry policy, or invalid-budget validation is specified.

**[INFERENCE]** A production adapter should validate the verdict enum, persist the history before returning, and distinguish rejected/budget-exhausted/error outcomes. These additions must not be mistaken for Listing 1's return contract. In particular, do not naively use its critic-call budget as the engineering-operation budget in §3.2.

### 1.3 Pipeline instantiations and agent bindings

**[PAPER]** Table 1 (p.5) gives the following candidate/critic/refinement abstractions. Agent names in the first seven rows are resolved from §§3.1–3.3 (pp.6–8). The remaining rows identify the boundary of the same abstraction using §§3.4–3.6 (pp.8–9).

| Table 1 stage | Candidate artifact and producing role | Critic role and exact Table 1 question | Refinement role/action |
|---|---|---|---|
| Finding limitations | Set of limitations; Limitation Extractor | Limitation Verifier: “Can guide novel improvement?” | Limitation Extractor: “Add missing limitations” |
| Seed idea generation | Seed ideas; Initial Idea Generator, then Idea Generator | Novelty Checker: “Is it novel?” | Idea Generator: “Add more novel ideas” |
| Reproduce baseline on subset | SOTA baseline result; Baseline Coding Agent | `-` | `-` |
| Idea experiment on subset | Idea, Code, Results; Subset Coding Agent | Subset Critic Agent: “Is it better than the reproduced baseline?” | Subset Engineering Agent: “Refine idea through engineering” |
| Idea experiment on full-set | Idea, Code, Results; Full-Set Coding Agent | Full-Set Critic Agent: “Is it better than the original SOTA result?” | Full-Set Engineer / Full-Set Engineering Agent: “Refine idea through engineering” |
| Idea evolution | Evolved idea; Idea Evolver Agent | “Idea experiment,” implemented by ACoder | Idea Evolver Agent: “Evolve idea from traces” |
| Select best idea | Best idea; Selector Agent selects from successful traces | “What is the best idea from traces?”; Selector Agent | `-` |
| Ablation study | Idea, Ablation results; selected idea plus Ablation Planner/Coding Agents | Ablation Critic: “Is the component breakdown clean?” | Full-Set Engineering Agent, with Result Comparison Agent verification: “Refine the method” |
| Initial drafting | Manuscript; Initial Drafter | `-` | `-` |
| Peer-Review | Manuscript; drafting/enhancement output | Peer-Reviewer: “Is review score good enough?” | Rebuttal Planner/Coding Agents and Paper Enhancer: “Run rebuttal experiments” |
| Meta-Review | Manuscript, Review; preceding drafting/review outputs | Meta-Review Agent: “Does it meet the venue bar?” | Full-Set Engineering Agent, Result Comparison Agent, then downstream analyses/writing: “Refine idea and analyze again” |

**[PAPER]** The authors say, “For clarity, we abstract all stages ... using the Python-style pseudocode in Listing 1” (p.5).

**[INFERENCE]** This is a conceptual common pattern, not proof that each row literally calls the same function. Baseline reproduction and initial drafting have no critic; selection has no refinement; evolution operates on pools and historical traces. For subset evaluation, `Good → accept`, `Engineer → refine`, `Bad → reject` is a natural local adapter. For full-set evaluation, use the analogous adapter, but the detailed full-set decision rubric is not separately enumerated. Limitation verification and novelty checking have no explicitly specified reject verdict or formal output schema in their dedicated descriptions.

## 2. §3.1: limitations and novel seed ideas

### 2.1 Agent contracts: paper-specified payloads versus inferred wiring

| Agent | [PAPER] Input/context and responsibility | [PAPER] Output | [INFERENCE] Required explicit wiring/schema |
|---|---|---|---|
| Limitation Extractor | Initially extracts limitations “from \(G\)” (p.6); on insufficiency identifies missing limitations or weaknesses and expands the collection | Initial set, then expanded set of limitations | Supply \(G\), current limitation set, and verifier feedback on subsequent calls; preserve stable limitation IDs, provenance, and expansion history |
| Limitation Verifier | Judges whether the current set “is sufficient to guide novel improvements to \(G\)” (p.6) | Sufficiency/completeness judgment: confirm all actionable limitations extracted, or require expansion | Return `sufficient: bool`, rationale, and actionable missing areas; the paper does **not** prescribe this tuple, Boolean encoding, numeric score, or list of missing limitations |
| Initial Idea Generator | Figure 4 names this role; §3.1 says the initial idea is specifically designed to address identified limitations (p.6) | One initial idea \(h_0\) | Supply \(G\) plus verified/current limitations; return hypothesis, targeted limitation IDs, proposed mechanism, and implementation plan |
| Novelty Checker | Computes the initial idea's novelty score; scores support final ranking (p.6); retrieves reference literature through Google Search (A.2, p.30) | Novelty score \(s_i\) associated with each candidate | Supply idea and research context; preserve retrieved papers and novelty rationale. A per-candidate scoring call is needed for all \(s_i\), but the invocation schedule beyond \(h_0\) is not specified |
| Idea Generator Agent | Iteratively expands the candidate pool with “distinct, higher-novelty ideas” (p.6) | Additional ideas until the pool contains \(N_{\mathrm{seed}}\) candidates | Supply \(G\), limitations, existing pool, and novelty feedback to avoid repeats and target originality; exact formal input signature, batch size, and duplicate test are not given |

**[PAPER]** These are named responsibilities and semantic artifacts, not published prompt templates or complete typed RPC signatures. In particular, the paper does not give an exact serialized verifier response. Do not claim that a verifier-produced missing-limitations list or a numeric novelty threshold is mandated.

### 2.2 Limitation verification loop

**[PAPER]** The branch condition and loop termination are explicit:

> “If the Limitation Verifier considers the set insufficient, the Limitation Extractor again identifies missing limitations or weaknesses and expands the collection. This verification loop repeats until the Limitation Verifier confirms that all actionable limitations have been thoroughly extracted or maximum number of iterations is reached.” (p.6)

A.2 fixes the cap: “We extract limitations for a maximum of 16 rounds” (p.30).

Operational sequence supported by the text:

1. Extract a set from \(G\).
2. Verify sufficiency for guiding novel improvements.
3. If sufficient, stop this loop and use the limitations for idea generation.
4. If insufficient and budget remains, expand rather than replace the collection with an unrelated set; verify again.
5. Stop at the configured cap even if the verifier remains unsatisfied.

**[INFERENCE / unresolved]** The paper does not say whether the initial extraction counts as one of the 16 rounds, whether a final expansion gets an additional verification call, or whether exhausting the cap returns the partial set or fails the stage. Listing 1 would return `None` on exhaustion; §3.1 only says the loop stops. A proposed policy is 16 extraction–verification pairs total, followed by an explicit `exhausted` status requiring a configured continue/abort policy. Do not silently label an unverified set sufficient.

### 2.3 Seed-pool construction, novelty evidence, and ordering

**[PAPER]** The construction and ranking are:

\[
\mathcal H_0\leftarrow\{h_0\},\qquad s_0=\operatorname{NoveltyChecker}(h_0),
\]

\[
\mathcal H_0=\{h_i\}_{i=0}^{N_{\mathrm{seed}}-1},\qquad
\{s_i\}_{i=0}^{N_{\mathrm{seed}}-1},\qquad
 i<j\Longrightarrow s_i\ge s_j.
\]

> “This process continues until a collection of \(N_{\mathrm{seed}}\) candidate ideas is gathered.” (p.6)
>
> “Finally, the seed ideas ... are sorted in descending order according to their novelty scores.” (p.6)

**[PAPER]** Novelty is intended to prioritize originality relative to existing research, grounded in retrieved reference papers. A.2 specifies: “To evaluate novelty, ScientistTwo retrieves two reference papers via Google Search” (p.30).

**[INFERENCE / not specified]** It is reasonable to compare each proposed mechanism with those papers, but no similarity function, scoring equation, rubric, range, calibration, acceptance threshold, or score aggregation is published here. A.2 does not explicitly say whether the two papers are fetched once, per idea, or per checker invocation, nor how they are selected, refreshed, deduplicated, or handled on retrieval failure. “Higher-novelty” does not specify higher than the initial idea, the last idea, or the current maximum. No proof of strict monotonic score improvement is required by the stated final non-increasing ordering. The `h_0` initially generated may move away from rank zero after sorting; preserve its identity independently of array position.

## 3. §3.2: ACoder, subset screening, and full-set validation

### 3.1 Baseline reproduction and subset implementation

**[PAPER]** The Baseline Coding Agent reproduces “the primary experiments of \(G\) on the benchmark subset,” producing “baseline experimental results \(E_{\mathrm{base}}\) alongside a reproducible subset codebase \(C_{\mathrm{base}}\)” (p.6).

- Semantic input: \(G\), including the primary baseline method/experiments and benchmark context.
- Semantic output: \((E_{\mathrm{base}},C_{\mathrm{base}})\).
- Table 1 specifies no baseline critic or refinement stage (p.5).

**[PAPER]** Initial screening selects “only the top-\(N_0\) highest-ranked ideas” from \(\mathcal H_0\) (p.6). For idea \(h\), the Subset Coding Agent implements it “by modifying \(C_{\mathrm{base}}\),” producing logs \(E_{\mathrm{sub}}^h\) and reproducible codebase \(C_{\mathrm{sub}}^h\) (p.6).

**[INFERENCE]** Make the subset definition, baseline artifacts, dataset/split versions, metrics, evaluation scripts, commands, and environment explicit inputs through \(G\) or a run context. ACoder's formal signature does not expose these separately. Cache a validated baseline per problem/protocol rather than unnecessarily reproduce it for every candidate; the text says “first” but does not specify cache scope. Fork immutable baseline snapshots so one candidate cannot contaminate another.

### 3.2 Subset Critic three-way contract

**[PAPER]** The Subset Critic compares \(E_{\mathrm{sub}}^h\) with \(E_{\mathrm{base}}\), emitting \((d^h,r^h)\), where \(r^h\) is feedback and, for engineering, a strategy (pp.6–7).

| Verdict | Exact rule (p.7) | Control-flow effect |
|---|---|---|
| `Bad` | “If performance is substantially inferior to the baseline, \(h\) is discarded” | Stop this idea's subset pipeline; do not scale it up; retain its failure trace for evolution |
| `Good` | “If \(h\) consistently outperforms the baseline, it is approved for scale-up” | End subset refinement and invoke full-set coding; **not yet a globally successful idea** |
| `Engineer` | “If \(h\) shows potential but requires hyperparameter tuning or code adjustments” | Subset Engineering Agent refines both \(h\) and \(C_{\mathrm{sub}}^h\), guided by \(r^h\), then produces new \(E_{\mathrm{sub}}^h\) for re-evaluation |

The budget rule is explicit:

> “This refinement loop repeats until \(d^h\in\{\mathrm{Good},\mathrm{Bad}\}\) or a budget of \(N_{\mathrm{eng}}\) iterations is exhausted. If \(N_{\mathrm{eng}}\) is reached without achieving \(d=\mathrm{Good}\), \(h\) is designated as Bad and pruned.” (p.7)

A.2 adds: “If the Idea Critic Agent flags an idea for engineering refinement, we apply engineering techniques for at most two rounds” (p.30).

**[INFERENCE: budget interpretation]** Count engineering operations separately from initial critic evaluation: evaluate initial implementation, permit up to \(N_{\mathrm{eng}}\le2\) engineer–execute–critic cycles, then convert a remaining `Engineer` into terminal `Bad`. This permits accepting the result of the last allowed engineering operation. That interpretation matches “without achieving ... Good,” but it is **not** identical to Listing 1's last-refinement-without-recheck behavior. Store the last raw verdict and the budget-forced terminal verdict separately.

### 3.3 Full-set scale-up

**[PAPER]** Only subset-validated `Good` ideas advance:

> “For ideas validated as Good, ScientistTwo scales the evaluation to the full benchmark.” (p.7)
>
> “A Full-Set Coding Agent adapts \(C_{\mathrm{sub}}^h\) to run across the entire benchmark suite.” (p.7)

The Full-Set Critic Agent and Full-Set Engineer perform final validation/engineering, yielding \(E_{\mathrm{full}}^h\), \(C_{\mathrm{full}}^h\), and terminal \(d^h\) (p.7). Table 1's full-set comparison target is the **original SOTA result**, unlike the subset's reproduced baseline (p.5).

**[PAPER versus INFERENCE]** A full-set critic/engineer loop is present in Figure 5 and the prose, and A.2's engineering cap is general. The paper does not separately restate full-set `Bad/Good/Engineer` thresholds or specify whether the two-round budget is independent per phase or shared per idea. Implementing the same three-way decision loop, with a separately tracked cap per phase, is a sensible **inference**, not an explicitly defined budget allocation. Full-set failure must not inherit subset `Good` as its terminal success.

### 3.4 Unified interface and terminal trace

**[PAPER]** Equation (2) (p.7) is the complete public tuple contract:

\[
\boxed{(h,E^h,C^h,d^h,r^h)=\mathcal A_{\mathrm{Coder}}(G,h).} \tag{2}
\]

| Element | Meaning supported by §§3.2–3.3 |
|---|---|
| Input \(G\) | Scientific problem and baseline/benchmark context |
| Input \(h\) | Candidate hypothesis to implement and evaluate |
| Output \(h\) | Evaluated hypothesis; engineering may have refined it |
| Output \(E^h\) | Execution results/logs; full-set for validated successes, subset results/failure evidence for ideas pruned before scale-up |
| Output \(C^h\) | Corresponding reproducible codebase, updated by coding/engineering |
| Output \(d^h\) | Terminal `Good` or `Bad`; `Engineer` is an intermediate control signal |
| Output \(r^h\) | Critic feedback, diagnostic lessons, and engineering strategy where applicable |

**[PAPER]** Figure 5 labels the outputs “Codebase of Idea,” “Good or Bad,” and “Results & Lessons” (p.7). §3.3 explicitly consumes diagnostic failure logs (p.7).

**[INFERENCE]** The paper does not fully define \(E^h,C^h,r^h\) for an unrecoverable execution error or early rejection. Preserve the latest artifacts, phase reached, error evidence, all intermediate attempts, original idea ID, and resulting idea version. Do not return bare `None` on rejection: that loses the required evolution feedback. If no runnable code/results exist, use explicit missing-artifact/error fields rather than inventing numerical results.

### 3.5 Scholarly performance contract: what can actually be enforced

**[PAPER]** This is not single-scalar target chasing. The introduction says ideas are evaluated across “comprehensive, multi-dataset benchmarks” using “representative benchmark slices” for screening (p.2). Figure 3 says each idea is verified “across multiple datasets and evaluation metrics” (p.4). Subset `Good` means “consistently outperforms the baseline” (p.7), and the Selector considers full-benchmark “performance metrics and execution logs across all validated ideas” (p.8).

| Contract dimension | [PAPER] Constraint | Unspecified detail / [INFERENCE] needed for implementation |
|---|---|---|
| Which metrics? | Metrics of the scientific problem's primary experiments/benchmark; plural metrics, not an arbitrary new single proxy | Enumerate metric IDs, definitions, units, evaluation code, primary/secondary roles, and decision aggregation in a problem-specific protocol; no universal metric is named |
| Which datasets? | Benchmark subset first, then “entire benchmark suite” (p.7) | Explicit dataset/model/task/split/configuration grid and representative subset selection; the paper gives no universal dataset list |
| How many? | Multi-dataset and multi-metric intent; all cases in the chosen full suite | No fixed number of datasets, metrics, repetitions, or seeds. Do not substitute the paper's 107 research problems for datasets within one experiment |
| Comparator | Reproduced subset baseline; original SOTA result for full-set in Table 1 (p.5) | Resolve hardware/protocol differences and whether to reproduce full-set baseline too; keep reported and reproduced baselines distinct |
| Improvement direction | “better,” “consistently outperforms,” “substantially inferior” | Store maximize/minimize per metric; no universal higher-is-better rule. Table 6 (p.14), for example, has both upward and downward arrows |
| Required breadth/size of gain | Consistency and holistic evidence, rather than a single target | No minimum percentage, win fraction, all-cells requirement, allowed regression, weighting, or Pareto rule is specified |
| Noise/statistics | No formal criterion in §§3.1–3.3/A.2 | Specify repeats, seed pairing, uncertainty, significance/effect-size thresholds, equivalence margins, handling of missing/failed cells, and compute matching |
| Validity | Reproducibility and method correctness (p.6); specification compliance filter “detect[s] and discard[s] rule-violating solutions immediately after experimentation” (p.14) | Enforce immutable evaluation protocol, dataset isolation, and artifact provenance before accepting numerical gains |

**[PAPER, related clarification]** Appendix B says ScientistTwo operates “without predefined numerical targets” (p.30). It also describes evaluation on “the paper’s full benchmark grid rather than the single registered split” and a “protocol-immutability audit” (p.31). It notes comparisons against reproduced baselines on different hardware (p.30), creating a real ambiguity relative to Table 1's “original SOTA result.” A method can beat the baseline on 5 of 6 metrics yet later be rejected because ablations attribute gains to generic training controls rather than the proposed mechanism (p.31). Thus full-set `Good` in this scope is not sufficient for final acceptance as a scientific contribution.

**[INFERENCE: minimal operational policy]** Before experiments, freeze a `BenchmarkProtocol` containing the full evaluation grid, subset grid, metric directions, baseline provenance, constraints, and a versioned comparison policy. A normalized gain can be represented as \(\Delta_j=\sigma_j(x_j-b_j)\), where \(\sigma_j=+1\) for maximize and \(-1\) for minimize; this is a proposed implementation convenience, **not a paper formula**. The comparison policy must explicitly map the multi-cell evidence to `Good`, `Bad`, or `Engineer`. Neither “any positive cell” nor “every cell strictly improves” is justified as the paper's exact rule.

## 4. §3.3: trace-conditioned evolution and selection

### 4.1 Initial round and historical memory

**[PAPER]** Round \(k=0\) executes the top-\(N_0\) seed ideas with ACoder (p.7). The paper writes:

\[
\mathcal R_0=\{(h,E^h,C^h,d^h,r^h)\mid h\in\mathcal H_0\}.
\]

**[PAPER / notation inconsistency]** Here \(\mathcal H_0\) previously denotes the **entire** \(N_{\mathrm{seed}}\)-element seed pool, but the accompanying sentence says only top-\(N_0\) are executed. Those are not equivalent when \(N_0<N_{\mathrm{seed}}\).

**[INFERENCE]** Preserve the original pool and introduce a separate initial evaluation batch \(B_0=\operatorname{Top}_{N_0}(\mathcal H_0)\); define \(\mathcal R_0\) over \(B_0\). Never mark all seeds evaluated just because the literal set-builder uses \(\mathcal H_0\).

**[PAPER]** For refinement round \(k\ge1\):

\[
\mathcal R_{<k}=\bigcup_{i=0}^{k-1}\mathcal R_i.
\]

The Idea Evolver \(\mathcal A_{\mathrm{Evolve}}\) uses all historical execution traces to produce \(\mathcal I_k\), a set of \(N_k\) evolved ideas. It “analyzes both successful results (\(d^h=\mathrm{Good}\)) and diagnostic failure logs (\(d^h=\mathrm{Bad}\)) to propose refined hypotheses” (p.7).

**[INFERENCE]** Its semantic input is \(\mathcal R_{<k}\) plus problem context \(G\); no formal AEvolve call signature is supplied. Include failed ideas and engineering histories, not just winning scores. Retain parent idea IDs and record which traces motivated each evolved hypothesis.

### 4.2 Exploration/exploitation mixture and evaluation

**[PAPER]** Evolved candidates exploit observed results; previously unevaluated seeds explore alternatives to early local optima. The paper specifies:

\[
\mathcal H_0^{(k)}\subset\mathcal H_0,
\qquad |\mathcal H_0^{(k)}|=N_e,
\]

where \(\mathcal H_0^{(k)}\) contains “the next \(N_e\) highest-ranked unevaluated seed ideas” (p.7), and

\[
\mathcal H_k=\mathcal I_k\cup\mathcal H_0^{(k)}.
\]

Each candidate is evaluated by ACoder:

\[
\mathcal R_k=
\left\{
(h,E^h,C^h,d^h,r^h)
\;\middle|\;
(h,E^h,C^h,d^h,r^h)=\mathcal A_{\mathrm{Coder}}(G,h),\ h\in\mathcal H_k
\right\}. \tag{3}
\]

**[INFERENCE]** With distinct, disjoint candidates, batch size is \(N_k+N_e\); a set union alone does not guarantee this cardinality if evolved ideas duplicate seeds. The paper supplies no exhaustion or deduplication fallback when fewer than \(N_e\) unused seeds remain.

### 4.3 Stopping and best-idea selection

**[PAPER]** Define the cumulative successful-idea count exactly as used on p.7:

\[
M_k=\sum_{i=0}^{k}\sum_{h\in\mathcal H_i}
\mathbb I(d^h=\mathrm{Good}).
\]

> “This evolutionary loop iterates until \(S\) successful ideas ... are collected, or the maximum refinement limit \(K\) is reached.” (p.7)

The successful stopping condition is

\[
M_k\ge S.
\]

The explicit whole-run failure condition is

\[
\sum_{i=0}^{K}\sum_{h\in\mathcal H_i}
\mathbb I(d^h=\mathrm{Good})=0
\quad\Longrightarrow\quad
\text{terminate the entire process}. 
\]

**[PAPER]** “Upon discovering at least one successful idea,” the Selector compares metrics and logs across **all** validated ideas evaluated on the **full benchmark** (p.8):

\[
(h_{\mathrm{best}},E_{\mathrm{best}},C_{\mathrm{best}})
=\mathcal A_{\mathrm{Selector}}\!\left(
G,\{(h,E^h,C^h)\mid d^h=\mathrm{Good}\}
\right). \tag{4}
\]

**[PAPER]** Selection is an agent judgment over performance metrics and execution logs, not a published scalar `argmax`, not the most novel seed, not the last idea, and not automatically the first `Good` result.

**[INFERENCE]** At the limit with \(1\le M_K<S\), proceed to selection from the available successes: the text requires at least one and only aborts the entire process at zero. The phrase “upon discovering at least one” could suggest selecting earlier, but should not silently override the explicit \(S\)-or-\(K\) search termination rule. A provisional best may be tracked while searching; final selection follows termination. Numeric ranking, trade-off handling, and tie-breaking remain unspecified.

### 4.4 Control-flow pseudocode

**[INFERENCE]** The following makes the prose operational while retaining its mathematical round convention. `K` here is a **maximum refinement index after initial round 0**. This pseudocode is not an assertion that Appendix A.2's four rounds means `K = 4`.

```text
limitations = extract_verify_expand(G, cap=16)
# Explicit configured policy decides what to do if limitations remain insufficient.
seed_pool = generate_and_score_seeds(G, limitations, N_seed)
seed_pool = sort_descending_novelty(seed_pool, configured_tie_break)
(E_base, C_base) = reproduce_subset_baseline(G, frozen_protocol)

evaluated_seed_ids = empty set
history = empty list
for k in 0 .. K inclusive:
    if k == 0:
        batch = top N_0 seed_pool entries
    else:
        R_before_k = all earlier terminal traces, Good AND Bad
        evolved = Evolve(G, R_before_k, count=N_k)
        fresh = next N_e seed_pool entries not previously evaluated
        batch = union_by_configured_identity(evolved, fresh)
    for idea in batch:
        trace = ACoder(G, idea)   # uses baseline context; always retain terminal evidence
        # subset Good alone is NOT a successful terminal trace
        history.append(trace)
        mark original seed identity evaluated when applicable
    if count_full_set_terminal_Good(history) >= S:
        break

successes = all full-set terminal-Good traces in history
if successes is empty:
    abort ENTIRE research run
else:
    return Selector(G, {(t.h, t.E, t.C) for t in successes})
```

**[INFERENCE]** This version checks \(S\) after complete rounds, matching the summed round formulation. Per-candidate early stopping, in-flight cancellation, concurrency, and duplicate-success counting require a separate documented policy. On the first round, use \(B_0\), not the full seed pool, in the cumulative count.

## 5. Configuration extraction and numerical consistency

**[PAPER]** A.2's relevant configuration paragraph states (p.30):

> “To evaluate novelty, ScientistTwo retrieves two reference papers via Google Search. We extract limitations for a maximum of 16 rounds. In each idea experimentation round, we evaluate two candidates: one selected from the seed ideas and the other an evolved idea. We run this experimentation loop for up to four rounds, terminating early once four successful ideas are obtained. If the Idea Critic Agent flags an idea for engineering refinement, we apply engineering techniques for at most two rounds.”

| Parameter | Symbol in paper | Value | Source (page) |
|---|---|---|---|
| Intended generic stage verdicts | `verdict` | 3: `accept`, `refine`, `reject` | Listing 1, p.5; literal `else` includes all non-accept/non-refine values |
| Generic critic-call budget | `max_rounds` | No universal numeric value | Listing 1, p.5 |
| Initial seed count before expansion | \(\mathcal H_0=\{h_0\}\) | 1 | §3.1, p.6 |
| Final seed-pool size | \(N_{\mathrm{seed}}\) | Not specified | §3.1, p.6; no value in A.2 |
| Limitation-extraction cap | No symbol given | Maximum 16 rounds | A.2, p.30 |
| Retrieved novelty references | No symbol given | 2 papers via Google Search | A.2, p.30 |
| Initial top-ranked seed batch size | \(N_0\) | Not specified explicitly | §§3.2–3.3, pp.6–7; initial-round exception unresolved in A.2 |
| Subset critic categories | \(d^h\) | 3: `Bad`, `Good`, `Engineer` | §3.2, p.7 |
| Terminal idea categories | \(d^h\) | 2: `Good`, `Bad` | §3.2/Figure 5 and §3.3, p.7 |
| Engineering cap | \(N_{\mathrm{eng}}\) | At most 2 engineering rounds, i.e. configured budget \(\le2\) | §3.2, p.7; A.2, p.30 |
| Candidates per experimentation round | \(\lvert\mathcal H_k\rvert\), not explicitly equated in A.2 | 2 = 1 seed + 1 evolved | A.2, p.30 |
| Fresh seeds per mixed refinement round | \(N_e\) | 1 under the A.2 configuration | §3.3, p.7; A.2, p.30 |
| Evolved candidates per mixed refinement round | \(N_k\), cardinality of \(\mathcal I_k\) | 1 under the A.2 configuration | §3.3, p.7; A.2, p.30 |
| Initial and refinement indices | \(k\) | Initial \(k=0\); refinement \(k\ge1\) | §3.3, p.7 |
| Experimentation limit | \(K\) in mathematical description | Up to 4 rounds in A.2; mapping to \(K\) unresolved | §3.3, p.7; A.2, p.30 |
| Successful-idea early-stop target | \(S\) | 4 | §3.3, p.7; A.2, p.30 |
| Whole-run abort threshold at limit | \(M_K\) (shorthand defined in this note) | 0 successes | §3.3, p.7 |
| Minimum successful candidates permitting selection | No separate symbol | At least 1 full-set validated idea | §3.3, p.8 |
| Number of specialized agents | \(N_a\) | Not numerically fixed in problem setup | Equation (1), p.6 |

**[PAPER]** Agent backends in A.2 are Gemini 3.6 Flash by default; “the Idea Experiment Coding Agent, the Ablation Study Agent, the Rebuttal Agent, and the Draft Enhancer” use Claude Code with Opus 4.8 (p.30). These are model/version names, not loop-count parameters. Exact backend allocation among baseline/subset/full-set/engineering subroles is not enumerated there. §4.2 says Claude Code is used “whenever coding capabilities are required” (p.15).

**[INFERENCE: conflicts requiring an explicit implementation decision]**

1. **Initial batch conflict:** §3.3 starts with seed-only round 0 and evolves only at \(k\ge1\); A.2 says every experimentation round contains one seed and one evolved idea. No initial evolved idea can use prior execution traces when none exist. Do not invent traces. A faithful configurable design can keep a seed-only bootstrap and mark A.2's initial-round scheduling unresolved.
2. **Four-round off-by-one:** Equations sum from \(0\) through \(K\), i.e. \(K+1\) evaluation batches, whereas A.2 says “up to four rounds.” If four includes round 0, the maximum index is 3; if four counts only refinement rounds, there are five batches including bootstrap. The paper does not reconcile these interpretations.
3. **Conditional experiment count:** Two candidates times four total rounds implies at most eight candidate evaluations **only if** the initial round also follows A.2 and no candidates are dropped/deduplicated before execution. Eight is a derived upper bound, not a separately published parameter and not a resolution of the initial-round conflict.

## 6. Figures 3–6: architectural constraints from captions

**[PAPER]** Captions, quoted to preserve the stated scope:

- **Figure 3, p.4:** “ScientistTwo leverages previous experiments, ablation studies, and reviewer to generate and validate novel ideas that advance human state-of-the-art baselines, verifying each idea across multiple datasets and evaluation metrics. Additionally, it simulates the peer-review process to iteratively refine drafts into publication-ready papers.” The diagram groups agents into idea generation, evaluation, analysis, and output roles; later feedback is part of the broader closed loop.
- **Figure 4, p.6:** “ScientistTwo begins its research by generating novel ideas that can address the limitations of the human state-of-the-art (see § 3.1).” The depicted chain is Scientific Problem → Limitation Extractor → Limitation Verifier → Initial Idea Generator → Novelty Checker → Idea Generator → Seed Ideas.
- **Figure 5, p.7:** “ScientistTwo utilizes ACoder to implement the generated idea through subset testing, critic evaluation, engineering refinement loops, and full-set scaling (see § 3.2).” The two engineering roles feed their respective subset/full-set phases.
- **Figure 6, p.8:** “ScientistTwo improves ideas based on prior experimental results, ultimately selecting the best hypothesis for ablation studies and paper drafting (see § 3.3).” The diagram includes unevaluated seed ideas, the Evolver, Implementer, Selector, and execution-trace updates.

**[INFERENCE]** These diagrams reinforce dataflow and feedback, but do not specify scheduling, RPC signatures, persistence formats, or numerical decision criteria beyond the prose.

## 7. Implementation warnings and required decisions

All items below are **[INFERENCE / unresolved contract details]**, not additional rules claimed to be in the paper.

1. **Stage exhaustion versus domain exhaustion:** Listing 1 returns `None`; ACoder must retain a terminal failure trace. Limitation and seed-generation descriptions do not define fallback artifacts at budget exhaustion. Use domain-specific adapters, not unqualified reuse of `stage`.
2. **Novelty ties:** Descending order allows equality. Choose a deterministic tie-break, such as stable generation index then idea ID; persist the scores and rank. The paper chooses neither.
3. **Unscorable novelty and retrieval failure:** Decide whether to retry, reject, defer, or use an explicitly flagged score. Do not turn missing literature evidence into high novelty. Define retrieval scope and keep the two-paper provenance.
4. **Unbounded seed expansion:** \(N_{\mathrm{seed}}\), generation budget, duplicate handling, score thresholds, and stagnation policy are absent. Rejecting all low-novelty proposals could otherwise loop forever. Decide whether and how limitations may be revisited.
5. **Insufficient limitations at 16:** Decide whether to abort or continue with an explicitly unverified partial collection. Preserve the verifier's final response, not just the set.
6. **All top-\(N_0\) seeds are `Bad`:** This is not the paper's whole-run abort condition. The Evolver explicitly uses `Bad` traces and later rounds introduce unused seeds. Continue while allowed; abort at the limit only if total terminal successes remain zero. Handle the separate case of no usable traces due to infrastructure failures.
7. **Seed exhaustion and identity:** Decide how to fill a round with fewer than \(N_e\) remaining seeds, prevent reevaluation, detect semantically identical evolved ideas, and count related versions as successes. A union is not a deduplication algorithm.
8. **Initial-round and round-count contradictions:** Resolve the issues in §5 through explicit configuration/compatibility modes, not accidental off-by-one behavior. Do not hardcode `N_0=2` or `K=4` as unambiguous paper values.
9. **Subset/full-set metric identity:** The paper does not assert identical metric sets or identical sampling between phases. Prefer the same metric definitions with a declared subset of cases; if they differ, record the mapping and never equate unmatched scores.
10. **Baseline identity and failed reproduction:** No tolerance is given for matching the published baseline, and no policy covers reproduction failure. Separate original reported results from reproduced results, require comparable protocols, and define hardware-sensitive comparisons.
11. **Noisy and incomplete runs:** Define repeated-run policies, confidence/variance criteria, treatment of timeouts/OOM/nonfinite values, checkpoint resumption, and whether engineering can use the same evaluation cases without overfitting. Infrastructure failure is not automatically scientific evidence that a hypothesis is bad.
12. **Engineering budgets:** Resolve per-phase versus shared \(N_{\mathrm{eng}}\), initial critic counting, final recheck, engineer failures, and whether changing the hypothesis substantially requires new subset validation. A full-set engineer changing the method may invalidate subset evidence.
13. **Output version consistency:** Returned \(h\), \(E\), and \(C\) must describe the same evaluated revision. Preserve both input and final idea identities; an engineer may change the method, not just code.
14. **Trace richness:** The minimum paper tuple alone can hide why a run failed. Store round, phase, parent IDs, hypothesis revision, baseline/protocol IDs, code snapshot, environment, commands, seeds, timing/resources, raw stdout/stderr, structured metrics, exceptions, critic verdict/rationale, requested engineering strategy, attempted changes, and budget counters. This makes both success and failure actionable to evolution.
15. **Successful-idea counting:** Count terminal full-set successes, not subset passes or repeated successful engineering attempts. Decide uniqueness and when to check \(S\), especially with parallel batches and in-flight work.
16. **Selector determinism:** No weighting, dominance, statistical ranking, or tie-break rule is given. Restrict selection to terminal full-set `Good` candidates, retain its rationale, and do not synthesize an unevaluated hybrid as the selected artifact.
17. **Protocol integrity:** Prevent modifying evaluator code/metric parameters or gaining by undisclosed compute increases. Keep code changes and protocol changes separately auditable. Later attribution/ablation may still reject a numerically successful method.
18. **Evolution context limits:** “All historic execution traces” is the semantic input. If full logs exceed context limits, preserve the complete store and document retrieval/summarization; silently passing only recent winners violates the stated information scope.
19. **Selection timing and partial success:** Make final selection after configured search termination, with a documented policy for \(0<M<S\) at the cap. Keep final research acceptance separate from idea-experiment `Good`.
20. **Broader recursive improvement:** §4.3 feeds a newly discovered method into a later discovery cycle (p.16). Do not confuse this outer reuse of an improved baseline with the inner \(k\)-indexed evolution loop or assume this note specifies an outer-loop stopping budget.

## 8. Minimal Pydantic-style state models

**[INFERENCE]** The following is a proposed typed persistence/interface schema, **not code and not a schema supplied by the paper**. `list[...]`, `dict[...]`, `Literal[...]`, `Optional[T]`, and generic `StageState[T]` use Pydantic/Python-style type notation. `ArtifactRef` references immutable stored content; it does not require a particular storage backend. Use tagged validation to enforce the invariants below.

### 8.1 Shared evidence and benchmark models

| Model | Field name: type | Purpose |
|---|---|---|
| `ArtifactRef` | `uri: str`; `sha256: str`; `kind: str` | Locate and content-identify papers, code snapshots, logs, scripts, environments, and reports |
| `ReferencePaper` | `id: str`; `title: str`; `url: str`; `content: Optional[ArtifactRef]`; `retrieval_query: str`; `retrieved_at: datetime` | Ground limitation/novelty evidence and audit Google Search retrieval |
| `MetricSpec` | `id: str`; `definition: str`; `direction: Literal['maximize','minimize']`; `unit: Optional[str]`; `role: Literal['primary','secondary','constraint']` | Define what better means without assuming all scores increase |
| `BenchmarkCase` | `id: str`; `dataset_id: str`; `dataset_version: str`; `split: str`; `configuration: dict[str, JsonValue]`; `metric_ids: list[str]` | Identify every dataset/model/task/configuration cell; configuration includes sampling details where relevant |
| `BenchmarkProtocol` | `id: str`; `full_cases: list[BenchmarkCase]`; `subset_case_ids: list[str]`; `metrics: list[MetricSpec]`; `evaluation_artifacts: list[ArtifactRef]`; `comparison_policy: ArtifactRef`; `constraints: list[str]` | Freeze evaluation grid, subset, metric definitions, validity constraints, and a versioned multi-metric/noise policy |
| `Problem` | `id: str`; `description: str`; `source_papers: list[ReferencePaper]`; `baseline_code: Optional[ArtifactRef]`; `protocol: BenchmarkProtocol`; `original_sota_results: Optional[ExperimentResults]` | Represent \(G\); distinguish published full-set results from reproduced baseline |
| `MetricObservation` | `case_id: str`; `metric_id: str`; `value: float`; `seed: Optional[int]`; `replicate: Optional[int]` | Preserve raw repeated measurements; failed/nonfinite results are represented by execution status, not fabricated finite scores |
| `ExperimentResults` | `id: str`; `protocol_id: str`; `phase: Literal['baseline_subset','subset','full']`; `observations: list[MetricObservation]`; `covered_case_ids: list[str]`; `raw_artifacts: list[ArtifactRef]`; `status: Literal['complete','partial','failed']` | Represent \(E_{\mathrm{base}},E_{\mathrm{sub}},E_{\mathrm{full}}\), coverage, and diagnostic outputs |
| `Codebase` | `snapshot: ArtifactRef`; `environment: ArtifactRef`; `reproduce_instructions: ArtifactRef`; `parent_snapshot: Optional[ArtifactRef]` | Represent reproducible \(C\) and immutable modification ancestry |

### 8.2 Limitations, ideas, and generic stage state

| Model | Field name: type | Purpose |
|---|---|---|
| `Critique` | `verdict: Literal['accept','refine','reject']`; `feedback: str`; `evidence: list[ArtifactRef]` | Generic critic output; domain adapters handle their own verdict types |
| `StageEvent[T]` | `round_index: int`; `candidate: T`; `critique: Critique`; `refined_candidate: Optional[T]` | Preserve each critic call and any replacement candidate, including the untested last refinement |
| `StageState[T]` | `candidate: T`; `max_rounds: int`; `events: list[StageEvent[T]]`; `status: Literal['pending','running','accepted','rejected','exhausted','error']`; `result: Optional[T]` | Represent exact Listing 1 state plus explicit persisted outcome metadata |
| `Limitation` | `id: str`; `description: str`; `evidence: list[ArtifactRef]` | Stable actionable limitation and supporting source context |
| `LimitationVerification` | `sufficient: bool`; `rationale: str`; `missing_areas: list[str]` | Proposed structured verifier response; `missing_areas` is not a mandated paper output |
| `LimitationRound` | `index: int`; `limitations: list[Limitation]`; `verification: LimitationVerification` | Retain each expanded collection and its sufficiency judgment |
| `LimitationState` | `rounds: list[LimitationRound]`; `max_rounds: int`; `status: Literal['pending','sufficient','exhausted','error']`; `final_limitations: list[Limitation]` | Model the 16-round limitation loop without conflating exhausted and verified |
| `NoveltyAssessment` | `score: float`; `rationale: str`; `references: list[ReferencePaper]`; `scoring_policy_id: str` | Store \(s_i\), literature evidence, and an implementation-defined scoring rubric |
| `Idea` | `id: str`; `revision: int`; `hypothesis: str`; `mechanism: str`; `implementation_plan: str`; `limitation_ids: list[str]`; `origin: Literal['seed','evolved']`; `parent_idea_ids: list[str]`; `source_trace_ids: list[str]`; `generation_index: int`; `novelty: Optional[NoveltyAssessment]` | Represent \(h\), seed identity, engineering revisions, and evolution lineage; novelty need not be rescored for evolved ideas under the paper's contract |
| `SeedPoolState` | `ideas: list[Idea]`; `target_size: int`; `ordered_seed_ids: list[str]`; `evaluated_seed_ids: set[str]`; `tie_break_policy: str`; `status: Literal['building','ready','failed']` | Represent expanded/ranked \(\mathcal H_0\) and the unused exploration queue |

### 8.3 Coding, traces, rounds, and final selection

| Model | Field name: type | Purpose |
|---|---|---|
| `IdeaCritique` | `verdict: Literal['Good','Bad','Engineer']`; `feedback: str`; `comparison_target_id: str`; `comparison_report: Optional[ArtifactRef]` | Represent intermediate \((d^h,r^h)\) and identify which baseline/result was compared |
| `CodingAttempt` | `phase: Literal['subset','full']`; `engineering_index: int`; `idea: Idea`; `code: Optional[Codebase]`; `results: Optional[ExperimentResults]`; `commands: list[str]`; `execution_evidence: list[ArtifactRef]`; `error: Optional[str]`; `critique: Optional[IdeaCritique]` | Preserve initial implementation (`engineering_index=0`) and each engineer–execute–critic step, including failed executions; execution evidence holds logs, seeds, timing, and resource manifests |
| `BaselineState` | `results: Optional[ExperimentResults]`; `code: Optional[Codebase]`; `status: Literal['pending','ready','failed']`; `diagnostics: list[ArtifactRef]` | Pair \((E_{\mathrm{base}},C_{\mathrm{base}})\) and retain reproduction failure evidence |
| `ExecutionTrace` | `id: str`; `round_index: int`; `input_idea_id: str`; `input_idea_revision: int`; `h: Idea`; `E: Optional[ExperimentResults]`; `C: Optional[Codebase]`; `d: Literal['Good','Bad']`; `r: str`; `phase_reached: Literal['subset','full']`; `termination_reason: Literal['accepted','critic_rejected','engineering_exhausted','execution_failed','invalid_protocol']`; `attempts: list[CodingAttempt]` | The ACoder tuple plus the minimum provenance needed to evolve from successes and failures; nullable artifacts are an explicit error-path extension |
| `SearchRound` | `index: int`; `historical_trace_ids: list[str]`; `evolved_idea_ids: list[str]`; `fresh_seed_ids: list[str]`; `candidate_idea_ids: list[str]`; `trace_ids: list[str]`; `status: Literal['pending','running','complete','failed']` | Represent \(\mathcal I_k,\mathcal H_0^{(k)},\mathcal H_k,\mathcal R_k\) and the evolver's historical input boundary |
| `SearchConfig` | `N_seed: int`; `N_0: int`; `N_e: int`; `N_k_by_round: dict[int,int]`; `S: int`; `max_total_rounds: int`; `max_refinement_index: int`; `limitation_cap: int`; `novelty_reference_count: int`; `subset_engineering_cap: int`; `full_engineering_cap: int`; `engineering_budget_scope: Literal['per_phase','per_idea']`; `bootstrap_policy: str`; `seed_exhaustion_policy: str`; `insufficient_limitations_policy: str`; `stop_check_policy: Literal['per_candidate','per_round']`; `agent_backends: dict[str,str]` | Make all symbolic/count parameters and unresolved scheduling policies explicit; validate consistency rather than infer \(K\) from four rounds |
| `Selection` | `h: Idea`; `E: ExperimentResults`; `C: Codebase`; `source_trace_id: str`; `considered_trace_ids: list[str]`; `rationale: str` | Represent Equation (4) and preserve evidence that selection considered the eligible successful set |
| `ResearchState` | `problem: Problem`; `config: SearchConfig`; `limitations: LimitationState`; `seeds: SeedPoolState`; `baseline: BaselineState`; `ideas_by_id: dict[str,Idea]`; `rounds: list[SearchRound]`; `traces: list[ExecutionTrace]`; `successful_trace_ids: list[str]`; `selection: Optional[Selection]`; `status: Literal['initializing','searching','selected','aborted','error']`; `stop_reason: Optional[str]` | Entire persisted state for §§3.1–3.3; round/history membership is authoritative, not reconstructed from selected winners |

**[INFERENCE: validation invariants]**

- A terminal `Good` trace has full-set coverage, non-null results/code, a corresponding full-set `Good` critique, and no protocol-invalidating condition; never classify a subset-only pass as global success.
- \(h,E,C\) point to the same evaluated revision and protocol; compare only compatible cases/metrics under the frozen policy.
- `Engineer` cannot escape ACoder as a terminal verdict. An exhausted engineering loop records the final raw `Engineer` critique but terminal `Bad`.
- Seed rank follows non-increasing novelty, with a separate deterministic tie policy. Evaluated seed IDs are not reintroduced as fresh seeds.
- The evolver's historical IDs include both `Good` and `Bad` traces from earlier rounds; no current/future results leak into \(\mathcal R_{<k}\).
- The Selector considers all eligible terminal successes and returns one existing evaluated triple. No eligible success at the final budget means `aborted`, not a fabricated best idea.
- Store configured policies and counters explicitly so a run can be audited against either the mathematical indexing or a documented four-total-round interpretation.
