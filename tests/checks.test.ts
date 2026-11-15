import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { defaultConfig } from "../src/rsi/config.ts";
import { GitWorkspace } from "../src/rsi/runtime/workspace.ts";
import { SubsetCoder } from "../src/rsi/agents/coding.ts";
import { makeEvidence, makeIdea, makeProblem } from "../src/rsi/types.ts";
import { makeContext } from "./helpers.ts";
import { tempDir } from "./helpers.ts";

function repoWithAdapter(checks: unknown[], python?: string): string {
  const root = tempDir("rsi-check-repo-");
  fs.mkdirSync(path.join(root, ".rsi"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.py"), "x = 1\n", "utf8");
  fs.writeFileSync(path.join(root, ".rsi", "adapter.json"), JSON.stringify({
    problem: "check-problem",
    languages: {
      python: {
        extensions: [".py"],
        ...(python ? { python } : {}),
        checks: checks.map((check) => ({ timeoutS: 10, severity: "required", ...(check as object) })),
      },
    },
  }), "utf8");
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]);
  git(["-c", "user.name=T", "-c", "user.email=t@local", "add", "-A"]);
  git(["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "baseline"]);
  return root;
}

async function candidate(checks: unknown[]) {
  const repo = repoWithAdapter(checks);
  const problem = makeProblem({ id: "check-problem", repo });
  const workspace = new GitWorkspace(problem, defaultConfig({ runner: "subprocess" }), tempDir("rsi-check-run-"));
  const base = await workspace.baselineRepo();
  const patch = ["--- a/a.py", "+++ b/a.py", "@@ -1 +1 @@", "-x = 1", "+x = 2"].join("\n");
  const repoRef = await workspace.writePatch(base, patch, "h1-subset");
  return { workspace, repoRef };
}

test("required check failure is reported and persisted", async () => {
  const { workspace, repoRef } = await candidate([
    { id: "ok", command: ["sh", "-c", "exit 0"] },
    { id: "bad", command: ["sh", "-c", "printf 'boom' >&2; exit 1"] },
  ]);
  const report = await workspace.check(repoRef, "h1-subset");
  assert.equal(report.status, "failed");
  const bad = report.checks.find((check) => check.id === "bad");
  assert.equal(bad?.status, "failed");
  assert.match(bad?.stderr ?? "", /boom/);
  assert.ok(fs.existsSync(path.join(repoRef.path, "..", "artifacts", "checks", "h1-subset", "report.json")));
});

test("a green required check passes; an advisory failure does not block", async () => {
  const { workspace, repoRef } = await candidate([
    { id: "ok", command: ["sh", "-c", "exit 0"] },
    { id: "style", command: ["sh", "-c", "exit 3"], severity: "advisory" },
  ]);
  const report = await workspace.check(repoRef, "h1-subset");
  assert.equal(report.status, "ok");
  assert.equal(report.checks.find((check) => check.id === "style")?.status, "failed");
});

test("advisory checks alone cannot authorize experiment delivery", async () => {
  const { workspace, repoRef } = await candidate([
    { id: "style", command: ["sh", "-c", "exit 0"], severity: "advisory" },
  ]);
  const report = await workspace.check(repoRef, "advisory-only");
  assert.equal(report.checks[0].status, "ok");
  assert.equal(report.status, "unavailable");
});

test("a missing required tool is unavailable, never a silent pass", async () => {
  const { workspace, repoRef } = await candidate([
    { id: "missing", command: ["definitely-not-a-real-tool-xyz"] },
  ]);
  const report = await workspace.check(repoRef, "h1-subset");
  assert.equal(report.status, "failed");
  assert.equal(report.checks[0].status, "unavailable");
});

test("the adapter Python resolves from the target source checkout", async () => {
  const repo = repoWithAdapter(
    [{ id: "configured-python", command: ["{python}"] }],
    ".rsi/fake-python",
  );
  const fake = path.join(repo, ".rsi", "fake-python");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(fake, 0o755);
  const problem = makeProblem({ id: "check-problem", repo });
  const workspace = new GitWorkspace(problem, defaultConfig({ runner: "subprocess" }), tempDir("rsi-check-run-"));
  const base = await workspace.baselineRepo();
  const patch = ["--- a/a.py", "+++ b/a.py", "@@ -1 +1 @@", "-x = 1", "+x = 2"].join("\n");
  const repoRef = await workspace.writePatch(base, patch, "h1-subset");
  // The fake interpreter is untracked, so it exists only in the source checkout.
  assert.equal(fs.existsSync(path.join(repoRef.path, ".rsi", "fake-python")), false);
  const report = await workspace.check(repoRef, "h1-subset-python");
  assert.equal(report.status, "ok");
  assert.equal(report.checks[0].command[0], fs.realpathSync(fake));
  assert.equal(report.checks[0].status, "ok");
});

test("a failed check never invokes the experiment runner", async () => {
  const ctx = makeContext({ config: { runner: "subprocess" } });
  let runs = 0;
  let checks = 0;
  ctx.workspace = {
    brief: () => "a.py: x = 2",
    writePatch: async (repo: any, patch: string, label: string) => ({
      ...repo,
      label,
      patch,
      parent: repo.commit,
      commit: "candidate-commit",
      branch: "candidate",
    }),
    check: async () => {
      checks += 1;
      return {
        commit: "candidate-commit",
        parent: "base-commit",
        languages: ["python"],
        changed_files: ["a.py"],
        status: "failed",
        checks: [{ id: "compile", command: ["sh", "-c", "exit 1"], status: "failed", severity: "required", exit_code: 1, stdout: "", stderr: "compile error", duration_s: 0.1 }],
      };
    },
    run: async () => {
      runs += 1;
      throw new Error("runner must not run");
    },
  } as any;
  const base = makeEvidence({
    idea_id: "baseline",
    scope: "subset",
    metrics: { auroc: 0.5 },
    code: { path: "", label: "baseline", parent: null, patch: "", commit: "base-commit" },
    result: { metrics: { auroc: 0.5 }, status: "ok", log_path: "", stdout: "", stderr: "", wall_time_s: 0 },
  });
  const evidence = new SubsetCoder(ctx).implement(
    makeIdea({ id: "h1", mechanism: "alignment", hypothesis: "alignment helps" }),
    { base, seeds: [7, 8, 9] },
  );
  const result = await evidence;
  assert.equal(checks, 1);
  assert.match(result.result?.stderr ?? "", /compile error/);
  assert.equal(runs, 0);
});

test("check reports persist across a resumed workspace", async () => {
  const counter = path.join(tempDir("rsi-check-count-"), "runs.log");
  const repo = repoWithAdapter([{
    id: "count",
    command: ["sh", "-c", `printf x >> ${counter}`],
    env: { RSI_CHECK_COUNTER: counter },
  }]);
  const problem = makeProblem({ id: "check-problem", repo });
  const runRoot = tempDir("rsi-check-resume-");
  const config = defaultConfig({ runner: "subprocess" });
  const first = new GitWorkspace(problem, config, runRoot);
  const base = await first.baselineRepo();
  const patch = ["--- a/a.py", "+++ b/a.py", "@@ -1 +1 @@", "-x = 1", "+x = 2"].join("\n");
  const repoRef = await first.writePatch(base, patch, "h1-subset");
  const one = await first.check(repoRef, "h1-subset");
  assert.equal(one.status, "ok");
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  const resumed = new GitWorkspace(problem, config, runRoot);
  const two = await resumed.check(repoRef, "h1-subset-resume");
  assert.equal(two.status, "ok");
  assert.equal(fs.readFileSync(counter, "utf8"), "x", "the resumed check must come from the report cache");
  assert.match(two.report_path ?? "", /h1-subset-resume/);
});

test("required worker mode fails closed when no worker is ready", async () => {
  const previousMode = process.env.RSI_CHECK_WORKER;
  const previousDir = process.env.RSI_CHECK_WORKER_DIR;
  process.env.RSI_CHECK_WORKER = "required";
  process.env.RSI_CHECK_WORKER_DIR = path.join(tempDir("rsi-check-missing-"), ".check-worker");
  try {
    const { workspace, repoRef } = await candidate([{ id: "ok", command: ["sh", "-c", "exit 0"] }]);
    const report = await workspace.check(repoRef, "h1-subset");
    assert.equal(report.status, "unavailable");
    assert.equal(report.checks[0].id, "check-worker");
    assert.equal(report.checks[0].status, "unavailable");
  } finally {
    if (previousMode === undefined) delete process.env.RSI_CHECK_WORKER;
    else process.env.RSI_CHECK_WORKER = previousMode;
    if (previousDir === undefined) delete process.env.RSI_CHECK_WORKER_DIR;
    else process.env.RSI_CHECK_WORKER_DIR = previousDir;
  }
});

test("language specs retain only supported adapter settings", async () => {
  const { languageSpecs } = await import("../src/rsi/runtime/checks.ts");
  const specs = languageSpecs({ languages: { python: { checks: [], obsolete_setting: { command: ["obsolete"] } } } } as any);
  assert.equal("obsolete_setting" in specs.python, false);
  assert.deepEqual(specs.python.checks, []);
});

test("default compiled-language checks use only their test commands", async () => {
  const { languageSpecs } = await import("../src/rsi/runtime/checks.ts");
  const specs = languageSpecs(null);
  assert.deepEqual(specs.rust.checks.map((check) => check.command), [["cargo", "test", "--locked", "--all-targets"]]);
  assert.deepEqual(specs.go.checks.map((check) => check.command), [["go", "test", "-v", "./..."]]);
  const migrated = languageSpecs({ languages: { python: { checks: [
    { id: "old", command: ["pyright"], severity: "advisory", timeoutS: 1 },
    { id: "tests", command: ["python3", "-m", "pytest"], severity: "required", timeoutS: 10 },
  ] } } });
  assert.deepEqual(migrated.python.checks.map((check) => check.id), ["tests"]);
});

test("check cache is invalidated when an executor binary changes", async () => {
  const tool = path.join(tempDir("rsi-executor-"), "check.sh");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(tool, 0o755);
  const { workspace, repoRef } = await candidate([{ id: "executor", command: [tool] }]);
  const first = await workspace.check(repoRef, "before-tool-change");
  assert.equal(first.status, "ok");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 12\n");
  const second = await workspace.check(repoRef, "after-tool-change");
  assert.equal(second.status, "failed");
  assert.notEqual(first.environment_fingerprint, second.environment_fingerprint);
});

test("pytest records executed assertions against the candidate checkout", async () => {
  const repo = repoWithAdapter([{ id: "tests", command: ["{python}", "-m", "pytest", "-q", "tests"] }]);
  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, "tests/test_candidate.py"), "import a\ndef test_candidate():\n    assert a.x == 2\n");
  for (const args of [["add", "tests"], ["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "trusted tests"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  }
  const workspace = new GitWorkspace(makeProblem({ id: "check-problem", repo }), defaultConfig({ runner: "subprocess" }), tempDir("rsi-assertions-"));
  const base = await workspace.baselineRepo();
  const ref = await workspace.writePatch(base, "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n", "candidate");
  await workspace.baselineRepo();
  const report = await workspace.check(ref, "executed-assertions");
  assert.equal(report.status, "ok", JSON.stringify(report.checks));
  assert.ok(report.checks[0].executed_tests?.includes("tests/test_candidate.py:test_candidate"));
});

test("Python syntax check compiles the changed files only", async () => {
  const repo = repoWithAdapter([{ id: "compile", command: ["{python}", "-m", "py_compile", "{changed_python_files}"] }]);
  fs.writeFileSync(path.join(repo, "unrelated.py"), "def broken(\n");
  for (const args of [["add", "unrelated.py"], ["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "existing unrelated syntax"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  }
  const workspace = new GitWorkspace(makeProblem({ id: "check-problem", repo }), defaultConfig({ runner: "subprocess" }), tempDir("rsi-syntax-"));
  const base = await workspace.baselineRepo();
  const patch = ["--- a/a.py", "+++ b/a.py", "@@ -1 +1 @@", "-x = 1", "+x = 2", ""].join("\n");
  const candidate = await workspace.writePatch(base, patch, "syntax");
  const report = await workspace.check(candidate, "syntax");
  assert.equal(report.status, "unavailable");
  assert.equal(report.checks[0].status, "ok");
  assert.deepEqual(report.checks[0].command.slice(-1), ["a.py"]);
});
