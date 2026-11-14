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
  type Refutation,
} from "../agents/ideas.ts";
import {
  MethodCodeAuditor,
  ReferenceAuditor,
  SpecAuditor,
  combine,
} from "../agents/integrity.ts";
import { LimitationExtractor, LimitationVerifier } from "../agents/limitations.ts";
import { MetaReviewer, PeerReviewer, RebuttalPlanner } from "../agents/review.ts";
import { StyleViolationError } from "../writing/style.ts";
import { InitialDrafter, PaperEnhancer } from "../agents/writing.ts";
import { BudgetExceeded } from "../runtime/budget.ts";
import { incumbentFileFor, ledgerFromEvidence, protocolFingerprint, writeIncumbent } from "../runtime/incumbent.ts";
import { runDiagnosis, type DiagnosisResult } from "../runtime/diagnosis.ts";
import { refreshLedgerFromContext } from "../runtime/ledger.ts";
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
  type DiagnosisFinding,
  type TraceCheckpoint,
  type Verdict,
  evidenceOk,
  evidenceProvenanceError,
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
  /** Candidate-ledger keys already written, so a resume does not duplicate rows. */
  private readonly journaled = new Set<string>();

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
      // An exhausted search is not the end of the science: a refuted pool seeds
      // another idea round (bounded by maxSeedRounds) before the run gives up.
      if (!resume || !this.state.searchDone || !this.state.goodTraces().length) {
        await this.ideaSearchWithReseeding();
      }
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
      // A paper that was already accepted is finished work; anything else
      // (missing, rejected, or an unaccepted resume) enters the bounded loop.
      const paperAccepted = resume && !!this.state.manuscript && !!this.state.review && this.state.metaReview?.decision === "accept";
      if (needsPaper && !paperAccepted) await this.paperLoop();
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        this.state.aborted = true;
        this.state.abortReason = error.message;
      } else if (error instanceof ScientificAbort) {
        this.state.aborted = ABORT_REASONS.has(error.message);
        if (this.state.aborted) this.state.abortReason = error.message;
        else this.state.exportReason = error.message;
      } else if (error instanceof StyleViolationError) {
        // A writing-contract failure is a run-level block, not a missing final
        // artifact. Preserve the baseline/diagnosis and make the run resumable.
        this.state.aborted = true;
        this.state.abortReason = "style_violation";
        this.transition("stage.abort", "style.violation", { message: error.message });
      } else if ((error as Error)?.name === "AbortError" || this.ctx.signal?.aborted) {
        // An interrupted run still needs a durable state/final pair. Do not
        // call integrity agents with an aborted signal; export what exists.
        this.state.aborted = true;
        const reason = this.ctx.signal?.reason;
        this.state.abortReason = reason === undefined ? "interrupted" : String(reason);
        this.transition("stage.abort", "run.interrupted", { reason: this.state.abortReason });
        return this.exportArtifacts(true);
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
    // Every transition is a new experiment datum; refresh the project ledger.
    refreshLedgerFromContext(this.ctx);
  }

  /** Run the target-declared read-only analysis on the reproduced baseline. */
  private async diagnose(): Promise<void> {
    if (!this.ctx.problem.diagnose_command) return;
    if (this.state.diagnosis?.findings.length) return;
    progress(this.ctx, "diagnose: measuring the baseline");
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
      const before = this.state.limitations.length;
      this.state.limitations = [...this.state.limitations, ...fresh].sort((a, b) => a.id.localeCompare(b.id));
      const verdict = await this.agents.limitationVerifier.verify(this.state.limitations, { round: index });
      const axes = new Set(
        this.state.limitations.map((item) => item.axis.trim().toLowerCase()).filter(Boolean),
      ).size;
      const sufficient =
        verdictAccepted(verdict) &&
        this.state.limitations.length >= this.ctx.config.minLimitations &&
        axes >= Math.min(3, this.ctx.config.minLimitations);
      this.transition(
        "stage.limitations",
        `limits.${sufficient ? "ok" : "refine"}:${this.state.limitations.length}`,
        { round: index, axes, verdict },
      );
      if (sufficient) return;
      // No new limitations after a full extraction round means the next round
      // can only duplicate the same set. Stop the loop instead of spending all
      // 16 rounds on an impossible axis-perfect set.
      if (this.state.limitations.length === before) {
        this.transition("stage.limitations", `limits.no-progress:${this.state.limitations.length}`, {
          round: index,
          axes,
          verdict,
        });
        throw new ScientificAbort("limitations_exhausted");
      }
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

  private async seedIdeas(round = 1): Promise<void> {
    progress(this.ctx, "§3.1 generating seed ideas");
    const findings = this.findings();
    // A resumed run may carry a previously over-extracted limitation set.
    // Keep the highest-severity bounded set; do not feed dozens of historical
    // limitations into every seed/novelty prompt.
    const maxLimitations = Math.max(this.ctx.config.minLimitations, 8);
    this.state.limitations = this.state.limitations
      .slice()
      .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))
      .slice(0, maxLimitations);
    const depth = this.depthSearch();
    // The config N_seed is the seed pool target in both policies. Depth mode
    // narrows the defect, not the number of ideas; otherwise one low-novelty
    // idea aborts the entire run before any experiment.
    const nSeed = Math.max(1, this.ctx.config.nSeed);
    const refuted = this.refutations();
    if (round > 1) {
      await this.seedAnotherRound(round, findings, refuted);
      return;
    }
    const initial = await this.agents.initialIdeaGenerator.generate(this.state.limitations, { findings, refuted });
    if (depth && initial.target_limitations.length === 0) {
      initial.target_limitations = [this.state.limitations.find((item) => /^D\d+$/.test(item.id))?.id ?? "D1"];
    }
    // Resume the pool a previous attempt already scored; never re-score it.
    const pool: Idea[] = this.state.ideaPool.length
      ? this.state.ideaPool.slice()
      : [await this.agents.noveltyChecker.score(initial, { findings })];
    this.state.ideaPool = pool.slice();
    this.persist();
    const attempts = Math.max(2 * this.ctx.config.nSeed, 1);
    for (let i = 0; i < attempts; i++) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      if (pool.length >= nSeed) break;
      const extra = await this.agents.ideaGenerator.generate({
        limitations: this.state.limitations,
        existing: pool,
        n: nSeed - pool.length,
        findings,
        refuted,
      });
      const ids = new Set(pool.map((idea) => idea.id));
      const clean = byId(extra).filter((idea) => !ids.has(idea.id));
      if (!clean.length) break;
      // Novelty scoring is independent per idea; parallelize the superagent
      // calls while retaining the deterministic byId order in the pool.
      const scored = await Promise.all(
        clean.slice(0, nSeed - pool.length).map(async (idea) => {
          this.ctx.budget.check();
          return this.agents.noveltyChecker.score(idea, { findings });
        }),
      );
      pool.push(...scored);
      // Persist the pool after every batch: a restart resumes scoring, not the
      // whole generation loop.
      this.state.ideaPool = pool.slice();
      this.persist();
    }
    let eligible = pool.filter(
      (idea) => idea.hypothesis.trim() && idea.novelty_score >= this.ctx.config.minNovelty,
    );
    if (!eligible.length && pool.length) {
      // The novelty score is a ranking signal when the pool is small. Keep the
      // best domain/guidance-qualified idea instead of returning zero seeds;
      // the subset/full measurements still decide whether it is adopted.
      const weak = filterByGuidance(pool.filter((idea) => idea.hypothesis.trim()), this.ctx.problem, this.ctx.config);
      if (weak.length) {
        eligible = weak;
        this.transition("stage.seeds", `seeds.weak:${weak.length}`, {
          minNovelty: this.ctx.config.minNovelty,
          best_novelty: Math.max(...weak.map((idea) => idea.novelty_score)),
        });
      }
    }
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

  /** Measured refutations: the evidence a new seed round must not repeat. */
  private refutations(): Refutation[] {
    return this.state.traces
      .filter((trace) => trace.decision !== "good" && !trace.invalid)
      .map((trace) => ({
        id: trace.idea.id,
        hypothesis: trace.idea.hypothesis,
        decision: trace.decision,
        feedback: trace.feedback,
        metrics: trace.evidence[trace.evidence.length - 1]?.metrics ?? {},
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * A round whose whole pool was refuted is a finding, not a stopping rule:
   * the generator must propose mechanisms that differ from the measured
   * failures. Rounds stay bounded so a dead end cannot spend without limit.
   */
  private async seedAnotherRound(round: number, findings: DiagnosisFinding[], refuted: Refutation[]): Promise<void> {
    const nSeed = Math.max(1, this.ctx.config.nSeed);
    const known = new Set<string>(this.state.evaluatedIds);
    for (const idea of this.state.seeds) known.add(idea.id);
    const existing = this.state.ideaPool.slice();
    const fresh = await this.agents.ideaGenerator.generate({
      limitations: this.state.limitations,
      existing,
      n: nSeed,
      findings,
      refuted,
    });
    // A generator may reuse an id for a different mechanism; the identity is
    // the hypothesis, so a colliding id is renamed instead of discarding the idea.
    const seenIds = new Set<string>([...known, ...existing.map((item) => item.id)]);
    const seenHypotheses = new Set(existing.map((item) => item.hypothesis.trim().toLowerCase()));
    const unseen: Idea[] = [];
    for (const idea of byId(fresh)) {
      const hypothesis = idea.hypothesis.trim();
      if (!hypothesis || seenHypotheses.has(hypothesis.toLowerCase())) continue;
      let id = idea.id;
      for (let suffix = 2; seenIds.has(id); suffix += 1) id = `${idea.id}r${round}${suffix > 2 ? suffix : ""}`;
      seenIds.add(id);
      seenHypotheses.add(hypothesis.toLowerCase());
      unseen.push({ ...idea, id, round });
    }
    const scored: Idea[] = [];
    for (const idea of unseen) {
      this.ctx.budget.check();
      scored.push(await this.agents.noveltyChecker.score(idea, { findings, round }));
    }
    const eligible = filterByGuidance(scored, this.ctx.problem, this.ctx.config).sort((a, b) => {
      const ar = -rankKey(a, this.ctx.config.guidanceWeight);
      const br = -rankKey(b, this.ctx.config.guidanceWeight);
      return ar === br ? a.id.localeCompare(b.id) : ar - br;
    });
    this.state.ideaPool = existing.concat(scored);
    this.state.seeds = eligible;
    this.transition("stage.seeds", `seeds.round:${round}`, {
      round,
      ids: eligible.map((idea) => idea.id),
      refuted: refuted.map((item) => item.id),
    });
    if (!eligible.length) this.transition("stage.seeds", `seeds.round:${round}.empty`, { round });
    this.persist();
  }

  private async ideaSearchWithReseeding(): Promise<void> {
    const maxRetries = Math.max(0, this.ctx.config.maxIdeaRetries);
    for (;;) {
      if (!this.state.searchDone) await this.ideaSearch();
      if (this.state.goodTraces().length) return;
      // The pool is exhausted: retry with fresh, non-overlapping ideas until
      // the problem's own retry budget is spent. Exhaustion never stops the
      // run on its own.
      if (this.state.ideaRetries >= maxRetries) throw new ScientificAbort("no_good_ideas");
      this.state.ideaRetries += 1;
      this.state.searchDone = false;
      this.transition("stage.seeds", `seeds.retry:${this.state.ideaRetries}`, {
        retry: this.state.ideaRetries,
        max_retry: maxRetries,
      });
      // The counter is durable: a resume continues the same retry budget.
      this.persist();
      await this.seedIdeas(this.state.ideaRetries + 1);
    }
  }

  private async baseline(): Promise<void> {
    this.ctx.budget.check();
    const baselineOk =
      !!this.state.baseline &&
      evidenceOk(this.state.baseline) &&
      Object.keys(this.state.baseline.metrics).length > 0;
    const fullOk =
      !!this.state.baselineFull &&
      evidenceOk(this.state.baselineFull) &&
      Object.keys(this.state.baselineFull.metrics).length > 0;
    progress(
      this.ctx,
      baselineOk && fullOk
        ? "§3.2 baseline ready (reused)"
        : baselineOk
          ? "§3.2 baseline ready (subset; full baseline lazy)"
          : "§3.2 measuring the baseline",
    );
    if (!baselineOk) {
      // A previous attempt may have recorded a failed subset baseline. Rerun
      // only that scope; a valid full baseline is still reusable.
      this.state.baseline = null;
      this.state.baseline = await this.agents.baselineCoder.reproduce({ scope: "subset" });
    }
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
      const resume = this.state.checkpointFor(idea.id);
      if (resume) {
        progress(
          this.ctx,
          `§3.2 round ${round}: ${idea.id} resumed at ${resume.stage} (${resume.trace.evidence.length} evidence)`,
        );
      }
      const trace = await this.agents.implementer.implement(idea, {
        round,
        resume: resume ?? undefined,
        onProgress: (checkpoint) => {
          this.state.checkpoint(checkpoint);
          this.journalCandidates(checkpoint);
          this.persist();
        },
      });
      await this.auditTrace(trace);
      this.state.record(trace);
      // An invalid implementation is UNKNOWN, not a scientific "bad" result.
      const outcome = trace.invalid ? "invalid" : trace.decision;
      this.transition("stage.round", `round${round}.${idea.id}:${outcome}`, {
        round,
        idea_id: idea.id,
        invalid: trace.invalid === true,
        trace,
      });
      progress(this.ctx, `§3.2 round ${round}: ${idea.id} → ${outcome}`);
    }
  }

  /**
   * Machine-readable candidate ledger: one line per measured seed, written as
   * soon as the measurement exists. state.json holds the same data, but a
   * ledger survives schema changes and is cheap to read after a restart.
   */
  private journalCandidates(checkpoint: TraceCheckpoint): void {
    // The critic may have rejected the aggregate even though one seed produced
    // finite numbers. An invalid verdict means this is not a candidate result.
    if (checkpoint.verdict?.invalid === true || checkpoint.trace.invalid === true) return;
    for (const evidence of checkpoint.trace.evidence) {
      // A failed execution or a parent-commit proxy is implementation evidence,
      // not a candidate measurement. Never pollute the scientific ledger with it.
      if (evidence.result?.status !== "ok") continue;
      if (evidenceProvenanceError(evidence)) continue;
      const commit = evidence.code?.commit ?? "";
      if (!commit) continue;
      if (evidence.code?.parent && commit === evidence.code.parent &&
        (evidence.scope === "subset" || evidence.scope === "ablation")) continue;
      const samples: Array<{ seed: number | null; metrics: Record<string, number> }> = evidence.samples?.length
        ? evidence.samples
        : [{ seed: null, metrics: evidence.metrics }];
      for (const [index, sample] of samples.entries()) {
        if (!sample.metrics || !Object.keys(sample.metrics).length) continue;
        // A mixed multi-seed aggregate must not journal a failed seed as a
        // candidate measurement. The run-level result may be `ok` because one
        // seed succeeded; every row still needs its own successful execution.
        const sampleResult = evidence.samples?.length ? evidence.samples[index]?.result : evidence.result;
        if (!sampleResult || sampleResult.status !== "ok") continue;
        const key = `${checkpoint.idea_id}|${commit}|${evidence.scope}|${sample.seed}|${evidence.label}`;
        if (this.journaled.has(key)) continue;
        this.journaled.add(key);
        this.ctx.store.appendJsonl("candidates.jsonl", {
          idea_id: checkpoint.idea_id,
          round: checkpoint.round,
          scope: evidence.scope,
          label: evidence.label,
          commit,
          parent: evidence.code?.parent ?? null,
          seed: sample.seed,
          metrics: sample.metrics,
          aggregate: evidence.metrics,
          baseline_metrics: evidence.baseline_metrics,
          stage: checkpoint.stage,
          verdict: checkpoint.verdict?.decision ?? null,
          feedback: checkpoint.verdict?.feedback ?? "",
        });
      }
    }
  }

  private async ideaSearch(): Promise<void> {
    progress(this.ctx, "§3.2 searching ideas");
    // Depth: one measured defect, one candidate, measured once. Breadth keeps
    // the original N0 seed batch and evolution rounds.
    const depth = this.depthSearch();
    // Depth mode selects one measured defect, not a single idea. Evaluate the
    // seed pool so one low-novelty idea cannot zero the run.
    await this.evaluate(this.state.nextSeeds(depth ? this.ctx.config.nSeed : this.ctx.config.n0), 0);
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
      // Evolved ideas are independent; score them concurrently.
      const scored: Idea[] = await Promise.all(
        byId(evolved).map(async (idea) => {
          this.ctx.budget.check();
          return this.agents.noveltyChecker.score(idea, { round });
        }),
      );
      const eligible = filterByGuidance(scored, this.ctx.problem, this.ctx.config);
      const evolvedIds = new Set(eligible.map((idea) => idea.id));
      const candidates = byId(eligible).concat(seeds.filter((idea) => !evolvedIds.has(idea.id)));
      await this.evaluate(candidates, round);
      if (!candidates.length) this.transition("stage.round", `round${round}.empty`, { round });
    }
    this.state.searchDone = true;
    this.persist();
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
    const plans = this.state.ablationPlans.length
      ? this.state.ablationPlans
      : await this.agents.ablationPlanner.plan(idea, {
          best,
          n: this.ctx.config.nAblationPlans,
        });
    if (!this.state.ablationPlans.length) {
      this.state.ablationPlans = byId(plans);
      this.persist();
    }
    const done = new Map(this.state.ablations.map((item) => [item.plan_id, item]));
    const results: AblationResult[] = [];
    for (const plan of byId(plans)) {
      checkAborted(this.ctx);
      this.ctx.budget.check();
      const existing = done.get(plan.id);
      if (existing) {
        results.push(existing);
        continue;
      }
      const measured = await this.agents.ablationCoder.runPlan(idea, plan, { best });
      // One ablation is a full measurement: record it before the next one runs.
      this.state.ablations = [...results, measured];
      this.persist();
      results.push(measured);
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
    // A persisted manuscript from an interrupted attempt is finished work: only
    // a meta refinement or a missing draft starts a new one.
    const redraft = Boolean(reviewerFeedback) || !this.state.manuscript;
    if (redraft) {
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
      // Keep the draft even if the host dies before the panel returns.
      this.persist();
    }
    await this.reviewPanel(redraft ? 0 : this.state.peerRound);
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
        // A rebuttal is a real measurement: keep it even if the host dies now.
        this.persist();
        if (
          evidence.result?.status === "ok" &&
          evidenceOk(evidence) &&
          Object.keys(evidence.metrics).length &&
          !evidenceProvenanceError(evidence)
        ) {
          rebuttal.push(evidence);
        }
      }
      if (!rebuttal.length) {
        this.transition("stage.review", "peer.no_evidence");
        break;
      }
      this.state.manuscript = await this.agents.paperEnhancer.enhance({
        manuscript: this.state.manuscript as Manuscript,
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
    const manuscript = this.state.manuscript;
    // Reviewers are independent superagents evaluating the same frozen
    // manuscript. Run the whole panel concurrently; the aggregate below keeps
    // reviewer order deterministic.
    const reviews: Review[] = await Promise.all(
      Array.from({ length: size }, async (_unused, reviewer) => {
        this.ctx.budget.check();
        return this.agents.peerReviewer.review(manuscript, { round, reviewer });
      }),
    );
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

  /**
   * §3.5–§3.6 paper loop. An unaccepted manuscript is not terminal: the
   * critiques seed another draft and another review, up to maxPaperRetries.
   * The retry counter is persisted so a resume does not restart the budget.
   */
  private async paperLoop(): Promise<void> {
    if (!this.state.manuscript || !this.state.review) await this.draftAndReview();
    for (;;) {
      if (!this.state.metaReview) await this.metaReview();
      const accepted = this.state.metaReview?.decision === "accept" && (this.state.review?.score ?? 0) >= this.ctx.config.reviewThreshold;
      if (accepted) return;
      if (this.state.paperRetries >= Math.max(0, this.ctx.config.maxPaperRetries)) return;
      this.state.paperRetries += 1;
      this.transition("stage.paper", `paper.retry:${this.state.paperRetries}`, {
        retry: this.state.paperRetries,
        max_retry: this.ctx.config.maxPaperRetries,
        reason: this.state.exportReason || this.state.metaReview?.decision || "not_accepted",
      });
      // The critique is spent once it has been answered by a revision.
      const critique = this.state.metaReview?.critique ?? "";
      this.state.metaReview = null;
      this.state.metaRound = 0;
      this.persist();
      await this.reviseAndReview(critique);
    }
  }

  /**
   * Paper-loop revision: the manuscript is enhanced against its review and the
   * meta critique, then the panel re-reviews the same paper. The identity of
   * the draft is preserved; only its content and evidence change.
   */
  private async reviseAndReview(feedback: string): Promise<void> {
    const manuscript = this.state.manuscript;
    if (!manuscript) throw new ScientificAbort("missing_manuscript");
    this.ctx.budget.check();
    this.state.manuscript = await this.agents.paperEnhancer.enhance({
      manuscript,
      review: this.state.review ?? makeReview({
        manuscript_id: manuscript.id,
        strengths: [],
        weaknesses: [],
        questions: [],
        score: 0,
      }),
      rebuttal: this.state.rebuttals.slice(),
      feedback,
    });
    // The revised paper gets a fresh panel; the previous rounds are spent.
    this.state.peerRound = 0;
    this.state.reviewRefinements = 0;
    this.state.reviews = [];
    this.state.review = null;
    this.transition("stage.paper", "paper.revised", { manuscript_id: this.state.manuscript.id });
    this.persist();
    await this.reviewPanel(0);
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
    const manuscript = this.state.manuscript;
    // The two integrity auditors are independent superagents over the same
    // frozen manuscript. Run them together, then record traces in stable order.
    const outcomes = await Promise.all(
      (["reference_auditor", "method_code_auditor"] as const).map(async (name) => {
        try {
          let report: IntegrityReport;
          if (name === "reference_auditor") {
            report = await this.agents.referenceAuditor.audit(manuscript);
          } else {
            let diff = "";
            const baseline = this.state.baseline;
            if (baseline?.code && this.state.bestCode) {
              diff = await this.ctx.workspace.diff(baseline.code, this.state.bestCode);
            }
            report = await this.agents.methodCodeAuditor.audit(manuscript, {
              diff,
              evidence: this.state.bestEvidence,
            });
          }
          return { name, report, error: null, budgetExceeded: false };
        } catch (error) {
          if ((error as Error)?.name === "AbortError") throw error;
          return {
            name,
            report: {
              score_verified: false,
              spec_violations: [],
              ref_violations: [],
              method_code_alignment: 0,
              checked_claims: 0,
              notes: [`${name} unavailable: ${(error as Error).name}`],
            } as IntegrityReport,
            error: error as Error,
            budgetExceeded: error instanceof BudgetExceeded,
          };
        }
      }),
    );
    for (const outcome of outcomes) {
      reports.push(outcome.report);
      if (outcome.error) {
        this.ctx.traces.append("integrity", { agent: outcome.name, error: outcome.error.name });
        if (outcome.budgetExceeded) {
          this.state.aborted = true;
          this.state.abortReason = outcome.error.message;
        }
      } else {
        this.ctx.traces.append("integrity", { agent: outcome.name, report: outcome.report });
      }
    }
    return combine(...reports);
  }

  private async exportArtifacts(interrupted = false): Promise<FinalArtifacts> {
    let accepted =
      !this.state.aborted &&
      this.state.review !== null &&
      this.state.review.score >= this.ctx.config.reviewThreshold &&
      this.state.metaReview !== null &&
      this.state.metaReview.decision === "accept";
    // Interruption must be exportable even when the signal is already aborted.
    const integrity = interrupted ? combine() : await this.exportIntegrity();
    const clean =
      !integrity.spec_violations.length &&
      !integrity.ref_violations.length &&
      integrity.score_verified &&
      integrity.method_code_alignment >= 0.5;
    accepted = accepted && clean;
    const extra: Record<string, unknown> = { accepted, ...(interrupted ? { interrupted: true } : {}) };
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
