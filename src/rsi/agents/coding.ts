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
  type Idea,
  type MetricSpec,
  type RebuttalTask,
  type RepoRef,
  type Scope,
  type Trace,
  clampMetric,
  makeEvidence,
  makeTrace,
} from "../types.ts";
import { BaseAgent, type AgentContext } from "./base.ts";
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

export class BaselineCoder extends BaseAgent {
  readonly NAME = "baseline_coder";
  readonly task = "code.baseline";
  readonly role = "coding";

  async reproduce(opts: { scope?: Scope } = {}): Promise<Evidence> {
    const requestedScope = opts.scope ?? "subset";
    const out = await this.ask(BaselinePatch, {
      user: stableString(this.ctx.problem),
      meta: { scope: requestedScope },
    });
    let repo = await this.ctx.workspace.baselineRepo();
    repo = await this.ctx.workspace.writePatch(repo, out.patch, `baseline-${requestedScope}`);
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, requestedScope);
    const evidence = makeEvidence({
      idea_id: "baseline",
      scope: requestedScope,
      metrics: result.metrics,
      code: repo,
      result,
      label: repo.label,
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

  async implement(idea: Idea, opts: { base: Evidence }): Promise<Evidence> {
    const brief = this.ctx.workspace.brief?.(codeOf(opts.base), `${idea.mechanism} ${idea.hypothesis}`) ?? "";
    const out = await askUnifiedDiff(this, SubsetPatch, {
      user:
        `${stableString(idea)}\n\nReturn a unified diff against this snapshot that implements the mechanism. ` +
        `Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id },
    });
    const patch = `${out.patch}\nHypothesis: ${idea.hypothesis}\nMechanism: ${idea.mechanism}\n`;
    const repo = await this.ctx.workspace.writePatch(codeOf(opts.base), patch, `${idea.id}-subset`);
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, "subset", idea);
    return makeEvidence({
      idea_id: idea.id,
      scope: "subset",
      metrics: result.metrics,
      baseline_metrics: { ...opts.base.metrics },
      code: repo,
      result,
      label: repo.label,
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
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, "ablation", idea);
    const metrics = this.applyComponentModel(idea, plan, opts.best, { ...result.metrics });
    if (stableString(metrics) !== stableString(result.metrics)) result.metrics = metrics;
    const evidence = makeEvidence({
      idea_id: idea.id,
      scope: "ablation",
      metrics,
      baseline_metrics: { ...opts.best.metrics },
      code: repo,
      result,
      label: plan.id,
    });
    return { plan_id: plan.id, component: plan.component, metrics, evidence, ok: result.status === "ok" };
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
    if (contribution <= 0) return metrics;
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
    if (baseline.result && baseline.result.status !== "ok") {
      trace.feedback = "Baseline reproduction failed; candidate cannot be compared.";
      trace.lessons.push(trace.feedback);
      return trace;
    }

    let current = await this.subsetCoder.implement(idea, { base: baseline });
    trace.evidence.push(current);
    let verdict = await this.subsetCritic.judge(current, { baseline });
    trace.lessons.push(verdict.feedback);

    const perStage = this.ctx.config.engineeringBudgetScope === "per_stage";
    const budget = this.ctx.config.maxEngRounds;
    let subsetUsed = 0;
    while (verdict.decision === "engineer" && subsetUsed < budget) {
      subsetUsed += 1;
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

    current = await this.fullSetCoder.scale(idea, { subset: current });
    const fullBaseline = (this.ctx.scratch.baseline_full as Evidence | undefined) ?? baseline;
    current = { ...current, baseline_metrics: { ...fullBaseline.metrics } };
    trace.evidence.push(current);

    let fullUsed = 0;
    const totalAttempts = () => (perStage ? fullUsed : subsetUsed + fullUsed);
    verdict = await this.fullCritic.judge(current, {
      baseline: fullBaseline,
      attempts: totalAttempts(),
    });
    trace.lessons.push(verdict.feedback);
    while (
      verdict.decision === "engineer" &&
      (perStage ? fullUsed < budget : subsetUsed + fullUsed < budget)
    ) {
      fullUsed += 1;
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
