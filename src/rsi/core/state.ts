/** Mutable research state: the single source of truth for one run (I8). */

import type { Config } from "../config.ts";
import { asArray, asRecord, canonical } from "../json.ts";
import type {
  AblationResult,
  Evidence,
  Idea,
  Limitation,
  Manuscript,
  MetaReview,
  Problem,
  RepoRef,
  Review,
  Trace,
} from "../types.ts";
import { rankKey } from "../agents/ideas.ts";

export class ResearchState {
  readonly problem: Problem;
  readonly config: Config;

  limitations: Limitation[] = [];
  seeds: Idea[] = [];

  baseline: Evidence | null = null;
  /** Full-set baseline, persisted so a resumed run does not rerun it. */
  baselineFull: Evidence | null = null;
  traces: Trace[] = [];
  round = 0;
  evaluatedIds = new Set<string>();

  bestIdea: Idea | null = null;
  bestEvidence: Evidence | null = null;
  bestCode: RepoRef | null = null;

  ablations: AblationResult[] = [];
  ablationRound = 0;

  manuscript: Manuscript | null = null;
  review: Review | null = null;
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
    const state = new ResearchState(problem, config);
    state.limitations = asArray(item.limitations) as Limitation[];
    state.seeds = asArray(item.seeds) as Idea[];
    state.baseline = (item.baseline ?? null) as Evidence | null;
    state.baselineFull = (item.baseline_full ?? null) as Evidence | null;
    state.traces = asArray(item.traces) as Trace[];
    state.round = Number(item.round ?? 0) || 0;
    state.evaluatedIds = new Set(asArray(item.evaluated_ids).map(String));
    state.bestIdea = (item.best_idea ?? null) as Idea | null;
    state.bestEvidence = (item.best_evidence ?? null) as Evidence | null;
    state.bestCode = (item.best_code ?? null) as ResearchState["bestCode"];
    state.ablations = asArray(item.ablations) as AblationResult[];
    state.ablationRound = Number(item.ablation_round ?? 0) || 0;
    state.manuscript = (item.manuscript ?? null) as Manuscript | null;
    state.review = (item.review ?? null) as Review | null;
    state.metaReview = (item.meta_review ?? null) as MetaReview | null;
    state.peerRound = Number(item.peer_round ?? 0) || 0;
    state.reviewRefinements = Number(item.review_refinements ?? 0) || 0;
    state.metaRound = Number(item.meta_round ?? 0) || 0;
    state.rebuttals = asArray(item.rebuttals) as Evidence[];
    state.decisionPath = asArray(item.decision_path).map(String);
    state.aborted = item.aborted === true;
    state.abortReason = String(item.abort_reason ?? "");
    state.exportReason = String(item.export_reason ?? "");
    return state;
  }

  goodTraces(): Trace[] {
    return this.traces
      .filter((trace) => trace.decision === "good")
      .sort((a, b) => (a.round === b.round ? a.idea.id.localeCompare(b.idea.id) : a.round - b.round));
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
      if (this.evaluatedIds.has(idea.id)) continue;
      out.push(idea);
      if (out.length === n) break;
    }
    return out;
  }

  record(trace: Trace): void {
    this.traces.push(trace);
    this.evaluatedIds.add(trace.idea.id);
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
      problem: this.problem,
      config: this.config,
      limitations: this.limitations,
      seeds: this.seeds,
      baseline: this.baseline,
      baseline_full: this.baselineFull,
      traces: this.traces,
      round: this.round,
      evaluated_ids: [...this.evaluatedIds].sort(),
      best_idea: this.bestIdea,
      best_evidence: this.bestEvidence,
      best_code: this.bestCode,
      ablations: this.ablations,
      ablation_round: this.ablationRound,
      manuscript: this.manuscript,
      review: this.review,
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
