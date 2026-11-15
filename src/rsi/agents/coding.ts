/** §3.2/§3.4 — snapshot coders and the bounded unified implementer. */

import { createHash } from "node:crypto";
import { crc32 } from "../crc32.ts";
import { stableString } from "../json.ts";
import {
  AblationPatch,
  BaselinePatch,
  FullSetPatch,
  ImplementationInstruction,
  ImplementationAudit,
  IndependentTests,
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
  type TraceCheckpoint,
  clampMetric,
  makeEvidence,
  makeTrace,
} from "../types.ts";
import { BaseAgent, type AgentContext } from "./base.ts";
import { BudgetExceeded } from "../runtime/budget.ts";
import { testIdentity } from "../runtime/checks.ts";
import { SpecAuditor } from "./integrity.ts";
import { LLMError } from "../providers/base.ts";
import { askUnifiedDiff, reviewChunks } from "./patch.ts";
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
    if (result.status !== "ok") break;
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

/**
 * A diff the workspace refused to apply is a broken implementation, not a code
 * change. Recording it as failed evidence keeps the parent commit out of the
 * candidate slot and sends the idea into the repair loop instead.
 */
export function unappliedEvidence(idea: Idea, scope: Scope, base: Evidence, message: string): Evidence {
  return makeEvidence({
    idea_id: idea.id,
    scope,
    metrics: {},
    baseline_metrics: { ...base.metrics },
    code: codeOf(base),
    result: {
      status: "failed",
      metrics: {},
      log_path: "",
      stdout: "",
      stderr: `patch does not apply: ${message}`,
      wall_time_s: 0,
    },
    label: `${idea.id}-${scope}-unapplied`,
    samples: [],
  });
}

/** Convert a rejected patch into failed evidence for every coder scope. */
export function rejectedEvidence(idea: Idea, scope: Scope, base: Evidence, error: unknown): Evidence {
  return unappliedEvidence(idea, scope, base, (error as Error)?.message ?? String(error));
}

/** Review the committed modules and their entry-point integration. */
export class ImplementationVerifier extends BaseAgent {
  readonly NAME = "implementation_verifier";
  readonly task = "code.verify";
  readonly role = "coding";

  async verify(idea: Idea, repo: RepoRef, scope: Scope) {
    const implementationScope = scope === "subset" || scope === "full";
    const key = createHash("sha256").update(stableString({
      version: 6,
      commit: repo.commit,
      scope: implementationScope ? "implementation" : scope,
      mechanism: idea.mechanism,
      hypothesis: idea.hypothesis,
      validation: repo.validation,
      intervention: implementationScope ? "" : repo.patch,
    })).digest("hex");
    const cachePath = `checks/implementation-cache/${key}.json`;
    try {
      return ImplementationAudit.parse(this.ctx.store.readJson(cachePath));
    } catch {
      // Missing or malformed reports require a fresh source review.
    }
    const sources = this.ctx.workspace.reviewSources?.(repo);
    const source = sources
      ? sources.map((file) => `FILE ${file.path} trusted_test=${file.trustedTest}\n${file.text}`).join("\n\n")
      : this.ctx.workspace.brief?.(repo, `${idea.mechanism} entrypoint forward train`, 24000) ?? "";
    if (!source.trim()) {
      return { decision: "engineer" as const, modules: [], tests: [], findings: ["Committed module source is unavailable."], test_gaps: [] };
    }
    const pieces = sources
      ? sources.flatMap((file) => reviewChunks(file.text, 15000).map((chunk, index) =>
          `FILE ${file.path} trusted_test=${file.trustedTest} part=${index + 1}\n${chunk}`))
      : reviewChunks(`${source}\nINTERVENTION PATCH\n${repo.patch}`);
    if (sources && repo.patch) pieces.push(...reviewChunks(repo.patch, 15000).map((chunk) => `INTERVENTION PATCH\n${chunk}`));
    const chunks: string[] = [];
    for (const piece of pieces) {
      const previous = chunks.length - 1;
      if (previous >= 0 && chunks[previous].length + piece.length + 2 <= 16000) chunks[previous] += `\n\n${piece}`;
      else chunks.push(piece);
    }
    const modules: string[] = [], tests: string[] = [], findings: string[] = [], testGaps: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const part = await this.ask(ImplementationAudit, {
        user: "Review the committed implementation and trusted independent tests. Map mechanisms to path:symbol evidence. " +
          "Check entry-point integration, interfaces, tensor dimensions and state/cache handling. " +
          "Record exact test path::Class::test_name identities for mechanism assertions, boundary cases and real entry-point execution. " +
          "Training methods also need forward, gradient, parameter-update and checkpoint-reload assertions. " +
          "Count only trusted_test=true assertions as independent test evidence. Never count inline tests in mutable source. " +
          "Review this chunk only. Put implementation defects in findings and missing test assertions in test_gaps. " +
          "Leave evidence arrays empty when absent from this chunk. " +
          "Task-specification auditing runs separately. For ablation/rebuttal verify the intervention in the patch.\n" +
          stableString({ idea, scope, commit: repo.commit, chunk: index + 1, chunks: chunks.length }) +
          `\nCOMMITTED SOURCE\n${chunk}`,
        meta: { idea_id: idea.id, scope, commit: repo.commit, chunk: index + 1, chunks: chunks.length },
      });
      modules.push(...part.modules);
      tests.push(...part.tests);
      findings.push(...part.findings);
      testGaps.push(...part.test_gaps);
      if (part.decision === "engineer" && !part.findings.length && !part.test_gaps.length) findings.push("Source review requests engineering repair.");
    }
    if (!modules.length) findings.push("Module implementation evidence is missing.");
    if (sources) {
      const trustedPaths = sources.filter((file) => file.trustedTest).map((file) => `${file.path}:`);
      if (!tests.length || tests.some((item) => !trustedPaths.some((prefix) => item.startsWith(prefix)))) {
        testGaps.push("Independent test assertions for the mechanism and entry point are missing or untrusted.");
      } else {
        const coverage = await this.ask(ImplementationAudit, {
          user: "Verify that this collected source/test evidence covers every requested mechanism, real entry point and boundary case. " +
            "Training changes require forward, gradient, parameter-update and checkpoint-reload assertions. " +
            "Put concrete missing assertions in test_gaps when coverage is incomplete.\n" + stableString({ idea, modules, tests }),
          meta: { idea_id: idea.id, scope, commit: repo.commit, coverage: true },
        });
        findings.push(...coverage.findings);
        testGaps.push(...coverage.test_gaps);
        if (coverage.decision === "engineer" && !coverage.findings.length && !coverage.test_gaps.length) testGaps.push("Independent test coverage is incomplete.");
      }
    }
    const audit = { decision: findings.length || testGaps.length ? "engineer" as const : "good" as const,
      modules: [...new Set(modules)], tests: [...new Set(tests)], findings: [...new Set(findings)], test_gaps: [...new Set(testGaps)] };
    this.ctx.store.writeJson(cachePath, audit);
    return audit;
  }
}

class IndependentTestAuthor extends BaseAgent {
  readonly NAME = "independent_test_author";
  readonly task = "code.tests";
  readonly role = "coding";

  async supplement(idea: Idea, repo: RepoRef, scope: Scope, gaps: string[]) {
    const sources = this.ctx.workspace.reviewSources?.(repo) ?? [];
    const output = await this.ask(IndependentTests, {
      system: "You independently author CPU contract tests from the research requirements. Return complete pytest files only. " +
        "Preserve the intended behavior when the candidate is wrong. Never weaken assertions to match candidate outputs. " +
        "Do not alter source, baseline tests, evaluation protocols, or dependencies. Never skip tests or use xfail. " +
        "Use tiny local fixtures and temporary directories. Require numerical or behavioral assertions through real entry points. " +
        "Training changes require backward, nonzero finite gradients, parameter updates and save/reload equivalence. " +
        "For native code, exercise its real entry points through a temporary harness and assert its results. " +
        "Use repository-relative paths from Path.cwd() for project files, since tests live under .rsi/validation. " +
        "Tests must check the requested intervention for ablation or rebuttal scopes.",
      user: stableString({ problem: this.ctx.problem, idea, scope, gaps, sources }),
      meta: { idea_id: idea.id, commit: repo.commit, scope },
    });
    return output.files;
  }
}

/** Run target-owned checks after patch; a required failure is not a candidate. */
export function checkFailedEvidence(
  idea: Idea,
  scope: Scope,
  repo: RepoRef,
  base: Evidence,
  message: string,
  reportPath = "",
): Evidence {
  return makeEvidence({
    idea_id: idea.id,
    scope,
    metrics: {},
    baseline_metrics: { ...base.metrics },
    code: repo,
    result: {
      metrics: {},
      status: "failed",
      log_path: "",
      stdout: "",
      stderr: `deterministic checks failed: ${message}`,
      wall_time_s: 0,
    },
    label: `${repo.label}-check-failed`,
    samples: [],
    check_report: reportPath || undefined,
  });
}

export async function checkRejection(
  ctx: AgentContext,
  idea: Idea,
  scope: Scope,
  base: Evidence,
  repo: RepoRef,
  label: string,
): Promise<Evidence | null> {
  if (ctx.config.runner === "simulated") return null;
  if (!ctx.workspace.check) return checkFailedEvidence(idea, scope, repo, base, "target checks are unavailable");
  const started = Date.now();
  let sourceSeconds = 0;
  let checkSeconds = 0;
  try {
    const requirement = createHash("sha256").update(stableString({ mechanism: idea.mechanism, hypothesis: idea.hypothesis,
      scope: scope === "subset" || scope === "full" ? "implementation" : scope })).digest("hex").slice(0, 32);
    if (repo.validation?.requirement !== requirement) delete repo.validation;
    let audit = await new ImplementationVerifier(ctx).verify(idea, repo, scope);
    if (label !== "resume" && audit.test_gaps.length && !audit.findings.length && ctx.workspace.addTests) {
      const files = await new IndependentTestAuthor(ctx).supplement(idea, repo, scope, audit.test_gaps);
      const previous = repo.commit;
      Object.assign(repo, await ctx.workspace.addTests(repo, files, requirement));
      ctx.traces.append("independent_tests", { source_commit: previous, commit: repo.commit, ...repo.validation });
      audit = await new ImplementationVerifier(ctx).verify(idea, repo, scope);
    }
    const checkLabel = `${label}-${repo.commit ?? "uncommitted"}`;
    const auditPath = ctx.store.writeJson(`checks/${checkLabel.replace(/[^a-zA-Z0-9_.-]+/g, "-")}/implementation.json`, {
      commit: repo.commit, scope, ...audit,
    });
    ctx.traces.append("implementation_audit", { commit: repo.commit, scope, report_path: auditPath, ...audit });
    if (audit.decision !== "good") {
      return checkFailedEvidence(idea, scope, repo, base, stableString(audit), auditPath);
    }
    if (base.code && ctx.workspace.diff) {
      const diff = await ctx.workspace.diff(base.code, repo);
      const specification = await new SpecAuditor(ctx).audit(idea, { evidence: { ...base, code: repo, result: null }, diff });
      ctx.store.writeJson(`checks/${checkLabel.replace(/[^a-zA-Z0-9_.-]+/g, "-")}/specification.json`, specification);
      if (specification.spec_violations.length) return checkFailedEvidence(idea, scope, repo, base, specification.spec_violations.join("\n"), auditPath);
    }
    sourceSeconds = (Date.now() - started) / 1000;
    const checkStarted = Date.now();
    const report = await ctx.workspace.check(repo, checkLabel);
    checkSeconds = (Date.now() - checkStarted) / 1000;
    const expectedEnvironment = ctx.scratch.expected_check_environment;
    if (expectedEnvironment && report.environment_fingerprint !== expectedEnvironment) {
      return checkFailedEvidence(idea, scope, repo, base, "execution environment differs from recorded measurements; resume requires fresh measurements", report.report_path);
    }
    if (report.environment_fingerprint) ctx.scratch.check_environment = report.environment_fingerprint;
    if (report.status === "ok") {
      const recordedTests = report.checks.filter((check) => check.severity === "required" && check.kind !== "syntax" && !check.empty_suite);
      if (!recordedTests.length || recordedTests.some((check) => check.status !== "ok" || !check.executed_tests?.length)) {
        return checkFailedEvidence(idea, scope, repo, base, "Required tests have no execution evidence", report.report_path);
      }
      const executed = recordedTests.flatMap((check) => check.executed_tests ?? []).map(testIdentity);
      const missing = audit.tests.filter((item) => {
        const expected = testIdentity(item);
        return !executed.some((test) => test === expected || test.startsWith(`${expected}[`));
      });
      if (missing.length) return checkFailedEvidence(idea, scope, repo, base, `Reviewed assertions did not execute: ${missing.join(", ")}`, report.report_path);
      if (!report.environment_fingerprint && ctx.workspace.preflight) {
        return checkFailedEvidence(idea, scope, repo, base, "Actual check environment fingerprint is unavailable", report.report_path);
      }
      repo.check_environment = report.environment_fingerprint;
      return null;
    }
    const failed = report.checks.filter((check) => check.severity === "required" && check.status !== "ok");
    const detail = failed.map((check) => [
      `${check.id}:${check.status}:exit=${check.exit_code}`,
      `stdout\n${check.stdout.slice(-6000)}`,
      `stderr\n${check.stderr.slice(-6000)}`,
    ].join("\n")).join("\n");
    return checkFailedEvidence(idea, scope, repo, base, detail || report.status, report.report_path);
  } catch (error) {
    if (error instanceof BudgetExceeded || (error as Error)?.name === "AbortError" || ctx.signal?.aborted) throw error;
    return checkFailedEvidence(idea, scope, repo, base, (error as Error)?.message ?? String(error));
  } finally {
    ctx.traces.append("delivery_timing", { commit: repo.commit, scope,
      source_s: sourceSeconds || (Date.now() - started) / 1000, checks_s: checkSeconds, total_s: (Date.now() - started) / 1000 });
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
    let repo;
    try {
      repo = await this.ctx.workspace.writePatch(codeOf(opts.base), patch, `${idea.id}-${scope}`);
    } catch (error) {
      return rejectedEvidence(idea, scope, opts.base, error);
    }
    const checkFailure = await checkRejection(this.ctx, idea, scope, opts.base, repo, `${idea.id}-${scope}`);
    if (checkFailure) return checkFailure;
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
      allowEmpty: true,
      user:
        `${stableString(idea)}\n\nReturn a unified diff against this snapshot that scales the validated change ` +
        `to the full benchmark without changing the method. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id },
    });
    // A full-set measurement may legitimately re-use the subset commit when
    // only the protocol/budget changes. An explicit empty patch is allowed;
    // non-empty prose or a malformed diff is still rejected.
    const patch = out.patch.trim()
      ? `${out.patch}\nHypothesis: ${idea.hypothesis}\nMechanism: ${idea.mechanism}\n`
      : "";
    let repo;
    try {
      repo = await this.ctx.workspace.writePatch(codeOf(opts.subset), patch, `${idea.id}-full`, { allowEmpty: true });
    } catch (error) {
      return rejectedEvidence(idea, "full", opts.subset, error);
    }
    const checkFailure = await checkRejection(this.ctx, idea, "full", opts.subset, repo, `${idea.id}-full`);
    if (checkFailure) return checkFailure;
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
    let repo;
    try {
      repo = await this.ctx.workspace.writePatch(codeOf(opts.best), patch, `${idea.id}-ablation-${plan.id}`);
    } catch (error) {
      return {
        plan_id: plan.id,
        component: plan.component,
        metrics: {},
        evidence: rejectedEvidence(idea, "ablation", opts.best, error),
        ok: false,
      };
    }
    const checkFailure = await checkRejection(this.ctx, idea, "ablation", opts.best, repo, `${idea.id}-ablation-${plan.id}`);
    if (checkFailure) {
      return { plan_id: plan.id, component: plan.component, metrics: {}, evidence: checkFailure, ok: false };
    }
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
      allowEmpty: true,
      user:
        `${stableString(idea)}\n${stableString(task)}\n\nReturn a unified diff that implements the ` +
        `supplementary experiment without changing the core method. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id, task_id: task.id },
    });
    let repo;
    try {
      const patch = out.patch.trim() ? `${out.patch}\n${stableString(task)}\n` : "";
      repo = await this.ctx.workspace.writePatch(
        codeOf(opts.best),
        patch,
        `${idea.id}-rebuttal-${task.id}`,
        { allowEmpty: true },
      );
    } catch (error) {
      return rejectedEvidence(idea, "rebuttal", opts.best, error);
    }
    const checkFailure = await checkRejection(this.ctx, idea, "rebuttal", opts.best, repo, `${idea.id}-rebuttal-${task.id}`);
    if (checkFailure) return checkFailure;
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

  async implement(
    idea: Idea,
    opts: { round?: number; resume?: TraceCheckpoint; onProgress?: (progress: TraceCheckpoint) => void } = {},
  ): Promise<Trace> {
    const round = opts.round ?? 0;
    const resume = opts.resume && (opts.resume.idea_id === idea.id || opts.resume.trace.idea.parent_ids.includes(idea.id)) ? opts.resume : null;
    // A resumed idea keeps its measured evidence and its spent budgets; only the
    // unfinished step runs again (and the measurement cache makes it cheap).
    const instruction = resume
      ? { instruction: "resumed from checkpoint" }
      : await this.ask(ImplementationInstruction, {
          user: stableString(idea),
          meta: { idea_id: idea.id, round },
        });
    this.log("implementation_instruction", { idea_id: idea.id, instruction: instruction.instruction });

    let baseline = this.ctx.scratch.baseline as Evidence | undefined;
    if (!baseline) {
      baseline = await this.baselineCoder.reproduce({ scope: "subset" });
      this.ctx.scratch.baseline = baseline;
    }
    const trace = resume ? resume.trace : makeTrace({ idea, round });
    const state: TraceCheckpoint = resume ?? {
      idea_id: idea.id,
      round,
      trace,
      stage: "subset",
      verdict: null,
      subset_rounds: 0,
      subset_repairs: 0,
      full_rounds: 0,
      full_repairs: 0,
    };
    trace.seed_id ??= state.idea_id;
    if (!resume) trace.idea = idea;
    else idea = trace.idea;
    const checkpoint = () => {
      state.trace = trace;
      state.idea_id = state.idea_id || idea.id;
      trace.decision = state.verdict?.decision === "good" ? "good" : "bad";
      trace.feedback = state.verdict?.feedback ?? "";
      opts.onProgress?.(state);
    };
    const baselineFailed =
      (baseline.result && baseline.result.status !== "ok") ||
      (baseline.samples ?? []).some((sample) => sample.result && sample.result.status !== "ok");
    if (baselineFailed) {
      trace.feedback = "Baseline reproduction failed; candidate cannot be compared.";
      trace.lessons.push(trace.feedback);
      // A failed reference is an infrastructure failure, not a refuted idea.
      trace.invalid = true;
      return trace;
    }

    const perStage = this.ctx.config.engineeringBudgetScope === "per_stage";
    const budget = this.ctx.config.maxEngRounds;
    const maxRepairs = this.ctx.config.maxRepairs;
    let current = state.trace.evidence.length ? state.trace.evidence[state.trace.evidence.length - 1] : null;
    let verdict = state.verdict;

    if (state.stage === "subset") {
      if (!current || !verdict) {
        current = await this.subsetCoder.implement(idea, { base: baseline, seeds: subsetSeeds(this.ctx.config) });
        trace.evidence.push(current);
        verdict = await this.subsetCritic.judge(current, { baseline });
        state.verdict = verdict;
        trace.lessons.push(verdict.feedback);
        checkpoint();
      }
      while (verdict.decision === "engineer") {
        // Evidence is the durable record: one completed pass per item. If a
        // checkpoint lost a counter update, that pass still counts against the
        // budget, so one idea can never keep refining on a stale counter.
        state.subset_rounds = Math.max(
          state.subset_rounds,
          Math.max(0, trace.evidence.length - 1 - state.subset_repairs),
        );
        // Invalid execution (patch, command or output contract) is a repair, not
        // a scientific engineering round. It is separately bounded so a broken
        // implementation cannot consume maxEngRounds.
        if (verdict.invalid) {
          if (state.subset_repairs >= maxRepairs) break;
          state.subset_repairs += 1;
        } else {
          if (state.subset_rounds >= budget) break;
          state.subset_rounds += 1;
        }
        current = await this.subsetEngineer.refine(idea, { evidence: current, feedback: verdict.feedback });
        trace.evidence.push(current);
        verdict = await this.subsetCritic.judge(current, { baseline });
        state.verdict = verdict;
        trace.lessons.push(verdict.feedback);
        checkpoint();
      }
      if (!verdict || verdict.decision !== "good") {
        trace.feedback = verdict?.feedback ?? "subset evidence missing";
        trace.decision = "bad";
        trace.invalid = verdict?.invalid === true;
        state.stage = "done";
        checkpoint();
        return trace;
      }
      state.stage = "full";
      state.verdict = null;
      checkpoint();
    }

    // The full baseline is lazy: measure it before the first full candidate so
    // a subset-only run never pays for a 954-step baseline.
    const fullBaseline = this.ctx.ensureBaselineFull
      ? await this.ctx.ensureBaselineFull()
      : ((this.ctx.scratch.baseline_full as Evidence | undefined) ?? baseline);
    if (!current) {
      throw new Error(`no subset evidence to scale for ${idea.id}`);
    }
    const totalAttempts = () => (perStage ? state.full_rounds : state.subset_rounds + state.full_rounds);
    if (!state.verdict || !current.baseline_metrics || Object.keys(current.baseline_metrics).length === 0) {
      current = await this.fullSetCoder.scale(idea, { subset: current });
      current = { ...current, baseline_metrics: { ...fullBaseline.metrics } };
      trace.evidence.push(current);
      state.verdict = await this.fullCritic.judge(current, {
        baseline: fullBaseline,
        attempts: totalAttempts(),
      });
      trace.lessons.push(state.verdict.feedback);
      checkpoint();
    }
    let verdictFull = state.verdict;
    while (verdictFull.decision === "engineer") {
      state.full_rounds = Math.max(
        state.full_rounds,
        Math.max(0, trace.evidence.length - 1 - state.full_repairs - state.subset_rounds - state.subset_repairs - 1),
      );
      if (verdictFull.invalid) {
        if (state.full_repairs >= maxRepairs) break;
        state.full_repairs += 1;
      } else {
        if (perStage ? state.full_rounds >= budget : state.subset_rounds + state.full_rounds >= budget) break;
        state.full_rounds += 1;
      }
      const refined = await this.fullEngineer.refine(idea, {
        evidence: current,
        feedback: verdictFull.feedback,
        reason: "full",
      });
      idea = refined.idea;
      current = refined.evidence;
      trace.idea = idea;
      trace.evidence.push(current);
      verdictFull = await this.fullCritic.judge(current, {
        baseline: fullBaseline,
        attempts: totalAttempts(),
      });
      state.verdict = verdictFull;
      trace.lessons.push(verdictFull.feedback);
      checkpoint();
    }
    trace.decision = verdictFull.decision === "good" ? "good" : "bad";
    trace.feedback = verdictFull.feedback;
    trace.invalid = verdictFull.invalid === true && verdictFull.decision !== "good";
    state.stage = "done";
    checkpoint();
    return trace;
  }
}
