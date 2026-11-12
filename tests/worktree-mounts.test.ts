import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitWorkspace } from "../src/rsi/runtime/workspace.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import { makeProblem } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

test("creating a candidate does not prune user worktrees invisible in another mount namespace", async () => {
  const root = tempDir("rsi-mount-namespace-");
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "target source\n");
  git("add", "README.md");
  git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline");
  git("worktree", "add", "--detach", path.join(root, "other-runtime"));
  const admin = path.join(repo, ".git/worktrees/other-runtime");
  // Simulate a valid user checkout that exists only under another runtime's mount.
  fs.writeFileSync(path.join(admin, "gitdir"), "/invisible-other-runtime/user-checkout/.git\n");
  const problem = makeProblem({ id: "mount-safety", repo, repo_ref: "HEAD" });
  const workspace = new GitWorkspace(problem, defaultConfig(), path.join(root, "fresh-run"));
  const baseline = await workspace.baselineRepo();
  assert.ok(baseline.commit);
  assert.equal(fs.existsSync(admin), true, "must not globally prune user metadata");
  assert.equal(fs.readFileSync(path.join(admin, "gitdir"), "utf8"), "/invisible-other-runtime/user-checkout/.git\n");
});
