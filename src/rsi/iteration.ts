/** One bounded, paired optimization iteration; deliberately not the paper SOP.
 *
 * The target owns training, checkpoint save/reload and evaluation. RSI only
 * invokes its unchanged command contract at two git snapshots. No project
 * adapter, metric surrogate, full-scope run, ablation or manuscript lives here.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isolateSmokeRemote, validateAdapterReport } from "./adapter-smoke.ts";

import { type AgentContext, checkAborted, progress } from "./agents/base.ts";
import { SubsetCoder } from "./agents/coding.ts";
import { ResultComparison } from "./agents/critics.ts";
import { InitialIdeaGenerator } from "./agents/ideas.ts";
import { SpecAuditor } from "./agents/integrity.ts";
import { defaultConfig, modelRoute, type Config } from "./config.ts";
import { LLMProvider, type LLMRequest, type LLMResponse } from "./providers/base.ts";
import { assertRunId, loadProblem, newRunId } from "./run.ts";
import {
  incumbentFileFor, loadIncumbent, protocolFingerprint, writeIncumbent, type IncumbentLedger,
} from "./runtime/incumbent.ts";
import { Budget, BudgetExceeded } from "./runtime/budget.ts";
import { ArtifactStore, TraceStore, type TraceRecord } from "./runtime/store.ts";
import {
  GitWorkspace, RemoteRunner, SubprocessRunner, evidenceFromResult, extractUnifiedDiff,
  type Runner, type Workspace,
} from "./runtime/workspace.ts";
import type { Evidence, Idea, Problem, RepoRef, Verdict } from "./types.ts";

export interface IterationOptions {
  problem: string | Problem;
  /** Inject the session's PiLLMProvider; no provider/authentication is constructed here. */
  provider: LLMProvider;
  cwd?: string;
  outDir?: string;
  runId?: string;
  seed?: number;
  model?: string;
  codingModel?: string;
  /** Optional explicit output cap for every role; omitted inherits native Pi/model policy. */
  maxTokens?: number;
  /** Optional coding override; omitted inherits the global override or native Pi/model policy. */
  codingMaxTokens?: number;
  /** subset (cheap screen) or full (formal protocol). Default subset. */
  scope?: "subset" | "full";
  configOverrides?: Partial<Config>;
  /** Immutable environment overlay for BOTH target invocations, including training budgets. */
  env?: Record<string, string>;
  /** Repo-relative files/directories/globs, additional to the baseline adapter manifest. */
  protectedPaths?: string[];
  maxLlmCalls?: number;
  maxWallTimeS?: number;
  /** Each experiment gets the same timeout, capped by the overall wall budget. */
  experimentTimeoutS?: number;
  /**
   * reuse: measure only the candidate and compare against the stored incumbent.
   * paired: re-measure the baseline every iteration (noise/drift control).
   * A missing, invalid or protocol-mismatched incumbent falls back to measured.
   */
  baselineMode?: "reuse" | "paired";
  /** Incumbent ledger path; default <outDir>/incumbent-<problem>.json. */
  incumbentPath?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Test seam only. Omit in production to use GitWorkspace's real RemoteRunner/subprocess. */
  runner?: Runner;
}

export interface IterationResult {
  runId: string;
  root: string;
  status: "executed" | "failed";
  executed: boolean;
  accepted: boolean;
  promoted: boolean;
  baselineSource: "measured" | "incumbent";
  incumbentPath: string;
  outcome: "accepted" | "rejected" | "error";
  baseline: Evidence | null;
  candidate: Evidence | null;
  candidateRepo: RepoRef | null;
  idea: Idea | null;
  diff: string;
  verdict: Verdict | null;
  errors: string[];
  summary: Record<string, unknown>;
  records: TraceRecord[];
}

// Budget's legacy SOP accounting stops AT its limits. This mode permits exactly
// the advertised number of calls/runs, while still refusing an additional one.
class IterationBudget extends Budget {
  override chargeLlm(n = 1): void {
    if (this.llmCalls + n > this.maxLlmCalls) throw new BudgetExceeded(`max_llm_calls=${this.maxLlmCalls}`);
    super.chargeLlm(n);
  }
  override chargeExperiment(n = 1): void {
    if (this.experiments + n > this.maxExperiments) throw new BudgetExceeded(`max_experiments=${this.maxExperiments}`);
    super.chargeExperiment(n);
  }
  override exhausted(): string | null {
    if (this.llmCalls > this.maxLlmCalls) return `max_llm_calls=${this.maxLlmCalls}`;
    if (this.experiments > this.maxExperiments) return `max_experiments=${this.maxExperiments}`;
    if (this.elapsed >= this.maxWallTimeS) return `max_wall_time_s=${this.maxWallTimeS}`;
    return null;
  }
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error}`);
  return result.stdout;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
  return value;
}

function protectedPattern(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`protected path must be repo-relative: ${value}`);
  }
  return normalized;
}

function matchesProtected(file: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return file === pattern || file.startsWith(`${pattern}/`);
  // Small, dependency-free glob matcher. ** spans directories; * does not.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\u0001").replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*").replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*").replaceAll("\u0001", "(?:.*/)?");
  return new RegExp(`^${escaped}$`).test(file);
}

const EXECUTABLE_SOURCE = /\.(py|ts|tsx|js|jsx|mjs|cjs|rs|go|c|cc|cpp|h|cu|sh)$/i;

function protections(problem: Problem, baseline: RepoRef, explicit: string[], env: Record<string, string>, seed: number): { protectedPaths: string[]; allowedFiles: string[]; declaredMutable: boolean } {
  const entries = git(baseline.path, ["ls-tree", "-r", "-z", baseline.commit!]).split("\0").filter(Boolean)
    .map(entry => { const [header, name] = entry.split("\t"); return { mode: header.split(" ")[0], name }; });
  const tracked = entries.map(entry => entry.name);
  const mutable: string[] = [];
  let declaredMutable = false;
  const paths = new Set([
    ".rsi", "run_experiment.py", "tests", "test", "data", "datasets", "tokenizer", "tokenizers",
    "eval", "evaluation", "evaluators", "lm_eval", "metrics", "protocol", "protocols", "configs", "config", "stages", "stage",
    "vocab.json", "vocab.txt", "merges.txt", ...explicit,
  ]);
  // The baseline manifest is authoritative, never the mutable source checkout.
  let manifests = 0;
  for (const name of tracked.filter((name) => name === ".rsi/adapter.json" || /^\.rsi\/.*\/adapter\.json$/.test(name) || /^\.rsi\/adapter\/[^/]+\.json$/.test(name))) {
    const manifest = JSON.parse(git(baseline.path, ["show", `${baseline.commit}:${name}`]));
    if (!Array.isArray(manifest.protected_paths) || !manifest.protected_paths.length || manifest.protected_paths.some((p: unknown) => typeof p !== "string")) {
      throw new Error(`${name}: protected_paths must be a nonempty string array`);
    }
    manifests++;
    if (Object.hasOwn(manifest, "mutable_paths")) {
      declaredMutable = true;
      if (!Array.isArray(manifest.mutable_paths) || !manifest.mutable_paths.length || manifest.mutable_paths.some((p: unknown) => typeof p !== "string")) {
        throw new Error(`${name}: mutable_paths must be a nonempty string array`);
      }
      for (const file of manifest.mutable_paths) mutable.push(protectedPattern(file));
    }
    if (manifest.env_prefix !== undefined) {
      if (typeof manifest.env_prefix !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(manifest.env_prefix)) throw new Error(`${name}: invalid env_prefix`);
      const key = `${manifest.env_prefix}_SEED`;
      if (env[key] !== undefined && env[key] !== String(seed)) throw new Error(`requested seed conflicts with ${key}`);
      env[key] = String(seed);
    }
    for (const file of manifest.protected_paths) paths.add(file);
  }
  if (!manifests) throw new Error("iteration requires a committed target adapter manifest with nonempty protected_paths");
  if (env.RSI_SEED !== undefined && env.RSI_SEED !== String(seed)) throw new Error("requested seed conflicts with RSI_SEED");
  env.RSI_SEED = String(seed);
  // Protect scripts named by the generic command (including {repo}/path).
  for (const token of problem.experiment_command ?? []) {
    const relative = token.replaceAll("{repo}/", "").replace(`${path.resolve(problem.repo!)}/`, "");
    for (const file of tracked) {
      if (relative === file || relative.endsWith(`=${file}`) || relative.includes(` ${file}`)) paths.add(file);
    }
  }
  // Conventional evaluator/metric/tokenizer/data-protocol files are immutable
  // even if the target has not yet supplied a complete manifest.
  for (const file of tracked) {
    if (/(^|\/)([^/]*(?:eval|metric|tokeniz)[^/]*|data(?:set|loader|_protocol)?[^/]*)\.(?:py|sh|js|ts|json|ya?ml|toml)$/i.test(file)) paths.add(file);
  }
  const protectedPaths = [...paths].map(protectedPattern).sort();
  const allowedFiles = entries.filter(entry => /^100(?:644|755)$/.test(entry.mode) && EXECUTABLE_SOURCE.test(entry.name) &&
    !protectedPaths.some(pattern => matchesProtected(entry.name, pattern)) &&
    (!declaredMutable || mutable.some(pattern => matchesProtected(entry.name, pattern)))).map(entry => entry.name);
  if (declaredMutable && !allowedFiles.length) throw new Error("mutable_paths declares no unprotected executable source files");
  // Manifest order expresses source priority; legacy manifests retain tracked-file order.
  if (declaredMutable) allowedFiles.sort((a, b) => mutable.findIndex(p => matchesProtected(a, p)) - mutable.findIndex(p => matchesProtected(b, p)));
  return { protectedPaths, allowedFiles, declaredMutable };
}

/** Bounded mode only: complete allowed source bodies, never protected protocol contents.
 * Read git objects at the pinned baseline, not the caller's possibly dirty checkout.
 */
function iterationBrief(baseline: RepoRef, files: string[], protocol: Record<string, unknown>, maxChars = 48_000): string {
  const preface = `COMMITTED ALLOWED SOURCE at ${baseline.commit}\n` +
    "Choose a minimal code-local executable change supported by the visible current APIs. Preserve fixed configuration, parameter budget and checkpoint compatibility. " +
    "Do not invent new trainable parameters or require protected config edits. Protected files are read-only; their contents are intentionally omitted. " +
    "Prefer the smallest change that stays finite under fp16 autocast: guard every division by a value that can approach zero, and avoid unproven rescaling of kernels or gradients.\n" +
    `IMMUTABLE PROTOCOL: ${JSON.stringify(protocol)}\nAllowed executable paths: ${JSON.stringify(files)}\n`;
  const omitted = "\n[TRUNCATED: remaining context exceeds the bounded source budget; omitted files are NOT complete.]\n";
  if (preface.length + omitted.length > maxChars) return preface.slice(0, maxChars - omitted.length) + omitted;
  let text = preface;
  for (const file of files) {
    const body = git(baseline.path, ["show", `${baseline.commit}:${file}`]);
    const header = `\n--- ${file} (${body.length} chars) ---\n`;
    const end = `\n[END COMPLETE FILE: ${file}]\n`;
    if (text.length + header.length + body.length + end.length + omitted.length <= maxChars) {
      text += header + body + end;
    } else {
      const label = `\n[TRUNCATED FILE: ${file}; full size ${body.length} chars; NOT complete.]\n` + omitted;
      const room = Math.max(0, maxChars - text.length - header.length - label.length);
      if (text.length + header.length + label.length <= maxChars) text += header + body.slice(0, room) + label;
      else text += omitted;
      break;
    }
  }
  return text;
}

/** Run exactly baseline subset + ONE changed candidate subset, or fail closed.
 * Failed/invalid candidates never trigger a retry experiment. An executed but
 * rejected result is successful execution, NOT a claim of scientific progress.
 * The caller retains ownership of the injected provider (it is not closed).
 */
export async function runIteration(opts: IterationOptions): Promise<IterationResult> {
  const cwd = opts.cwd ?? process.cwd();
  const source = typeof opts.problem === "string" ? loadProblem(opts.problem, cwd) : opts.problem;
  // Clone the protocol so neither caller mutation nor candidate code can change it.
  const problem: Problem = structuredClone(source);
  if (!problem.repo || !problem.repo_ref || !problem.experiment_command?.length) {
    throw new Error("iteration requires an external repo, explicit repo_ref and experiment_command");
  }
  problem.repo = path.resolve(cwd, problem.repo);
  if (!problem.metrics.length || !problem.subset_datasets.length) {
    throw new Error("iteration requires explicit metrics and subset_datasets");
  }
  const maxTokens = opts.maxTokens ?? opts.configOverrides?.modelRoutes?.default?.maxTokens;
  const codingMaxTokens = opts.codingMaxTokens ?? opts.maxTokens ?? opts.configOverrides?.modelRoutes?.coding?.maxTokens ?? maxTokens;
  for (const [name, value] of [["maxTokens", maxTokens], ["codingMaxTokens", codingMaxTokens]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} must be a positive safe integer`);
  }
  // No user-facing LLM/wall flags for the bounded flow: it is a fixed pipeline.
  // The internal values are safety stops far above actual use (2-4 calls), and
  // the experiment timeout comes from the fixture's own remote limit.
  const runScope = opts.scope ?? "subset";
  if (runScope !== "subset" && runScope !== "full") throw new Error('iteration scope must be "subset" or "full"');
  const maxLlmCalls = positive(opts.maxLlmCalls ?? opts.configOverrides?.maxLlmCalls ?? 64, "maxLlmCalls");
  if (!Number.isInteger(maxLlmCalls)) throw new Error("maxLlmCalls must be an integer");
  const experimentTimeoutS = Math.max(1, Math.floor(
    positive(opts.experimentTimeoutS ?? problem.remote?.timeout_s ?? 3600, "experimentTimeoutS"),
  ));
  const experimentCount = opts.baselineMode === "paired" ? 2 : 1;
  const maxWallTimeS = positive(
    opts.maxWallTimeS ?? opts.configOverrides?.maxWallTimeS ?? experimentTimeoutS * experimentCount + 1800,
    "maxWallTimeS",
  );
  const env = { ...(problem.remote?.env ?? {}), ...(opts.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error(`invalid environment entry: ${key}`);
    }
  }
  if (problem.remote) problem.remote = { ...problem.remote, env, timeout_s: experimentTimeoutS };
  const outDir = path.resolve(cwd, opts.outDir ?? "runs");
  const config = defaultConfig({ ...opts.configOverrides, runner: "subprocess", outDir,
    seed: opts.seed ?? opts.configOverrides?.seed ?? 7, maxExperiments: 2, maxLlmCalls, maxWallTimeS,
    maxEngRounds: 0, maxRefineRounds: 0, maxAblationRounds: 0, maxReviewRefinements: 0 });
  for (const [role, route] of Object.entries(config.modelRoutes)) {
    const model = role === "coding" ? opts.codingModel ?? opts.model : opts.model;
    config.modelRoutes[role] = modelRoute({ ...route, ...(model ? { model } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) });
  }
  config.modelRoutes.coding = modelRoute({ ...config.modelRoutes.coding, ...(codingMaxTokens !== undefined ? { maxTokens: codingMaxTokens } : {}) });
  const runId = assertRunId(opts.runId ?? newRunId(outDir, problem, config.seed));
  config.runId = runId;
  // A local run id may be reused under a different output root. Remote paths
  // must still be fresh, or a missing report could reuse an older measurement.
  const remoteRunId = `iteration-${randomUUID()}`;
  if (problem.remote) isolateSmokeRemote(problem.remote, remoteRunId, path.basename(problem.repo));
  const root = path.join(outDir, runId);
  // Never reuse a run/worktree or silently overwrite an earlier result.
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(root);
  const deadline = AbortSignal.timeout(Math.ceil(maxWallTimeS * 1000));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const store = new ArtifactStore(root);
  const traces = new TraceStore(path.join(root, "traces.jsonl"));
  const budget = new IterationBudget({ maxLlmCalls, maxExperiments: 2, maxWallTimeS });
  const result: IterationResult = { runId, root, status: "failed", executed: false, accepted: false,
    promoted: false, baselineSource: "measured", incumbentPath: "",
    outcome: "error", baseline: null, candidate: null, candidateRepo: null, idea: null, diff: "",
    verdict: null, errors: [], summary: {}, records: [] };
  const wrapped = new class extends LLMProvider {
    readonly name = opts.provider.name;
    async complete(req: LLMRequest): Promise<LLMResponse> {
      checkAborted(ctx);
      budget.check();
      if (req.task === "ideas.initial") req = { ...req, user: `${req.user}\n\n${sourceBrief}` };
      traces.append("model.request", req);
      try {
        const response = await abortable(opts.provider.complete({ ...req, signal }), signal);
        traces.append("model.response", { task: req.task, model: response.model, usage: response.usage,
          latency_s: response.latencyS, text: response.text });
        checkAborted(ctx);
        budget.check();
        return response;
      } catch (error) {
        traces.append("model.error", { task: req.task, error });
        throw error;
      }
    }
  }();
  // Only real generic runners are chosen by default. Tests inject Runner mocks.
  // The shared deadline also cancels remote sync/SSH, not just stage transitions.
  const runner = opts.runner ?? (problem.remote
    ? new RemoteRunner(store, { remote: problem.remote, command: problem.experiment_command,
      runId: remoteRunId, timeoutS: experimentTimeoutS, signal })
    : new SubprocessRunner(store, { timeoutS: experimentTimeoutS, command: problem.experiment_command, signal }));
  const native = new GitWorkspace(problem, { ...config, maxWallTimeS: experimentTimeoutS }, root, runner);
  let baselineRepo: RepoRef;
  let protectedPaths: string[] = [];
  let allowedFiles: string[] = [];
  let declaredMutable = false;
  let sourceBrief = "";
  let invocations = 0;
  let baselinePipeline: Record<string, unknown> | null = null;
  let candidatePipeline: Record<string, unknown> | null = null;
  let measureBaseline = true;
  let incumbent: IncumbentLedger | null = null;
  const guarded: Workspace = {
    problem, config, root,
    baselineRepo: () => native.baselineRepo(),
    brief: () => sourceBrief,
    diff: (a, b) => native.diff(a, b),
    async writePatch(repo, patch, label) {
      checkAborted(ctx);
      budget.check();
      store.writeText("candidate.proposed.diff", patch);
      if (repo.commit !== baselineRepo.commit) throw new Error("candidate must descend directly from immutable baseline");
      const diff = extractUnifiedDiff(patch);
      if (!diff) throw new Error("candidate has no valid unified diff");
      const violations = new SpecAuditor(ctx).hardViolations(problem, diff, null);
      if (violations.length) throw new Error(violations.join("; "));
      const next = await native.writePatch(repo, patch, label);
      result.candidateRepo = next;
      result.diff = await native.diff(repo, next);
      store.writeJson("candidate.repo.json", next);
      store.writeText("candidate.diff", result.diff);
      if (next.commit === repo.commit || !result.diff.trim()) throw new Error("candidate patch is invalid, unchanged or a no-op");
      const files = git(next.path, ["diff", "--name-only", "-z", repo.commit!, next.commit!]).split("\0").filter(Boolean);
      const forbidden = files.filter((file) => protectedPaths.some((pattern) => matchesProtected(file, pattern)));
      if (forbidden.length) throw new Error(`candidate changes protected protocol paths: ${forbidden.join(", ")}`);
      if (declaredMutable && files.some(file => !allowedFiles.includes(file))) throw new Error("candidate changes paths outside declared mutable executable source");
      const meaningful = result.diff.split("\n").filter((line) => /^[+-](?![+-])/.test(line))
        .map((line) => line.slice(1).trim()).filter((line) => line && !/^(#|\/\/|\/\*|\*|\*\/)/.test(line));
      if (!meaningful.length || !files.some((file) => /\.(py|ts|tsx|js|jsx|rs|go|c|cc|cpp|h|cu|sh)$/.test(file))) {
        throw new Error("candidate contains no executable implementation change");
      }
      if (git(next.path, ["diff", "--ignore-all-space", "--ignore-blank-lines", repo.commit!, next.commit!]).trim() === "") {
        throw new Error("candidate is a whitespace-only no-op");
      }
      return next;
    },
    async run(repo, scope, idea) {
      checkAborted(ctx);
      budget.check();
      const limit = measureBaseline ? 2 : 1;
      if (scope !== runScope || invocations >= limit) {
        throw new Error(measureBaseline ? `bounded iteration permits one baseline and one candidate ${runScope} experiment` : `incumbent reuse permits exactly one candidate ${runScope} experiment`);
      }
      const phase = measureBaseline && invocations === 0 ? "baseline" : "candidate";
      const expectedCommit = phase === "baseline" ? baselineRepo.commit : result.candidateRepo?.commit;
      if (repo.commit !== expectedCommit) throw new Error("unexpected experiment snapshot");
      invocations++;
      traces.append("iteration.experiment.start", { index: invocations, scope, commit: repo.commit, env });
      // Real runners own cancellation and must finish their process-group
      // cleanup before the iteration returns. Only opaque test seams are raced.
      const experiment = opts.runner
        ? await abortable(native.run(repo, scope, idea), signal)
        : await native.run(repo, scope, idea);
      traces.append("iteration.experiment.end", { index: invocations, commit: repo.commit, result: experiment });
      // Persist evidence before checking failure/cancellation/time so partial runs remain inspectable.
      const evidence = evidenceFromResult(idea?.id ?? "baseline", runScope, experiment, repo, result.baseline?.metrics ?? {});
      if (phase === "baseline") result.baseline = evidence;
      else result.candidate = evidence;
      store.writeJson(phase === "baseline" ? "baseline.json" : "candidate.json", evidence);
      if (git(repo.path, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
        throw new Error("experiment mutated tracked files; immutable snapshot violated");
      }
      checkAborted(ctx);
      budget.check();
      // The legacy runners coerce values and may accept a failed-status report.
      // Native real iterations must validate the ORIGINAL JSON and end-to-end
      // training metadata, not merely the runner's converted metric map.
      if (!opts.runner && experiment.status === "ok") {
        const log = JSON.parse(fs.readFileSync(experiment.log_path, "utf8"));
        const report = problem.remote
          ? JSON.parse(fs.readFileSync(log.raw_report_path, "utf8")) : log;
        const measured = validateAdapterReport(problem, report);
        if (JSON.stringify(measured) !== JSON.stringify(experiment.metrics)) throw new Error("runner metrics disagree with original report");
        const details = report.details as Record<string, unknown>;
        if (details.seed !== config.seed) throw new Error(`adapter reported seed ${details.seed}; requested ${config.seed}. Honor RSI_SEED or the manifest env_prefix seed.`);
        if (runScope === "full") {
          if (details.scope !== "full" || details.run_kind !== "full_test" || details.eval_limit != null) {
            throw new Error("full scope requires a real full_test report with no evaluation limit");
          }
          if (!Number.isInteger(details.executed_train_steps) || (details.executed_train_steps as number) < 2) {
            throw new Error("full scope requires a real trained checkpoint, not a one-step smoke");
          }
        }
        store.writeJson(`${phase}.report.json`, report);
        if (phase === "baseline") baselinePipeline = details;
        else {
          candidatePipeline = details;
          for (const field of ["executed_train_steps", "checkpoint_step", "seed", "effective_batch_size", "effective_batch", "train_steps", "expected_training_steps", "max_length", "eval_max_length", "eval_limit", "lm_eval_batch_size", "tokenizer", "harness", "stage_sha256", "eval_script_sha256"]) {
            if (details[field] !== baselinePipeline?.[field]) throw new Error(`paired pipeline ${field} differs from baseline`);
          }
        }
      }
      const keys = Object.keys(experiment.metrics).sort();
      const expected = problem.metrics.map(spec => spec.name).sort();
      if (experiment.status !== "ok" || JSON.stringify(keys) !== JSON.stringify(expected) || !problem.metrics.every((spec) => {
        const value = experiment.metrics[spec.name];
        return typeof value === "number" && Number.isFinite(value) &&
          (!spec.bounds || (value >= spec.bounds[0] && value <= spec.bounds[1]));
      })) {
        throw new Error(`${phase} experiment failed or violates exact finite bounded metrics: ${experiment.stderr}`);
      }
      return experiment;
    },
  };
  const ctx: AgentContext = { problem, config, llm: wrapped, workspace: guarded, store, traces, budget,
    scratch: {}, projectRoot: cwd, signal, onProgress: opts.onProgress };
  store.writeJson("problem.json", problem);
  store.writeJson("config.json", config);
  try {
    checkAborted(ctx);
    // Incumbent reuse: a promoted commit becomes the next baseline, so an
    // accepted improvement accumulates instead of being re-derived each time.
    result.incumbentPath = opts.incumbentPath
      ? path.resolve(cwd, opts.incumbentPath)
      : incumbentFileFor(outDir, problem, runScope);
    const fingerprint = protocolFingerprint(problem, env, config.seed, runScope);
    const loaded = opts.baselineMode === "paired" ? null : loadIncumbent(result.incumbentPath, problem, fingerprint, runScope);
    if (loaded) {
      incumbent = loaded.ledger;
      problem.repo_ref = incumbent.commit;
    }
    baselineRepo = await native.baselineRepo();
    measureBaseline = !incumbent;
    result.baselineSource = measureBaseline ? "measured" : "incumbent";
    // Freeze the resolved commit, not a movable branch name, in the protocol.
    problem.repo_ref = baselineRepo.commit!;
    ({ protectedPaths, allowedFiles, declaredMutable } = protections(problem, baselineRepo, opts.protectedPaths ?? [], env, config.seed));
    if (!problem.remote && !opts.runner) {
      // Keep the runner's original command array identity while adding the
      // declared seed/budget environment after reading the pinned manifest.
      problem.experiment_command!.splice(0, 0, "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`));
    }
    const protocol = { mode: "bounded_iteration",
      scope: runScope,
      scopes: measureBaseline ? [runScope, runScope] : [runScope],
      experiments: measureBaseline ? 2 : 1, baseline_source: result.baselineSource,
      incumbent_path: result.incumbentPath, protocol_fingerprint: fingerprint,
      baseline_commit: baselineRepo.commit, command: problem.experiment_command, env,
      metrics: problem.metrics, datasets: problem.subset_datasets, seed: config.seed,
      remote: problem.remote, experiment_timeout_s: experimentTimeoutS, protected_paths: protectedPaths,
      allowed_source_paths: allowedFiles, declared_mutable_paths: declaredMutable,
      max_tokens: maxTokens ?? null, coding_max_tokens: codingMaxTokens ?? null,
      output_policy: { default: maxTokens === undefined ? "inherit Pi/model defaults" : "explicit user cap", coding: codingMaxTokens === undefined ? "inherit Pi/model defaults" : "explicit user cap" },
      note: "Small-budget paired measurement only; no full benchmark or scientific claim. Target owns real training/checkpoint reload/evaluation." };
    sourceBrief = iterationBrief(baselineRepo, allowedFiles, protocol);
    store.writeText("source-context.txt", sourceBrief);
    store.writeJson("protocol.json", protocol);
    traces.append("iteration.start", protocol);
    if (measureBaseline) {
      progress(ctx, "iteration: immutable baseline subset (1/2)");
      budget.chargeExperiment();
      await guarded.run(baselineRepo, runScope);
      // The project baseline is not a promoted candidate; persist the measured
      // initial baseline so the next iteration reuses it even when this
      // candidate is rejected.
      const initial: IncumbentLedger = {
        version: 1,
        problem: problem.id,
        scope: runScope,
        commit: baselineRepo.commit!,
        metrics: result.baseline!.metrics,
        protocol: fingerprint,
        pipeline: baselinePipeline,
        evidence: { report: store.artifact("baseline.report.json"), raw: "" },
        history: [],
      };
      try {
        writeIncumbent(result.incumbentPath, initial);
      } catch {
        // A read-only project cache must not invalidate the iteration; the
        // measured evidence remains in the run artifacts.
      }
    } else {
      progress(ctx, "iteration: reusing stored incumbent measurement (0/1 baseline runs)");
      baselinePipeline = incumbent!.pipeline;
      const reused = evidenceFromResult("baseline", runScope, {
        metrics: incumbent!.metrics,
        status: "ok",
        log_path: incumbent!.evidence?.report ?? "",
        stdout: `reused incumbent ${incumbent!.commit}`,
        stderr: "",
        wall_time_s: 0,
      }, baselineRepo, {});
      result.baseline = reused;
      store.writeJson("baseline.incumbent.json", { commit: incumbent!.commit, metrics: incumbent!.metrics, evidence: incumbent!.evidence });
      traces.append("iteration.incumbent.reused", { commit: incumbent!.commit, metrics: incumbent!.metrics });
    }
    ctx.scratch.baseline = result.baseline;
    progress(ctx, "iteration: one initial idea and one implementation");
    result.idea = await new InitialIdeaGenerator(ctx).generate([]);
    if (!result.idea.hypothesis.trim() || !result.idea.mechanism.trim()) throw new Error("model returned an empty idea");
    // Audit the actual candidate diff, not a prose idea that may restate a
    // forbidden action negatively ("never train on the test split").
    store.writeJson("idea.json", result.idea);
    progress(ctx, measureBaseline ? "iteration: changed candidate subset (2/2)" : "iteration: changed candidate subset (1/1)");
    await new SubsetCoder(ctx).implement(result.idea, { base: result.baseline!, scope: runScope });
    result.verdict = await new ResultComparison(ctx).compare(result.candidate!, result.baseline!);
    result.executed = true;
    result.status = "executed";
    result.accepted = result.verdict.decision === "good";
    result.promoted = result.accepted;
    result.outcome = result.accepted ? "accepted" : "rejected";
    if (result.promoted) {
      // Promotion is a measured chain: the new incumbent carries its metrics,
      // pipeline identity and the exact protocol it was measured under.
      const history = [...(incumbent?.history ?? []), {
        commit: baselineRepo.commit!, metrics: result.baseline!.metrics, at: new Date().toISOString(),
      }].slice(-20);
      const ledger: IncumbentLedger = {
        version: 1, problem: problem.id, scope: runScope, commit: result.candidateRepo!.commit!,
        metrics: result.candidate!.metrics, protocol: fingerprint,
        pipeline: candidatePipeline ?? baselinePipeline,
        evidence: {
          report: store.artifact("candidate.report.json"),
          raw: store.artifact("candidate.diff"),
        },
        evidence_sha256: fs.existsSync(store.artifact("candidate.report.json"))
          ? createHash("sha256").update(fs.readFileSync(store.artifact("candidate.report.json"))).digest("hex")
          : undefined,
        history,
      };
      writeIncumbent(result.incumbentPath, ledger);
      traces.append("iteration.promoted", { commit: ledger.commit, metrics: ledger.metrics, prior: result.baseline!.code?.commit });
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    traces.append("iteration.error", { error, candidate_commit: result.candidateRepo?.commit });
  } finally {
    result.summary = { run_id: runId, mode: "bounded_iteration", status: result.status, executed: result.executed,
      scope: runScope, formal_baseline: runScope === "full",
      accepted: result.accepted, promoted: result.promoted, outcome: result.outcome, experiment_invocations: invocations,
      baseline_source: result.baselineSource, incumbent_path: result.incumbentPath,
      baseline_commit: result.baseline?.code?.commit ?? null, candidate_commit: result.candidateRepo?.commit ?? null,
      baseline_metrics: result.baseline?.metrics ?? {}, candidate_metrics: result.candidate?.metrics ?? {},
      budget: budget.snapshot(), errors: result.errors, scientific_claim: false };
    traces.append("iteration.done", result.summary);
    result.records = traces.readAll();
    const { records: _records, ...persisted } = result;
    fs.writeFileSync(path.join(root, "iteration.json"), JSON.stringify(persisted, null, 2));
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(result.summary, null, 2));
  }
  return result;
}
