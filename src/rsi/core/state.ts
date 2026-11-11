/** Mutable research state: the single source of truth for one run (I8). */

import type { Config } from "../config.ts";
import { canonical } from "../json.ts";
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
