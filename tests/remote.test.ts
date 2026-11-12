import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRemoteInvocation,
  DEFAULT_RSYNC_EXCLUDES,
  expandRemoteTemplate,
  gitIgnoredPaths,
  GitWorkspace,
  RemoteRunner,
  shellQuote,
  subsetBudgetEnv,
  type ExperimentRequest,
  type RemoteTransport,
} from "../src/rsi/runtime/workspace.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/rsi/config.ts";
import { loadProblem } from "../src/rsi/run.ts";
import { fixture, tempDir } from "./helpers.ts";
import { makeProblem, metricSpec, type RemoteConfig } from "../src/rsi/types.ts";

const remote: RemoteConfig = {
  host: "gpu-node",
  dir: "/data/rsi",
  worktree: "",
  out: "",
  setup: "",
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

test("the subset screen uses min(10% of full, 200) real steps", () => {
  const problem = makeProblem({
    id: "budget",
    budget: { full_steps: 954, subset_fraction: 0.1, subset_max_steps: 200, steps_env: "RSI_CORAL_TRAIN_STEPS", seed_env: "RSI_CORAL_SEED" },
    metrics: [metricSpec({ name: "word_ppl", direction: "min" })],
  });
  const config = defaultConfig();
  assert.deepEqual(subsetBudgetEnv(problem, config, "subset"), { RSI_CORAL_TRAIN_STEPS: "95" });
  assert.deepEqual(subsetBudgetEnv(problem, config, "ablation"), { RSI_CORAL_TRAIN_STEPS: "95" });
  assert.deepEqual(subsetBudgetEnv(problem, config, "full"), {});
  assert.deepEqual(
    subsetBudgetEnv(makeProblem({ ...problem, budget: { ...problem.budget!, full_steps: 3815 } }), config, "subset"),
    { RSI_CORAL_TRAIN_STEPS: "200" },
    "the 200-step cap wins over 10% of a large full budget",
  );
  assert.deepEqual(
    subsetBudgetEnv(makeProblem({ ...problem, budget: null }), config, "subset"),
    {},
    "without a declared budget the target keeps its own default",
  );
});

test("scope-specific budget env reaches the remote command", () => {
  const invocation = buildRemoteInvocation(
    { ...remote, env: { HF_HOME: "/data/hf" } },
    ["{python}", "bench/eval.py", "--scope", "{scope}"],
    { ...req, env: { RSI_CORAL_TRAIN_STEPS: "95" } },
    "/remote/worktree",
    "/remote/out.json",
  );
  assert.match(invocation.inner, /RSI_CORAL_TRAIN_STEPS=95/);
  assert.match(invocation.inner, /HF_HOME=\/data\/hf/);
});

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

test("remote invocation requires an explicit GPU id", () => {
  assert.throws(
    () =>
      buildRemoteInvocation(
        { ...remote, gpu_ids: "", env: {}, timeout_s: 0 },
        ["true"],
        req,
        "/remote/worktree",
        "/remote/out.json",
      ),
    /remote\.gpu_ids is required/,
  );
});

test("an aborted remote run kills the detached process group with a fresh SSH call", async () => {
  const controller = new AbortController();
  const calls: Array<{ binary: string; command: string; signal?: AbortSignal }> = [];
  const transport: RemoteTransport = async (binary, args, opts) => {
    const command = String(args.at(-1) ?? "");
    calls.push({ binary, command, signal: opts.signal });
    if (binary === "rsync") return { code: 0, stdout: "", stderr: "", killed: false };
    if (command.includes("mkdir -p")) return { code: 0, stdout: "", stderr: "", killed: false };
    if (command.includes("wait $!")) {
      controller.abort();
      return { code: 1, stdout: "", stderr: "Aborted", killed: true };
    }
    if (command.includes("kill -TERM")) return { code: 0, stdout: "", stderr: "", killed: false };
    return { code: 1, stdout: "", stderr: "Aborted", killed: true };
  };
  const runner = new RemoteRunner(tempDir("rsi-remote-abort-"), {
    remote: { ...remote, worktree: "", out: "" },
    command: ["{python}", "bench/eval.py", "--scope", "{scope}"],
    runId: "run-1",
    timeoutS: 60,
    signal: controller.signal,
    transport,
  });
  const result = await runner.run({ ...req, repo: { ...req.repo, path: tempDir("rsi-remote-src-") } });
  assert.equal(result.status, "failed");
  const cleanup = calls.find((call) => call.command.includes("kill -TERM -- -$p"));
  assert.ok(cleanup, "the aborted run must clean up the remote group");
  assert.equal(cleanup!.signal, undefined, "cleanup must not reuse the aborted signal");
  assert.match(cleanup!.command, /p=\$\(cat .*\.rsi-0001\.pid/);
  assert.ok(calls.indexOf(cleanup!) < calls.length - 1, "cleanup runs before the result fetch");
});

test("a Problem with remote selects RemoteRunner", () => {
  const problem = loadProblem(fixture("dfm_ssm_external"));
  assert.ok(problem.remote);
  const workspace = new GitWorkspace(
    problem,
    defaultConfig({ runner: "subprocess", runId: "remote-select" }),
    tempDir("rsi-remote-select-"),
  );
  assert.ok(workspace.runner instanceof RemoteRunner);
});

test("the dfm fixture injects remote.env into the SSH command", () => {
  const problem = loadProblem(fixture("dfm_ssm_external"));
  assert.ok(problem.remote);
  assert.ok(problem.experiment_command);
  const invocation = buildRemoteInvocation(
    problem.remote,
    problem.experiment_command,
    req,
    "/home/sl/mamba/projects/dfm-ssm-run-1/worktree",
    "/home/sl/mamba/projects/dfm-ssm-run-1/out/process-0001.json",
  );
  assert.match(invocation.inner, /RSI_DFM_TRAIN_DATA=\/home\/sl\/SlimPajama-10B/);
  assert.match(invocation.inner, /RSI_DFM_TOKENIZER=\/home\/sl\/mamba\/checkpoints/);
  assert.match(invocation.inner, /CUDA_VISIBLE_DEVICES=0/);
  assert.match(invocation.inner, /bench\/rsi_dfm_train_eval\.py/);
});

test("remote path templates and setup are applied", () => {
  const worktree = expandRemoteTemplate("/home/sl/projects/dfm-ssm-{run_id}", "run-1", "dfm-ssm");
  assert.equal(worktree, "/home/sl/projects/dfm-ssm-run-1");
  const invocation = buildRemoteInvocation(
    { ...remote, setup: "source /opt/conda/etc/profile.d/conda.sh && conda activate dsfm" },
    ["{python}", "bench/run.py"],
    req,
    worktree,
    "/home/sl/projects/dfm-ssm-run-1/out",
  );
  assert.match(invocation.inner, /conda activate dsfm/);
  assert.match(invocation.inner, /cd \/home\/sl\/projects\/dfm-ssm-run-1/);
});

test("default rsync excludes cover VCS, caches, checkpoints and data", () => {
  for (const pattern of [".git", "runs", "checkpoints", "pretrained", "data", "build", "*.pt", "*.parquet"]) {
    assert.ok(DEFAULT_RSYNC_EXCLUDES.includes(pattern), pattern);
  }
});

test("gitIgnoredPaths honours .gitignore, including negations", () => {
  const root = tempDir("rsi-ignore-");
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n*.log\n!keep.log\n");
  fs.mkdirSync(path.join(root, "ignored"));
  fs.writeFileSync(path.join(root, "ignored", "data.bin"), "x");
  fs.writeFileSync(path.join(root, "a.log"), "x");
  fs.writeFileSync(path.join(root, "keep.log"), "x");
  const ignored = gitIgnoredPaths(root);
  assert.ok(ignored.some((item) => item.startsWith("ignored")));
  assert.ok(ignored.includes("a.log"));
  assert.ok(!ignored.includes("keep.log"));
});
