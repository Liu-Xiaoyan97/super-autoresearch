/** Shared run/inspect/replay API used by both the CLI and the Pi tools. */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "./config.ts";
import { defaultConfig, modelRoute } from "./config.ts";
import { Orchestrator } from "./core/orchestrator.ts";
import { asRecord, num, numRecord, str, strArray, stringRecord } from "./json.ts";
import { LLMProvider } from "./providers/base.ts";
import { MockLLMProvider, type MockScript, loadMockScript } from "./providers/mock.ts";
import { Budget } from "./runtime/budget.ts";
import { ArtifactStore, TraceStore, type TraceRecord } from "./runtime/store.ts";
import { GitWorkspace } from "./runtime/workspace.ts";
import {
  type FinalArtifacts,
  type MetricSpec,
  type Problem,
  type RemoteConfig,
  type ResearchDirection,
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
  /** Offline deterministic provider. */
  mock?: boolean;
  mockScript?: MockScript | null;
  /** Supplied provider (the Pi extension passes PiLLMProvider). */
  provider?: LLMProvider;
  providerName?: string;
  model?: string;
  codingModel?: string;
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
    direction: item.direction === "min" ? "min" : "max",
    tolerance: num(item.tolerance, 1e-3),
    weight: num(item.weight, 1),
    bounds,
  });
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
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
    gpu_ids: str(item.gpu_ids),
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
    remote: parseRemote(item.remote),
    datasets: strArray(item.datasets),
    subset_datasets: strArray(item.subset_datasets),
    metrics,
    reported_metrics: numRecord(item.reported_metrics),
    constraints: strArray(item.constraints),
    directions: Array.isArray(item.directions) ? item.directions.map(parseDirection) : [],
    forbidden: strArray(item.forbidden),
    venue: str(item.venue, "ICLR"),
    audience_note: str(item.audience_note),
  });
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

function buildConfig(opts: RunOptions): Config {
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
  if (opts.model) {
    const routes = { ...config.modelRoutes };
    for (const key of Object.keys(routes)) {
      routes[key] = modelRoute({ ...routes[key], model: opts.model });
    }
    config.modelRoutes = routes;
  }
  if (opts.codingModel) {
    const routes = { ...config.modelRoutes };
    for (const key of ["coding", "ablation", "rebuttal", "draft_enhancer"]) {
      routes[key] = modelRoute({ ...routes[key], model: opts.codingModel });
    }
    config.modelRoutes = routes;
  }
  return config;
}

export async function runResearch(opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const problem = loadProblem(opts.problem, cwd);
  const config = buildConfig(opts);
  const outDir = path.resolve(cwd, opts.outDir ?? config.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const runId = opts.runId ? assertRunId(opts.runId) : newRunId(outDir, problem, config.seed);
  config.runId = runId;
  config.outDir = outDir;
  const root = path.join(outDir, runId);
  fs.mkdirSync(root, { recursive: true });

  const store = new ArtifactStore(root);
  const traces = new TraceStore(path.join(root, "traces.jsonl"));
  const budget = new Budget({
    maxLlmCalls: config.maxLlmCalls,
    maxExperiments: config.maxExperiments,
    maxWallTimeS: config.maxWallTimeS,
  });
  const workspace = new GitWorkspace(problem, config, root);
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
    signal: opts.signal,
    onProgress: opts.onProgress,
  };

  try {
    const orchestrator = new Orchestrator(ctx);
    const final = await orchestrator.run();
    const state = orchestrator.stateDict();
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state, null, 2), "utf8");
    fs.writeFileSync(path.join(root, "final.json"), JSON.stringify(final, null, 2), "utf8");
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
