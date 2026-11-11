/** §3.1–§3.6 state machine: sequencing, strict adoption, replayable export. */

import type { Config } from "../config.ts";
import type { AgentContext } from "../agents/base.ts";
import { checkAborted, progress } from "../agents/base.ts";
import { AblationCritic, AblationPlanner } from "../agents/ablation.ts";
import {
  AblationCoder,
  BaselineCoder,
  FullSetCoder,
  IdeaImplementer,
  RebuttalCoder,
  SubsetCoder,
} from "../agents/coding.ts";
import { FullSetCritic, ResultComparison, Selector, SubsetCritic } from "../agents/critics.ts";
import { FullSetEngineer, SubsetEngineer } from "../agents/engineering.ts";
import {
  IdeaEvolver,
  IdeaGenerator,
  InitialIdeaGenerator,
  NoveltyChecker,
  filterByGuidance,
  rankKey,
} from "../agents/ideas.ts";
import {
  MethodCodeAuditor,
  ReferenceAuditor,
  SpecAuditor,
  combine,
} from "../agents/integrity.ts";
import { LimitationExtractor, LimitationVerifier } from "../agents/limitations.ts";
import { MetaReviewer, PeerReviewer, RebuttalPlanner } from "../agents/review.ts";
import { InitialDrafter, PaperEnhancer } from "../agents/writing.ts";
import { BudgetExceeded } from "../runtime/budget.ts";
import {
  type AblationResult,
  type Evidence,
  type FinalArtifacts,
  type Idea,
  type IntegrityReport,
  type Manuscript,
  type Scope,
  type Trace,
  evidenceOk,
  isStrictlyBetter,
  makeFinal,
  makeManuscript,
  verdictAccepted,
} from "../types.ts";
import { ResearchState } from "./state.ts";

export class ScientificAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScientificAbort";
  }
}

export interface AgentBundle {
  limitationExtractor: LimitationExtractor;
  limitationVerifier: LimitationVerifier;
  initialIdeaGenerator: InitialIdeaGenerator;
  noveltyChecker: NoveltyChecker;
  ideaGenerator: IdeaGenerator;
  ideaEvolver: IdeaEvolver;
  baselineCoder: BaselineCoder;
  subsetCoder: SubsetCoder;
  fullSetCoder: FullSetCoder;
  subsetCritic: SubsetCritic;
  fullSetCritic: FullSetCritic;
  subsetEngineer: SubsetEngineer;
  fullSetEngineer: FullSetEngineer;
  implementer: IdeaImplementer;
  resultComparison: ResultComparison;
  selector: Selector;
  ablationPlanner: AblationPlanner;
  ablationCoder: AblationCoder;
  ablationCritic: AblationCritic;
  initialDrafter: InitialDrafter;
  peerReviewer: PeerReviewer;
  rebuttalPlanner: RebuttalPlanner;
  rebuttalCoder: RebuttalCoder;
  paperEnhancer: PaperEnhancer;
  metaReviewer: MetaReviewer;
  specAuditor: SpecAuditor;
  referenceAuditor: ReferenceAuditor;
  methodCodeAuditor: MethodCodeAuditor;
}

export function buildAgents(ctx: AgentContext): AgentBundle {
  const subsetCritic = new SubsetCritic(ctx);
  const fullSetCritic = new FullSetCritic(ctx);
  const subsetEngineer = new SubsetEngineer(ctx);
  const fullSetEngineer = new FullSetEngineer(ctx);
  const baselineCoder = new BaselineCoder(ctx);
  const subsetCoder = new SubsetCoder(ctx);
  const fullSetCoder = new FullSetCoder(ctx);
  return {
    limitationExtractor: new LimitationExtractor(ctx),
    limitationVerifier: new LimitationVerifier(ctx),
    initialIdeaGenerator: new InitialIdeaGenerator(ctx),
    noveltyChecker: new NoveltyChecker(ctx),
    ideaGenerator: new IdeaGenerator(ctx),
    ideaEvolver: new IdeaEvolver(ctx),
    baselineCoder,
    subsetCoder,
    fullSetCoder,
    subsetCritic,
    fullSetCritic,
    subsetEngineer,
    fullSetEngineer,
    implementer: new IdeaImplementer(ctx, {
      subsetCritic,
      fullCritic: fullSetCritic,
      subsetEngineer,
      fullEngineer: fullSetEngineer,
      baselineCoder,
      subsetCoder,
      fullSetCoder,
    }),
    resultComparison: new ResultComparison(ctx),
    selector: new Selector(ctx),
    ablationPlanner: new AblationPlanner(ctx),
    ablationCoder: new AblationCoder(ctx),
    ablationCritic: new AblationCritic(ctx),
    initialDrafter: new InitialDrafter(ctx),
    peerReviewer: new PeerReviewer(ctx),
    rebuttalPlanner: new RebuttalPlanner(ctx),
    rebuttalCoder: new RebuttalCoder(ctx),
    paperEnhancer: new PaperEnhancer(ctx),
    metaReviewer: new MetaReviewer(ctx),
    specAuditor: new SpecAuditor(ctx),
    referenceAuditor: new ReferenceAuditor(ctx),
    methodCodeAuditor: new MethodCodeAuditor(ctx),
  };
}

const ABORT_REASONS = new Set([
  "no_good_ideas",
  "no_eligible_seeds",
  "baseline_failed",
  "limitations_exhausted",
]);

function byId<T extends { id: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => a.id.localeCompare(b.id));
}

function g(value: number): string {
  return String(value);
}

export class Orchestrator {
  readonly ctx: AgentContext;
  readonly agents: AgentBundle;
  readonly state: ResearchState;
  private specReports = new Map<string, IntegrityReport>();

  constructor(ctx: AgentContext, agents?: AgentBundle) {
    this.ctx = ctx;
    this.agents = agents ?? buildAgents(ctx);
    this.state = new ResearchState(ctx.problem, ctx.config);
  }

  async run(): Promise<FinalArtifacts> {
    try {
      this.ctx.budget.check();
      await this.limitations();
      await this.seedIdeas();
      await this.baseline();
      await this.ideaSearch();
      await this.select();
      await this.ablations();
      await this.draftAndReview();
      await this.metaReview();
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        this.state.aborted = true;
        this.state.abortReason = error.message;
      } else if (error instanceof ScientificAbort) {
        this.state.aborted = ABORT_REASONS.has(error.message);
        if (this.state.aborted) this.state.abortReason = error.message;
        else this.state.exportReason = error.message;
      } else {
        throw error;
      }
    }
    return this.exportArtifacts();
  }

  private transition(kind: string, token: string, data: Record<string, unknown> = {}): void {
    this.state.note(token);
    this.ctx.traces.append(kind, { decision: token, token, ...data });
    this.persist();
  }

  private persist(): void {
    this.ctx.store.writeJson("../state.json", this.state.toDict());
  }

  private async limitations(): Promise<void> {
    progress(this.ctx, "§3.1 extracting limitations");
    const rounds = Math.min(16, this.ctx.config.maxLimitationRounds);
    for (let index = 0; index < rounds; index++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      const fresh = await this.agents.limitationExtractor.extract({
        round: index,
        existing: this.state.limitations,
      });
      this.state.limitations = [...this.state.limitations, ...fresh].sort((a, b) => a.id.localeCompare(b.id));
      const verdict = await this.agents.limitationVerifier.verify(this.state.limitations, { round: index });
      const sufficient =
        verdictAccepted(verdict) && this.state.limitations.length >= this.ctx.config.minLimitations;
      this.transition(
        "stage.limitations",
        `limits.${sufficient ? "ok" : "refine"}:${this.state.limitations.length}`,
        { round: index, verdict },
      );
      if (sufficient) return;
    }
    throw new ScientificAbort("limitations_exhausted");
  }

  private async seedIdeas(): Promise<void> {
    progress(this.ctx, "§3.1 generating seed ideas");
    const initial = await this.agents.initialIdeaGenerator.generate(this.state.limitations);
    const pool: Idea[] = [await this.agents.noveltyChecker.score(initial)];
    const attempts = Math.max(2 * this.ctx.config.nSeed, 1);
    for (let i = 0; i < attempts; i++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      if (pool.length >= this.ctx.config.nSeed) break;
      const extra = await this.agents.ideaGenerator.generate({
        limitations: this.state.limitations,
        existing: pool,
        n: this.ctx.config.nSeed - pool.length,
      });
      const ids = new Set(pool.map((idea) => idea.id));
      const clean = byId(extra).filter((idea) => !ids.has(idea.id));
      if (!clean.length) break;
      for (const idea of clean.slice(0, this.ctx.config.nSeed - pool.length)) {
        this.ctx.budget.check();
        pool.push(await this.agents.noveltyChecker.score(idea));
      }
    }
    const eligible = pool.filter(
      (idea) => idea.hypothesis.trim() && idea.novelty_score >= this.ctx.config.minNovelty,
    );
    this.state.seeds = filterByGuidance(eligible, this.ctx.problem, this.ctx.config).sort((a, b) => {
      const ar = -rankKey(a, this.ctx.config.guidanceWeight);
      const br = -rankKey(b, this.ctx.config.guidanceWeight);
      return ar === br ? a.id.localeCompare(b.id) : ar - br;
    });
    this.transition("stage.seeds", `seeds:${this.state.seeds.length}`, {
      ids: this.state.seeds.map((idea) => idea.id),
    });
    if (pool.length < this.ctx.config.nSeed) {
      this.transition("stage.seeds", `seeds.partial:${pool.length}`);
    }
    if (!this.state.seeds.length) throw new ScientificAbort("no_eligible_seeds");
  }

  private async baseline(): Promise<void> {
    progress(this.ctx, "§3.2 reproducing the baseline");
    this.ctx.budget.check();
    if (!this.state.baseline) {
      this.state.baseline = await this.agents.baselineCoder.reproduce({ scope: "subset" });
    }
    if (!("baseline_full" in this.ctx.scratch)) {
      const full = await this.agents.baselineCoder.reproduce({ scope: "full" });
      this.ctx.scratch.baseline_full = full;
      this.transition("stage.baseline", "baseline.full.ok", { metrics: full.metrics });
    }
    this.ctx.scratch.baseline = this.state.baseline;
    this.transition("stage.baseline", evidenceOk(this.state.baseline) ? "baseline.ok" : "baseline.bad", {
      metrics: this.state.baseline.metrics,
    });
    if (!evidenceOk(this.state.baseline) || !Object.keys(this.state.baseline.metrics).length) {
      throw new ScientificAbort("baseline_failed");
    }
  }

  private async auditTrace(trace: Trace): Promise<void> {
    if (trace.decision !== "good") return;
    try {
      const evidence = trace.evidence.length ? trace.evidence[trace.evidence.length - 1] : null;
      if (!evidence) return;
      const baseline = this.state.baseline;
      let diff = "";
      if (baseline?.code && evidence.code) diff = await this.ctx.workspace.diff(baseline.code, evidence.code);
      const report = await this.agents.specAuditor.audit(trace.idea, { evidence, diff });
      this.specReports.set(trace.idea.id, report);
      this.ctx.traces.append("integrity", { agent: "spec_auditor", report });
      if (report.spec_violations.length) {
        trace.decision = "bad";
        trace.lessons.push(`Specification violation: ${report.spec_violations.slice().sort().join("; ")}`);
        this.transition("stage.round", `spec.violation:${trace.idea.id}`, {
          violations: report.spec_violations.slice().sort(),
        });
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      this.specReports.set(trace.idea.id, {
        score_verified: false,
        spec_violations: [],
        ref_violations: [],
        method_code_alignment: 0,
        checked_claims: 0,
        notes: [`spec_auditor unavailable: ${(error as Error).name}`],
      });
      this.ctx.traces.append("integrity", { agent: "spec_auditor", error: (error as Error).name });
    }
  }

  private async evaluate(ideas: Idea[], round: number): Promise<void> {
    this.state.round = round;
    for (const idea of ideas) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      if (this.state.evaluatedIds.has(idea.id)) continue;
      const trace = await this.agents.implementer.implement(idea, { round });
      await this.auditTrace(trace);
      this.state.record(trace);
      this.transition("stage.round", `round${round}.${idea.id}:${trace.decision}`, {
        round,
        idea_id: idea.id,
        trace,
      });
      progress(this.ctx, `§3.2 round ${round}: ${idea.id} → ${trace.decision}`);
    }
  }

  private async ideaSearch(): Promise<void> {
    await this.evaluate(this.state.nextSeeds(this.ctx.config.n0), 0);
    for (let round = 1; round <= this.ctx.config.maxRefineRounds; round++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      if (this.state.goodTraces().length >= this.ctx.config.successTarget) break;
      const seeds = this.state.nextSeeds(this.ctx.config.nExplore);
      const n = this.ctx.config.nEvolved + this.ctx.config.nExplore - seeds.length;
      const evolved = await this.agents.ideaEvolver.evolve({
        traces: this.state.traces
          .slice()
          .sort((a, b) => (a.round === b.round ? a.idea.id.localeCompare(b.idea.id) : a.round - b.round)),
        n,
        round,
      });
      const scored: Idea[] = [];
      for (const idea of byId(evolved)) {
        this.ctx.budget.check();
        scored.push(await this.agents.noveltyChecker.score(idea, { round }));
      }
      const eligible = filterByGuidance(scored, this.ctx.problem, this.ctx.config);
      const evolvedIds = new Set(eligible.map((idea) => idea.id));
      const candidates = byId(eligible).concat(seeds.filter((idea) => !evolvedIds.has(idea.id)));
      await this.evaluate(candidates, round);
      if (!candidates.length) this.transition("stage.round", `round${round}.empty`, { round });
    }
    if (!this.state.goodTraces().length) throw new ScientificAbort("no_good_ideas");
  }

  private async select(): Promise<void> {
    progress(this.ctx, "§3.3 selecting the incumbent");
    if (!this.state.baseline) throw new ScientificAbort("baseline_failed");
    const valid: Trace[] = [];
    for (const trace of this.state.goodTraces()) {
      const evidence = trace.evidence.length ? trace.evidence[trace.evidence.length - 1] : null;
      if (evidence && evidence.scope === ("full" as Scope)) valid.push(trace);
    }
    if (!valid.length) throw new ScientificAbort("no_valid_full_evidence");
    const selected = await this.agents.selector.select(valid, { baseline: this.state.baseline });
    const evidence = selected.evidence.length ? selected.evidence[selected.evidence.length - 1] : null;
    this.transition("stage.select", `select:${selected.idea.id}`, { idea_id: selected.idea.id });
    if (!evidence || !(await this.adopt(selected.idea, evidence, this.state.baseline, "select"))) {
      throw new ScientificAbort("selection_not_better_than_baseline");
    }
  }

  private async adopt(idea: Idea, evidence: Evidence, base: Evidence, reason: string): Promise<boolean> {
    const verdict = await this.agents.resultComparison.compare(evidence, base);
    const better =
      evidenceOk(evidence) &&
      verdictAccepted(verdict) &&
      isStrictlyBetter(evidence.metrics, base.metrics, this.ctx.problem.metrics);
    if (better) {
      this.state.adopt(idea, evidence);
      this.transition("state.adopt", `adopt.${reason}:${idea.id}`, {
        idea_id: idea.id,
        metrics: evidence.metrics,
      });
    }
    return better;
  }

  private async ablations(): Promise<void> {
    progress(this.ctx, "§3.4 running ablations");
    for (let index = 0; index <= this.ctx.config.maxAblationRounds; index++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      this.state.ablationRound = index;
      const [idea, best] = this.incumbent();
      const plans = await this.agents.ablationPlanner.plan(idea, {
        best,
        n: this.ctx.config.nAblationPlans,
      });
      const results: AblationResult[] = [];
      for (const plan of byId(plans)) {
        this.ctx.budget.check();
        results.push(await this.agents.ablationCoder.runPlan(idea, plan, { best }));
      }
      this.state.ablations = results;
      const verdict = await this.agents.ablationCritic.judge(idea, results, { best });
      this.transition("stage.ablation", `ablation.${verdict.decision}`, { round: index, verdict });
      if (verdictAccepted(verdict) || (verdict.decision !== "refine" && verdict.decision !== "engineer")) {
        return;
      }
      if (index >= this.ctx.config.maxAblationRounds) return;
      this.ctx.budget.check();
      const revised = await this.agents.fullSetEngineer.refine(idea, {
        evidence: best,
        feedback: verdict.feedback,
        reason: "ablation",
      });
      if (!(await this.adopt(revised.idea, revised.evidence, best, "ablation"))) {
        this.transition("stage.ablation", "ablation.keep");
        return;
      }
    }
  }

  private async draftAndReview(reviewerFeedback = ""): Promise<void> {
    progress(this.ctx, "§3.5 drafting and peer review");
    const [idea, best] = this.incumbent();
    this.state.peerRound = 0;
    this.state.reviewRefinements = 0;
    this.state.rebuttals = [];
    this.state.manuscript = await this.agents.initialDrafter.draft({
      idea,
      best,
      ablations: this.state.ablations,
      round: this.state.metaRound,
      reviewerFeedback,
    });
    this.state.review = await this.agents.peerReviewer.review(this.state.manuscript, { round: 0 });
    this.transition("stage.review", `peer.r0:${g(this.state.review.score)}`, {
      score: this.state.review.score,
    });
    while (
      !(this.state.review.score >= this.ctx.config.reviewThreshold) &&
      this.state.peerRound < this.ctx.config.maxPeerRounds &&
      this.state.reviewRefinements < this.ctx.config.maxReviewRefinements
    ) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      const tasks = await this.agents.rebuttalPlanner.plan(this.state.review, {
        n: Math.max(1, this.state.review.questions.length),
      });
      const rebuttal: Evidence[] = [];
      for (const task of byId(tasks)) {
        this.ctx.budget.check();
        const evidence = await this.agents.rebuttalCoder.runTask(idea, task, { best });
        this.state.rebuttals.push(evidence);
        if (evidenceOk(evidence) && Object.keys(evidence.metrics).length) rebuttal.push(evidence);
      }
      if (!rebuttal.length) {
        this.transition("stage.review", "peer.no_evidence");
        break;
      }
      this.state.manuscript = await this.agents.paperEnhancer.enhance({
        manuscript: this.state.manuscript,
        review: this.state.review,
        rebuttal,
      });
      this.state.peerRound += 1;
      this.state.reviewRefinements += 1;
      this.state.review = await this.agents.peerReviewer.review(this.state.manuscript, {
        round: this.state.peerRound,
      });
      this.transition("stage.review", `peer.r${this.state.peerRound}:${g(this.state.review.score)}`, {
        score: this.state.review.score,
      });
    }
  }

  private async metaReview(): Promise<void> {
    progress(this.ctx, "§3.6 meta-review");
    for (let index = 0; index <= this.ctx.config.maxMetaRounds; index++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      this.state.metaRound = index;
      if (!this.state.manuscript || !this.state.review) {
        throw new ScientificAbort("missing_manuscript");
      }
      this.state.metaReview = await this.agents.metaReviewer.decide(this.state.manuscript, this.state.review, {
        round: index,
      });
      this.transition("stage.meta", `meta.${this.state.metaReview.decision}`, { round: index });
      if (this.state.metaReview.decision === "accept") {
        if (!(this.state.review.score >= this.ctx.config.reviewThreshold)) {
          throw new ScientificAbort("peer_review_below_threshold");
        }
        return;
      }
      if (index >= this.ctx.config.maxMetaRounds) {
        this.state.exportReason = "meta_refinement_budget_exhausted";
        this.transition("stage.meta", "meta.exhausted");
        return;
      }
      const [idea, best] = this.incumbent();
      this.ctx.budget.check();
      const revised = await this.agents.fullSetEngineer.refine(idea, {
        evidence: best,
        feedback: this.state.metaReview.critique,
        reason: "meta",
      });
      if (!(await this.adopt(revised.idea, revised.evidence, best, "meta"))) {
        this.state.exportReason = "meta_refinement_not_strictly_better";
        this.transition("stage.meta", "meta.keep");
        return;
      }
      this.state.metaRound = index + 1;
      await this.ablations();
      await this.draftAndReview(this.state.metaReview.critique);
    }
  }

  private incumbent(): [Idea, Evidence] {
    if (!this.state.bestIdea || !this.state.bestEvidence) {
      throw new ScientificAbort("missing_incumbent");
    }
    return [this.state.bestIdea, this.state.bestEvidence];
  }

  private async exportIntegrity(): Promise<IntegrityReport> {
    const reports: IntegrityReport[] = [];
    if (this.state.bestIdea) {
      const report = this.specReports.get(this.state.bestIdea.id);
      if (report) reports.push(report);
    }
    if (!this.state.manuscript) return combine(...reports);
    for (const name of ["reference_auditor", "method_code_auditor"] as const) {
      try {
        let report: IntegrityReport;
        if (name === "reference_auditor") {
          report = await this.agents.referenceAuditor.audit(this.state.manuscript);
        } else {
          let diff = "";
          const baseline = this.state.baseline;
          if (baseline?.code && this.state.bestCode) {
            diff = await this.ctx.workspace.diff(baseline.code, this.state.bestCode);
          }
          report = await this.agents.methodCodeAuditor.audit(this.state.manuscript, {
            diff,
            evidence: this.state.bestEvidence,
          });
        }
        reports.push(report);
        this.ctx.traces.append("integrity", { agent: name, report });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        reports.push({
          score_verified: false,
          spec_violations: [],
          ref_violations: [],
          method_code_alignment: 0,
          checked_claims: 0,
          notes: [`${name} unavailable: ${(error as Error).name}`],
        });
        this.ctx.traces.append("integrity", { agent: name, error: (error as Error).name });
        if (error instanceof BudgetExceeded) {
          this.state.aborted = true;
          this.state.abortReason = error.message;
          break;
        }
      }
    }
    return combine(...reports);
  }

  private async exportArtifacts(): Promise<FinalArtifacts> {
    let accepted =
      !this.state.aborted &&
      this.state.review !== null &&
      this.state.review.score >= this.ctx.config.reviewThreshold &&
      this.state.metaReview !== null &&
      this.state.metaReview.decision === "accept";
    const integrity = await this.exportIntegrity();
    const clean =
      !integrity.spec_violations.length &&
      !integrity.ref_violations.length &&
      integrity.score_verified &&
      integrity.method_code_alignment >= 0.5;
    accepted = accepted && clean;
    const extra: Record<string, unknown> = { accepted };
    if (!accepted && !this.state.aborted) {
      if (!this.state.exportReason) {
        this.state.exportReason = !clean ? "integrity_not_clean" : "acceptance_gates_not_met";
      }
      extra.export_reason = this.state.exportReason;
    }
    if (integrity.method_code_alignment < 0.5) {
      extra.integrity_warning = "Method-code alignment is below 0.5.";
    }
    const terminal = this.state.aborted
      ? "run.abort"
      : accepted
        ? "run.accept"
        : "run.export_incumbent";
    this.transition(this.state.aborted ? "run.abort" : "run.done", terminal, {
      reason: this.state.abortReason || this.state.exportReason,
    });
    const final = makeFinal({
      paper:
        this.state.manuscript ??
        makeManuscript({ id: `${this.ctx.problem.id}-incomplete` }),
      code: this.state.bestCode,
      review: this.state.review,
      meta_review: this.state.metaReview,
      integrity,
      metrics: this.state.bestEvidence ? this.state.bestEvidence.metrics : {},
      decision_path: [...this.state.decisionPath],
      aborted: this.state.aborted,
      abort_reason: this.state.abortReason,
      extra,
    });
    this.persist();
    this.ctx.store.writeJson("final.json", final);
    return final;
  }

  stateDict(): Record<string, unknown> {
    return this.state.toDict();
  }
}

export type { AblationResult, Manuscript, Trace, Config };
