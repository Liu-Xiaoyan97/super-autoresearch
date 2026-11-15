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

function repoWithAdapter(checks: unknown[]): string {
  const root = tempDir("rsi-check-repo-");
  fs.mkdirSync(path.join(root, ".rsi"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.py"), "x = 1\n", "utf8");
  fs.writeFileSync(path.join(root, ".rsi", "adapter.json"), JSON.stringify({
    problem: "check-problem",
    languages: {
      python: {
        extensions: [".py"],
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

test("a missing required tool is unavailable, never a silent pass", async () => {
  const { workspace, repoRef } = await candidate([
    { id: "missing", command: ["definitely-not-a-real-tool-xyz"] },
  ]);
  const report = await workspace.check(repoRef, "h1-subset");
  assert.equal(report.status, "failed");
  assert.equal(report.checks[0].status, "unavailable");
});

test("a failed check never invokes the experiment runner", async () => {
  const ctx = makeContext({ config: { runner: "subprocess" } });
  let runs = 0;
  ctx.workspace = {
    brief: () => "",
    writePatch: async (repo: any, patch: string, label: string) => ({
      ...repo,
      label,
      patch,
      parent: repo.commit,
      commit: "candidate-commit",
      branch: "candidate",
    }),
    check: async () => ({
      commit: "candidate-commit",
      parent: "base-commit",
      languages: ["python"],
      changed_files: ["a.py"],
      status: "failed",
      checks: [{ id: "compile", command: ["sh", "-c", "exit 1"], status: "failed", severity: "required", exit_code: 1, stdout: "", stderr: "compile error", duration_s: 0.1 }],
    }),
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
  await evidence;
  assert.equal(runs, 0);
});
