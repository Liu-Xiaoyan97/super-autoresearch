/** §3.2/§3.4 — snapshot coders and the bounded unified implementer. */

import { crc32 } from "../crc32.ts";
import { stableString } from "../json.ts";
import {
  AblationPatch,
  BaselinePatch,
  FullSetPatch,
  ImplementationInstruction,
  RebuttalPatch,
  SubsetPatch,
} from "../schemas.ts";
import {
  type AblationPlan,
  type AblationResult,
  type Evidence,
  type ExperimentResult,
  type Idea,
  type MetricSpec,
  type RebuttalTask,
  type SeedSample,
  type RepoRef,
  type Scope,
  type Trace,
  clampMetric,
  makeEvidence,
  makeTrace,
} from "../types.ts";
import { BaseAgent, type AgentContext } from "./base.ts";
import { LLMError } from "../providers/base.ts";
import { askUnifiedDiff } from "./patch.ts";
import { FullSetCritic, SubsetCritic } from "./critics.ts";
import { FullSetEngineer, SubsetEngineer } from "./engineering.ts";

export function codeOf(evidence: Evidence): RepoRef {
  if (!evidence.code) throw new Error("execution requires a code snapshot");
  return evidence.code;
}

export function componentContribution(component: string): number {
  const key = crc32(component || "component");
  if (key % 5 === 0) return 0;
  return 0.02 + (key % 90) / 1000;
}

export function isDeadComponent(idea: Idea, plan: AblationPlan): boolean {
  const ideaKey = crc32(idea.mechanism || idea.id);
  const componentKey = crc32(plan.component || plan.id);
  return ideaKey % 4 === 0 && componentKey % 5 === 0;
}

function clampSpec(value: number, spec: MetricSpec): number {
  return clampMetric(value, spec);
}

/** Independent seeds for the subset screen; full/rebuttal stay single-seed. */
export function subsetSeeds(config: { seed: number; subsetSeeds: number }): number[] {
  const count = Math.max(1, Math.trunc(config.subsetSeeds) || 1);
  return Array.from({ length: count }, (_, index) => config.seed + index);
}

/** Mean over the seeds that reported a finite value for each metric. */
export function meanMetrics(samples: SeedSample[]): Record<string, number> {
  const sums: Record<string, { total: number; count: number }> = {};
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample.metrics)) {
      if (!Number.isFinite(value)) continue;
      const item = sums[name] ?? { total: 0, count: 0 };
      item.total += value;
      item.count += 1;
      sums[name] = item;
    }
  }
  const out: Record<string, number> = {};
  for (const [name, item] of Object.entries(sums)) out[name] = item.total / item.count;
  return out;
}

/** Run one subset candidate with every screen seed and aggregate its metrics. */
export async function runSeeded<T extends { run(repo: any, scope: any, idea?: any, seed?: number): Promise<ExperimentResult> }>(
  runner: T,
  repo: any,
  idea: Idea | null,
  seeds: number[],
  charge: () => void,
  scope: Scope = "subset",
): Promise<{ metrics: Record<string, number>; samples: SeedSample[]; result: ExperimentResult | null }> {
  const samples: SeedSample[] = [];
  let result: ExperimentResult | null = null;
  for (const seed of seeds) {
    charge();
    result = await runner.run(repo, scope, idea, seed);
    samples.push({ seed, metrics: result.metrics, result });
  }
  return { metrics: meanMetrics(samples), samples, result };
}

export class BaselineCoder extends BaseAgent {
  readonly NAME = "baseline_coder";
  readonly task = "code.baseline";
  readonly role = "coding";

  async reproduce(opts: { scope?: Scope } = {}): Promise<Evidence> {
    const requestedScope = opts.scope ?? "subset";
    // The baseline is the authorized snapshot itself, never a model patch.
    // Keep the task ticket/report as the protocol audit point, but ignore its
    // patch: the measured code is always the latest commit at repo_ref.
    try {
      await this.ask(BaselinePatch, {
        user:
          "This task reproduces the baseline from the problem's authorized repository snapshot. " +
          "The snapshot at the problem's repo_ref is the unmodified reference. Use it as-is: " +
          "do not explore or modify the repository, and do not invent code. " +
          'Return {"patch":""}. A baseline patch is never applied.\n\n' +
          stableString(this.ctx.problem),
        meta: { scope: requestedScope },
      });
    } catch (error) {
      // A worker that cannot answer must not block the deterministic base-commit
      // run. Blocked reports, aborts and budget errors still propagate.
      const message = (error as Error)?.message ?? String(error);
      if (!(error instanceof LLMError) || /reported blocked\b/.test(message)) throw error;
      this.log("baseline.patch.skipped", { reason: message.slice(0, 500) });
    }
    let repo = await this.ctx.workspace.baselineRepo();
    repo = await this.ctx.workspace.writePatch(repo, "", `baseline-${requestedScope}`);
    let result: ExperimentResult | null = null;
    let samples: SeedSample[] = [];
    let metrics: Record<string, number> = {};
    if (requestedScope === "subset") {
      const measured = await runSeeded(
        this.ctx.workspace,
        repo,
        null,
        subsetSeeds(this.ctx.config),
        () => this.ctx.budget.chargeExperiment(),
      );
      metrics = measured.metrics;
      samples = measured.samples;
      result = measured.samples.map((sample) => sample.result).find((item) => item?.status === "ok") ?? measured.result;
    } else {
      this.ctx.budget.chargeExperiment();
      result = await this.ctx.workspace.run(repo, requestedScope);
      metrics = result.metrics;
      samples = [{ seed: this.ctx.config.seed, metrics: result.metrics, result }];
    }
    const evidence = makeEvidence({
      idea_id: "baseline",
      scope: requestedScope,
      metrics,
      code: repo,
      result,
      label: repo.label,
      samples,
    });
    if (requestedScope === "subset") this.ctx.scratch.baseline = evidence;
    else this.ctx.scratch.baseline_full = evidence;
    return evidence;
  }
}

export class SubsetCoder extends BaseAgent {
  readonly NAME = "subset_coder";
  readonly task = "code.subset";
  readonly role = "coding";

  async implement(idea: Idea, opts: { base: Evidence; scope?: Scope; seeds?: number[] }): Promise<Evidence> {
    const scope = opts.scope ?? "subset";
    const brief = this.ctx.workspace.brief?.(codeOf(opts.base), `${idea.mechanism} ${idea.hypothesis}`) ?? "";
    const out = await askUnifiedDiff(this, SubsetPatch, {
      user:
        `${stableString(idea)}\n\nReturn a unified diff against this snapshot that implements the mechanism. ` +
        `Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id },
    });
    const patch = `${out.patch}\nHypothesis: ${idea.hypothesis}\nMechanism: ${idea.mechanism}\n`;
    const repo = await this.ctx.workspace.writePatch(codeOf(opts.base), patch, `${idea.id}-${scope}`);
    const seeds = scope === "subset" ? (opts.seeds ?? [this.ctx.config.seed]) : [this.ctx.config.seed];
    const measured = await runSeeded(
      this.ctx.workspace,
      repo,
      idea,
      seeds,
      () => this.ctx.budget.chargeExperiment(),
      scope,
    );
    return makeEvidence({
      idea_id: idea.id,
      scope,
      metrics: measured.metrics,
      baseline_metrics: { ...opts.base.metrics },
      code: repo,
      result: measured.samples.map((sample) => sample.result).find((item) => item?.status === "ok") ?? measured.result,
      label: repo.label,
      samples: measured.samples,
    });
  }
}

export class FullSetCoder extends BaseAgent {
  readonly NAME = "full_set_coder";
  readonly task = "code.full";
  readonly role = "coding";

  async scale(idea: Idea, opts: { subset: Evidence }): Promise<Evidence> {
    const brief = this.ctx.workspace.brief?.(codeOf(opts.subset), `${idea.mechanism} ${idea.hypothesis}`) ?? "";
    const out = await askUnifiedDiff(this, FullSetPatch, {
      user:
        `${stableString(idea)}\n\nReturn a unified diff against this snapshot that scales the validated change ` +
        `to the full benchmark without changing the method. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id },
    });
    const patch = `${out.patch}\nHypothesis: ${idea.hypothesis}\nMechanism: ${idea.mechanism}\n`;
    const repo = await this.ctx.workspace.writePatch(codeOf(opts.subset), patch, `${idea.id}-full`);
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, "full", idea);
    return makeEvidence({
      idea_id: idea.id,
      scope: "full",
      metrics: result.metrics,
      baseline_metrics: { ...opts.subset.baseline_metrics },
      code: repo,
      result,
      label: repo.label,
    });
  }
}

export class AblationCoder extends BaseAgent {
  readonly NAME = "ablation_coder";
  readonly task = "code.ablation";
  readonly role = "ablation";

  async runPlan(idea: Idea, plan: AblationPlan, opts: { best: Evidence }): Promise<AblationResult> {
    const brief = this.ctx.workspace.brief?.(codeOf(opts.best), `${idea.mechanism} ${plan.component}`) ?? "";
    const out = await askUnifiedDiff(this, AblationPatch, {
      user:
        `${stableString(idea)}\n${stableString(plan)}\n\nReturn a unified diff that performs only this ` +
        `component intervention. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id, plan_id: plan.id },
    });
    const patch = `${out.patch}\nMechanism: ${idea.mechanism}\n${stableString(plan)}\n`;
    const repo = await this.ctx.workspace.writePatch(codeOf(opts.best), patch, `${idea.id}-ablation-${plan.id}`);
    // Same subset data, 95-step budget, hyperparameters and seeds as the
    // candidate subset control; never a full 954-step run.
    const measured = await runSeeded(
      this.ctx.workspace,
      repo,
      idea,
      subsetSeeds(this.ctx.config),
      () => this.ctx.budget.chargeExperiment(),
      "ablation",
    );
    const metrics = this.applyComponentModel(idea, plan, opts.best, { ...measured.metrics });
    const result = measured.samples.map((sample) => sample.result).find((item) => item?.status === "ok") ?? measured.result;
    if (result && stableString(metrics) !== stableString(measured.metrics)) result.metrics = metrics;
    const evidence = makeEvidence({
      idea_id: idea.id,
      scope: "ablation",
      metrics,
      baseline_metrics: { ...opts.best.metrics },
      code: repo,
      result,
      label: plan.id,
      samples: measured.samples,
    });
    const ok = measured.samples.length > 0 && measured.samples.every((sample) => sample.result?.status === "ok");
    return { plan_id: plan.id, component: plan.component, metrics, evidence, ok };
  }

  applyComponentModel(
    idea: Idea,
    plan: AblationPlan,
    best: Evidence,
    metrics: Record<string, number>,
  ): Record<string, number> {
    if (this.ctx.config.runner !== "simulated" || !Object.keys(best.metrics).length) return metrics;
    let contribution = componentContribution(plan.component || plan.id);
    if (isDeadComponent(idea, plan)) contribution = 0;
    // A dead component's removal is a no-op: it must match the subset control,
    // not the raw simulated run. This is the negative-control case the critic
    // should reject as "no measured contribution".
    if (contribution <= 0) return { ...best.metrics };
    const out = { ...metrics };
    for (const spec of this.ctx.problem.metrics) {
      const base = best.metrics[spec.name];
      if (base === undefined) continue;
      const factor = spec.direction === "max" ? 1 - contribution : 1 + contribution;
      out[spec.name] = clampSpec(base * factor, spec);
    }
    return out;
  }
}

export class RebuttalCoder extends BaseAgent {
  readonly NAME = "rebuttal_coder";
  readonly task = "code.rebuttal";
  readonly role = "rebuttal";

  async runTask(idea: Idea, task: RebuttalTask, opts: { best: Evidence }): Promise<Evidence> {
    const brief = this.ctx.workspace.brief?.(codeOf(opts.best), `${idea.mechanism} ${task.question}`) ?? "";
    const out = await askUnifiedDiff(this, RebuttalPatch, {
      user:
        `${stableString(idea)}\n${stableString(task)}\n\nReturn a unified diff that implements the ` +
        `supplementary experiment without changing the core method. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id, task_id: task.id },
    });
    const repo = await this.ctx.workspace.writePatch(
      codeOf(opts.best),
      `${out.patch}\n${stableString(task)}\n`,
      `${idea.id}-rebuttal-${task.id}`,
    );
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, "rebuttal", idea);
    return makeEvidence({
      idea_id: idea.id,
      scope: "rebuttal",
      metrics: result.metrics,
      baseline_metrics: { ...opts.best.metrics },
      code: repo,
      result,
      label: task.id,
    });
  }
}

export class IdeaImplementer extends BaseAgent {
  readonly NAME = "idea_implementer";
  readonly task = "code.implement";
  readonly role = "coding";

  private readonly subsetCritic: SubsetCritic;
  private readonly fullCritic: FullSetCritic;
  private readonly subsetEngineer: SubsetEngineer;
  private readonly fullEngineer: FullSetEngineer;
  private readonly baselineCoder: BaselineCoder;
  private readonly subsetCoder: SubsetCoder;
  private readonly fullSetCoder: FullSetCoder;

  constructor(
    ctx: AgentContext,
    deps: {
      subsetCritic: SubsetCritic;
      fullCritic: FullSetCritic;
      subsetEngineer: SubsetEngineer;
      fullEngineer: FullSetEngineer;
      baselineCoder: BaselineCoder;
      subsetCoder: SubsetCoder;
      fullSetCoder: FullSetCoder;
    },
  ) {
    super(ctx);
    this.subsetCritic = deps.subsetCritic;
    this.fullCritic = deps.fullCritic;
    this.subsetEngineer = deps.subsetEngineer;
    this.fullEngineer = deps.fullEngineer;
    this.baselineCoder = deps.baselineCoder;
    this.subsetCoder = deps.subsetCoder;
    this.fullSetCoder = deps.fullSetCoder;
  }

  async implement(idea: Idea, opts: { round?: number } = {}): Promise<Trace> {
    const round = opts.round ?? 0;
    const instruction = await this.ask(ImplementationInstruction, {
      user: stableString(idea),
      meta: { idea_id: idea.id, round },
    });
    this.log("implementation_instruction", { idea_id: idea.id, instruction: instruction.instruction });

    let baseline = this.ctx.scratch.baseline as Evidence | undefined;
    if (!baseline) {
      baseline = await this.baselineCoder.reproduce({ scope: "subset" });
      this.ctx.scratch.baseline = baseline;
    }
    const trace = makeTrace({ idea, round });
    const baselineFailed =
      (baseline.result && baseline.result.status !== "ok") ||
      (baseline.samples ?? []).some((sample) => sample.result && sample.result.status !== "ok");
    if (baselineFailed) {
      trace.feedback = "Baseline reproduction failed; candidate cannot be compared.";
      trace.lessons.push(trace.feedback);
      return trace;
    }

    let current = await this.subsetCoder.implement(idea, { base: baseline, seeds: subsetSeeds(this.ctx.config) });
    trace.evidence.push(current);
    let verdict = await this.subsetCritic.judge(current, { baseline });
    trace.lessons.push(verdict.feedback);

    const perStage = this.ctx.config.engineeringBudgetScope === "per_stage";
    const budget = this.ctx.config.maxEngRounds;
    const maxRepairs = this.ctx.config.maxRepairs;
    let subsetUsed = 0;
    let subsetRepairs = 0;
    while (verdict.decision === "engineer") {
      // Invalid execution (patch, command or output contract) is a repair, not
      // a scientific engineering round. It is separately bounded so a broken
      // implementation cannot consume maxEngRounds.
      if (verdict.invalid) {
        if (subsetRepairs >= maxRepairs) break;
        subsetRepairs += 1;
      } else {
        if (subsetUsed >= budget) break;
        subsetUsed += 1;
      }
      current = await this.subsetEngineer.refine(idea, { evidence: current, feedback: verdict.feedback });
      trace.evidence.push(current);
      verdict = await this.subsetCritic.judge(current, { baseline });
      trace.lessons.push(verdict.feedback);
    }
    if (verdict.decision !== "good") {
      trace.feedback = verdict.feedback;
      trace.decision = "bad";
      return trace;
    }

    // The full baseline is lazy: measure it before the first full candidate so
    // a subset-only run never pays for a 954-step baseline.
    const fullBaseline = this.ctx.ensureBaselineFull
      ? await this.ctx.ensureBaselineFull()
      : ((this.ctx.scratch.baseline_full as Evidence | undefined) ?? baseline);
    current = await this.fullSetCoder.scale(idea, { subset: current });
    current = { ...current, baseline_metrics: { ...fullBaseline.metrics } };
    trace.evidence.push(current);

    let fullUsed = 0;
    let fullRepairs = 0;
    const totalAttempts = () => (perStage ? fullUsed : subsetUsed + fullUsed);
    verdict = await this.fullCritic.judge(current, {
      baseline: fullBaseline,
      attempts: totalAttempts(),
    });
    trace.lessons.push(verdict.feedback);
    while (verdict.decision === "engineer") {
      if (verdict.invalid) {
        if (fullRepairs >= maxRepairs) break;
        fullRepairs += 1;
      } else {
        if (perStage ? fullUsed >= budget : subsetUsed + fullUsed >= budget) break;
        fullUsed += 1;
      }
      const refined = await this.fullEngineer.refine(idea, {
        evidence: current,
        feedback: verdict.feedback,
        reason: "full",
      });
      idea = refined.idea;
      current = refined.evidence;
      trace.idea = idea;
      trace.evidence.push(current);
      verdict = await this.fullCritic.judge(current, {
        baseline: fullBaseline,
        attempts: totalAttempts(),
      });
      trace.lessons.push(verdict.feedback);
    }
    trace.decision = verdict.decision === "good" ? "good" : "bad";
    trace.feedback = verdict.feedback;
    return trace;
  }
}
