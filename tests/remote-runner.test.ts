import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { RemoteRunner, shellQuote, buildRemoteInvocation } from "../src/rsi/runtime/workspace.ts";
import type { RemoteConfig } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

function remote(over: Partial<RemoteConfig> = {}): RemoteConfig {
  return {
    host: "gpu@example.test",
    dir: "/data/rsi",
    worktree: "",
    out: "",
    python: "python3",
    setup: "",
    ssh_args: [],
    rsync_args: [],
    gpu_ids: "0",
    env: {},
    timeout_s: 60,
    excludes: [],
    ...over,
  };
}

function request(repo: string) {
  return {
    idea_id: "idea",
    scope: "subset" as const,
    repo: { path: repo, label: "candidate", parent: "a", patch: "", commit: "b" },
    datasets: [],
    metrics: ["score"],
    idea: null,
    label: "candidate",
  };
}

/** Records every remote command and answers like a healthy server. */
function recorder() {
  const commands: string[] = [];
  const transport = async (binary: string, args: readonly string[]) => {
    const script = args[args.length - 1] ?? "";
    commands.push(`${binary} ${script}`);
    if (binary === "rsync") return { code: 0, stdout: "", stderr: "", killed: false };
    if (script.startsWith("cat ")) {
      return { code: 0, stdout: '{"metrics":{"score":1.5}}', stderr: "", killed: false };
    }
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  return { commands, transport };
}

function repo(): string {
  const dir = tempDir("rsi-remote-repo-");
  fs.writeFileSync(path.join(dir, "train.py"), "print('x')\n", "utf8");
  return dir;
}

test("shellQuote keeps a leading home expansion outside the quotes", () => {
  assert.equal(shellQuote("~/rsi"), "~/'rsi'");
  assert.equal(shellQuote("~/rsi/my run"), "~/'rsi/my run'");
  assert.equal(shellQuote("/data/rsi"), "/data/rsi");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("the default remote worktree is per run, not the shared source root", async () => {
  const repoPath = repo();
  const store = tempDir("rsi-remote-store-");
  const paths: string[] = [];
  for (const runId of ["run-a", "run-b"]) {
    const seen = recorder();
    const runner = new RemoteRunner(store, {
      remote: remote(),
      command: null,
      runId,
      transport: seen.transport as any,
    });
    const result = await runner.run(request(repoPath));
    assert.equal(result.status, "ok", result.stderr);
    // The mkdir command carries the resolved worktree path.
    const mkdir = seen.commands.find((line) => line.includes("mkdir -p"))!;
    paths.push(mkdir);
  }
  assert.notEqual(paths[0], paths[1], "two runs must not sync into one directory");
  assert.match(paths[0], /\/data\/rsi\/rsi\/run-a\/worktree/);
  assert.match(paths[1], /\/data\/rsi\/rsi\/run-b\/worktree/);
});

test("an explicit remote worktree template still wins", async () => {
  const seen = recorder();
  const runner = new RemoteRunner(tempDir("rsi-remote-store-"), {
    remote: remote({ worktree: "/scratch/{repo}/{run_id}" }),
    command: null,
    runId: "run-a",
    transport: seen.transport as any,
  });
  const result = await runner.run(request(repo()));
  assert.equal(result.status, "ok", result.stderr);
  const mkdir = seen.commands.find((line) => line.includes("mkdir -p"))!;
  assert.match(mkdir, /\/scratch\//);
});

test("results of two runs land in separate output directories", async () => {
  const repoPath = repo();
  const store = tempDir("rsi-remote-store-");
  const dirs: string[] = [];
  for (const runId of ["run-a", "run-b"]) {
    const seen = recorder();
    const runner = new RemoteRunner(store, { remote: remote(), command: null, runId, transport: seen.transport as any });
    assert.equal((await runner.run(request(repoPath))).status, "ok");
    dirs.push(seen.commands.find((line) => line.startsWith("ssh cat "))!);
  }
  assert.notEqual(dirs[0], dirs[1]);
});

test("in-session preflight and setup failures prevent experiment execution", () => {
  const root = repo();
  const marker = path.join(root, "executed");
  const command = ["python3", "-c", "from pathlib import Path; Path('executed').touch()"];
  const req = { ...request(root), preflight: ["sh", "-c", "exit 7"] };
  const failedPreflight = buildRemoteInvocation(remote(), command, req, root, path.join(root, "result.json"));
  assert.equal(spawnSync("bash", ["-lc", failedPreflight.inner]).status, 7);
  assert.equal(fs.existsSync(marker), false);
  const failedSetup = buildRemoteInvocation(remote({ setup: "false" }), command, { ...req, preflight: [] }, root, path.join(root, "result.json"));
  assert.notEqual(spawnSync("bash", ["-lc", failedSetup.inner]).status, 0);
  assert.equal(fs.existsSync(marker), false);
});
