/** Shared run/inspect/replay API used by both the CLI and the Pi tools. */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "./config.ts";
import { defaultConfig, modelRoute } from "./config.ts";
import { Orchestrator } from "./core/orchestrator.ts";
import { ResearchState } from "./core/state.ts";
import { asRecord, num, numRecord, str, strArray, stringRecord } from "./json.ts";
import { LLMProvider } from "./providers/base.ts";
import { MockLLMProvider, type MockScript, loadMockScript } from "./providers/mock.ts";
import { Budget } from "./runtime/budget.ts";
import { ArtifactStore, TraceStore, type TraceRecord } from "./runtime/store.ts";
import { GitWorkspace } from "./runtime/workspace.ts";
import { loadRunBaselines, type RunBaselineSeeds } from "./runtime/incumbent.ts";
import { refreshLedgerFromContext } from "./runtime/ledger.ts";
import {
  type Evidence,
  type FinalArtifacts,
  type MetricSpec,
  type Problem,
  type RemoteConfig,
  type ResearchDirection,
  type BudgetPolicy,
  makeProblem,
  metricSpec,
} from "./types.ts";

export interface RunOptions {
  problem: string;
  cwd?: string;
  outDir?: string;
  runId?: string;
  seed?: number;
  runner?: "simulated" | "subprocess";
  /** Resume a previous run id in the same out dir, preserving its state/traces. */
  resumeFrom?: string;
  /** Trusted baseline JSON/incumbent ledger; reused instead of reproducing. */
  baseline?: string;
  /** Offline deterministic provider. */
  mock?: boolean;
  mockScript?: MockScript | null;
  /** Supplied provider (the Pi extension passes PiLLMProvider). */
  provider?: LLMProvider;
  providerName?: string;
  model?: string;
  codingModel?: string;
  /** Explicit output cap for all roles; unset inherits native model policy. */
  maxTokens?: number;
  /** Optional override for coding, ablation, rebuttal and draft enhancement. */
  codingMaxTokens?: number;
  strictDirections?: boolean;
  maxRefineRounds?: number;
  maxReviewRefinements?: number;
  maxLlmCalls?: number;
  maxExperiments?: number;
  maxWallTimeS?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  configOverrides?: Partial<Config>;
}

export interface RunResult {
  runId: string;
  root: string;
  state: Record<string, unknown>;
  final: FinalArtifacts;
  records: TraceRecord[];
  orchestrator: Orchestrator;
  provider: LLMProvider;
  summary: Record<string, unknown>;
}

function parseMetric(raw: unknown): MetricSpec {
  const item = asRecord(raw) ?? {};
  const bounds = Array.isArray(item.bounds) && item.bounds.length === 2
    ? [num(item.bounds[0]), num(item.bounds[1])] as [number, number]
    : null;
  return metricSpec({
    name: str(item.name, "score"),
    dataset: typeof item.dataset === "string" && item.dataset.trim() ? item.dataset.trim() : null,
    direction: item.direction === "min" ? "min" : "max",
    tolerance: num(item.tolerance, 1e-3),
    weight: num(item.weight, 1),
    bounds,
  });
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function parseBudget(raw: unknown): BudgetPolicy | null {
  const item = asRecord(raw);
  if (!item) return null;
  const full = num(item.full_steps, Number.NaN);
  const fraction = num(item.subset_fraction, Number.NaN);
  const max = num(item.subset_max_steps, Number.NaN);
  const env = str(item.steps_env);
  if (!Number.isFinite(full) || full <= 0 || !env) return null;
  return {
    full_steps: full,
    subset_fraction: Number.isFinite(fraction) && fraction > 0 ? fraction : null,
    subset_max_steps: Number.isFinite(max) && max > 0 ? max : null,
    steps_env: env,
    seed_env: str(item.seed_env) || null,
  };
}

function parseRemote(raw: unknown): RemoteConfig | null {
  const item = asRecord(raw);
  if (!item) return null;
  return {
    host: str(item.host) || process.env.RSI_REMOTE_HOST || "",
    dir: str(item.dir),
    worktree: str(item.worktree),
    out: str(item.out),
    python: str(item.python, "python3"),
    setup: str(item.setup),
    ssh_args: strArray(item.ssh_args),
    rsync_args: strArray(item.rsync_args),
    gpu_ids: (() => {
      const raw = item.gpu_ids;
      const value = typeof raw === "number" ? String(raw) : str(raw);
      if (!/^\d+(,\d+)*$/.test(value)) {
        throw new Error('remote.gpu_ids is required and must be a GPU id list such as "0" or "0,1"');
      }
      return value;
    })(),
    env: stringRecord(item.env),
    timeout_s: num(item.timeout_s, 7200),
    excludes: strArray(item.excludes),
  };
}

function parseDirection(raw: unknown, index: number): ResearchDirection {
  const item = asRecord(raw) ?? {};
  return {
    id: str(item.id, `d${index + 1}`),
    title: str(item.title),
    description: str(item.description),
    keywords: strArray(item.keywords),
    weight: num(item.weight, 1),
    must_include: item.must_include === true,
  };
}

export function parseProblem(raw: unknown): Problem {
  const item = asRecord(raw);
  if (!item) throw new Error("problem JSON must be an object");
  const metrics = Array.isArray(item.metrics) ? item.metrics.map(parseMetric) : [];
  const datasets = strArray(item.datasets);
  const seenMetrics = new Set<string>();
  for (const metric of metrics) {
    if (seenMetrics.has(metric.name)) throw new Error(`duplicate metric name: ${metric.name}`);
    seenMetrics.add(metric.name);
    if (metric.dataset && !datasets.includes(metric.dataset)) {
      throw new Error(`metric ${metric.name} names dataset ${metric.dataset}, which is not in datasets`);
    }
  }
  return makeProblem({
    id: str(item.id, "problem"),
    statement: str(item.statement),
    domain: str(item.domain),
    subfield: str(item.subfield),
    source_paper: str(item.source_paper),
    repo:
      typeof item.repo === "string" && item.repo.trim()
        ? expandEnv(item.repo)
        : null,
    repo_ref:
      typeof item.repo_ref === "string" && item.repo_ref.trim() ? item.repo_ref : null,
    experiment_command: strArray(item.experiment_command).length
      ? strArray(item.experiment_command)
      : null,
    diagnose_command: strArray(item.diagnose_command).length ? strArray(item.diagnose_command) : null,
    job_worker: typeof item.job_worker === "string" && item.job_worker.trim() ? item.job_worker.trim() : null,
    remote: parseRemote(item.remote),
    budget: parseBudget(item.budget),
    datasets,
    subset_datasets: strArray(item.subset_datasets),
    metrics,
    reported_metrics: numRecord(item.reported_metrics),
    constraints: strArray(item.constraints),
    directions: Array.isArray(item.directions) ? item.directions.map(parseDirection) : [],
    forbidden: strArray(item.forbidden),
    venue: str(item.venue, "ICLR"),
    audience_note: str(item.audience_note),
    max_retry: parseMaxRetry(item.max_retry),
  });
}

/**
 * Loop-retry policy from the problem fixture. Two loops have independent
 * budgets: the idea loop reseeds a refuted pool, the paper loop re-drafts an
 * unaccepted manuscript.
 */
function parseMaxRetry(raw: unknown): Problem["max_retry"] {
  const item = asRecord(raw);
  if (!item) return null;
  const count = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`max_retry must be a non-negative integer, got ${String(value)}`);
    return parsed;
  };
  return { idea: count(item.idea, 2), paper: count(item.paper, 1) };
}

/** Load a Problem from a JSON file or an inline JSON object. */
export function loadProblem(input: string, cwd = process.cwd()): Problem {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) return parseProblem(JSON.parse(trimmed));
  const file = path.resolve(cwd, input.replace(/^@/, ""));
  if (!fs.existsSync(file)) throw new Error(`problem file not found: ${file}`);
  return parseProblem(JSON.parse(fs.readFileSync(file, "utf8")));
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "problem";
}

export function newRunId(outDir: string, problem: Problem, seed: number): string {
  const base = `${slug(problem.id)}-s${seed}`;
  let runId = base;
  let index = 2;
  while (fs.existsSync(path.join(outDir, runId))) {
    runId = `${base}-${index}`;
    index += 1;
  }
  return runId;
}

export function assertRunId(runId: string): string {
  if (!runId || path.basename(runId) !== runId || runId === "." || runId === "..") {
    throw new Error("run_id must be a single directory name");
  }
  return runId;
}

export function buildConfig(opts: RunOptions): Config {
  const overrides: Partial<Config> = { ...(opts.configOverrides ?? {}) };
  if (opts.seed !== undefined) overrides.seed = opts.seed;
  if (opts.runner) overrides.runner = opts.runner;
  if (opts.strictDirections) overrides.strictDirections = true;
  if (opts.maxRefineRounds !== undefined) overrides.maxRefineRounds = opts.maxRefineRounds;
  if (opts.maxReviewRefinements !== undefined) overrides.maxReviewRefinements = opts.maxReviewRefinements;
  if (opts.maxLlmCalls !== undefined) overrides.maxLlmCalls = opts.maxLlmCalls;
  if (opts.maxExperiments !== undefined) overrides.maxExperiments = opts.maxExperiments;
  if (opts.maxWallTimeS !== undefined) overrides.maxWallTimeS = opts.maxWallTimeS;
  const config = defaultConfig(overrides);
  if (opts.model || opts.providerName || opts.maxTokens !== undefined) {
    const routes = { ...config.modelRoutes };
    for (const key of Object.keys(routes)) {
      routes[key] = modelRoute({
        ...routes[key],
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.providerName ? { provider: opts.providerName } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    }
    config.modelRoutes = routes;
  }
  if (opts.codingModel || opts.codingMaxTokens !== undefined) {
    const routes = { ...config.modelRoutes };
    for (const key of ["coding", "ablation", "rebuttal", "draft_enhancer"]) {
      routes[key] = modelRoute({
        ...(routes[key] ?? routes.default),
        ...(opts.codingModel ? { model: opts.codingModel } : {}),
        ...(opts.codingMaxTokens !== undefined ? { maxTokens: opts.codingMaxTokens } : {}),
      });
    }
    config.modelRoutes = routes;
  }
  return config;
}

/** A baseline recorded inside a run is reusable only if it still parses as evidence. */
function baselineIsValid(evidence: Evidence, problem: Problem): boolean {
  const commit = evidence.code?.commit ?? "";
  if (!/^[0-9a-f]{40}$/i.test(commit)) return false;
  const names = problem.metrics.map((metric) => metric.name).sort();
  const metrics = evidence.metrics ?? {};
  if (JSON.stringify(Object.keys(metrics).sort()) !== JSON.stringify(names)) return false;
  return names.every((name) => typeof metrics[name] === "number" && Number.isFinite(metrics[name]));
}

export async function runResearch(opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const problem = loadProblem(opts.problem, cwd);
  const config = buildConfig(opts);
  // examples/*.json carries the loop policy; an explicit caller override wins.
  if (problem.max_retry) {
    if (opts.configOverrides?.maxIdeaRetries === undefined) config.maxIdeaRetries = problem.max_retry.idea;
    if (opts.configOverrides?.maxPaperRetries === undefined) config.maxPaperRetries = problem.max_retry.paper;
  }
  // No user-facing wall flag: a remote fixture's own execution limit is the
  // real bound. Keep an internal safety margin for two experiments plus drafting.
  if (opts.maxWallTimeS === undefined && opts.configOverrides?.maxWallTimeS === undefined && problem.remote?.timeout_s) {
    config.maxWallTimeS = Math.max(config.maxWallTimeS, problem.remote.timeout_s * 2 + 7200);
  }
  const outDir = path.resolve(cwd, opts.outDir ?? config.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const runId = opts.runId ? assertRunId(opts.runId) : newRunId(outDir, problem, config.seed);
  config.runId = runId;
  config.outDir = outDir;
  const root = path.join(outDir, runId);
  fs.mkdirSync(root, { recursive: true });

  let resumedState: ResearchState | undefined;
  if (opts.resumeFrom) {
    const previousId = assertRunId(opts.resumeFrom);
    const previousRoot = path.join(outDir, previousId);
    // Resuming in place is the normal case: one run id, one directory, one
    // history. A different directory is still accepted for explicit forks.
    const inPlace = path.resolve(previousRoot) === path.resolve(root);
    const previousState = path.join(previousRoot, "state.json");
    if (!fs.existsSync(previousState)) {
      throw new Error(`state.json not found for resume source: ${previousRoot}`);
    }
    if (!inPlace) {
      fs.copyFileSync(previousState, path.join(root, "state.json"));
      const previousTraces = path.join(previousRoot, "traces.jsonl");
      if (fs.existsSync(previousTraces)) {
        fs.copyFileSync(previousTraces, path.join(root, "traces.jsonl"));
      }
    }
    resumedState = ResearchState.fromDict(
      problem,
      config,
      JSON.parse(fs.readFileSync(previousState, "utf8")),
    );
  }

  // A stored/manual baseline is the reference; reproduce only the scope that
  // is missing. The promoted commit is the base for a missing scope.
  // A resume continues from what the run already recorded: an external baseline
  // file that has since disappeared must not invalidate recorded evidence.
  let baselineSeeds: RunBaselineSeeds = { subset: null, full: null, source: null, path: "" };
  let baselineGap = "";
  try {
    baselineSeeds = loadRunBaselines(problem, outDir, config.seed, opts.baseline);
  } catch (error) {
    const explicit = opts.baseline ? path.resolve(cwd, opts.baseline) : "";
    const recorded = resumedState?.baseline ?? resumedState?.baselineFull;
    const missing = explicit !== "" && !fs.existsSync(explicit);
    if (!missing || !recorded || !baselineIsValid(recorded, problem)) throw error;
    baselineSeeds.path = explicit;
    baselineGap = `baseline file ${explicit} is gone; continued from the baseline recorded in this run (${recorded.code?.commit})`;
  }
  const seedCommit = baselineSeeds.full?.evidence.code?.commit ?? baselineSeeds.subset?.evidence.code?.commit;
  const baseCommit = resumedState?.baseline?.code?.commit ?? resumedState?.baselineFull?.code?.commit ?? seedCommit;
  if (baseCommit) problem.repo_ref = baseCommit;

  const store = new ArtifactStore(root);
  const traces = new TraceStore(path.join(root, "traces.jsonl"));
  const budget = new Budget({
    maxLlmCalls: config.maxLlmCalls,
    maxExperiments: config.maxExperiments,
    maxWallTimeS: config.maxWallTimeS,
  });
  const workspace = new GitWorkspace(
    problem,
    config,
    root,
    undefined,
    resumedState?.baseline?.code?.repo,
    opts.signal,
  );
  const provider =
    opts.provider ??
    (opts.mock
      ? new MockLLMProvider(opts.mockScript ?? null, config.seed)
      : (() => {
          throw new Error("runResearch requires a provider unless mock is enabled");
        })());

  const ctx = {
    problem,
    config,
    llm: provider,
    workspace,
    store,
    traces,
    budget,
    scratch: {} as Record<string, unknown>,
    projectRoot: cwd,
    signal: opts.signal,
    onProgress: opts.onProgress,
  };
  if (config.runner !== "simulated") {
    workspace.onExperimentResult = () => refreshLedgerFromContext(ctx);
  }

  try {
    const orchestrator = new Orchestrator(ctx, undefined, resumedState);
    if (baselineGap) {
      orchestrator.state.note("baseline.recorded");
      const recorded = orchestrator.state.baseline ?? orchestrator.state.baselineFull;
      if (recorded) {
        recorded.result = {
          status: recorded.result?.status ?? "ok",
          metrics: recorded.metrics,
          log_path: recorded.result?.log_path ?? "",
          stdout: baselineGap,
          stderr: "",
          wall_time_s: recorded.result?.wall_time_s ?? 0,
        };
      }
    }
    // Fill only the scopes the resumed state (or the caller) did not provide.
    if (!orchestrator.state.baseline && baselineSeeds.subset) {
      orchestrator.state.baseline = baselineSeeds.subset.evidence;
      orchestrator.state.baselineSource = baselineSeeds.subset.source;
      orchestrator.state.baselinePath = baselineSeeds.subset.path;
    }
    if (!orchestrator.state.baselineFull && baselineSeeds.full) {
      orchestrator.state.baselineFull = baselineSeeds.full.evidence;
      if (!baselineSeeds.subset) {
        orchestrator.state.baselineSource = baselineSeeds.full.source;
        orchestrator.state.baselinePath = baselineSeeds.full.path;
      }
    }
    const final = await orchestrator.run({ resume: Boolean(resumedState) });
    const state = orchestrator.stateDict();
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state, null, 2), "utf8");
    // Keep every finished attempt readable: a resume must not erase the record
    // of what the previous attempt concluded.
    const finalFile = path.join(root, "final.json");
    if (fs.existsSync(finalFile)) {
      let attempt = 1;
      while (fs.existsSync(path.join(root, `final.attempt-${attempt}.json`))) attempt += 1;
      fs.copyFileSync(finalFile, path.join(root, `final.attempt-${attempt}.json`));
    }
    fs.writeFileSync(finalFile, JSON.stringify(final, null, 2), "utf8");
    refreshLedgerFromContext(ctx);
    const records = traces.readAll();
    const summary = summarize(runId, state, final, records);
    return { runId, root, state, final, records, orchestrator, provider, summary };
  } finally {
    await provider.close();
  }
}

export function summarize(
  runId: string,
  state: Record<string, unknown>,
  final: FinalArtifacts,
  records: TraceRecord[],
): Record<string, unknown> {
  const traces = Array.isArray(state.traces) ? (state.traces as any[]) : [];
  const rounds = traces.map((trace) => ({
    round: trace?.round ?? 0,
    idea: trace?.idea?.id ?? "?",
    decision: trace?.decision ?? "?",
  }));
  const scores: number[] = [];
  let ablationVerdict: string | null = null;
  for (const record of records) {
    const kind = String(record.kind);
    const data = (record.data ?? {}) as Record<string, unknown>;
    if (kind.includes("review")) {
      const review = asRecord(data.review) ?? data;
      if (typeof review.score === "number") scores.push(review.score);
    }
    if (kind === "stage.ablation") {
      const verdict = asRecord(data.verdict);
      if (typeof verdict?.decision === "string") ablationVerdict = verdict.decision;
      else if (typeof data.decision === "string") ablationVerdict = data.decision;
    }
  }
  if (!scores.length && final.review) scores.push(final.review.score);
  return {
    run_id: runId,
    limitations: Array.isArray(state.limitations) ? state.limitations.length : 0,
    seeds: Array.isArray(state.seeds) ? state.seeds.length : 0,
    rounds,
    h_best: (asRecord(state.best_idea) ?? {}).id ?? null,
    ablation_verdict: ablationVerdict,
    review_scores: scores,
    meta_decision: final.meta_review?.decision ?? null,
    decision_path: final.decision_path,
    aborted: final.aborted,
    abort_reason: final.abort_reason,
    accepted: Boolean(final.extra.accepted),
    baseline_source: state.baseline_source ?? "reproduced",
    baseline_path: state.baseline_path ?? "",
  };
}

/** Rebuild the decision path from traces without a provider or workspace. */
export function reconstructDecisionPath(records: TraceRecord[]): string[] {
  const haveNotes = records.some((record) => record.kind === "state.note");
  let path: string[] = [];
  for (const record of records) {
    const kind = String(record.kind ?? "");
    if (haveNotes && kind !== "state.note") continue;
    if (!["state.note", "state.adopt", "run.abort", "run.done"].includes(kind) && !kind.startsWith("stage.")) {
      continue;
    }
    const data = record.data;
    if (typeof data === "string") {
      path.push(data);
      continue;
    }
    const recordData = asRecord(data);
    if (!recordData) continue;
    const state = asRecord(recordData.state);
    let snapshot = recordData.decision_path;
    if (snapshot === undefined && state) snapshot = state.decision_path;
    if (Array.isArray(snapshot)) {
      path = snapshot.map(String);
      continue;
    }
    let note = recordData.note ?? recordData.transition ?? recordData.decision;
    if (note === undefined && state) note = state.note;
    if (typeof note === "string") path.push(note);
  }
  return path;
}

export interface InspectResult {
  root: string;
  state: Record<string, unknown>;
  final: FinalArtifacts;
  records: TraceRecord[];
  decisionPath: string[];
}

export function inspectRun(opts: { outDir?: string; runId: string; cwd?: string }): InspectResult {
  const outDir = path.resolve(opts.cwd ?? process.cwd(), opts.outDir ?? "runs");
  const runId = assertRunId(opts.runId);
  const root = path.join(outDir, runId);
  const tracesFile = path.join(root, "traces.jsonl");
  if (!fs.existsSync(tracesFile)) throw new Error(`traces.jsonl not found under ${root}`);
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")) as Record<string, unknown>;
  const final = JSON.parse(fs.readFileSync(path.join(root, "final.json"), "utf8")) as FinalArtifacts;
  const records = new TraceStore(tracesFile).readAll();
  return {
    root,
    state,
    final,
    records,
    decisionPath: Array.isArray(state.decision_path) ? state.decision_path.map(String) : [],
  };
}

export interface ReplayResult {
  match: boolean;
  recorded: string[];
  reconstructed: string[];
  records: TraceRecord[];
  root: string;
}

export function replayRun(opts: { outDir?: string; runId: string; cwd?: string }): ReplayResult {
  const inspected = inspectRun(opts);
  const reconstructed = reconstructDecisionPath(inspected.records);
  return {
    root: inspected.root,
    match:
      reconstructed.length === inspected.decisionPath.length &&
      reconstructed.every((token, index) => token === inspected.decisionPath[index]),
    recorded: inspected.decisionPath,
    reconstructed,
    records: inspected.records,
  };
}

export function listRuns(outDir = "runs", cwd = process.cwd()): string[] {
  const root = path.resolve(cwd, outDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "traces.jsonl")))
    .map((entry) => entry.name)
    .sort();
}

export function loadScript(file: string, cwd = process.cwd()): MockScript {
  const full = path.resolve(cwd, file);
  return loadMockScript(JSON.parse(fs.readFileSync(full, "utf8")));
}
