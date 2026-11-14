import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { defaultConfig } from "../src/rsi/config.ts";
import { DEFAULT_EXPERIMENT_COMMAND, GitWorkspace, extractUnifiedDiff } from "../src/rsi/runtime/workspace.ts";
import { makeProblem } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixtureRepo(extra: Record<string, string> = {}): string {
  const root = tempDir("rsi-git-");
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");
  fs.writeFileSync(path.join(repo, "pkg", "cache.py"), "def f():\n    return 1\n", "utf8");
  for (const [name, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content, "utf8");
  }
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-q", "-m", "baseline"]);
  return repo;
}

test("baseline uses a git worktree and a commit, not a file copy", async () => {
  const repo = fixtureRepo();
  const problem = makeProblem({ id: "p", repo });
  const workspace = new GitWorkspace(problem, defaultConfig(), tempDir("rsi-ws-"));
  const snapshot = await workspace.baselineRepo();
  assert.ok(snapshot.commit && snapshot.commit.length >= 7);
  assert.equal(snapshot.branch, "detached");
  assert.ok(fs.existsSync(snapshot.path));
  assert.equal(fs.readFileSync(path.join(snapshot.path, "a.txt"), "utf8"), "hello\n");
  assert.equal(git(repo, ["show", `${snapshot.commit}:a.txt`]), "hello");
  // The source repository's working tree is untouched.
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "hello\n");
});

test("unified diffs become commits on candidate branches", async () => {
  const repo = fixtureRepo();
  const problem = makeProblem({ id: "p", repo });
  const workspace = new GitWorkspace(problem, defaultConfig(), tempDir("rsi-ws-"));
  const base = await workspace.baselineRepo();
  const patch = [
    "Here is the change.",
    "```diff",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-hello",
    "+hello world",
    "```",
    "Hypothesis: this should not be part of the diff.",
  ].join("\n");
  const candidate = await workspace.writePatch(base, patch, "h1-subset");
  assert.ok(candidate.commit);
  assert.notEqual(candidate.commit, base.commit);
  assert.equal(candidate.parent, base.commit);
  assert.match(candidate.branch ?? "", /^rsi\//);
  assert.equal(git(repo, ["show", `${candidate.commit}:a.txt`]), "hello world");
  assert.match(await workspace.diff(base, candidate), /\+hello world/);
  assert.equal(git(repo, ["branch", "--list", candidate.branch!]).length > 0, true);
  // The source working tree still has the original content.
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "hello\n");
});

test("prose creates no commit; a failing diff is refused and logged", async () => {
  const repo = fixtureRepo();
  const problem = makeProblem({ id: "p", repo });
  const workspace = new GitWorkspace(problem, defaultConfig({ runner: "subprocess" }), tempDir("rsi-ws-"));
  const base = await workspace.baselineRepo();

  // A non-empty prose response has no code change. It must be refused, not
  // turned into a baseline measurement under the candidate label.
  await assert.rejects(
    () => workspace.writePatch(base, "Inspect and tune the implementation.", "prose"),
    /no unified diff/,
  );
  assert.match(fs.readFileSync(path.join(base.path, "..", "patches", "prose.apply.log"), "utf8"), /refusing/);
  // The baseline snapshot itself is the only permitted empty patch.
  const empty = await workspace.writePatch(base, "", "baseline-empty");
  assert.equal(empty.commit, base.commit);
  await assert.rejects(() => workspace.writePatch(base, "", "h1-subset"), /only allowed for the baseline/);
  // Full/rebuttal may explicitly re-use the existing snapshot for protocol-only work.
  const protocol = await workspace.writePatch(base, "", "h1-full", { allowEmpty: true });
  assert.equal(protocol.commit, base.commit);


  const bad = ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-does-not-exist", "+nope"].join("\n");
  // A diff that does not apply must never become a candidate at the parent
  // commit: that would measure the baseline as if it were the idea.
  await assert.rejects(() => workspace.writePatch(base, bad, "bad"), /patch does not apply/);
  assert.match(fs.readFileSync(path.join(base.path, "..", "patches", "bad.apply.log"), "utf8"), /status=[1-9]/);
  assert.equal(git(repo, ["show", `${base.commit}:a.txt`]), "hello");
});

test("a configured but missing problem.repo fails loudly", async () => {
  const problem = makeProblem({ id: "p", repo: "/definitely/missing/repo" });
  const workspace = new GitWorkspace(problem, defaultConfig(), tempDir("rsi-ws-"));
  await assert.rejects(() => workspace.baselineRepo(), /problem\.repo not found/);
});

test("experiment_command runs in the candidate worktree and is project-agnostic", async () => {
  const runner = [
    "import argparse, json",
    "from pathlib import Path",
    "p = argparse.ArgumentParser()",
    "p.add_argument('--scope')",
    "p.add_argument('--out')",
    "args = p.parse_args()",
    "Path(args.out).write_text(json.dumps({'metrics': {'exact': 1.0, 'cost': 3}}))",
    "",
  ].join("\n");
  const repo = fixtureRepo({ "bench/run.py": runner });
  const problem = makeProblem({
    id: "p",
    repo,
    experiment_command: ["python3", "bench/run.py", "--scope", "{scope}", "--out", "{out}"],
  });
  const workspace = new GitWorkspace(problem, defaultConfig({ runner: "subprocess" }), tempDir("rsi-ws-"));
  const base = await workspace.baselineRepo();
  const result = await workspace.run(base, "subset");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.metrics, { exact: 1, cost: 3 });
  assert.ok(DEFAULT_EXPERIMENT_COMMAND.includes("run_experiment.py"));
});

test("extractUnifiedDiff keeps only the diff body", () => {
  const text = [
    "prose before",
    "--- a/x.py",
    "+++ b/x.py",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "prose after",
  ].join("\n");
  const diff = extractUnifiedDiff(text);
  assert.ok(diff);
  assert.match(diff, /^--- a\/x\.py/m);
  assert.match(diff, /\+new/);
  assert.doesNotMatch(diff, /prose after/);
  assert.equal(extractUnifiedDiff("just prose"), null);
});

test("brief reads the git tree and relevant files at a commit", async () => {
  const repo = fixtureRepo();
  const problem = makeProblem({ id: "p", repo });
  const workspace = new GitWorkspace(problem, defaultConfig(), tempDir("rsi-ws-"));
  const snapshot = await workspace.baselineRepo();
  const brief = workspace.brief(snapshot, "cache update", 5000);
  assert.match(brief, /Repository tree at/);
  assert.match(brief, /pkg\/cache\.py/);
  assert.match(brief, /def f/);
});

test("a diff with a malformed hunk header still applies when git can verify placement", async () => {
  const repo = fixtureRepo({ "three.txt": "a\nb\nc\nd\ne\n" });
  const problem = makeProblem({ id: "p", repo });
  const workspace = new GitWorkspace(problem, defaultConfig(), tempDir("rsi-ws-"));
  const base = await workspace.baselineRepo();
  // The body is valid (three context lines, one removal); the header lies.
  const malformed = ["--- a/three.txt", "+++ b/three.txt", "@@ -1,6 +1,6 @@", " a", " b", " c", "-d", "+D"].join("\n");
  const candidate = await workspace.writePatch(base, `${malformed}\nHypothesis: test\n`, "malformed-count");
  assert.notEqual(candidate.commit, base.commit);
  assert.equal(git(repo, ["show", `${candidate.commit}:three.txt`]), "a\nb\nc\nD\ne");
  const log = fs.readFileSync(path.join(base.path, "..", "patches", "malformed-count.apply.log"), "utf8");
  assert.match(log, /status=0/);
});

test("a diff that applies but changes nothing is refused, not measured", async () => {
  const repo = fixtureRepo();
  const problem = makeProblem({ id: "p", repo });
  const workspace = new GitWorkspace(problem, defaultConfig(), tempDir("rsi-ws-noop-"));
  const base = await workspace.baselineRepo();
  // Same content on both sides of the hunk: git apply succeeds, the tree is
  // identical, and the parent commit would otherwise become the candidate.
  const noop = ["--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-hello", "+hello"].join("\n");
  await assert.rejects(() => workspace.writePatch(base, noop, "noop"), /produced no change/);
  assert.match(
    fs.readFileSync(path.join(base.path, "..", "patches", "noop.apply.log"), "utf8"),
    /status=0[\s\S]*no change after apply/,
  );
});
