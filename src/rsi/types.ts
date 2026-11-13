/**
 * Frozen domain models for the ScientistTwo / RSI loop.
 *
 * Value names come from the original Python implementation; they are part of
 * the artifact contract: state.json, final.json and traces.jsonl from earlier
 * runs stay readable.
 */

export type Decision = "good" | "bad" | "engineer" | "refine" | "accept";
export type Scope = "subset" | "full" | "ablation" | "rebuttal";
export type MetricDirection = "max" | "min";
export type IdeaOrigin = "seed" | "evolved" | "meta";

export interface MetricSpec {
  name: string;
  /** Dataset this metric belongs to; null for a dataset-agnostic metric. */
  dataset?: string | null;
  direction: MetricDirection;
  /** Relative noise band: smaller differences are not evidence. */
  tolerance: number;
  weight: number;
  /** Physical range, e.g. [0, 1] for AUROC. Runners clamp into it. */
  bounds: [number, number] | null;
}

/** A human-provided steer for exploration; a soft weight unless must_include. */
export interface ResearchDirection {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  weight: number;
  must_include: boolean;
}

export interface RemoteConfig {
  /** SSH target, e.g. "user@gpu-node" or a ~/.ssh/config alias. */
  host: string;
  /** Base directory on the GPU server (must exist or be creatable). */
  dir: string;
  /** Optional remote project path template; supports {run_id}. Default: <dir>/rsi/<run_id>/worktree. */
  worktree: string;
  /** Optional remote output directory template; supports {run_id}. Default: <worktree>/../out. */
  out: string;
  /** Remote python executable (default python3). */
  python: string;
  /** Optional shell setup before the command, e.g. conda activate / module load. */
  setup: string;
  ssh_args: string[];
  rsync_args: string[];
  /** Value for CUDA_VISIBLE_DEVICES, e.g. "0" or "0,1". */
  gpu_ids: string;
  env: Record<string, string>;
  timeout_s: number;
  /** Extra rsync excludes (on top of .git/runs/caches). */
  excludes: string[];
}

/** Target-declared screening budget. The target adapter reads `steps_env`. */
export interface BudgetPolicy {
  /** Full-protocol training steps, e.g. 954. */
  full_steps: number | null;
  /** Fraction of full_steps for the subset screen; default 0.1. */
  subset_fraction: number | null;
  /** Hard cap on subset steps; default 200. */
  subset_max_steps: number | null;
  /** Env key the target reads for training steps (e.g. RSI_CORAL_TRAIN_STEPS). */
  steps_env: string | null;
  /** Env key the target reads for the training seed (e.g. RSI_CORAL_SEED). */
  seed_env: string | null;
}

export interface Problem {
  id: string;
  statement: string;
  domain: string;
  subfield: string;
  source_paper: string;
  /** External git repository to optimize (absolute or relative to cwd). */
  repo: string | null;
  /** Git ref used as the baseline (branch/tag/SHA; default HEAD). */
  repo_ref: string | null;
  /** Target-declared full/subset budget; the subset command gets a real screen. */
  budget: BudgetPolicy | null;
  /**
   * Command template executed in the candidate worktree. Placeholders:
   * {scope}, {out}, {repo}, {commit}. Default: python3 run_experiment.py ...
   */
  experiment_command: string[] | null;
  /** Read-only measured analysis of the baseline; same execution surface as experiments. */
  diagnose_command: string[] | null;
  /** Target-owned detached executor, relative to the repo (default bench/rsi_job_worker.py). */
  job_worker: string | null;
  /** Optional GPU-server execution: rsync the candidate worktree, then run over SSH. */
  remote: RemoteConfig | null;
  datasets: string[];
  subset_datasets: string[];
  metrics: MetricSpec[];
  reported_metrics: Record<string, number>;
  constraints: string[];
  directions: ResearchDirection[];
  forbidden: string[];
  venue: string;
  audience_note: string;
  /** Bounded retries per loop: an exhausted idea pool or paper loop re-runs. */
  max_retry: { idea: number; paper: number } | null;
}

export interface DiagnosisFinding {
  id: string;
  title: string;
  axis: string;
  /** Human-readable measured evidence; mandatory even for a labelled hypothesis. */
  evidence: string;
  severity: number;
  actionable: boolean;
  /** True only when the target command measured this defect. */
  measured: boolean;
  metric?: string;
  value?: number;
  artifact?: string;
}

/** One read-only diagnosis of the reproduced baseline. */
export interface Diagnosis {
  findings: DiagnosisFinding[];
  log_path: string;
  stdout: string;
  stderr: string;
  wall_time_s: number;
}

export interface Limitation {
  id: string;
  text: string;
  axis: string;
  evidence: string;
  severity: number;
  actionable: boolean;
}

export interface Idea {
  id: string;
  hypothesis: string;
  mechanism: string;
  target_limitations: string[];
  novelty_score: number;
  novelty_refs: string[];
  parent_ids: string[];
  round: number;
  origin: IdeaOrigin;
  expected_gain: number;
  direction_ids: string[];
  domain_fit: number;
  notes: string;
}

export interface RepoRef {
  /** Per-run git worktree path (one checkout, reused; no per-candidate copies). */
  path: string;
  label: string;
  /** Parent commit SHA (null for the reproduced baseline). */
  parent: string | null;
  patch: string;
  /** Canonical target repository (external to RSI). */
  repo?: string;
  /** Candidate commit SHA. */
  commit?: string;
  /** Candidate branch name. */
  branch?: string;
}

export interface ExperimentResult {
  metrics: Record<string, number>;
  status: "ok" | "failed" | "timeout";
  log_path: string;
  stdout: string;
  stderr: string;
  wall_time_s: number;
  /** True when the result came from the measurement cache, not a new run. */
  cached?: boolean;
}

export interface SeedSample {
  seed: number;
  metrics: Record<string, number>;
  result?: ExperimentResult | null;
}

export interface Evidence {
  idea_id: string;
  scope: Scope;
  /** Aggregate metrics across `samples` (mean when multi-seed). */
  metrics: Record<string, number>;
  baseline_metrics: Record<string, number>;
  code: RepoRef | null;
  result: ExperimentResult | null;
  label: string;
  /** Per-seed subset measurements; empty/one for full and single-seed scopes. */
  samples?: SeedSample[];
}

export interface Verdict {
  decision: Decision;
  feedback: string;
  metrics: Record<string, number>;
  notes: string;
  /** Deterministic flag: the run failed validation; repair code, don't prune. */
  invalid?: boolean;
}

export interface Trace {
  idea: Idea;
  evidence: Evidence[];
  decision: Decision;
  feedback: string;
  round: number;
  lessons: string[];
}

/**
 * Mid-idea progress, persisted after every measurement so a host restart does
 * not discard experiments that were already paid for (§3.2 resumability).
 */
export interface TraceCheckpoint {
  idea_id: string;
  round: number;
  trace: Trace;
  stage: "subset" | "full" | "done";
  verdict: Verdict | null;
  subset_rounds: number;
  subset_repairs: number;
  full_rounds: number;
  full_repairs: number;
}

export interface AblationPlan {
  id: string;
  component: string;
  description: string;
  expects: string;
  variant_of: string;
}

export interface AblationResult {
  plan_id: string;
  component: string;
  metrics: Record<string, number>;
  evidence: Evidence | null;
  ok: boolean;
}

export interface Claim {
  text: string;
  metric: string;
  value: number | null;
  evidence_ref: string;
}

export interface Manuscript {
  id: string;
  title: string;
  abstract: string;
  sections: Record<string, string>;
  claims: Claim[];
  evidence_ledger: Record<string, number>;
  latex_path: string;
  format: string;
  round: number;
}

export interface Review {
  manuscript_id: string;
  strengths: string[];
  weaknesses: string[];
  questions: string[];
  score: number;
  scale_max: number;
  summary: string;
  round: number;
}

export interface RebuttalTask {
  id: string;
  question: string;
  plan: string;
  experiment: string;
}

export interface MetaReview {
  decision: "accept" | "refine";
  critique: string;
  score: number;
  round: number;
}

export interface IntegrityReport {
  score_verified: boolean;
  spec_violations: string[];
  ref_violations: string[];
  method_code_alignment: number;
  checked_claims: number;
  notes: string[];
}

export interface FinalArtifacts {
  paper: Manuscript;
  code: RepoRef | null;
  review: Review | null;
  meta_review: MetaReview | null;
  integrity: IntegrityReport | null;
  metrics: Record<string, number>;
  decision_path: string[];
  aborted: boolean;
  abort_reason: string;
  extra: Record<string, unknown>;
}

// --------------------------------------------------------------------------- //
// constructors with the Python defaults
// --------------------------------------------------------------------------- //

export function metricSpec(over: Partial<MetricSpec> = {}): MetricSpec {
  return {
    name: "score",
    dataset: null,
    direction: "max",
    tolerance: 1e-3,
    weight: 1,
    bounds: null,
    ...over,
  };
}

export function makeProblem(over: Partial<Problem> = {}): Problem {
  return {
    id: "problem",
    statement: "",
    domain: "",
    subfield: "",
    source_paper: "",
    repo: null,
    repo_ref: null,
    experiment_command: null,
    diagnose_command: null,
    job_worker: null,
    remote: null,
    datasets: [],
    subset_datasets: [],
    metrics: [],
    reported_metrics: {},
    budget: null,
    constraints: [],
    directions: [],
    forbidden: [],
    venue: "ICLR",
    audience_note: "",
    max_retry: null,
    ...over,
  };
}

export function makeIdea(over: Partial<Idea> = {}): Idea {
  return {
    id: "h0",
    hypothesis: "",
    mechanism: "",
    target_limitations: [],
    novelty_score: 0,
    novelty_refs: [],
    parent_ids: [],
    round: 0,
    origin: "seed",
    expected_gain: 0,
    direction_ids: [],
    domain_fit: 0,
    notes: "",
    ...over,
  };
}

export function makeLimitation(over: Partial<Limitation> = {}): Limitation {
  return {
    id: "L1",
    text: "",
    axis: "method",
    evidence: "",
    severity: 0.5,
    actionable: true,
    ...over,
  };
}

export function makeEvidence(over: Partial<Evidence> = {}): Evidence {
  return {
    idea_id: "baseline",
    scope: "subset",
    metrics: {},
    baseline_metrics: {},
    code: null,
    result: null,
    label: "",
    samples: [],
    ...over,
  };
}

export function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return { decision: "bad", feedback: "", metrics: {}, notes: "", ...over };
}

export function makeCheckpoint(over: Partial<TraceCheckpoint> = {}): TraceCheckpoint {
  return {
    idea_id: "",
    round: 0,
    trace: makeTrace(),
    stage: "subset",
    verdict: null,
    subset_rounds: 0,
    subset_repairs: 0,
    full_rounds: 0,
    full_repairs: 0,
    ...over,
  };
}

export function makeTrace(over: Partial<Trace> = {}): Trace {
  return {
    idea: makeIdea(),
    evidence: [],
    decision: "bad",
    feedback: "",
    round: 0,
    lessons: [],
    ...over,
  };
}

export function makeManuscript(over: Partial<Manuscript> = {}): Manuscript {
  return {
    id: "paper",
    title: "",
    abstract: "",
    sections: {},
    claims: [],
    evidence_ledger: {},
    latex_path: "",
    format: "iclr2025",
    round: 0,
    ...over,
  };
}

export function makeReview(over: Partial<Review> = {}): Review {
  return {
    manuscript_id: "",
    strengths: [],
    weaknesses: [],
    questions: [],
    score: 1,
    scale_max: 10,
    summary: "",
    round: 0,
    ...over,
  };
}

export function makeIntegrity(over: Partial<IntegrityReport> = {}): IntegrityReport {
  return {
    score_verified: false,
    spec_violations: [],
    ref_violations: [],
    method_code_alignment: 0,
    checked_claims: 0,
    notes: [],
    ...over,
  };
}

export function makeFinal(over: Partial<FinalArtifacts> = {}): FinalArtifacts {
  return {
    paper: makeManuscript(),
    code: null,
    review: null,
    meta_review: null,
    integrity: null,
    metrics: {},
    decision_path: [],
    aborted: false,
    abort_reason: "",
    extra: {},
    ...over,
  };
}

// --------------------------------------------------------------------------- //
// problem helpers
// --------------------------------------------------------------------------- //

export function problemMetric(problem: Problem, name: string): MetricSpec | undefined {
  return problem.metrics.find((m) => m.name === name);
}

export function hardDirections(problem: Problem): ResearchDirection[] {
  return problem.directions.filter((d) => d.must_include && d.weight > 0);
}

/** Guidance block injected into generative prompts only. */
export function directionText(problem: Problem): string {
  if (!problem.domain && !problem.directions.length) return "";
  const lines: string[] = [];
  if (problem.domain) {
    lines.push(`Domain: ${problem.domain}` + (problem.subfield ? ` / ${problem.subfield}` : ""));
  }
  if (problem.directions.length) {
    lines.push("Reference research directions (stay inside them unless evidence demands otherwise):");
    for (const d of problem.directions) {
      const tag = d.must_include ? " [REQUIRED]" : "";
      const kw = d.keywords.length ? ` (keywords: ${d.keywords.join(", ")})` : "";
      lines.push(`- ${d.id}. ${d.title}${tag}${kw}: ${d.description}`);
    }
  }
  if (problem.forbidden.length) lines.push(`Out of scope: ${problem.forbidden.join("; ")}`);
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// improvement semantics: the single definition of invariant I2
// --------------------------------------------------------------------------- //

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Signed relative improvement (+ = better) per metric. */
export function metricDeltas(
  next: Record<string, number>,
  base: Record<string, number>,
  metrics: MetricSpec[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of metrics) {
    if (!(spec.name in next) || !(spec.name in base)) continue;
    const b = base[spec.name];
    const n = next[spec.name];
    if (!finite(b) || !finite(n)) continue;
    const denom = Math.abs(b) > 1e-12 ? Math.abs(b) : 1;
    const raw = (n - b) / denom;
    out[spec.name] = spec.direction === "max" ? raw : -raw;
  }
  return out;
}

/**
 * "E_new strictly outperforms E_best": no metric regresses beyond tolerance and
 * at least one improves beyond tolerance. require_all=false checks the primary
 * metric only (subset screening).
 */
export function isStrictlyBetter(
  next: Record<string, number>,
  base: Record<string, number>,
  metrics: MetricSpec[],
  opts: { requireAll?: boolean } = {},
): boolean {
  const requireAll = opts.requireAll ?? true;
  let specs = metrics.slice();
  if (!specs.length) return false;
  if (!requireAll) specs = specs.slice(0, 1);
  const deltas = metricDeltas(next, base, specs);
  if (!Object.keys(deltas).length) return false;
  let improved = false;
  for (const spec of specs) {
    if (!(spec.name in deltas)) continue;
    const d = deltas[spec.name];
    if (d < -spec.tolerance) return false;
    if (d > spec.tolerance) improved = true;
  }
  return improved;
}

// --------------------------------------------------------------------------- //
// convenience predicates
// --------------------------------------------------------------------------- //

export function resultOk(result: ExperimentResult | null | undefined): boolean {
  return !result || result.status === "ok";
}

export function evidenceOk(evidence: Evidence | null | undefined): boolean {
  if (!evidence) return false;
  return evidence.result === null || resultOk(evidence.result);
}

export function verdictAccepted(verdict: Verdict): boolean {
  return verdict.decision === "good" || verdict.decision === "accept";
}

export function traceSucceeded(trace: Trace): boolean {
  return trace.decision === "good";
}

export function finalEvidence(trace: Trace): Evidence | null {
  return trace.evidence.length ? trace.evidence[trace.evidence.length - 1] : null;
}

export function reviewPasses(review: Review, threshold: number): boolean {
  return review.score >= threshold;
}

export function integrityClean(report: IntegrityReport): boolean {
  return (
    report.score_verified &&
    report.spec_violations.length === 0 &&
    report.ref_violations.length === 0
  );
}

export function clampMetric(value: number, spec: MetricSpec | undefined): number {
  if (!spec?.bounds) return value;
  const [low, high] = spec.bounds;
  const margin = 1e-6 * Math.max(1, Math.abs(high - low));
  return Math.min(Math.max(value, low + margin), high - margin);
}
