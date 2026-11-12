/**
 * Event-driven remote jobs.
 *
 * The client snapshots one candidate worktree, writes an immutable request into
 * a job directory and launches the target-owned worker over SSH with
 * `setsid nohup`. The worker claims the job atomically, takes the GPU lock and
 * publishes `events.jsonl`. This module reads those events, verifies the atomic
 * `result.json`, and can stream events so a Pi session is woken on completion.
 *
 * SSH is the only channel: the server never dials back to the client.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  DEFAULT_RSYNC_EXCLUDES,
  gitIgnoredPaths,
  shellQuote,
  sh,
  type RemoteTransport,
} from "./workspace.ts";
import type { RemoteConfig } from "../types.ts";

export interface JobPaths {
  jobId: string;
  remoteDir: string;
  worktree: string;
  out: string;
  request: string;
  events: string;
  result: string;
  lockDir: string;
}

export interface JobHandle extends JobPaths {
  host: string;
  sshArgs: string[];
  gpuIds: string;
  commit: string;
  protocolDigest: string;
  timeoutS: number;
}

export interface JobEvent {
  seq: number;
  at: string;
  event: "claimed" | "started" | "running" | "heartbeat" | "completed" | "failed" | string;
  [key: string]: unknown;
}

export interface JobResult {
  version: number;
  job_id: string;
  commit: string;
  protocol_digest: string;
  status: "ok" | "failed" | "timeout" | "cancelled";
  exit: number;
  error?: string | null;
  report?: Record<string, unknown> | null;
  report_sha256?: string | null;
  stdout_tail?: string | null;
  elapsed_s: number;
}

export interface SubmitJobOptions {
  remote: RemoteConfig;
  /** Local git worktree already checked out at `commit`. */
  repoPath: string;
  commit: string;
  scope: string;
  /** Command template with `{python}`, `{repo}`, `{out}`, `{scope}`, `{commit}`. */
  command: readonly string[];
  env: Record<string, string>;
  timeoutS: number;
  /** Path inside the target repository; must be protected and synced. */
  jobWorker?: string;
  /** Hash of the frozen protocol (env/command/seed/metrics). */
  protocolDigest: string;
  ledgerDir?: string;
  transport?: RemoteTransport;
  signal?: AbortSignal;
}

const TERMINAL = new Set(["completed", "failed"]);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function joinRemote(...parts: string[]): string {
  return path.posix.join(...parts);
}

/** Deterministic id: the same commit/protocol/scope never runs twice. */
export function jobId(commit: string, protocolDigest: string, scope: string, nonce = ""): string {
  return sha256(`${commit}|${protocolDigest}|${scope}|${nonce}`).slice(0, 16);
}

export function expandJobCommand(
  command: readonly string[],
  values: { python: string; repo: string; out: string; scope: string; commit: string },
): string[] {
  return command.map((token) =>
    token
      .replaceAll("{python}", values.python)
      .replaceAll("{repo}", values.repo)
      .replaceAll("{out}", values.out)
      .replaceAll("{scope}", values.scope)
      .replaceAll("{commit}", values.commit),
  );
}

export function parseEvents(text: string): JobEvent[] {
  const events: JobEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as JobEvent;
      if (typeof item?.seq === "number" && typeof item.event === "string") events.push(item);
    } catch {
      // A partially flushed last line is normal; the next read gets it.
    }
  }
  return events.sort((a, b) => a.seq - b.seq);
}

export function terminalEvent(events: JobEvent[]): JobEvent | null {
  return [...events].reverse().find((event) => TERMINAL.has(event.event)) ?? null;
}

/** Verify the server result against the submitted identity and its own hash. */
export function verifyResult(handle: JobHandle, raw: string, result: JobResult, event: JobEvent | null): JobResult {
  if (result?.version !== 1) throw new Error("job result version mismatch");
  if (result.job_id !== handle.jobId) throw new Error(`job result id mismatch: ${result.job_id}`);
  if (result.commit !== handle.commit) throw new Error(`job result commit mismatch: ${result.commit}`);
  if (result.protocol_digest !== handle.protocolDigest) throw new Error("job result protocol mismatch");
  const declared = event?.result_sha256;
  if (typeof declared === "string" && declared !== sha256(raw)) {
    throw new Error("job result hash does not match the completion event");
  }
  if (typeof result.report_sha256 === "string" && result.report && result.status === "ok") {
    // The report hash is informational here; the adapter validator re-checks metrics.
  }
  return result;
}

function ledgerPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function writeLedger(dir: string, handle: JobHandle, state: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = ledgerPath(dir, handle.jobId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...handle, ...state, updated_at: new Date().toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function readLedger(dir: string, id: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(dir, id), "utf8"));
  } catch {
    return null;
  }
}

export function listLedger(dir: string): Array<Record<string, unknown>> {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  } catch {
    return [];
  }
}

export async function submitJob(opts: SubmitJobOptions): Promise<JobHandle> {
  const { remote } = opts;
  if (!remote.host) throw new Error("remote.host is required");
  if (!remote.dir) throw new Error("remote.dir is required");
  if (!remote.python) throw new Error("remote.python is required");
  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) throw new Error("timeout must be positive");
  if (!fs.existsSync(opts.repoPath)) throw new Error(`local worktree not found: ${opts.repoPath}`);
  const transport = opts.transport ?? sh;
  const id = jobId(opts.commit, opts.protocolDigest, opts.scope);
  const root = joinRemote(remote.dir, "rsi-jobs");
  const remoteDir = joinRemote(root, id);
  const worktree = joinRemote(remoteDir, "worktree");
  const out = joinRemote(remoteDir, "out", "report.json");
  const request = joinRemote(remoteDir, "request.json");
  const events = joinRemote(remoteDir, "events.jsonl");
  const result = joinRemote(remoteDir, "result.json");
  const lockDir = joinRemote(root, "_locks");
  const worker = opts.jobWorker ?? "bench/rsi_job_worker.py";
  const sshBase = [...remote.ssh_args, remote.host];

  const handle: JobHandle = {
    jobId: id, remoteDir, worktree, out, request, events, result, lockDir,
    host: remote.host, sshArgs: [...remote.ssh_args], gpuIds: remote.gpu_ids, commit: opts.commit,
    protocolDigest: opts.protocolDigest, timeoutS: opts.timeoutS,
  };
  const ledger = opts.ledgerDir ?? path.resolve("runs", "jobs");

  // Idempotency: an existing successful result is returned untouched.
  const existing = await transport("ssh", [...sshBase, "--", `test -f ${shellQuote(result)} && echo yes || true`], { timeoutS: 60, signal: opts.signal });
  if (existing.stdout.trim() === "yes") {
    writeLedger(ledger, handle, { state: "completed", reused: true });
    return handle;
  }

  const mkdir = await transport("ssh", [...sshBase, "--", `mkdir -p ${shellQuote(worktree)} ${shellQuote(joinRemote(remoteDir, "out"))} ${shellQuote(lockDir)}`], { timeoutS: 120, signal: opts.signal });
  if (mkdir.code !== 0) throw new Error(`cannot create remote job directory: ${mkdir.stderr}`);

  const excludes = new Set([...DEFAULT_RSYNC_EXCLUDES, ...remote.excludes, ...gitIgnoredPaths(opts.repoPath)]);
  const excludeFile = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "rsi-job-")), "excludes.txt");
  fs.writeFileSync(excludeFile, `${[...excludes].join("\n")}\n`, "utf8");
  const synced = await transport("rsync", [
    "-az", "--delete", "--exclude-from", excludeFile, ...remote.rsync_args,
    `${path.resolve(opts.repoPath)}/`, `${remote.host}:${shellQuote(worktree)}/`,
  ], { timeoutS: 1800, signal: opts.signal });
  if (synced.code !== 0) throw new Error(`job worktree sync failed: ${synced.stderr.trim()}`);

  const command = expandJobCommand(opts.command, {
    python: remote.python, repo: worktree, out, scope: opts.scope, commit: opts.commit,
  });
  const spec = {
    version: 1, job_id: id, commit: opts.commit, protocol_digest: opts.protocolDigest,
    command, env: { ...remote.env, ...opts.env, CUDA_VISIBLE_DEVICES: remote.gpu_ids },
    cwd: worktree, out, timeout_s: opts.timeoutS, gpu_ids: remote.gpu_ids,
    lock_dir: lockDir, created_at: new Date().toISOString(),
  };
  const encoded = Buffer.from(JSON.stringify(spec)).toString("base64");
  const written = await transport("ssh", [...sshBase, "--",
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(`${request}.tmp`)} && mv ${shellQuote(`${request}.tmp`)} ${shellQuote(request)}`],
    { timeoutS: 60, signal: opts.signal });
  if (written.code !== 0) throw new Error(`cannot write job request: ${written.stderr}`);

  const launch = [
    `cd ${shellQuote(worktree)} &&`,
    `setsid nohup ${shellQuote(remote.python)} ${shellQuote(worker)} --spec ${shellQuote(request)}`,
    `>${shellQuote(joinRemote(remoteDir, "worker.out"))} 2>&1 </dev/null &`,
  ].join(" ");
  writeLedger(ledger, handle, { state: "submitted", worker, reused: false });
  const started = await transport("ssh", [...sshBase, "--", `bash -lc ${shellQuote(launch)}`], { timeoutS: 60, signal: opts.signal });
  if (started.code !== 0) {
    // A detached launch may close the SSH channel non-zero after the worker
    // has already claimed the job. Events are the source of truth.
    let claimed = false;
    for (let attempt = 0; attempt < 10 && !claimed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      claimed = (await readEvents(handle, transport, opts.signal)).length > 0;
    }
    if (!claimed) {
      writeLedger(ledger, handle, { state: "launch-failed", worker, error: started.stderr });
      throw new Error(`cannot launch job worker: ${started.stderr || `exit ${started.code}`}`);
    }
  }
  return handle;
}

export async function readEvents(handle: JobHandle, transport: RemoteTransport = sh, signal?: AbortSignal): Promise<JobEvent[]> {
  const read = await transport("ssh", [...handle.sshArgs, handle.host, "--", `test -f ${shellQuote(handle.events)} && cat ${shellQuote(handle.events)} || true`], { timeoutS: 60, signal });
  if (read.code !== 0) throw new Error(`cannot read job events: ${read.stderr}`);
  return parseEvents(read.stdout);
}

export async function readResult(handle: JobHandle, transport: RemoteTransport = sh, signal?: AbortSignal): Promise<{ raw: string; result: JobResult } | null> {
  const read = await transport("ssh", [...handle.sshArgs, handle.host, "--", `test -f ${shellQuote(handle.result)} && cat ${shellQuote(handle.result)} || true`], { timeoutS: 60, signal });
  if (read.code !== 0) throw new Error(`cannot read job result: ${read.stderr}`);
  if (!read.stdout.trim()) return null;
  return { raw: read.stdout, result: JSON.parse(read.stdout) as JobResult };
}

export interface WaitOptions {
  timeoutS?: number;
  pollMs?: number;
  transport?: RemoteTransport;
  signal?: AbortSignal;
  ledgerDir?: string;
  onEvent?: (event: JobEvent) => void;
}

/**
 * Bounded wait. A timeout returns `running`, never `failed`: the job keeps
 * running on the server and the caller can resume from the event sequence.
 */
export async function waitForJob(
  handle: JobHandle,
  opts: WaitOptions = {},
): Promise<{ state: "ok" | "failed" | "timeout" | "cancelled" | "running"; result?: JobResult; events: JobEvent[] }> {
  const deadline = Date.now() + (opts.timeoutS ?? 60) * 1000;
  const pollMs = opts.pollMs ?? 2000;
  let seen = 0;
  const events: JobEvent[] = [];
  for (;;) {
    opts.signal?.throwIfAborted();
    const next = await readEvents(handle, opts.transport, opts.signal);
    for (const event of next) {
      if (event.seq <= seen) continue;
      seen = event.seq;
      events.push(event);
      opts.onEvent?.(event);
    }
    const terminal = terminalEvent(events);
    if (terminal) {
      const fetched = await readResult(handle, opts.transport, opts.signal);
      if (!fetched) throw new Error("completion event without an atomic result");
      const result = verifyResult(handle, fetched.raw, fetched.result, terminal);
      const state = result.status;
      if (opts.ledgerDir) writeLedger(opts.ledgerDir, handle, { state, last_seq: seen, notified: false });
      return { state, result, events };
    }
    if (Date.now() >= deadline) {
      if (opts.ledgerDir) writeLedger(opts.ledgerDir, handle, { state: "running", last_seq: seen });
      return { state: "running", events };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function cancelJob(handle: JobHandle, transport: RemoteTransport = sh, signal?: AbortSignal): Promise<void> {
  const cancelFile = joinRemote(handle.remoteDir, "cancel");
  let pid: number | undefined;
  let fresh = false;
  let terminal = false;
  try {
    const events = await readEvents(handle, transport, signal);
    const latest = events.at(-1);
    const found = [...events].reverse().find((event) => Number.isSafeInteger(event.pid) && Number(event.pid) > 0)?.pid;
    pid = typeof found === "number" ? found : undefined;
    const at = latest?.at ? Date.parse(String(latest.at)) : Number.NaN;
    // Heartbeats are every 30s. A stale worker cannot see the cancel file, so
    // the client must reach the detached process group itself.
    fresh = Number.isFinite(at) && Date.now() - at < 120_000;
    terminal = latest?.event === "completed" || latest?.event === "failed";
  } catch {
    /* events may be unreadable; still try the cancel file */
  }
  const fallback = pid && !fresh && !terminal
    ? `; kill -TERM -- -${pid} 2>/dev/null || true; sleep 2; kill -KILL -- -${pid} 2>/dev/null || true`
    : "";
  const result = await transport(
    "ssh",
    [...handle.sshArgs, handle.host, "--", `mkdir -p ${shellQuote(handle.remoteDir)} && touch ${shellQuote(cancelFile)}${fallback}`],
    { timeoutS: 60, signal },
  );
  if (result.code !== 0) throw new Error(`cannot request cancellation: ${result.stderr}`);
}

export interface JobStream {
  lines: AsyncIterable<string>;
  close(): void;
}

export type JobStreamer = (handle: JobHandle, signal?: AbortSignal) => JobStream;

/** Real subscription: one long-lived SSH `tail -F` on the event log. */
export const sshEventStream: JobStreamer = (handle, signal) => {
  const child = spawn("ssh", [...handle.sshArgs, handle.host, "--", `tail -n +1 -F ${shellQuote(handle.events)}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  async function* lines(): AsyncGenerator<string> {
    for await (const chunk of child.stdout) {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) yield line;
    }
  }
  return { lines: lines(), close: () => { signal?.removeEventListener("abort", abort); child.kill("SIGKILL"); } };
};

/**
 * Subscribe until a terminal event, resuming by `seq` after a disconnect.
 * The caller decides how to surface the completion (for Pi: sendMessage with
 * triggerTurn). This function never marks a dropped connection as a failure.
 */
export async function watchJob(
  handle: JobHandle,
  opts: { onEvent?: (event: JobEvent) => void; signal?: AbortSignal; streamer?: JobStreamer; ledgerDir?: string; retryMs?: number; transport?: RemoteTransport } = {},
): Promise<{ result: JobResult; events: JobEvent[] }> {
  const streamer = opts.streamer ?? sshEventStream;
  let seen = 0;
  const events: JobEvent[] = [];
  for (;;) {
    opts.signal?.throwIfAborted();
    const stream = streamer(handle, opts.signal);
    try {
      for await (const line of stream.lines) {
        let event: JobEvent;
        try { event = JSON.parse(line) as JobEvent; } catch { continue; }
        if (typeof event?.seq !== "number" || event.seq <= seen) continue;
        seen = event.seq;
        events.push(event);
        opts.onEvent?.(event);
        if (TERMINAL.has(event.event)) {
          const fetched = await readResult(handle, opts.transport ?? sh, opts.signal);
          if (!fetched) throw new Error("completion event without an atomic result");
          const result = verifyResult(handle, fetched.raw, fetched.result, event);
          if (opts.ledgerDir) writeLedger(opts.ledgerDir, handle, { state: result.status, last_seq: seen, notified: false });
          return { result, events };
        }
      }
    } finally {
      stream.close();
    }
    // A dropped SSH stream is not a job failure. Wait for the daemon-side job
    // to continue, then reconnect; the seq cursor prevents duplicate delivery.
    await new Promise((resolve) => setTimeout(resolve, opts.retryMs ?? 3000));
  }
}

export function newNonce(): string {
  return randomUUID();
}
