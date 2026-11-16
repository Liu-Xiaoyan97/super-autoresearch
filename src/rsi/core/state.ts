/** Mutable research state: the single source of truth for one run (I8). */

import type { Config } from "../config.ts";
import path from "node:path";
import { asArray, asRecord, canonical } from "../json.ts";
import { evidenceProvenanceError, evidenceSucceeded } from "../types.ts";
import type {
  AblationPlan,
  AblationResult,
  Diagnosis,
  Evidence,
  Idea,
  IntegrityReport,
  Limitation,
  Manuscript,
  MetaReview,
  Problem,
  RepoRef,
  Review,
  Trace,
  TraceCheckpoint,
  Verdict,
} from "../types.ts";
import { rankKey } from "../agents/ideas.ts";

function protocol(problem: Record<string, unknown>, config: Record<string, unknown>): string {
  const fields = ["id", "repo", "datasets", "subset_datasets", "metrics", "constraints", "forbidden", "experiment_command", "budget",
    "remote", "diagnose_command", "job_worker"];
  const settings = ["runner", "seed", "subsetFraction", "subsetMaxSteps", "subsetSeeds", "subsetMargin"];
  return JSON.stringify(canonical({
    problem: Object.fromEntries(fields.map((key) => [key, problem[key]])),
    config: Object.fromEntries(settings.map((key) => [key, config[key]])),
  }));
}

export class ResearchState {
  readonly problem: Problem;
  readonly config: Config;

  /** Measured baseline diagnosis; null until the diagnose stage succeeds. */
  diagnosis: Diagnosis | null = null;

  limitations: Limitation[] = [];
  seeds: Idea[] = [];

  baseline: Evidence | null = null;
  /** Immutable source reference for specification and manuscript audits. */
  auditBaseline: RepoRef | null = null;
  specReports: Record<string, { commit: string; report: IntegrityReport }> = {};
  /** Full-set baseline, persisted so a resumed run does not rerun it. */
  baselineFull: Evidence | null = null;
  /** Where the active baseline came from; recorded so a resume never re-runs a reused one. */
  baselineSource: "reproduced" | "incumbent" | "manual" | "promoted" | "mixed" = "reproduced";
  baselinePath = "";
  environmentFingerprint = "";
  traces: Trace[] = [];
  /** Mid-idea progress by idea id; survives a restart so measured seeds are not re-run. */
  checkpoints: Record<string, TraceCheckpoint> = {};
  /** True once the search loop reached its end, so a resume does not restart §3.2. */
  searchDone = false;
  /** Completed idea-exhaustion retries; persisted so a resume continues the count. */
  ideaRetries = 0;
  /** Completed paper-loop retries (re-draft + re-review after a non-accept). */
  paperRetries = 0;
  round = 0;
  evaluatedIds = new Set<string>();

  /** Candidate pool as it grows; a restart continues scoring instead of redoing it. */
  ideaPool: Idea[] = [];

  bestIdea: Idea | null = null;
  bestEvidence: Evidence | null = null;
  /** Subset evidence for the incumbent; component ablations compare against it. */
  bestSubset: Evidence | null = null;
  bestCode: RepoRef | null = null;

  ablations: AblationResult[] = [];
  ablationPlans: AblationPlan[] = [];
  ablationRound = 0;
  ablationCommit = "";
  /** Last attribution verdict; the data gate requires acceptance. */
  ablationVerdict: Verdict | null = null;

  manuscript: Manuscript | null = null;
  manuscriptCommit = "";
  review: Review | null = null;
  /** Independent reviews of the current manuscript; every score gates acceptance. */
  reviews: Review[] = [];
  metaReview: MetaReview | null = null;
  peerRound = 0;
  reviewRefinements = 0;
  metaRound = 0;
  rebuttals: Evidence[] = [];

  decisionPath: string[] = [];
  aborted = false;
  abortReason = "";
  exportReason = "";

  constructor(problem: Problem, config: Config) {
    this.problem = problem;
    this.config = config;
  }

  /** Restore the mutable state fields from a previous run's state.json. */
  static fromDict(problem: Problem, config: Config, raw: unknown): ResearchState {
    const item = asRecord(raw) ?? {};
    const version = Number(item.state_version ?? 1);
    if (!Number.isInteger(version) || version < 1 || version > 2) throw new Error("unsupported research state version");
    const previousProblem = asRecord(item.problem);
    const previousConfig = asRecord(item.config);
    if (config.runner !== "simulated" && (!previousProblem || !previousConfig) &&
      (item.best_evidence || asArray(item.traces).length)) throw new Error("resume candidate evidence lacks a recorded problem or configuration");
    if (previousProblem && previousConfig && protocol(previousProblem, previousConfig) !==
      protocol(problem as unknown as Record<string, unknown>, config as unknown as Record<string, unknown>)) {
      throw new Error("resume protocol differs from recorded datasets, metrics, constraints, command, budget or seeds");
    }
    const state = new ResearchState(problem, config);
    state.diagnosis = (item.diagnosis ?? null) as Diagnosis | null;
    state.limitations = asArray(item.limitations) as Limitation[];
    state.seeds = asArray(item.seeds) as Idea[];
    state.baseline = (item.baseline ?? null) as Evidence | null;
    state.baselineFull = (item.baseline_full ?? null) as Evidence | null;
    state.baselineSource = item.baseline_source === "incumbent" || item.baseline_source === "manual" || item.baseline_source === "promoted" || item.baseline_source === "mixed"
      ? item.baseline_source
      : "reproduced";
    state.baselinePath = String(item.baseline_path ?? "");
    state.environmentFingerprint = String(item.environment_fingerprint ?? "");
    state.traces = asArray(item.traces) as Trace[];
    const initialCode = state.traces.flatMap((trace) => trace.evidence)
      .find((evidence) => evidence.scope === "subset" && evidence.code?.parent)?.code;
    state.auditBaseline = (item.audit_baseline ?? null) as RepoRef | null;
    if (!state.auditBaseline && initialCode?.parent) {
      state.auditBaseline = { ...initialCode, commit: initialCode.parent, parent: null, patch: "", label: "audit-baseline" };
    }
    state.auditBaseline ??= state.baseline?.code ?? null;
    state.specReports = (asRecord(item.spec_reports) ?? {}) as ResearchState["specReports"];
    state.checkpoints = (asRecord(item.checkpoints) ?? {}) as ResearchState["checkpoints"];
    state.searchDone = item.search_done === true;
    state.ideaRetries = Math.max(0, Number(item.idea_retries ?? 0) || 0);
    state.paperRetries = Math.max(0, Number(item.paper_retries ?? 0) || 0);
    state.round = Number(item.round ?? 0) || 0;
    state.evaluatedIds = new Set(asArray(item.evaluated_ids).map(String));
    state.bestIdea = (item.best_idea ?? null) as Idea | null;
    state.bestEvidence = (item.best_evidence ?? null) as Evidence | null;
    state.bestSubset = (item.best_subset ?? null) as Evidence | null;
    state.bestCode = (item.best_code ?? null) as ResearchState["bestCode"];
    state.ideaPool = asArray(item.idea_pool) as Idea[];
    state.ablations = asArray(item.ablations) as AblationResult[];
    state.ablationPlans = asArray(item.ablation_plans) as AblationPlan[];
    state.ablationRound = Number(item.ablation_round ?? 0) || 0;
    state.ablationCommit = String(item.ablation_commit ?? "");
    state.ablationVerdict = (item.ablation_verdict ?? null) as Verdict | null;
    state.manuscript = (item.manuscript ?? null) as Manuscript | null;
    state.manuscriptCommit = String(item.manuscript_commit ?? "");
    state.review = (item.review ?? null) as Review | null;
    state.reviews = asArray(item.reviews) as Review[];
    state.metaReview = (item.meta_review ?? null) as MetaReview | null;
    state.peerRound = Number(item.peer_round ?? 0) || 0;
    state.reviewRefinements = Number(item.review_refinements ?? 0) || 0;
    state.metaRound = Number(item.meta_round ?? 0) || 0;
    state.rebuttals = asArray(item.rebuttals) as Evidence[];
    state.decisionPath = asArray(item.decision_path).map(String);
    state.aborted = item.aborted === true;
    state.abortReason = String(item.abort_reason ?? "");
    state.exportReason = String(item.export_reason ?? "");

    // A state written before the provenance guard may contain an old parent-
    // commit proxy as a "good" candidate. Never resume it as measured science.
    const invalid = (evidence: Evidence | null | undefined): boolean =>
      !!evidence && evidenceSucceeded(evidence) && evidenceProvenanceError(evidence) !== null;
    for (const trace of state.traces) {
      // Only the final usable measurement matters; an earlier failed repair
      // must not invalidate a later repaired candidate.
      const final = (trace.evidence ?? [])[(trace.evidence ?? []).length - 1];
      if (invalid(final)) {
        trace.invalid = true;
        trace.decision = "bad";
        state.evaluatedIds.delete(trace.idea.id);
      }
    }
    for (const [ideaId, checkpoint] of Object.entries(state.checkpoints)) {
      const final = (checkpoint.trace?.evidence ?? [])[(checkpoint.trace?.evidence ?? []).length - 1];
      if (invalid(final)) {
        delete state.checkpoints[ideaId];
        state.evaluatedIds.delete(ideaId);
      }
    }
    if (invalid(state.bestEvidence)) {
      state.bestIdea = null;
      state.bestEvidence = null;
      state.bestSubset = null;
      state.bestCode = null;
      // Downstream artifacts were derived from the now-invalid incumbent.
      state.ablations = [];
      state.ablationPlans = [];
      state.ablationRound = 0;
      state.ablationVerdict = null;
      state.manuscript = null;
      state.review = null;
      state.reviews = [];
      state.metaReview = null;
      state.peerRound = 0;
      state.reviewRefinements = 0;
      state.metaRound = 0;
      state.rebuttals = [];
    }
    // A proxy ablation/rebuttal must not contribute attribution or paper claims.
    for (const ablation of state.ablations) {
      if (invalid(ablation.evidence) && ablation.evidence?.result?.status === "ok") {
        ablation.ok = false;
        ablation.metrics = {};
      }
    }
    state.rebuttals = state.rebuttals.filter((evidence) =>
      evidenceSucceeded(evidence) && !invalid(evidence),
    );
    if (invalid(state.bestSubset)) state.bestSubset = null;
    for (const trace of state.traces) {
      trace.seed_id ??= trace.evidence.find((evidence) => evidence.scope === "subset")?.idea_id ?? trace.idea.id;
      if (!trace.invalid) state.evaluatedIds.add(trace.seed_id);
    }
    for (const [key, checkpoint] of Object.entries(state.checkpoints)) {
      const seedId = checkpoint.trace.seed_id ?? checkpoint.trace.evidence.find((evidence) => evidence.scope === "subset")?.idea_id ?? key;
      checkpoint.trace.seed_id = seedId;
      checkpoint.idea_id = seedId;
      if (key !== seedId) delete state.checkpoints[key];
      state.checkpoints[seedId] = checkpoint;
    }
    if (config.runner !== "simulated") state.invalidateCandidateEnvironment();
    return state;
  }

  /** Keep historical records while retiring evidence with missing or changed execution identity. */
  invalidateCandidateEnvironment(environments?: Map<string, string>): number {
    const stale = (evidence: Evidence | null | undefined): boolean => !!evidence && evidence.idea_id !== "baseline" &&
      evidenceSucceeded(evidence) && (!evidence.code?.check_environment ||
        environments !== undefined && evidence.code.check_environment !== environments.get(evidence.code.commit ?? ""));
    let retired = 0;
    for (const trace of this.traces) {
      if (trace.invalid || !trace.evidence.some(stale)) continue;
      trace.invalid = true;
      this.evaluatedIds.delete(trace.seed_id ?? trace.idea.id);
      this.evaluatedIds.delete(trace.idea.id);
      retired++;
    }
    for (const [id, checkpoint] of Object.entries(this.checkpoints)) {
      if (!checkpoint.trace.evidence.some(stale)) continue;
      delete this.checkpoints[id];
      this.evaluatedIds.delete(id);
      retired++;
    }
    const incumbentStale = stale(this.bestEvidence) || stale(this.bestSubset);
    const attributionStale = this.ablations.some((result) => stale(result.evidence)) || this.rebuttals.some(stale);
    if (incumbentStale) {
      this.bestIdea = null;
      this.bestCode = null;
      this.bestEvidence = null;
      this.bestSubset = null;
      retired++;
    }
    if (incumbentStale || attributionStale) {
      this.ablations = [];
      this.ablationPlans = [];
      this.ablationVerdict = null;
      this.ablationCommit = "";
      this.ablationRound = 0;
      this.manuscript = null;
      this.manuscriptCommit = "";
      this.review = null;
      this.reviews = [];
      this.metaReview = null;
      this.rebuttals = [];
      this.peerRound = 0;
      this.reviewRefinements = 0;
      this.metaRound = 0;
      retired++;
    }
    if (retired) {
      for (const trace of this.traces) {
        if (trace.invalid) continue;
        this.evaluatedIds.add(trace.seed_id ?? trace.idea.id);
        this.evaluatedIds.add(trace.idea.id);
      }
      this.searchDone = false;
      this.specReports = {};
      this.ablations = this.ablations.filter((result) => !stale(result.evidence));
      this.rebuttals = this.rebuttals.filter((evidence) => !stale(evidence));
      this.environmentFingerprint = "";
    }
    return retired;
  }

  goodTraces(): Trace[] {
    const winners = new Map<string, Trace>();
    for (const trace of this.traces) {
      if (trace.decision === "good" && !trace.invalid) winners.set(trace.seed_id ?? trace.idea.id, trace);
    }
    return [...winners.values()]
      .sort((a, b) => (a.round === b.round ? a.idea.id.localeCompare(b.idea.id) : a.round - b.round));
  }

  rebindWorktree(root: string): void {
    const traces = [...this.traces, ...Object.values(this.checkpoints).map((checkpoint) => checkpoint.trace)];
    const codes = [this.auditBaseline, this.baseline?.code, this.baselineFull?.code, this.bestCode,
      this.bestEvidence?.code, this.bestSubset?.code, ...traces.flatMap((trace) => trace.evidence.map((evidence) => evidence.code)),
      ...this.ablations.map((result) => result.evidence?.code), ...this.rebuttals.map((evidence) => evidence.code)];
    for (const code of codes) if (code) code.path = path.join(root, "worktree");
  }

  nextSeeds(n: number): Idea[] {
    if (n <= 0) return [];
    const ordered = this.seeds.slice().sort((a, b) => {
      const ar = -rankKey(a, this.config.guidanceWeight);
      const br = -rankKey(b, this.config.guidanceWeight);
      return ar === br ? a.id.localeCompare(b.id) : ar - br;
    });
    const out: Idea[] = [];
    for (const idea of ordered) {
      // invalid implementation is unknown, not evaluated; it may be retried.
      if (this.evaluatedIds.has(idea.id)) continue;
      out.push(idea);
      if (out.length === n) break;
    }
    return out;
  }

  record(trace: Trace): void {
    this.traces.push(trace);
    // An implementation that never produced a candidate commit is UNKNOWN, not
    // a refutation. Keep the trace for audit, but never let it exclude the idea
    // from a later reseed or from the scientific refutation list.
    const seedId = trace.seed_id ?? trace.idea.id;
    if (!trace.invalid) {
      this.evaluatedIds.add(seedId);
      this.evaluatedIds.add(trace.idea.id);
    }
    delete this.checkpoints[seedId];
    delete this.checkpoints[trace.idea.id];
  }

  /** Persist in-flight progress for one idea without marking it evaluated. */
  checkpoint(progress: TraceCheckpoint): void {
    this.checkpoints[progress.idea_id] = progress;
  }

  /** Resume point for an idea that was interrupted mid-measurement. */
  checkpointFor(ideaId: string): TraceCheckpoint | null {
    return this.checkpoints[ideaId] ?? null;
  }

  adopt(idea: Idea, evidence: Evidence): void {
    this.bestIdea = idea;
    this.bestEvidence = evidence;
    this.bestCode = evidence.code;
  }

  note(decision: string): void {
    this.decisionPath.push(decision);
  }

  /** JSON-serializable full snapshot with snake_case field names (I8). */
  toDict(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {
      state_version: 2,
      problem: this.problem,
      config: this.config,
      diagnosis: this.diagnosis,
      limitations: this.limitations,
      seeds: this.seeds,
      baseline: this.baseline,
      audit_baseline: this.auditBaseline,
      spec_reports: this.specReports,
      baseline_full: this.baselineFull,
      baseline_source: this.baselineSource,
      baseline_path: this.baselinePath,
      environment_fingerprint: this.environmentFingerprint,
      traces: this.traces,
      checkpoints: this.checkpoints,
      search_done: this.searchDone,
      idea_retries: this.ideaRetries,
      paper_retries: this.paperRetries,
      round: this.round,
      evaluated_ids: [...this.evaluatedIds].sort(),
      idea_pool: this.ideaPool,
      best_idea: this.bestIdea,
      best_evidence: this.bestEvidence,
      best_subset: this.bestSubset,
      best_code: this.bestCode,
      ablations: this.ablations,
      ablation_plans: this.ablationPlans,
      ablation_round: this.ablationRound,
      ablation_commit: this.ablationCommit,
      ablation_verdict: this.ablationVerdict,
      manuscript: this.manuscript,
      manuscript_commit: this.manuscriptCommit,
      review: this.review,
      reviews: this.reviews,
      meta_review: this.metaReview,
      peer_round: this.peerRound,
      review_refinements: this.reviewRefinements,
      meta_round: this.metaRound,
      rebuttals: this.rebuttals,
      decision_path: this.decisionPath,
      aborted: this.aborted,
      abort_reason: this.abortReason,
      export_reason: this.exportReason,
    };
    return canonical(snapshot) as Record<string, unknown>;
  }
}
