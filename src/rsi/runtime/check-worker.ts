/**
 * Secret-free deterministic-check worker.
 *
 * Run this process in a separate container with no credentials and no network
 * (`network_mode: none`). The only writable mount is the `runs/` directory; the
 * RSI source tree and the target repository are read-only. The worker receives
 * jobs through `runs/.check-worker/pending/` and writes reports through
 * `results/`. It never reads API keys from the environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CheckJobRequest, CheckJobResult, CheckWorkerReady } from "./check-protocol.ts";
import { runCheckJob } from "./checks.ts";
import { ArtifactStore } from "./store.ts";

const dir = path.resolve(process.env.RSI_CHECK_WORKER_DIR || "runs/.check-worker");
const allowedRoot = path.dirname(dir);
const pending = path.join(dir, "pending");
const running = path.join(dir, "running");
const results = path.join(dir, "results");
const cancel = path.join(dir, "cancel");

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function log(message: string): void {
  process.stdout.write(`[check-worker] ${message}\n`);
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJob(file: string): CheckJobRequest | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CheckJobRequest;
  } catch {
    return null;
  }
}

function validate(job: CheckJobRequest): void {
  if (!inside(allowedRoot, job.root)) {
    throw new Error(`run root escapes the worker mailbox: ${job.root}`);
  }
  if (!inside(job.root, job.repo.path)) {
    throw new Error(`candidate worktree escapes its run root: ${job.repo.path}`);
  }
  if (!job.repo.commit || !job.repo.parent) {
    throw new Error("check worker requires a real candidate commit and parent");
  }
  if (!job.specs || typeof job.specs !== "object") throw new Error("request has no language specs");
  if (!Array.isArray(job.languages) || !Array.isArray(job.changedFiles)) {
    throw new Error("request has invalid language or changed-file lists");
  }
}

async function processOne(file: string): Promise<void> {
  const source = path.join(pending, file);
  const claim = path.join(running, file);
  try {
    fs.renameSync(source, claim);
  } catch {
    return; // another worker or a stale entry won the claim
  }
  const job = readJob(claim);
  let result: CheckJobResult;
  if (!job) {
    result = { error: "invalid check request" };
  } else if (fs.existsSync(path.join(cancel, `${job.id}.json`))) {
    result = { error: "check request was cancelled before it started" };
  } else {
    const started = Date.now();
    try {
      validate(job);
      const report = await runCheckJob(
        new ArtifactStore(job.root),
        job.repo,
        job.label,
        job.specs,
        job.languages,
        job.changedFiles,
        job.lsp ?? {},
      );
      result = { report };
      log(`${job.id} ${report.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      result = { error: (error as Error).message || String(error) };
      log(`${job.id} failed: ${result.error}`);
    }
  }
  writeAtomic(path.join(results, `${path.basename(file, ".json")}.json`), result);
  try { fs.rmSync(claim, { force: true }); } catch { /* stale claim is harmless */ }
}

function moveStaleClaims(): void {
  try {
    for (const name of fs.readdirSync(running).filter((item) => item.endsWith(".json"))) {
      const from = path.join(running, name);
      const to = path.join(pending, name);
      try { fs.renameSync(from, to); } catch { /* keep the claim */ }
    }
  } catch { /* no running directory yet */ }
}

async function main(): Promise<void> {
  for (const item of [pending, running, results, cancel]) fs.mkdirSync(item, { recursive: true });
  moveStaleClaims();
  const ready: CheckWorkerReady = { pid: process.pid, host: os.hostname(), started_at: new Date().toISOString() };
  writeAtomic(path.join(dir, "ready.json"), ready);
  log(`ready; mailbox ${dir}; allowed run root ${allowedRoot}`);
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (!stopping) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(pending).filter((name) => name.endsWith(".json")).sort();
    } catch {
      names = [];
    }
    if (!names.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      continue;
    }
    for (const name of names) {
      if (stopping) break;
      await processOne(name);
    }
  }
  try { fs.rmSync(path.join(dir, "ready.json"), { force: true }); } catch { /* already gone */ }
  log("stopped");
}

main().catch((error) => {
  log(`fatal: ${(error as Error).message || String(error)}`);
  process.exitCode = 1;
});
