/** Native adapter smoke API: real pinned git baseline + RemoteRunner, never a simulation. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { defaultConfig } from "./config.ts";
import { loadProblem } from "./run.ts";
import { GitWorkspace, RemoteRunner, expandRemoteTemplate, type RemoteTransport } from "./runtime/workspace.ts";
import type { Problem, RemoteConfig } from "./types.ts";

export interface AdapterSmokeParams {
  problem: string;
  repo?: string;
  /** Must not already exist. */
  out?: string;
  env?: Record<string, string>;
  timeout_s?: number;
}

export const ADAPTER_SMOKE_PARAMS = {
  type: "object",
  properties: {
    problem: { type: "string", description: "Problem JSON path (or inline JSON) with pinned repo_ref, real experiment command, remote configuration and exact metric specifications." },
    repo: { type: "string", description: "Override the local target git repository path." },
    out: { type: "string", description: "Fresh evidence directory; reuse is rejected. Default: unique runs/adapter-smoke-* directory." },
    env: { type: "object", additionalProperties: { type: "string" }, description: "Explicit remote protocol environment overrides; no budgets or datasets are guessed." },
    timeout_s: { type: "integer", minimum: 1, description: "Remote experiment timeout in seconds (default 900)." },
  },
  required: ["problem"],
  additionalProperties: false,
};

export interface AdapterSmokeOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Internal test seam only; the native tool never exposes this argument. */
  transport?: RemoteTransport;
  onProgress?: (message: string) => void;
}

export interface AdapterSmokeResult {
  status: "ok" | "failed";
  run_id: string;
  root: string;
  summary_path: string;
  error?: string;
  metrics?: Record<string, number>;
  readiness: "unverified";
}

/** Reject traversal *before* normalizing: a token removed by '..' is not isolation. */
function remotePath(value: string, label: string): string {
  if (!path.posix.isAbsolute(value) || value.includes("\0") || value.includes("\\")) {
    throw new Error(`${label} must be an absolute POSIX path`);
  }
  if (value.split("/").some(part => part === "." || part === "..")) {
    throw new Error(`${label} must not contain . or .. traversal`);
  }
  return path.posix.normalize(value).replace(/\/$/, "") || "/";
}

/** Freeze safe effective paths, including defaults, before any rsync --delete. */
export function isolateSmokeRemote(remote: RemoteConfig, runId: string, repoName: string): void {
  const base = remotePath(remote.dir, "remote.dir");
  const worktree = remote.worktree || path.posix.join(base, "rsi", "{run_id}", "worktree");
  // Derive from the per-run base, not dirname(custom worktree): the latter can be shared.
  const out = remote.out || path.posix.join(base, "rsi", "{run_id}", "out");
  const effective = [worktree, out].map((template, index) => {
    const label = index === 0 ? "remote.worktree" : "remote.out";
    if (!template.includes("{run_id}")) throw new Error(`${label} must include {run_id} for smoke isolation`);
    const normalized = remotePath(expandRemoteTemplate(template, runId, repoName), label);
    if (!normalized.split("/").some(part => part.includes(runId))) {
      throw new Error(`${label} must retain run_id after normalization`);
    }
    return normalized;
  });
  const [tree, output] = effective;
  if (output === tree || output.startsWith(`${tree}/`) || tree.startsWith(`${output}/`)) {
    throw new Error("remote.out must be outside and separate from the rsync worktree (rsync --delete destroys evidence)");
  }
  remote.dir = base;
  remote.worktree = tree;
  remote.out = output;
}

export function validateAdapterReport(problem: Problem, report: any): Record<string, number> {
  if (!report || report.status !== "ok") throw new Error("adapter report.status is not ok");
  const metrics = report.metrics;
  const expected = problem.metrics.map(spec => spec.name).sort();
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics) ||
      JSON.stringify(Object.keys(metrics).sort()) !== JSON.stringify(expected)) {
    throw new Error("adapter report metric keys do not match fixture");
  }
  for (const spec of problem.metrics) {
    const value = metrics[spec.name];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`metric ${spec.name} is not a finite number`);
    if (spec.bounds && (value < spec.bounds[0] || value > spec.bounds[1])) throw new Error(`metric ${spec.name} is outside bounds`);
  }
  const details = report.details;
  if (details?.training_skipped !== false) {
    throw new Error("adapter details.training_skipped must be false: end-to-end readiness requires actual training evidence");
  }
  if (!Number.isInteger(details.executed_train_steps) || details.executed_train_steps <= 0) {
    throw new Error("adapter details.executed_train_steps must be a positive integer");
  }
  if (details.checkpoint_step !== details.executed_train_steps) {
    throw new Error("adapter details.checkpoint_step must match executed_train_steps");
  }
  for (const field of ["checkpoint", "raw_metrics"]) {
    if (typeof details[field] !== "string" || !details[field].trim()) {
      throw new Error(`adapter details.${field} must identify a nonempty artifact path`);
    }
  }
  return metrics;
}

/** Caller owns execution authority. The extension checks its live experiment policy before calling. */
export async function adapterSmoke(params: AdapterSmokeParams, options: AdapterSmokeOptions = {}): Promise<AdapterSmokeResult> {
  const cwd = options.cwd ?? process.cwd();
  options.signal?.throwIfAborted();
  if (!params.problem?.trim()) throw new Error("problem is required");
  const problem = loadProblem(params.problem, cwd);
  if (params.repo) problem.repo = params.repo.replace(/^@/, "");
  if (problem.repo) problem.repo = path.resolve(cwd, problem.repo);
  if (!problem.repo || !fs.existsSync(problem.repo)) throw new Error("a real local target repository is required (--repo or problem.repo)");
  if (!problem.repo_ref) throw new Error("problem.repo_ref is required");
  if (!problem.experiment_command?.length || !problem.metrics.length) throw new Error("experiment_command and metrics are required");
  if (new Set(problem.metrics.map(spec => spec.name)).size !== problem.metrics.length) throw new Error("fixture metric names must be unique");
  const remote = problem.remote;
  if (!remote?.host || !remote.dir || !remote.gpu_ids) throw new Error("remote host, dir and gpu_ids are required");
  const timeout = params.timeout_s ?? 900;
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("timeout_s must be a positive integer");
  const runId = `adapter-smoke-${randomUUID()}`;
  isolateSmokeRemote(remote, runId, path.basename(problem.repo).replace(/[^a-zA-Z0-9_.-]+/g, "-"));
  remote.timeout_s = timeout;
  remote.ssh_args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...remote.ssh_args];
  remote.env = { ...remote.env, ...params.env };
  for (const [key, value] of Object.entries(remote.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error(`invalid remote environment assignment: ${key}`);
    }
  }
  const root = path.resolve(cwd, params.out?.replace(/^@/, "") ?? path.join("runs", runId));
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root); // Intentionally reject stale evidence and all existing directories.
  const runner = new RemoteRunner(root, { remote, command: problem.experiment_command, runId, timeoutS: timeout, signal: options.signal, transport: options.transport });
  const workspace = new GitWorkspace(problem, defaultConfig({ runner: "subprocess", runId, maxWallTimeS: timeout, disableMeasurementCache: true }), root, runner);
  const summaryPath = workspace.store.artifact("smoke-summary.json");
  const summary: Record<string, unknown> = {
    status: "failed", purpose: "plumbing-only; not a scientific baseline or proof of training",
    readiness: "unverified", readiness_note: "Review the adapter's documented training/evaluation evidence and complete the end-to-end adapter skill before research.",
    fixture: params.problem.trim().startsWith("{") ? "inline" : path.resolve(cwd, params.problem.replace(/^@/, "")),
    run_id: runId, host: remote.host, gpu_ids: remote.gpu_ids,
    env_overrides: params.env ?? {}, remote_worktree: remote.worktree, remote_out_dir: remote.out,
  };
  try {
    options.signal?.throwIfAborted();
    options.onProgress?.("Preparing the real baseline at problem.repo_ref…");
    const repo = await workspace.baselineRepo();
    summary.repo = repo;
    options.signal?.throwIfAborted();
    options.onProgress?.("Running the configured remote subset protocol (no guessed budgets or datasets)…");
    const result = await workspace.run(repo, "subset");
    summary.result = result;
    workspace.store.writeText("smoke-stdout.txt", result.stdout);
    workspace.store.writeText("smoke-stderr.txt", result.stderr);
    const log = result.log_path && fs.existsSync(result.log_path) ? JSON.parse(fs.readFileSync(result.log_path, "utf8")) : null;
    summary.invocation = log;
    let report: any;
    if (typeof log?.raw_report_path === "string") {
      const raw = fs.readFileSync(log.raw_report_path, "utf8");
      workspace.store.writeText("smoke-report.raw.txt", raw);
      try {
        report = JSON.parse(raw);
        workspace.store.writeJson("smoke-report.json", report);
      } catch (error) {
        summary.report_parse_error = String(error);
      }
    }
    // Original JSON has already been saved, even when the command failed.
    options.signal?.throwIfAborted();
    if (result.status !== "ok") throw new Error(result.stderr || "remote experiment failed");
    if (log?.fetch?.code !== 0 || !report) throw new Error("cannot fetch original adapter report");
    summary.metrics = validateAdapterReport(problem, report);
    summary.pipeline_details = report.details;
    summary.pipeline_metadata_validated = true;
    summary.status = "ok";
  } catch (error) {
    summary.error = String(error);
  } finally {
    workspace.store.writeJson("smoke-summary.json", summary);
  }
  return {
    status: summary.status as "ok" | "failed", run_id: runId, root, summary_path: summaryPath,
    error: summary.error as string | undefined, metrics: summary.metrics as Record<string, number> | undefined,
    readiness: "unverified",
  };
}
