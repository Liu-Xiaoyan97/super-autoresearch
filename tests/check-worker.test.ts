import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  checkWorkerDir,
  checkWorkerMode,
  checkWorkerReady,
  runCheckInWorker,
  workerUnavailableReport,
} from "../src/rsi/runtime/check-client.ts";
import type { CheckJobRequest } from "../src/rsi/runtime/check-protocol.ts";
import type { LanguageSpec } from "../src/rsi/runtime/checks.ts";
import type { RepoRef } from "../src/rsi/types.ts";
import { repoRoot, tempDir } from "./helpers.ts";

function layout(): { runs: string; root: string; repo: string; workerDir: string } {
  const base = tempDir("rsi-check-worker-");
  const runs = path.join(base, "runs");
  const root = path.join(runs, "run-1");
  const repo = path.join(root, "worktree");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "a.py"), "x = 1\n", "utf8");
  const workerDir = path.join(runs, ".check-worker");
  return { runs, root, repo, workerDir };
}

function ref(repo: string): RepoRef {
  return {
    path: repo,
    label: "candidate",
    parent: "parent-commit",
    patch: "",
    repo: path.dirname(repo),
    commit: "candidate-commit",
    branch: "candidate",
  };
}

function specs(exitCode = 0): Record<string, LanguageSpec> {
  return {
    python: {
      id: "python",
      extensions: [".py"],
      checks: [{
        id: "smoke",
        command: ["sh", "-c", `printf 'checked' >&2; printf '%s\\n' '{"executed_tests":["tests/test_worker.py::test_worker"]}'; exit ${exitCode}`],
        timeoutS: 5,
        severity: "required",
      }],
    },
  };
}

function request(root: string, repo: string, languageSpecs = specs(), label = "candidate"): Omit<CheckJobRequest, "id"> {
  return {
    root,
    repo: ref(repo),
    label,
    specs: languageSpecs,
    languages: ["python"],
    changedFiles: ["a.py"],
    timeoutMs: 15000,
  };
}

async function waitFor(file: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function worker(workerDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["src/rsi/runtime/check-worker.ts"], {
    cwd: repoRoot,
    env: { ...process.env, RSI_CHECK_WORKER_DIR: workerDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(path.join(workerDir, "ready.json"));
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 2000).unref?.();
  });
}

test("worker mode and readiness are explicit", () => {
  assert.equal(checkWorkerMode({} as NodeJS.ProcessEnv), "required");
  assert.equal(checkWorkerMode({ RSI_CHECK_WORKER: "auto" } as NodeJS.ProcessEnv), "auto");
  assert.equal(checkWorkerMode({ RSI_CHECK_WORKER: "required" } as NodeJS.ProcessEnv), "required");
  assert.equal(checkWorkerMode({ RSI_CHECK_WORKER: "typo" } as NodeJS.ProcessEnv), "required");
  const { root, workerDir } = layout();
  assert.equal(checkWorkerDir(root, {} as NodeJS.ProcessEnv), path.join(path.dirname(root), ".check-worker"));
  assert.equal(checkWorkerReady(workerDir), false);
});

test("the worker runs required checks and writes the same artifact contract", async (t) => {
  const { root, repo, workerDir } = layout();
  const child = await worker(workerDir);
  t.after(() => stop(child));
  const report = await runCheckInWorker(workerDir, request(root, repo), { pollMs: 25 });
  assert.equal(report.status, "ok");
  assert.equal(report.commit, "candidate-commit");
  assert.equal(report.checks[0].status, "ok");
  assert.match(report.checks[0].stderr, /checked/);
  assert.ok(report.report_path);
  assert.ok(fs.existsSync(report.report_path));
});

test("a required failure stays a failed report, not a local pass", async (t) => {
  const { root, repo, workerDir } = layout();
  const child = await worker(workerDir);
  t.after(() => stop(child));
  const report = await runCheckInWorker(workerDir, request(root, repo, specs(7), "candidate-7"), { pollMs: 25 });
  assert.equal(report.status, "failed");
  assert.equal(report.checks[0].status, "failed");
  assert.equal(report.checks[0].exit_code, 7);
});

test("the worker rejects a candidate worktree outside the run root", async (t) => {
  const { runs, root, workerDir } = layout();
  const outside = path.join(runs, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const child = await worker(workerDir);
  t.after(() => stop(child));
  const report = await runCheckInWorker(workerDir, request(root, outside), { pollMs: 25 });
  assert.equal(report.status, "unavailable");
  assert.match(report.checks[0].stderr, /escapes/);
});

test("a missing worker fails closed when required", () => {
  const { root, workerDir } = layout();
  assert.equal(checkWorkerReady(workerDir), false);
  const report = workerUnavailableReport(ref(path.join(root, "worktree")), `not ready at ${workerDir}`);
  assert.equal(report.status, "unavailable");
  assert.equal(report.checks[0].status, "unavailable");
  assert.match(report.checks[0].stderr, /not ready/);
});
