import test from "node:test";
import assert from "node:assert/strict";

import { buildRemoteInvocation, GitWorkspace, RemoteRunner, shellQuote } from "../src/rsi/runtime/workspace.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import { loadProblem } from "../src/rsi/run.ts";
import { fixture, tempDir } from "./helpers.ts";
import type { ExperimentRequest } from "../src/rsi/runtime/workspace.ts";
import type { RemoteConfig } from "../src/rsi/types.ts";

const remote: RemoteConfig = {
  host: "gpu-node",
  dir: "/data/rsi",
  python: "/opt/conda/bin/python",
  ssh_args: ["-o", "BatchMode=yes"],
  rsync_args: [],
  gpu_ids: "0,1",
  env: { HF_HOME: "/data/hf", TOKENIZERS_PARALLELISM: "false" },
  timeout_s: 3600,
  excludes: [],
};

const req: ExperimentRequest = {
  idea_id: "h1",
  scope: "full",
  repo: {
    path: "/local/worktree",
    label: "h1-full",
    parent: "abc",
    patch: "",
    repo: "/local/target",
    commit: "abc123",
    branch: "rsi/run/h1-full-1",
  },
  datasets: [],
  metrics: ["word_ppl"],
  idea: null,
  label: "h1-full",
};

test("remote invocation exports GPU/env and expands placeholders", () => {
  const invocation = buildRemoteInvocation(
    remote,
    ["{python}", "bench/eval.py", "--repo", "{repo}", "--scope", "{scope}", "--out", "{out}", "--commit", "{commit}"],
    req,
    "/data/rsi/rsi/run/worktree",
    "/data/rsi/rsi/run/out/1.json",
  );
  assert.match(invocation.inner, /^cd \/data\/rsi\/rsi\/run\/worktree &&/);
  assert.match(invocation.inner, /CUDA_VISIBLE_DEVICES=0,1/);
  assert.match(invocation.inner, /HF_HOME=\/data\/hf/);
  assert.match(invocation.inner, /timeout 3600/);
  assert.match(invocation.inner, /\/opt\/conda\/bin\/python/);
  assert.match(invocation.inner, /--scope full/);
  assert.match(invocation.inner, /--out \/data\/rsi\/rsi\/run\/out\/1.json/);
  assert.match(invocation.inner, /--commit abc123/);
  assert.deepEqual(invocation.env, {
    HF_HOME: "/data/hf",
    TOKENIZERS_PARALLELISM: "false",
    CUDA_VISIBLE_DEVICES: "0,1",
  });
});

test("shellQuote escapes single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote("/tmp/a b"), "'/tmp/a b'");
});

test("remote invocation without GPU ids leaves CUDA_VISIBLE_DEVICES unset", () => {
  const invocation = buildRemoteInvocation(
    { ...remote, gpu_ids: "", env: {}, timeout_s: 0 },
    ["true"],
    req,
    "/remote/worktree",
    "/remote/out.json",
  );
  assert.doesNotMatch(invocation.inner, /CUDA_VISIBLE_DEVICES/);
  assert.doesNotMatch(invocation.inner, /timeout /);
});

test("a Problem with remote selects RemoteRunner", () => {
  const problem = loadProblem(fixture("dfm_ssm"));
  assert.ok(problem.remote);
  const workspace = new GitWorkspace(
    problem,
    defaultConfig({ runner: "subprocess", runId: "remote-select" }),
    tempDir("rsi-remote-select-"),
  );
  assert.ok(workspace.runner instanceof RemoteRunner);
});
