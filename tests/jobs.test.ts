import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  cancelJob, jobId, listLedger, parseEvents, readLedger, readResult, submitJob, terminalEvent, verifyResult, waitForJob,
  type JobEvent, type JobHandle, type JobResult,
} from "../src/rsi/runtime/jobs.ts";
import type { RemoteConfig } from "../src/rsi/types.ts";
import type { RemoteTransport } from "../src/rsi/runtime/workspace.ts";
import { tempDir } from "./helpers.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const result = (status: JobResult["status"] = "ok"): JobResult => ({
  version: 1, job_id: "job-1", commit: "a".repeat(40), protocol_digest: "sha256:p",
  status, exit: status === "ok" ? 0 : 1, report: status === "ok" ? { status: "ok", metrics: { loss: 1 } } : null,
  report_sha256: "r", elapsed_s: 1,
});

const remote: RemoteConfig = {
  host: "mock-host", dir: "/remote", worktree: "", out: "", python: "/opt/py",
  setup: "", ssh_args: ["-o", "BatchMode=yes"], rsync_args: [], gpu_ids: "0",
  env: { RSI_X: "1" }, timeout_s: 60, excludes: [],
};

function handle(over: Partial<JobHandle> = {}): JobHandle {
  const commit = "a".repeat(40);
  return {
    jobId: "job-1", remoteDir: "/remote/rsi-jobs/job-1", worktree: "/remote/rsi-jobs/job-1/worktree",
    out: "/remote/rsi-jobs/job-1/out/report.json", request: "/remote/rsi-jobs/job-1/request.json",
    events: "/remote/rsi-jobs/job-1/events.jsonl", result: "/remote/rsi-jobs/job-1/result.json",
    lockDir: "/remote/rsi-jobs/_locks", host: "mock-host", sshArgs: [], gpuIds: "0",
    commit, protocolDigest: "sha256:p", timeoutS: 60, ...over,
  };
}

function recorder(): { transport: RemoteTransport; calls: Array<{ binary: string; args: string[] }> } {
  const calls: Array<{ binary: string; args: string[] }> = [];
  const transport: RemoteTransport = async (binary, args) => {
    calls.push({ binary, args: [...args] });
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  return { transport, calls };
}

test("job ids are deterministic for the same commit, protocol and scope", () => {
  assert.equal(jobId("a".repeat(40), "sha256:p", "subset"), jobId("a".repeat(40), "sha256:p", "subset"));
  assert.notEqual(jobId("a".repeat(40), "sha256:p", "subset"), jobId("b".repeat(40), "sha256:p", "subset"));
  assert.match(jobId("a", "b", "subset"), /^[0-9a-f]{16}$/);
});

test("submit snapshots the worktree, writes an immutable request and launches detached", async () => {
  const repo = tempDir("rsi-job-repo-");
  fs.writeFileSync(path.join(repo, "train.py"), "rate = 1\n");
  const ledger = tempDir("rsi-job-ledger-");
  const { transport, calls } = recorder();
  const submitted = await submitJob({
    remote, repoPath: repo, commit: "a".repeat(40), scope: "subset",
    command: ["{python}", "bench/run.py", "--repo", "{repo}", "--scope", "{scope}", "--out", "{out}"],
    env: { STEPS: "2" }, timeoutS: 120, protocolDigest: "sha256:p", ledgerDir: ledger, transport,
  });
  assert.match(submitted.jobId, /^[0-9a-f]{16}$/);
  assert.ok(calls.some((call) => call.binary === "rsync"));
  const write = calls.find((call) => call.args.at(-1)?.includes("request.json"));
  assert.ok(write, "request write");
  const encoded = /printf %s '?([A-Za-z0-9+/=]+)'?/.exec(write!.args.at(-1)!)![1];
  const spec = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.deepEqual(spec.command, ["/opt/py", "bench/run.py", "--repo", submitted.worktree, "--scope", "subset", "--out", submitted.out]);
  assert.equal(spec.env.STEPS, "2");
  assert.equal(spec.env.CUDA_VISIBLE_DEVICES, "0");
  assert.equal(spec.env.RSI_X, "1");
  assert.equal(spec.gpu_ids, "0");
  const launch = calls.at(-1)!;
  assert.match(launch.args.at(-1)!, /setsid nohup/);
  assert.match(launch.args.at(-1)!, /bench\/rsi_job_worker\.py/);
  const saved = readLedger(ledger, submitted.jobId);
  assert.equal(saved?.state, "submitted");
  assert.equal(saved?.jobId, submitted.jobId);
});

test("an existing result makes resubmission idempotent", async () => {
  const repo = tempDir("rsi-job-repo-");
  const { transport, calls } = recorder();
  const existing: RemoteTransport = async (binary, args, opts) => {
    if (binary === "ssh" && args.at(-1)?.includes("test -f") && args.at(-1)?.includes("result.json")) {
      calls.push({ binary, args: [...args] });
      return { code: 0, stdout: "yes\n", stderr: "", killed: false };
    }
    return transport(binary, args, opts);
  };
  const submitted = await submitJob({
    remote, repoPath: repo, commit: "a".repeat(40), scope: "subset",
    command: ["{python}", "run.py"], env: {}, timeoutS: 60, protocolDigest: "sha256:p", transport: existing, ledgerDir: tempDir("rsi-job-ledger-"),
  });
  assert.ok(submitted.jobId);
  assert.equal(calls.some((call) => call.binary === "rsync"), false, "no resync when the result exists");
});

test("waitForJob returns the terminal result and verifies its identity and hash", async () => {
  const raw = JSON.stringify({ ...result(), job_id: "job-1", commit: "a".repeat(40), protocol_digest: "sha256:p" });
  const completed: JobEvent = { seq: 4, at: "t", event: "completed", result_sha256: sha256(raw) };
  const events = [
    { seq: 1, at: "t", event: "claimed" },
    { seq: 2, at: "t", event: "started" },
    { seq: 3, at: "t", event: "running" },
    completed,
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  let polls = 0;
  const transport: RemoteTransport = async (_binary, args) => {
    const command = args.at(-1)!;
    if (command.includes("events.jsonl")) {
      polls += 1;
      return { code: 0, stdout: polls === 1 ? events.split("\n").slice(0, 2).join("\n") : events, stderr: "", killed: false };
    }
    if (command.includes("result.json")) return { code: 0, stdout: raw, stderr: "", killed: false };
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  const waited = await waitForJob(handle(), { timeoutS: 5, pollMs: 10, transport });
  assert.equal(waited.state, "ok");
  assert.deepEqual(waited.result?.report, { status: "ok", metrics: { loss: 1 } });
  assert.equal(waited.events.at(-1)?.event, "completed");
});

test("a completion event with a mismatched result hash is rejected", async () => {
  const raw = JSON.stringify({ ...result(), job_id: "job-1", commit: "a".repeat(40), protocol_digest: "sha256:p" });
  const event: JobEvent = { seq: 1, at: "t", event: "completed", result_sha256: "deadbeef" };
  assert.throws(() => verifyResult(handle(), raw, JSON.parse(raw), event), /hash does not match/);
});

test("result identity mismatches are rejected", () => {
  const raw = JSON.stringify(result());
  assert.throws(() => verifyResult(handle({ jobId: "other" }), raw, JSON.parse(raw), null), /id mismatch/);
  assert.throws(() => verifyResult(handle({ commit: "b".repeat(40) }), raw, JSON.parse(raw), null), /commit mismatch/);
  const other = { ...result(), protocol_digest: "sha256:other" };
  assert.throws(() => verifyResult(handle(), JSON.stringify(other), other, null), /protocol mismatch/);
});

test("a bounded wait returns running, never failed", async () => {
  const transport: RemoteTransport = async (_binary, args) => {
    if (args.at(-1)?.includes("events.jsonl")) {
      return { code: 0, stdout: '{"seq":1,"at":"t","event":"running"}\n', stderr: "", killed: false };
    }
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  const waited = await waitForJob(handle(), { timeoutS: 0.05, pollMs: 10, transport });
  assert.equal(waited.state, "running");
  assert.equal(waited.result, undefined);
});

test("cancel writes the cancel marker and events parse tolerantly", async () => {
  const calls: string[] = [];
  const transport: RemoteTransport = async (_binary, args) => {
    calls.push(args.at(-1)!);
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  await cancelJob(handle(), transport);
  assert.ok(calls.some((command) => command.includes("cancel")));
  const parsed = parseEvents('{"seq":1,"event":"running"}\n{"seq":2,"event":"comp');
  assert.deepEqual(parsed.map((event) => event.seq), [1]);
  assert.equal(terminalEvent(parsed), null);
});

test("ledger listing returns submitted jobs without a remote call", async () => {
  const ledger = tempDir("rsi-job-ledger-");
  const { transport } = recorder();
  const repo = tempDir("rsi-job-repo-");
  await submitJob({ remote, repoPath: repo, commit: "a".repeat(40), scope: "subset", command: ["{python}", "run.py"], env: {}, timeoutS: 30, protocolDigest: "sha256:p", transport, ledgerDir: ledger });
  const rows = listLedger(ledger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "submitted");
});

test("readResult returns null before the atomic result exists", async () => {
  const transport: RemoteTransport = async () => ({ code: 0, stdout: "", stderr: "", killed: false });
  assert.equal(await readResult(handle(), transport), null);
});

test("a detached launch that closes SSH non-zero is accepted when events appear", async () => {
  const repo = tempDir("rsi-job-repo-");
  const transport: RemoteTransport = async (_binary, args) => {
    const command = args.at(-1) ?? "";
    if (command.includes("setsid nohup")) return { code: 255, stdout: "", stderr: "Connection to host closed", killed: false };
    if (command.includes("events.jsonl") && command.includes("cat")) {
      return { code: 0, stdout: '{"seq":1,"at":"t","event":"claimed"}\n', stderr: "", killed: false };
    }
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  const submitted = await submitJob({
    remote, repoPath: repo, commit: "a".repeat(40), scope: "subset",
    command: ["{python}", "run.py"], env: {}, timeoutS: 30, protocolDigest: "sha256:p",
    transport, ledgerDir: tempDir("rsi-job-ledger-"),
  });
  assert.ok(submitted.jobId);
});
