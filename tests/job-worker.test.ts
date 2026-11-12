import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { repoRoot, tempDir } from "./helpers.ts";

const worker = path.join(repoRoot, "skills", "rsi-adapter", "templates", "job_worker.py");
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function spec(options: { command?: string[]; timeout?: number } = {}) {
  const root = fs.realpathSync(tempDir("rsi-worker-"));
  const job = path.join(root, "job");
  const work = path.join(job, "worktree");
  const out = path.join(job, "out", "report.json");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const command = options.command ?? [
    "python3", "-c",
    "import json,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(json.dumps({'status':'ok','metrics':{'loss':1.5}}))",
    out,
  ];
  const request = {
    version: 1, job_id: "job-test", commit: "a".repeat(40), protocol_digest: "sha256:test",
    command, env: { RSI_TEST: "1" }, cwd: work, out, timeout_s: options.timeout ?? 30,
    gpu_ids: "0", lock_dir: path.join(root, "locks"), created_at: new Date().toISOString(),
  };
  const specPath = path.join(job, "request.json");
  fs.writeFileSync(specPath, JSON.stringify(request));
  return { root, job, work, out, specPath, request };
}

const events = (job: string) => fs.readFileSync(path.join(job, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const result = (job: string) => JSON.parse(fs.readFileSync(path.join(job, "result.json"), "utf8"));

test("worker claims, runs, publishes events and an atomic result", () => {
  const h = spec();
  const run = spawnSync("python3", [worker, "--spec", h.specPath], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  const list = events(h.job);
  assert.deepEqual(list.map((event) => event.event), ["claimed", "started", "running", "completed"]);
  assert.deepEqual(list.map((event) => event.seq), [1, 2, 3, 4]);
  const out = result(h.job);
  assert.equal(out.status, "ok");
  assert.equal(out.report.metrics.loss, 1.5);
  assert.equal(out.job_id, "job-test");
  assert.equal(list.at(-1).result_sha256, sha256(path.join(h.job, "result.json")));
  assert.ok(fs.existsSync(path.join(h.job, "claimed")));
});

test("a second worker cannot claim the same job and does not rerun it", () => {
  const h = spec();
  assert.equal(spawnSync("python3", [worker, "--spec", h.specPath], { encoding: "utf8" }).status, 0);
  const before = events(h.job).length;
  const second = spawnSync("python3", [worker, "--spec", h.specPath], { encoding: "utf8" });
  assert.equal(second.status, 0);
  assert.match(second.stderr, /already claimed/);
  assert.equal(events(h.job).length, before);
});

test("a missing adapter report is a failed result, not a false success", () => {
  const h = spec({ command: ["python3", "-c", "print('did nothing')"] });
  const run = spawnSync("python3", [worker, "--spec", h.specPath], { encoding: "utf8" });
  assert.equal(run.status, 1);
  const out = result(h.job);
  assert.equal(out.status, "failed");
  assert.match(out.error, /report not found/);
  assert.equal(events(h.job).at(-1).event, "failed");
});

test("a report with status failed is rejected", () => {
  const h = spec();
  const command = ["python3", "-c",
    "import json,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(json.dumps({'status':'failed','metrics':{}}))", h.out];
  const rerun = spec({ command });
  const run = spawnSync("python3", [worker, "--spec", rerun.specPath], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(result(rerun.job).status, "failed");
});

test("timeout kills the process group and records a timeout result", () => {
  const h = spec({ command: ["python3", "-c", "import time; time.sleep(20)"], timeout: 0.5 });
  const started = Date.now();
  const run = spawnSync("python3", [worker, "--spec", h.specPath], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.ok(Date.now() - started < 8000, "timeout must not wait for the sleeper");
  assert.equal(result(h.job).status, "timeout");
  assert.equal(events(h.job).at(-1).event, "failed");
});

test("a cancel request terminates the process group", async () => {
  const h = spec({ command: ["python3", "-c", "import time; time.sleep(30)"] });
  const child = spawn("python3", [worker, "--spec", h.specPath], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(h.job, "events.jsonl")) &&
        events(h.job).some((event) => event.event === "running")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fs.writeFileSync(path.join(h.job, "cancel"), "");
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 1);
  assert.equal(result(h.job).status, "cancelled");
  assert.equal(events(h.job).at(-1).event, "failed");
});

test("paths outside the job directory are rejected before execution", () => {
  const h = spec();
  h.request.cwd = "/tmp";
  fs.writeFileSync(h.specPath, JSON.stringify(h.request));
  const run = spawnSync("python3", [worker, "--spec", h.specPath], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /inside the job directory/);
  assert.equal(fs.existsSync(path.join(h.job, "events.jsonl")), false);
});
