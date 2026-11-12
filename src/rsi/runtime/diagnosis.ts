/**
 * Measured, read-only diagnosis of the reproduced baseline.
 *
 * The target owns the analysis (adapter rule): RSI only expands the declared
 * `diagnose_command` on the same local/rsync+SSH surface as experiments, fetches
 * the JSON report and validates that at least one evidence-backed finding was
 * actually measured. No project math lives in core and no stale report is ever
 * accepted.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { ArtifactStore } from "./store.ts";
import {
  DEFAULT_RSYNC_EXCLUDES,
  buildRemoteInvocation,
  expandCommand,
  expandRemoteTemplate,
  gitIgnoredPaths,
  sh,
  shellQuote,
} from "./workspace.ts";
import type { DiagnosisFinding, Problem, RepoRef } from "../types.ts";

export interface DiagnosisResult {
  status: "ok" | "failed";
  findings: DiagnosisFinding[];
  stdout: string;
  stderr: string;
  log_path: string;
  wall_time_s: number;
  error?: string;
}

export interface DiagnosisOptions {
  timeoutS: number;
  signal?: AbortSignal;
  /** Internal test seam; production uses real rsync/ssh. */
  transport?: typeof sh;
}

const OUTPUT_LIMIT = 1024 * 1024;
const TAIL = 4000;
let sequence = 0;

const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text);
const bounded = (chunk: string, current: string) =>
  current.length >= OUTPUT_LIMIT ? current : (current + chunk).slice(0, OUTPUT_LIMIT);

function failed(logPath: string, reason: string, extra: Partial<DiagnosisResult> = {}): DiagnosisResult {
  const result: DiagnosisResult = {
    status: "failed",
    findings: [],
    stdout: extra.stdout ?? "",
    stderr: tail(`${extra.stderr ?? ""}\n${reason}`.trim()),
    log_path: logPath,
    wall_time_s: extra.wall_time_s ?? 0,
    error: reason,
  };
  // Persist the failure on every path (local, remote, timeout, validation).
  // The trace only carries log_path, so a missing file otherwise makes the
  // actual remote stderr impossible to inspect locally.
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `${result.stdout}\n--- stderr ---\n${result.stderr}\n`, "utf8");
  } catch {
    /* best effort; the failure reason is still returned in the trace */
  }
  return result;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

/** Validate the exact target contract; a hypothesis may be unmeasured, not unlabelled. */
export function validateDiagnosis(raw: unknown): DiagnosisFinding[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("diagnosis report must be a JSON object");
  const item = raw as Record<string, unknown>;
  if (item.status !== "ok") throw new Error(`diagnosis status is not ok: ${String(item.status)}`);
  if (!Array.isArray(item.findings) || item.findings.length === 0) throw new Error("diagnosis has no findings");
  const ids = new Set<string>();
  const findings: DiagnosisFinding[] = [];
  for (const value of item.findings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("finding must be an object");
    const finding = value as Record<string, unknown>;
    const id = typeof finding.id === "string" ? finding.id.trim() : "";
    if (!id) throw new Error("finding.id is required");
    if (ids.has(id)) throw new Error(`duplicate finding id: ${id}`);
    ids.add(id);
    for (const field of ["title", "axis", "evidence"]) {
      if (typeof finding[field] !== "string" || !(finding[field] as string).trim()) {
        throw new Error(`finding ${id}.${field} is required`);
      }
      if ((finding[field] as string).length > 2000) throw new Error(`finding ${id}.${field} is too long`);
    }
    const severity = number(finding.severity, `finding ${id}.severity`);
    if (severity < 0 || severity > 1) throw new Error(`finding ${id}.severity must be in [0,1]`);
    if (typeof finding.actionable !== "boolean") throw new Error(`finding ${id}.actionable must be boolean`);
    if (typeof finding.measured !== "boolean") throw new Error(`finding ${id}.measured must be boolean`);
    const out: DiagnosisFinding = {
      id,
      title: finding.title as string,
      axis: finding.axis as string,
      evidence: finding.evidence as string,
      severity,
      actionable: finding.actionable,
      measured: finding.measured,
    };
    if (finding.metric !== undefined) {
      if (typeof finding.metric !== "string" || !finding.metric.trim()) throw new Error(`finding ${id}.metric must be a string`);
      out.metric = finding.metric;
    }
    if (finding.value !== undefined) out.value = number(finding.value, `finding ${id}.value`);
    if (finding.artifact !== undefined) {
      if (typeof finding.artifact !== "string" || finding.artifact.length > 2000) {
        throw new Error(`finding ${id}.artifact must be a bounded string`);
      }
      out.artifact = finding.artifact;
    }
    findings.push(out);
  }
  if (!findings.some((finding) => finding.measured)) {
    throw new Error("diagnosis has no measured finding; unmeasured hypotheses cannot prioritize work");
  }
  return findings.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
}

/** Read a fresh report, not a file left by an earlier run. */
function readReport(file: string, since: number): unknown {
  const stat = fs.statSync(file);
  if (stat.mtimeMs + 1 < since) throw new Error("diagnosis report predates this invocation (stale output)");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function local(command: string[], repo: string, logPath: string, timeoutS: number, signal?: AbortSignal): Promise<{
  code: number; stdout: string; stderr: string; killed: boolean;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command[0], command.slice(1), { cwd: repo, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
      catch { child.kill(sig); }
    };
    const abort = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 500).unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      stderr += `\nTimeoutError: diagnosis exceeded ${timeoutS}s`;
      abort();
    }, timeoutS * 1000);
    const finish = (code: number, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fs.writeFileSync(logPath, `${stdout}\n--- stderr ---\n${stderr}\n`, "utf8");
      resolve({ code, stdout, stderr, killed: sig === "SIGKILL" || sig === "SIGTERM" });
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = bounded(chunk.toString("utf8"), stdout); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = bounded(chunk.toString("utf8"), stderr); });
    child.on("error", (error) => { stderr += `\n${error.message}`; finish(1, null); });
    child.on("close", (code, sig) => finish(code ?? 1, sig));
  });
}

export async function runDiagnosis(
  problem: Problem,
  repo: RepoRef,
  store: ArtifactStore,
  opts: DiagnosisOptions,
): Promise<DiagnosisResult> {
  const command = problem.diagnose_command;
  if (!command?.length) throw new Error("problem.diagnose_command is required");
  if (!repo.repo) throw new Error("diagnosis requires the external target repository");
  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) throw new Error("diagnosis timeout must be positive");
  const started = Date.now();
  const seq = ++sequence;
  const name = `diagnosis-${String(seq).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
  const logPath = store.artifact(`experiments/${name}.log`);
  const req = {
    idea_id: "baseline",
    scope: "subset" as const,
    repo,
    datasets: problem.subset_datasets.slice(),
    metrics: problem.metrics.map((metric) => metric.name),
    idea: null,
    label: "diagnosis",
  };
  const transport = opts.transport ?? sh;
  let lastStdout = "";
  let lastStderr = "";

  try {
    opts.signal?.throwIfAborted();
    let raw: unknown;
    let stdout = "";
    let stderr = "";
    if (!problem.remote) {
      const out = store.artifact(`experiments/${name}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const argv = expandCommand(command, req, repo.path, out);
      const since = Date.now();
      const result = await local(argv, repo.path, logPath, opts.timeoutS, opts.signal);
      stdout = result.stdout;
      stderr = result.stderr;
      lastStdout = stdout;
      lastStderr = stderr;
      if (result.code !== 0) return failed(logPath, `diagnosis command exited ${result.code}${result.killed ? " (killed)" : ""}`, { stdout: tail(stdout), stderr: tail(stderr) });
      raw = readReport(out, since);
      store.writeText(`experiments/${name}.raw.json`, JSON.stringify(raw, null, 2) + "\n");
    } else {
      const remote = { ...problem.remote, env: { ...problem.remote.env } };
      const runId = `diag-${randomUUID()}`;
      const base = remote.dir;
      const worktree = expandRemoteTemplate(remote.worktree || path.posix.join(base, "rsi", "{run_id}", "worktree"), runId, "diagnosis");
      const outDir = expandRemoteTemplate(remote.out || path.posix.join(base, "rsi", "{run_id}", "out"), runId, "diagnosis");
      if (outDir === worktree || outDir.startsWith(`${worktree}/`) || worktree.startsWith(`${outDir}/`)) {
        throw new Error("remote.out must be outside the diagnosis worktree");
      }
      const remoteOut = path.posix.join(outDir, `${name}.json`);
      const mkdir = await transport("ssh", [...remote.ssh_args, remote.host, "--", `mkdir -p ${shellQuote(worktree)} ${shellQuote(outDir)}`], { timeoutS: 120, signal: opts.signal });
      if (mkdir.code !== 0) return failed(logPath, `cannot create remote diagnosis directories: ${mkdir.stderr}`);
      const excludes = new Set([...DEFAULT_RSYNC_EXCLUDES, ...remote.excludes, ...gitIgnoredPaths(repo.path)]);
      const excludeFile = store.path("rsync", `${name}.excludes.txt`);
      fs.writeFileSync(excludeFile, `${[...excludes].join("\n")}\n`, "utf8");
      const synced = await transport("rsync", [
        "-az", "--delete", "--exclude-from", excludeFile, ...remote.rsync_args,
        `${path.resolve(repo.path)}/`, `${remote.host}:${shellQuote(worktree)}/`,
      ], { timeoutS: Math.min(1800, Math.max(60, opts.timeoutS)), signal: opts.signal });
      if (synced.code !== 0) return failed(logPath, `diagnosis worktree sync failed: ${tail(synced.stderr)}`);
      // Expand against the remote synced worktree, never the local worktree.
      // buildRemoteInvocation performs the placeholder expansion itself.
      const invocation = buildRemoteInvocation(remote, command, req, worktree, remoteOut);
      const run = await transport("ssh", [...remote.ssh_args, remote.host, "--", `bash -lc ${shellQuote(invocation.inner)}`], { timeoutS: opts.timeoutS, signal: opts.signal });
      stdout = run.stdout;
      stderr = run.stderr;
      lastStdout = stdout;
      lastStderr = stderr;
      if (run.code !== 0) return failed(logPath, `remote diagnosis exited ${run.code}${run.killed ? " (killed)" : ""}`, { stdout: tail(stdout), stderr: tail(stderr) });
      const fetched = await transport("ssh", [...remote.ssh_args, remote.host, "--", `cat ${shellQuote(remoteOut)}`], { timeoutS: 120, signal: opts.signal });
      if (fetched.code !== 0) return failed(logPath, `cannot fetch remote diagnosis report: ${tail(fetched.stderr)}`, { stdout: tail(stdout), stderr: tail(stderr) });
      store.writeText(`experiments/${name}.raw.json`, fetched.stdout);
      raw = JSON.parse(fetched.stdout);
    }
    const findings = validateDiagnosis(raw);
    store.writeJson(`experiments/${name}.json`, {
      scope: "diagnose", command, host: problem.remote?.host ?? "local",
      gpu_ids: problem.remote?.gpu_ids ?? null, commit: repo.commit ?? null,
      findings, status: "ok", wall_time_s: (Date.now() - started) / 1000,
    });
    return {
      status: "ok",
      findings,
      stdout: tail(stdout),
      stderr: tail(stderr),
      log_path: logPath,
      wall_time_s: (Date.now() - started) / 1000,
    };
  } catch (error) {
    return failed(logPath, error instanceof Error ? `${error.name}: ${error.message}` : String(error), {
      stdout: tail(lastStdout),
      stderr: tail(lastStderr),
      wall_time_s: (Date.now() - started) / 1000,
    });
  }
}
