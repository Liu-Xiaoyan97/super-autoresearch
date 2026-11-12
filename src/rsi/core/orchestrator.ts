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
  codeOf,
  meanMetrics,
  subsetSeeds,
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
import { incumbentFileFor, ledgerFromEvidence, protocolFingerprint, writeIncumbent } from "../runtime/incumbent.ts";
import { runDiagnosis, type DiagnosisResult } from "../runtime/diagnosis.ts";
import {
  type AblationResult,
  type Diagnosis,
  type Evidence,
  type FinalArtifacts,
  type Idea,
  type IntegrityReport,
  type Manuscript,
  type Problem,
  type RepoRef,
  type Review,
  type Scope,
  type SeedSample,
  type Trace,
  type Verdict,
  evidenceOk,
  finalEvidence,
  isStrictlyBetter,
  makeEvidence,
  makeFinal,
  makeLimitation,
  makeManuscript,
  makeReview,
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
  "diagnosis_failed",
  "diagnosis_requires_baseline",
  "limitations_exhausted",
  "data_gate_not_met",
]);

function byId<T extends { id: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => a.id.localeCompare(b.id));
}

function g(value: number): string {
  return String(value);
}

export type DiagnoseFn = (
  problem: Problem,
  repo: RepoRef,
  store: AgentContext["store"],
  opts: { timeoutS: number; signal?: AbortSignal },
) => Promise<DiagnosisResult>;

export class Orchestrator {
  readonly ctx: AgentContext;
  readonly agents: AgentBundle;
  readonly state: ResearchState;
  private specReports = new Map<string, IntegrityReport>();
  private readonly diagnoseFn: DiagnoseFn;

  constructor(ctx: AgentContext, agents?: AgentBundle, state?: ResearchState, diagnoseFn: DiagnoseFn = runDiagnosis) {
    this.ctx = ctx;
    this.agents = agents ?? buildAgents(ctx);
    this.state = state ?? new ResearchState(ctx.problem, ctx.config);
    this.diagnoseFn = diagnoseFn;
  }

  async run(opts: { resume?: boolean } = {}): Promise<FinalArtifacts> {
    this.ctx.ensureBaselineFull = () => this.ensureBaselineFull();
    const resume = opts.resume === true;
    if (resume) {
      this.state.aborted = false;
      this.state.abortReason = "";
      this.state.exportReason = "";
      this.ctx.scratch.baseline = this.state.baseline;
      this.ctx.scratch.baseline_full = this.state.baselineFull;
    }
    try {
      this.ctx.budget.check();
      // A declared diagnosis needs a reproduced baseline first: defects are
      // measured on the baseline commit, never on an assumed number.
      if (this.ctx.problem.diagnose_command) {
        await this.baseline();
        await this.diagnose();
      }
      const limitsDone = this.state.decisionPath.some((token) => token.startsWith("limits.ok"));
      if (!resume || !limitsDone) await this.limitations();
      if (!resume || !this.state.seeds.length) await this.seedIdeas();
      if (!this.ctx.problem.diagnose_command) await this.baseline();
      await this.ideaSearch();
      const needsPaper = !resume || !this.state.manuscript || !this.state.review;
      if (needsPaper) {
        const gate = this.dataGate();
        if (!gate.ok) {
          this.transition("stage.gate", `data.gate:${gate.reason}`, { reason: gate.reason });
          throw new ScientificAbort("data_gate_not_met");
        }
      }
      if (!resume || !this.state.bestIdea) await this.select();
      if (!resume || !this.state.ablations.length) await this.ablations();
      if (needsPaper && !this.attributionGate()) {
        this.transition("stage.gate", "data.gate:attribution", { reason: "attribution" });
        throw new ScientificAbort("data_gate_not_met");
      }
      if (needsPaper) await this.draftAndReview();
      if (!resume || !this.state.metaReview) await this.metaReview();
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

  /**
   * The code loop must produce multiple independent full-set winners before the
   * paper loop may start. Depth mode deliberately tests one measured defect, so
   * it keeps its single-candidate contract.
   */
  private dataGate(): { ok: boolean; reason: string } {
    const depth = this.depthSearch();
    const required = depth ? 1 : Math.max(1, this.ctx.config.minGoodTraces);
    const good = this.state
      .goodTraces()
      .filter((trace) => finalEvidence(trace)?.scope === "full");
    const rounds = new Set(good.map((trace) => trace.round)).size;
    const enough = good.length >= required && (depth || rounds >= Math.min(2, required));
    return {
      ok: enough,
      reason: enough ? "ok" : `evidence:${good.length}/${required},rounds:${rounds}`,
    };
  }

  /** Attribution is the other half of the data gate: a gain must survive ablations. */
  private attributionGate(): boolean {
    if (this.state.ablationVerdict) return verdictAccepted(this.state.ablationVerdict);
    return this.state.decisionPath.some((token) => token === "ablation.good" || token === "ablation.accept");
  }

  private persist(): void {
    this.ctx.store.writeJson("../state.json", this.state.toDict());
  }

  /** Run the target-declared read-only analysis on the reproduced baseline. */
  private async diagnose(): Promise<void> {
    if (!this.ctx.problem.diagnose_command) return;
    if (this.state.diagnosis?.findings.length) return;
    progress(this.ctx, "diagnose: measuring the reproduced baseline");
    const code = this.state.baseline?.code;
    if (!this.ctx.problem.repo || !code?.repo || !code.commit) {
      throw new ScientificAbort("diagnosis_requires_baseline");
    }
    const timeoutS = Math.max(30, Math.min(this.ctx.config.maxWallTimeS, 1800));
    const result = await this.diagnoseFn(this.ctx.problem, code, this.ctx.store, {
      timeoutS,
      signal: this.ctx.signal,
    });
    if (result.status !== "ok" || !result.findings.length) {
      this.transition("stage.diagnose", "diagnose.failed", { error: result.error, log_path: result.log_path });
      throw new ScientificAbort("diagnosis_failed");
    }
    const diagnosis: Diagnosis = {
      findings: result.findings,
      log_path: result.log_path,
      stdout: result.stdout,
      stderr: result.stderr,
      wall_time_s: result.wall_time_s,
    };
    this.state.diagnosis = diagnosis;
    const measured = diagnosis.findings.map((finding, index) => makeLimitation({
      id: `D${index + 1}`,
      text: `${finding.title} (${finding.evidence})`,
      axis: finding.axis,
      evidence: finding.evidence,
      severity: Math.min(1, Math.max(0, finding.severity)),
      actionable: finding.actionable,
    }));
    const known = new Set(this.state.limitations.map((item) => item.id));
    this.state.limitations = [...measured.filter((item) => !known.has(item.id)), ...this.state.limitations]
      .sort((a, b) => a.id.localeCompare(b.id));
    this.transition("stage.diagnose", `diagnose.ok:${result.findings.length}`, {
      findings: result.findings.map((finding) => ({ id: finding.id, severity: finding.severity, measured: finding.measured })),
    });
  }

  private async limitations(): Promise<void> {
    progress(this.ctx, "§3.1 extracting limitations");
    const findings = this.findings();
    const rounds = Math.min(16, this.ctx.config.maxLimitationRounds);
    for (let index = 0; index < rounds; index++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      const fresh = await this.agents.limitationExtractor.extract({
        round: index,
        existing: this.state.limitations,
        findings,
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

  private findings() {
    return [...(this.state.diagnosis?.findings ?? [])]
      .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  }

  /** A measured diagnosis and the default depth policy allow one defect at a time. */
  private depthSearch(): boolean {
    return !!this.state.diagnosis?.findings.length && this.ctx.config.searchPolicy === "depth";
  }

  private async seedIdeas(): Promise<void> {
    progress(this.ctx, "§3.1 generating seed ideas");
    const findings = this.findings();
    const depth = this.depthSearch();
    const nSeed = depth ? 1 : this.ctx.config.nSeed;
    const initial = await this.agents.initialIdeaGenerator.generate(this.state.limitations, { findings });
    if (depth && initial.target_limitations.length === 0) {
      initial.target_limitations = [this.state.limitations.find((item) => /^D\d+$/.test(item.id))?.id ?? "D1"];
    }
    const pool: Idea[] = [await this.agents.noveltyChecker.score(initial, { findings })];
    const attempts = depth ? 0 : Math.max(2 * this.ctx.config.nSeed, 1);
    for (let i = 0; i < attempts; i++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      if (pool.length >= nSeed) break;
      const extra = await this.agents.ideaGenerator.generate({
        limitations: this.state.limitations,
        existing: pool,
        n: nSeed - pool.length,
        findings,
      });
      const ids = new Set(pool.map((idea) => idea.id));
      const clean = byId(extra).filter((idea) => !ids.has(idea.id));
      if (!clean.length) break;
      for (const idea of clean.slice(0, nSeed - pool.length)) {
        this.ctx.budget.check();
        pool.push(await this.agents.noveltyChecker.score(idea, { findings }));
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
    if (pool.length < nSeed) {
      this.transition("stage.seeds", `seeds.partial:${pool.length}`);
    }
    if (!this.state.seeds.length) throw new ScientificAbort("no_eligible_seeds");
  }

  private async baseline(): Promise<void> {
    progress(this.ctx, "§3.2 reproducing the baseline");
    this.ctx.budget.check();
    const baselineOk =
      !!this.state.baseline &&
      evidenceOk(this.state.baseline) &&
      Object.keys(this.state.baseline.metrics).length > 0;
    if (!baselineOk) {
      // A previous attempt may have recorded a failed subset baseline. Rerun
      // only that scope; a valid full baseline is still reusable.
      this.state.baseline = null;
      this.state.baseline = await this.agents.baselineCoder.reproduce({ scope: "subset" });
    }
    const fullOk =
      !!this.state.baselineFull &&
      evidenceOk(this.state.baselineFull) &&
      Object.keys(this.state.baselineFull.metrics).length > 0;
    if (!baselineOk || !fullOk) {
      this.state.baselineSource = baselineOk || fullOk ? "mixed" : "reproduced";
      this.state.baselinePath = "";
    }
    // Full baseline is lazy: measured by ensureBaselineFull() only when a
    // candidate first reaches the full protocol. A subset-only run therefore
    // never pays a full 954-step baseline measurement.
    this.ctx.scratch.baseline_full = fullOk ? this.state.baselineFull : null;
    const baseline = this.state.baseline;
    if (!baseline) throw new ScientificAbort("baseline_failed");
    this.ctx.scratch.baseline = baseline;
    // Persist the initial measurement into the project baseline store. Future
    // runs for this project reuse it even when no candidate was promoted.
    this.persistBaseline("subset", baseline, null);
    this.transition("stage.baseline", evidenceOk(baseline) ? "baseline.ok" : "baseline.bad", {
      metrics: baseline.metrics,
      source: this.state.baselineSource,
      ...(this.state.baselinePath ? { path: this.state.baselinePath } : {}),
    });
    if (!evidenceOk(baseline) || !Object.keys(baseline.metrics).length) {
      throw new ScientificAbort("baseline_failed");
    }
  }

  /**
   * Lazy full baseline. Called by IdeaImplementer immediately before the first
   * full candidate and by select on resume. A reused full baseline is returned
   * without an experiment; otherwise the authorized repo_ref snapshot is
   * measured once at the full protocol.
   */
  private async ensureBaselineFull(): Promise<Evidence> {
    const existing = this.state.baselineFull;
    if (existing && evidenceOk(existing) && Object.keys(existing.metrics).length > 0) {
      this.ctx.scratch.baseline_full = existing;
      return existing;
    }
    const cached = this.ctx.scratch.baseline_full as Evidence | undefined;
    if (cached && evidenceOk(cached) && Object.keys(cached.metrics).length > 0) {
      this.state.baselineFull = cached;
      return cached;
    }
    this.ctx.budget.check();
    const full = await this.agents.baselineCoder.reproduce({ scope: "full" });
    this.state.baselineFull = full;
    this.ctx.scratch.baseline_full = full;
    // Persist the lazy full measurement project-wide too.
    this.persistBaseline("full", full, null);
    if (this.state.baselineSource === "manual" || this.state.baselineSource === "incumbent") {
      this.state.baselineSource = "mixed";
    }
    this.transition("stage.baseline", evidenceOk(full) ? "baseline.full.ok" : "baseline.full.bad", {
      metrics: full.metrics,
      lazy: true,
    });
    if (!evidenceOk(full) || !Object.keys(full.metrics).length) {
      throw new ScientificAbort("baseline_failed");
    }
    return full;
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
    // Depth: one measured defect, one candidate, measured once. Breadth keeps
    // the original N0 seed batch and evolution rounds.
    const depth = this.depthSearch();
    await this.evaluate(this.state.nextSeeds(depth ? 1 : this.ctx.config.n0), 0);
    for (let round = 1; !depth && round <= this.ctx.config.maxRefineRounds; round++) {
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
    // Full-set candidates compare against the formal full baseline; a promoted
    // full candidate replaces it for later rounds, while state.baseline keeps
    // the original reproduced subset reference.
    const comparison = await this.ensureBaselineFull();
    const selected = await this.agents.selector.select(valid, { baseline: comparison });
    const evidence = selected.evidence.length ? selected.evidence[selected.evidence.length - 1] : null;
    const subset = [...selected.evidence].reverse().find((item) => item.scope === "subset") ?? null;
    this.transition("stage.select", `select:${selected.idea.id}`, { idea_id: selected.idea.id });
    if (!evidence || !(await this.adopt(selected.idea, evidence, comparison, "select"))) {
      throw new ScientificAbort("selection_not_better_than_baseline");
    }
    // §3.4 compares component removals against the subset control, never a full
    // 954-step run. Keep the candidate's last subset evidence alongside the
    // full incumbent.
    this.state.bestSubset = subset;
    // Promote the selected candidate's subset baseline too, so the project
    // store keeps one coherent incumbent instead of a promoted full scope
    // paired with the previous initial subset scope.
    if (subset && evidenceOk(subset)) {
      const prior = this.state.baseline;
      this.promoteBaseline("subset", subset, prior);
      this.state.baseline = subset;
      this.state.baselineSource = "promoted";
      this.transition("state.adopt", `adopt.select-subset:${selected.idea.id}`, {
        idea_id: selected.idea.id,
        metrics: subset.metrics,
        baseline_scope: "subset",
      });
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
      // A full refinement after select (meta) invalidates the subset control;
      // the ablation stage re-measures it from the new code.
      if (evidence.scope === "full" && reason !== "select") this.state.bestSubset = null;
      // Only a measured subset/full baseline is promoted. Ablation and other
      // local evidence updates the incumbent but must not replace a baseline.
      const scope: "subset" | "full" | null = evidence.scope === "full" ? "full" : evidence.scope === "subset" ? "subset" : null;
      const promotedPath = scope ? this.promoteBaseline(scope, evidence, base) : "";
      this.transition("state.adopt", `adopt.${reason}:${idea.id}`, {
        idea_id: idea.id,
        metrics: evidence.metrics,
        ...(scope ? { baseline_scope: scope } : {}),
        ...(promotedPath ? { baseline_path: promotedPath } : {}),
      });
    }
    return better;
  }

  private promoteBaseline(scope: "subset" | "full", evidence: Evidence, base: Evidence): string {
    if (scope === "full") this.state.baselineFull = evidence;
    else this.state.baseline = evidence;
    this.state.baselineSource = "promoted";
    return this.persistBaseline(scope, evidence, base);
  }

  /** A promoted candidate becomes the next baseline; persist it for reuse. */
  private persistBaseline(scope: "subset" | "full", evidence: Evidence, prior: Evidence | null): string {
    const file = incumbentFileFor(this.ctx.config.outDir, this.ctx.problem, scope);
    const protocol = protocolFingerprint(
      this.ctx.problem,
      this.ctx.problem.remote?.env ?? {},
      this.ctx.config.seed,
      scope,
    );
    const history = prior?.code?.commit
      ? [{ commit: prior.code.commit, metrics: prior.metrics, at: new Date().toISOString() }]
      : [];
    const ledger = ledgerFromEvidence(this.ctx.problem, scope, evidence, protocol, history);
    if (!ledger) return "";
    try {
      writeIncumbent(file, ledger);
      this.state.baselinePath = file;
      return file;
    } catch {
      // A ledger write is provenance, not the scientific gate; keep the run.
      return "";
    }
  }

  private async ablations(): Promise<Verdict> {
    progress(this.ctx, "§3.4 running subset component ablations");
    checkAborted(this.ctx);
    const [idea, full] = this.incumbent();
    // The control is the incumbent measured under the subset protocol. Reuse
    // the candidate's subset evidence when select captured it; after a full
    // refinement (meta) measure the new code at the same subset budget.
    const best = await this.incumbentSubset(idea, full);
    this.ctx.budget.check();
    this.state.ablationRound = 0;
    const plans = await this.agents.ablationPlanner.plan(idea, {
      best,
      n: this.ctx.config.nAblationPlans,
    });
    const results: AblationResult[] = [];
    for (const plan of byId(plans)) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      results.push(await this.agents.ablationCoder.runPlan(idea, plan, { best }));
    }
    this.state.ablations = results;
    const verdict = await this.agents.ablationCritic.judge(idea, results, { best });
    this.state.ablationVerdict = verdict;
    this.transition("stage.ablation", `ablation.${verdict.decision}`, { round: 0, verdict });
    if (!verdictAccepted(verdict)) {
      // Attribution is a subset-level diagnostic. Never launch a hidden full
      // 954-step refinement from this stage; the data gate decides the paper.
      this.transition("stage.ablation", "ablation.keep", { reason: "subset_only" });
    }
    return verdict;
  }

  /**
   * Measure the incumbent at the subset protocol when select did not leave a
   * usable subset control (resume, meta refinement). Same code, data, steps,
   * hyperparameters and seeds as the ablation variants.
   */
  private async incumbentSubset(idea: Idea, full: Evidence): Promise<Evidence> {
    if (this.state.bestSubset && evidenceOk(this.state.bestSubset)) return this.state.bestSubset;
    const seeds = subsetSeeds(this.ctx.config);
    const samples: SeedSample[] = [];
    for (const seed of seeds) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      this.ctx.budget.chargeExperiment();
      const result = await this.ctx.workspace.run(codeOf(full), "subset", idea, seed);
      samples.push({ seed, metrics: result.metrics, result });
    }
    const control = makeEvidence({
      idea_id: idea.id,
      scope: "subset",
      metrics: meanMetrics(samples),
      baseline_metrics: { ...full.baseline_metrics },
      code: full.code,
      result: samples.map((sample) => sample.result).find((item) => item?.status === "ok") ?? null,
      label: `${full.label}-subset-control`,
      samples,
    });
    this.state.bestSubset = control;
    return control;
  }

  private async draftAndReview(reviewerFeedback = ""): Promise<void> {
    progress(this.ctx, "§3.5 drafting and peer review");
    const [idea, best] = this.incumbent();
    this.state.peerRound = 0;
    this.state.reviewRefinements = 0;
    this.state.rebuttals = [];
    this.state.reviews = [];
    this.state.manuscript = await this.agents.initialDrafter.draft({
      idea,
      best,
      ablations: this.state.ablations,
      round: this.state.metaRound,
      reviewerFeedback,
    });
    await this.reviewPanel(0);
    while (
      !this.reviewsPass() &&
      this.state.peerRound < this.ctx.config.maxPeerRounds &&
      this.state.reviewRefinements < this.ctx.config.maxReviewRefinements
    ) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      // The aggregate review carries every reviewer's questions and weaknesses.
      const tasks = await this.agents.rebuttalPlanner.plan(this.state.review!, {
        n: Math.max(1, this.state.review!.questions.length),
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
        review: this.state.review!,
        rebuttal,
      });
      this.state.peerRound += 1;
      this.state.reviewRefinements += 1;
      await this.reviewPanel(this.state.peerRound);
    }
  }

  /** Call the independent panel and reduce it to the all-reviewer gate. */
  private async reviewPanel(round: number): Promise<void> {
    if (!this.state.manuscript) throw new ScientificAbort("missing_manuscript");
    const size = Math.max(1, this.ctx.config.reviewPanelSize);
    const reviews: Review[] = [];
    for (let reviewer = 0; reviewer < size; reviewer++) {
      this.ctx.budget.check();
      reviews.push(await this.agents.peerReviewer.review(this.state.manuscript, { round, reviewer }));
    }
    const unique = (items: string[]): string[] => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
    const score = Math.min(...reviews.map((review) => review.score));
    this.state.reviews = reviews;
    this.state.review = makeReview({
      manuscript_id: this.state.manuscript.id,
      strengths: unique(reviews.flatMap((review) => review.strengths)),
      weaknesses: unique(reviews.flatMap((review) => review.weaknesses)),
      questions: unique(reviews.flatMap((review) => review.questions)),
      score: Number.isFinite(score) ? score : 1,
      scale_max: this.ctx.config.reviewScaleMax,
      summary: `Panel minimum ${Number.isFinite(score) ? score : 1} across ${reviews.length} independent reviewers.`,
      round,
    });
    this.transition("stage.review", `peer.r${round}:${g(this.state.review.score)}`, {
      score: this.state.review.score,
      scores: reviews.map((review) => review.score),
      reviewers: reviews.length,
    });
  }

  private reviewsPass(): boolean {
    const size = Math.max(1, this.ctx.config.reviewPanelSize);
    return (
      this.state.reviews.length >= size &&
      this.state.reviews.every((review) => review.score >= this.ctx.config.reviewThreshold)
    );
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
