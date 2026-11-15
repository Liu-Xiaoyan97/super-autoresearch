/**
 * Client side of the secret-free check worker.
 *
 * The worker is a separate container/process with no credentials and no
 * network. The only channel is a request/result directory under the run root:
 * the main process writes a job, the worker writes the report. Missing workers
 * block checks by default. Explicit `RSI_CHECK_WORKER=off` selects the local executor.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RepoRef } from "../types.ts";
import { safeCheckLabel, type CheckReport } from "./checks.ts";
import type { CheckJobRequest, CheckJobResult, CheckWorkerReady } from "./check-protocol.ts";

export type CheckWorkerMode = "off" | "auto" | "required";

export function checkWorkerMode(env: NodeJS.ProcessEnv = process.env): CheckWorkerMode {
  const raw = (env.RSI_CHECK_WORKER ?? "required").trim().toLowerCase();
  if (raw === "auto" || raw === "required" || raw === "off") return raw;
  return "required";
}

/** Default worker mailbox: the sibling of the run root, never inside the worktree. */
export function checkWorkerDir(runRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RSI_CHECK_WORKER_DIR;
  return configured ? path.resolve(configured) : path.resolve(runRoot, "..", ".check-worker");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A stopped worker leaves ready.json behind; ignore it when the pid is local and dead. */
export function checkWorkerReady(dir: string): boolean {
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(dir, "ready.json"), "utf8")) as CheckWorkerReady;
    if (ready.protocol !== 3) return false;
    if (typeof ready.pid === "number" && ready.host === os.hostname() && !processAlive(ready.pid)) return false;
    return true;
  } catch {
    return false;
  }
}

export function workerUnavailableReport(repo: RepoRef, message: string, status: "unavailable" | "timeout" = "unavailable"): CheckReport {
  return {
    commit: repo.commit ?? "",
    parent: repo.parent,
    languages: [],
    changed_files: [],
    status: "unavailable",
    checks: [{
      id: "check-worker",
      command: [],
      status,
      severity: "required",
      exit_code: null,
      stdout: "",
      stderr: message,
      duration_s: 0,
    }],
  };
}

function readJson(file: string): CheckJobResult | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CheckJobResult;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Submit one job and wait for its report. The request id is unique, so a
 * resumed run can retry without reading a stale result.
 */
export async function runCheckInWorker(
  dir: string,
  request: Omit<CheckJobRequest, "id">,
  opts: { pollMs?: number } = {},
): Promise<CheckReport> {
  const id = `${safeCheckLabel(request.label)}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job: CheckJobRequest = { ...request, id };
  const pending = path.join(dir, "pending", `${id}.json`);
  const resultFile = path.join(dir, "results", `${id}.json`);
  writeAtomic(pending, job);
  const deadline = Date.now() + Math.max(1000, request.timeoutMs);
  const pollMs = Math.max(25, opts.pollMs ?? 100);
  while (Date.now() < deadline) {
    const result = readJson(resultFile);
    if (result) {
      if (result.report) return result.report;
      return workerUnavailableReport(request.repo, result.error || "check worker returned no report");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  writeAtomic(path.join(dir, "cancel", `${id}.json`), { id, at: new Date().toISOString() });
  return workerUnavailableReport(
    request.repo,
    `check worker did not finish within ${Math.round(request.timeoutMs / 1000)}s`,
    "timeout",
  );
}
