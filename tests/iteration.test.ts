import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runIteration, type IterationOptions } from "../src/rsi/iteration.ts";
import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { PiLLMProvider } from "../src/rsi/providers/pi.ts";
import { makeProblem, metricSpec, type ExperimentResult } from "../src/rsi/types.ts";
import type { ExperimentRequest, Runner } from "../src/rsi/runtime/workspace.ts";
import { readJson, tempDir } from "./helpers.ts";

const idea = { id: "h0", hypothesis: "A lower training rate improves held-out loss", mechanism: "lower the training rate" };
function patch(file = "train.py", before = "rate = 1", after = "rate = 0.5"): string {
  return `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}
function git(repo: string, ...args: string[]): string {
  const out = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}
function setup(options: { patch?: string; manifest?: string[]; scores?: number[]; failAt?: number } = {}) {
  const repo = tempDir("rsi-iteration-repo-");
  fs.mkdirSync(path.join(repo, ".rsi"));
  fs.mkdirSync(path.join(repo, "protocol"));
  fs.writeFileSync(path.join(repo, "train.py"), "rate = 1\n");
  fs.writeFileSync(path.join(repo, "evaluate.py"), "rate = 1\n");
  fs.writeFileSync(path.join(repo, "protocol", "split.py"), "rate = 1\n");
  fs.writeFileSync(path.join(repo, ".rsi", "run.py"), "rate = 1\n");
  fs.writeFileSync(path.join(repo, ".rsi", "adapter.json"), JSON.stringify({ protected_paths: options.manifest ?? [".rsi"] }));
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline");
  const baselineCommit = git(repo, "rev-parse", "HEAD");
  const problem = makeProblem({ id: "generic-target", statement: "Improve training only under fixed evaluation",
    repo, repo_ref: baselineCommit, experiment_command: ["{python}", ".rsi/run.py", "--scope", "{scope}", "--out", "{out}"],
    datasets: ["all"], subset_datasets: ["small"], metrics: [metricSpec({ name: "loss", direction: "min" })],
    remote: { host: "never-connect.invalid", dir: "/not-used", worktree: "", out: "", python: "python3",
      setup: "", ssh_args: [], rsync_args: [], gpu_ids: "0", env: { TRAIN_STEPS: "1", EVAL_SPLIT: "test" }, timeout_s: 60, excludes: [] } });
  const requests: ExperimentRequest[] = [];
  const runner: Runner = { async run(req) {
    requests.push(structuredClone(req));
    const failed = requests.length === options.failAt;
    const result: ExperimentResult = { status: failed ? "failed" : "ok",
      metrics: failed ? {} : { loss: options.scores?.[requests.length - 1] ?? (requests.length === 1 ? 2 : 1) },
      stderr: failed ? "training failed" : "", stdout: "mock runner: no GPU/SSH/inference", log_path: "", wall_time_s: 0 };
    return result;
  } };
  const provider = new MockLLMProvider({ "ideas.initial": { ideas: [idea] }, "code.subset": { patch: options.patch ?? patch() } });
  const opts: IterationOptions = { problem, provider, runner, outDir: tempDir("rsi-iteration-out-"), runId: "bounded", maxWallTimeS: 120 };
  return { repo, baselineCommit, problem, requests, provider, opts };
}

test("one iteration uses real Pi provider registry path, exactly two snapshots and fixed subset protocol", async () => {
  const ctx = setup();
  const completions: any[] = [];
  const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", maxTokens: 65536 };
  // Real PiLLMProvider, with only the registry/network boundary mocked.
  ctx.opts.provider = new PiLLMProvider({ registry: {
    find: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true,
    async complete(model, context: any, options) {
      completions.push({ model, context, options });
      const isIdea = context.messages[0].content.includes("Generate exactly one initial idea");
      return { provider: model.provider, model: model.id, stopReason: "stop",
        usage: { input: 11, output: 7, totalTokens: 18, cost: { total: 0.001 } },
        content: [{ type: "text", text: JSON.stringify(isIdea ? { ideas: [idea] } : { patch: patch() }) }] };
    },
  } });
  ctx.opts.env = { TRAIN_STEPS: "2", TRAIN_TOKENS: "128", EVAL_LIMIT: "0" };
  ctx.opts.maxLlmCalls = 2;
  ctx.opts.codingMaxTokens = 32768;
  const result = await runIteration(ctx.opts);
  assert.equal(result.status, "executed", JSON.stringify(result.errors));
  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "accepted");
  assert.equal(ctx.requests.length, 2);
  assert.deepEqual(ctx.requests.map((r) => r.scope), ["subset", "subset"]);
  assert.deepEqual(ctx.requests.map((r) => r.datasets), [["small"], ["small"]]);
  assert.deepEqual(ctx.requests.map((r) => r.metrics), [["loss"], ["loss"]]);
  assert.equal(ctx.requests[0].repo.commit, ctx.baselineCommit);
  assert.notEqual(ctx.requests[1].repo.commit, ctx.baselineCommit);
  assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.baselineCommit);
  assert.equal(git(ctx.repo, "status", "--porcelain"), "");
  assert.equal(ctx.requests[1].repo.parent, ctx.baselineCommit);
  assert.match(result.diff, /rate = 0.5/);
  assert.equal(completions.length, 2);
  assert.equal(Object.hasOwn(completions[0].options, "maxTokens"), false);
  assert.equal(completions[1].options.maxTokens, 32768);
  assert.equal(readJson(path.join(result.root, "artifacts/config.json")).modelRoutes.coding.maxTokens, 32768);
  const usage = result.records.filter((r) => r.kind === "model.response");
  assert.equal(usage.length, 2);
  assert.equal((usage[0].data as any).usage.totalTokens, 18);
  assert.equal((usage[0].data as any).usage.cost_total, 0.001);
  const protocol = readJson(path.join(result.root, "artifacts/protocol.json"));
  assert.deepEqual(protocol.env, { TRAIN_STEPS: "2", EVAL_SPLIT: "test", TRAIN_TOKENS: "128", EVAL_LIMIT: "0", RSI_SEED: "7" });
  assert.equal(protocol.experiment_timeout_s, 60); // the fixture pins the adapter timeout
  assert.equal(protocol.coding_max_tokens, 32768);
  assert.equal(protocol.baseline_commit, ctx.baselineCommit);
  const launches = result.records.filter((r) => r.kind === "iteration.experiment.start");
  assert.deepEqual((launches[0].data as any).env, protocol.env);
  assert.deepEqual((launches[1].data as any).env, protocol.env);
  assert.equal((result.summary.budget as any).experiments, 2);
  assert.equal((result.summary.budget as any).limits.max_experiments, 2);
  assert.equal(result.summary.scientific_claim, false);
  assert.ok(fs.existsSync(path.join(result.root, "artifacts/baseline.json")));
  assert.ok(fs.existsSync(path.join(result.root, "artifacts/candidate.json")));
  assert.ok(fs.existsSync(path.join(result.root, "iteration.json")));
  assert.ok(!result.records.some((r) => /ablation|manuscript|code.full/.test(JSON.stringify(r))));
});

test("no improvement is still an executed iteration and never triggers engineering or a full run", async () => {
  const ctx = setup({ scores: [1, 2] });
  const result = await runIteration(ctx.opts);
  assert.equal(result.executed, true);
  assert.equal(result.status, "executed");
  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.errors.length, 0);
  assert.equal(ctx.requests.length, 2);
  assert.deepEqual(ctx.provider.calls.map((r) => r.task), ["ideas.initial", "code.subset"]);
  assert.equal(ctx.provider.calls[1].maxTokens, undefined);
  const protocol = readJson(path.join(result.root, "artifacts/protocol.json"));
  assert.equal(protocol.coding_max_tokens, null);
  assert.equal(protocol.output_policy.coding, "inherit Pi/model defaults");
});

for (const [name, change] of [
  ["prose", "change the rate please"],
  ["invalid patch", patch("train.py", "missing = 1")],
  ["identical patch", patch("train.py", "rate = 1", "rate = 1")],
  ["whitespace-only", patch("train.py", "rate = 1", "rate  =  1")],
  ["comment-only", "--- a/train.py\n+++ b/train.py\n@@ -1 +1,2 @@\n rate = 1\n+# a better model\n"],
] as const) {
  test(`${name} candidate is rejected before candidate execution`, async () => {
    const ctx = setup({ patch: change });
    const result = await runIteration(ctx.opts);
    assert.equal(result.status, "failed");
    assert.equal(result.executed, false);
    assert.equal(ctx.requests.length, 1);
    assert.equal(result.outcome, "error");
    assert.ok(result.errors.length);
    assert.ok(fs.existsSync(path.join(result.root, "iteration.json")));
    assert.ok(ctx.provider.calls.length <= 3);
  });
}

const protectedCases: [string, string, { manifest?: string[]; protectedPaths?: string[] }][] = [
  ["adapter", ".rsi/run.py", {}],
  ["evaluator", "evaluate.py", {}],
  ["manifest protected", "protocol/split.py", { manifest: ["protocol/"] }],
  ["explicit protected", "train.py", { protectedPaths: ["train.py"] }],
  ["glob protected", "train.py", { protectedPaths: ["*.py"] }],
  ["recursive glob protected", "train.py", { protectedPaths: ["**/*.py"] }],
];
for (const [name, file, options] of protectedCases) {
  test(`${name} files cannot be changed by the coding agent`, async () => {
    const ctx = setup({ patch: patch(file), ...options });
    const result = await runIteration({ ...ctx.opts, ...options });
    assert.equal(result.executed, false);
    assert.equal(ctx.requests.length, 1);
    assert.match(result.errors.join(" "), /protected protocol paths/);
    assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.baselineCommit);
  });
}

test("command script is protected outside .rsi", async () => {
  const ctx = setup();
  ctx.problem.experiment_command = ["python3", "train.py", "--scope", "{scope}", "--out", "{out}"];
  const result = await runIteration(ctx.opts);
  assert.equal(ctx.requests.length, 1);
  assert.match(result.errors.join(" "), /protected protocol paths: train.py/);
});

test("fixture forbidden approach integrity convention cannot be overridden by an LLM", async () => {
  const ctx = setup({ patch: patch("train.py", "rate = 1", "rate = 0.5 # retraining the encoder") });
  ctx.problem.forbidden = ["retraining the encoder"];
  const result = await runIteration(ctx.opts);
  assert.equal(ctx.requests.length, 1);
  assert.match(result.errors.join(" "), /forbidden approach/);
});

for (const failAt of [1, 2]) {
  test(`failed experiment ${failAt} persists evidence/errors without reruns`, async () => {
    const ctx = setup({ failAt });
    const result = await runIteration(ctx.opts);
    assert.equal(result.status, "failed");
    assert.equal(ctx.requests.length, failAt);
    assert.match(result.errors.join(" "), /experiment failed/);
    assert.equal(result.accepted, false);
    const evidence = failAt === 1 ? result.baseline : result.candidate;
    assert.equal(evidence?.result?.status, "failed");
    assert.equal(readJson(path.join(result.root, "iteration.json")).errors.length, 1);
  });
}

test("immutable inputs are cloned; ambiguous repo without pinned baseline fails before experiments", async () => {
  const ctx = setup();
  const before = structuredClone(ctx.problem);
  await runIteration(ctx.opts);
  assert.deepEqual(ctx.problem, before);
  await assert.rejects(runIteration({ ...ctx.opts, problem: { ...ctx.problem, repo_ref: null } }), /repo_ref/);
  await assert.rejects(runIteration(ctx.opts), /EEXIST/);
  assert.equal(ctx.requests.length, 2);
});

test("cancellation and exhausted LLM budget never launch a candidate", async () => {
  const ctx = setup();
  const result = await runIteration({ ...ctx.opts, maxLlmCalls: 1 });
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.provider.calls.length, 1);
  assert.equal((result.summary.budget as any).llm_calls, 1);
  assert.match(result.errors.join(" "), /max_llm_calls/);
  const cancelled = setup();
  const controller = new AbortController();
  controller.abort();
  const abort = await runIteration({ ...cancelled.opts, signal: controller.signal });
  assert.equal(cancelled.requests.length, 0);
  assert.match(abort.errors.join(" "), /AbortError/);
});

test("model failures are persisted, never substituted with a fake candidate", async () => {
  const ctx = setup();
  ctx.provider.scriptDynamic = async () => { throw new Error("model transport unavailable"); };
  const result = await runIteration(ctx.opts);
  assert.equal(ctx.requests.length, 1);
  assert.equal(result.executed, false);
  assert.equal(result.candidate, null);
  assert.match(result.errors.join(" "), /model transport unavailable/);
  assert.ok(result.records.some((r) => r.kind === "model.request"));
  assert.ok(result.records.some((r) => r.kind === "model.error"));
});

test("overall deadline bounds a stalled model without launching candidate experiments", async () => {
  const ctx = setup();
  ctx.provider.scriptDynamic = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { ideas: [idea] };
  };
  const result = await runIteration({ ...ctx.opts, maxWallTimeS: 0.8 });
  assert.equal(result.executed, false);
  assert.equal(ctx.requests.length, 1);
  assert.match(result.errors.join(" "), /TimeoutError|max_wall_time/);
});

test("nested target-owned adapter manifests protect the protocol", async () => {
  const ctx = setup({ patch: patch("protocol/split.py") });
  fs.mkdirSync(path.join(ctx.repo, ".rsi/adapter"));
  fs.writeFileSync(path.join(ctx.repo, ".rsi/adapter/project.json"), JSON.stringify({ protected_paths: ["protocol/split.py"] }));
  git(ctx.repo, "add", ".rsi/adapter/project.json");
  git(ctx.repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "target-owned manifest");
  ctx.problem.repo_ref = git(ctx.repo, "rev-parse", "HEAD");
  const result = await runIteration(ctx.opts);
  assert.equal(ctx.requests.length, 1);
  assert.match(result.errors.join(" "), /protected protocol paths: protocol\/split.py/);
});

test("paired iteration remote outputs stay isolated across reused local run IDs", async () => {
  const a = setup();
  const b = setup();
  const ra = await runIteration(a.opts);
  const rb = await runIteration(b.opts);
  const pa = readJson(path.join(ra.root, "artifacts/protocol.json"));
  const pb = readJson(path.join(rb.root, "artifacts/protocol.json"));
  assert.notEqual(pa.remote.worktree, pb.remote.worktree);
  assert.notEqual(pa.remote.out, pb.remote.out);
  assert.equal(pa.remote.out.startsWith(pa.remote.worktree + "/"), false);
});

for (const metrics of [{ loss: 101 }, { loss: 1, surprise: 2 }, { loss: NaN }] as Array<Record<string, number>>) {
  test(`paired iteration refuses invalid bounded metric contract ${JSON.stringify(metrics)}`, async () => {
    const ctx = setup();
    ctx.problem.metrics[0].bounds = [0, 100];
    const runner: Runner = { async run(): Promise<ExperimentResult> {
      return { metrics, status: "ok", stderr: "", stdout: "", log_path: "", wall_time_s: 0 };
    } };
    const result = await runIteration({ ...ctx.opts, runner });
    assert.equal(result.executed, false);
    assert.match(result.errors.join(" "), /exact finite bounded metrics/);
    assert.equal(result.summary.experiment_invocations, 1);
  });
}

test("a valid idea may state scientific constraints negatively without being treated as forbidden code", async () => {
  const ctx = setup();
  ctx.problem.forbidden = ["training on wikitext test data"];
  ctx.opts.provider = new MockLLMProvider({
    "ideas.initial": { ideas: [{ ...idea, mechanism: "Lower the rate during training and never use wikitext test data" }] },
    "code.subset": { patch: patch() },
  });
  const result = await runIteration(ctx.opts);
  assert.equal(result.executed, true, result.errors.join(" "));
  assert.equal(ctx.requests.length, 2);
});

test("missing or empty target protocol manifests block all experiments", async () => {
  for (const missing of [true, false]) {
    const ctx = setup({ manifest: [] });
    if (missing) {
      git(ctx.repo, "rm", ".rsi/adapter.json");
      git(ctx.repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "no manifest");
      ctx.problem.repo_ref = git(ctx.repo, "rev-parse", "HEAD");
    }
    const result = await runIteration(ctx.opts);
    assert.equal(ctx.requests.length, 0);
    assert.match(result.errors.join(" "), /manifest|protected_paths/);
  }
});

test("unlisted conventional protocol files cannot manufacture an improvement", async () => {
  const ctx = setup({ patch: patch("protocol/split.py") });
  const result = await runIteration(ctx.opts);
  assert.equal(ctx.requests.length, 1);
  assert.match(result.errors.join(" "), /protected protocol paths/);
});

test("declared adapter seed environment is forwarded and conflicting seeds fail before spend", async () => {
  for (const conflict of [false, true]) {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.repo, ".rsi/adapter.json"), JSON.stringify({ protected_paths: [".rsi"], env_prefix: "RSI_TARGET" }));
    git(ctx.repo, "add", ".rsi/adapter.json");
    git(ctx.repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "declared seed contract");
    ctx.problem.repo_ref = git(ctx.repo, "rev-parse", "HEAD");
    const result = await runIteration({ ...ctx.opts, seed: 2026, env: conflict ? { RSI_TARGET_SEED: "7" } : {} });
    if (conflict) {
      assert.equal(ctx.requests.length, 0);
      assert.match(result.errors.join(" "), /seed conflicts/);
    } else {
      const protocol = readJson(path.join(result.root, "artifacts/protocol.json"));
      assert.equal(protocol.env.RSI_TARGET_SEED, "2026");
      assert.equal(protocol.env.RSI_SEED, "2026");
    }
  }
});

function commitManifest(ctx: ReturnType<typeof setup>, mutable: unknown, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(ctx.repo, ".rsi/adapter.json"), JSON.stringify({ protected_paths: [".rsi"], mutable_paths: mutable, ...extra }));
  git(ctx.repo, "add", "-A");
  git(ctx.repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "source contract");
  ctx.problem.repo_ref = git(ctx.repo, "rev-parse", "HEAD");
}

test("bounded idea and coding context includes complete committed mutable bodies and tails, never protected bodies or dirty checkout", async () => {
  const ctx = setup();
  const modelBody = "# visible implementation\n".repeat(650) + "MODEL_FORWARD_TAIL = 1\n";
  const optimBody = "# optimizer implementation\n".repeat(220) + "OPTIMIZER_TAIL = 1\n";
  fs.mkdirSync(path.join(ctx.repo, "models"));
  fs.writeFileSync(path.join(ctx.repo, "models/model.py"), modelBody);
  fs.writeFileSync(path.join(ctx.repo, "optim.py"), optimBody);
  fs.writeFileSync(path.join(ctx.repo, "evaluate.py"), "PROTECTED_EVALUATOR_SECRET_BODY = 1\n");
  commitManifest(ctx, ["models/model.py", "optim.py", "train.py"]);
  fs.writeFileSync(path.join(ctx.repo, "models/model.py"), "DIRTY_CHECKOUT_BODY\n");
  fs.writeFileSync(path.join(ctx.repo, ".rsi/adapter.json"), JSON.stringify({ protected_paths: ["models"], mutable_paths: ["evaluate.py"] }));
  const result = await runIteration(ctx.opts);
  assert.equal(result.executed, true, result.errors.join(" "));
  const brief = fs.readFileSync(path.join(result.root, "artifacts/source-context.txt"), "utf8");
  assert.ok(brief.length <= 48000);
  for (const request of ctx.provider.calls.filter(req => ["ideas.initial", "code.subset"].includes(req.task))) {
    assert.ok(request.user.includes(modelBody));
    assert.ok(request.user.includes(optimBody));
    assert.match(request.user, /END COMPLETE FILE: models\/model.py/);
    assert.match(request.user, /MODEL_FORWARD_TAIL/);
    assert.match(request.user, /OPTIMIZER_TAIL/);
    assert.match(request.user, /minimal code-local executable change/);
    assert.match(request.user, /checkpoint compatibility/);
    assert.ok(request.user.includes(brief), request.task);
    assert.doesNotMatch(request.user, /PROTECTED_EVALUATOR_SECRET_BODY|DIRTY_CHECKOUT_BODY/);
  }
  const traced = result.records.find(record => record.kind === "model.request" && (record.data as any).task === "ideas.initial");
  assert.ok((traced?.data as any).user.includes(brief), "trace the actual enriched request");
  assert.equal(fs.readFileSync(path.join(ctx.repo, "models/model.py"), "utf8"), "DIRTY_CHECKOUT_BODY\n");
});

test("oversized mutable source is explicitly truncated under the total context budget", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "large.py"), "# large source\n".repeat(5000) + "UNSEEN_LARGE_TAIL = 1\n");
  commitManifest(ctx, ["large.py", "train.py"]);
  const result = await runIteration(ctx.opts);
  assert.equal(result.executed, true, result.errors.join(" "));
  const brief = fs.readFileSync(path.join(result.root, "artifacts/source-context.txt"), "utf8");
  assert.ok(brief.length <= 48000);
  assert.match(brief, /TRUNCATED FILE: large.py.*NOT complete/);
  assert.doesNotMatch(brief, /UNSEEN_LARGE_TAIL|END COMPLETE FILE: large.py/);
});

test("invalid or overfrozen declared mutable paths block before baseline experiments and model spend", async () => {
  for (const mutable of [[], "train.py", [1], ["../escape.py"], ["evaluate.py"], [".rsi"], ["missing.py"], ["README.md"]]) {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.repo, "README.md"), "not executable");
    commitManifest(ctx, mutable);
    const result = await runIteration(ctx.opts);
    assert.equal(ctx.requests.length, 0, JSON.stringify(mutable));
    assert.equal(ctx.provider.calls.length, 0);
    assert.match(result.errors.join(" "), /mutable_paths|repo-relative/);
  }
});

test("declared mutable executable allowlist is enforced without weakening protected paths", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "other.py"), "rate = 1\n");
  commitManifest(ctx, ["other.py"]);
  const result = await runIteration(ctx.opts);
  assert.equal(ctx.requests.length, 1);
  assert.match(result.errors.join(" "), /outside declared mutable executable source/);
});

test("coding token cap rejects invalid values before any experiment or model spend", async () => {
  const ctx = setup();
  for (const codingMaxTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    await assert.rejects(runIteration({ ...ctx.opts, codingMaxTokens }), /codingMaxTokens/);
  }
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.provider.calls.length, 0);
});

test("baseline mutations and missing paired metrics fail closed", async () => {
  for (const mutate of [true, false]) {
    const ctx = setup();
    const runner: Runner = { async run(req): Promise<ExperimentResult> {
      ctx.requests.push(req);
      if (mutate) fs.writeFileSync(path.join(req.repo.path, "train.py"), "rate = 100\n");
      return { metrics: mutate ? { loss: 1 } : { wrong_metric: 1 }, status: "ok", stderr: "", stdout: "", log_path: "", wall_time_s: 0 };
    } };
    const result = await runIteration({ ...ctx.opts, runner });
    assert.equal(ctx.requests.length, 1);
    assert.equal(result.executed, false);
    assert.match(result.errors.join(" "), mutate ? /mutated tracked files/ : /exact finite bounded metrics/);
  }
});

test("incumbent reuse measures only the candidate and promotes the better commit", async () => {
  const ctx = setup();
  const outDir = tempDir("rsi-incumbent-");
  const calls: string[] = [];
  const losses = [2, 1, 0.5];
  const runner: Runner = { async run(req): Promise<ExperimentResult> {
    calls.push(req.repo.commit!);
    return { metrics: { loss: losses[calls.length - 1] }, status: "ok", stderr: "", stdout: "", log_path: "", wall_time_s: 0 };
  } };
  const first = await runIteration({ ...ctx.opts, runner, outDir, runId: "one" });
  assert.equal(first.status, "executed", first.errors.join(" "));
  assert.equal(first.accepted, true);
  assert.equal(first.promoted, true);
  assert.equal(first.baselineSource, "measured");
  assert.equal(calls.length, 2);

  assert.equal(git(ctx.repo, "show", `${first.candidateRepo!.commit}:train.py`), "rate = 0.5");
  const secondPatch = patch("train.py", "rate = 0.5", "rate = 0.4");
  const second = await runIteration({
    ...ctx.opts,
    runner,
    outDir,
    runId: "two",
    provider: new MockLLMProvider({ "ideas.initial": { ideas: [idea] }, "code.subset": { patch: secondPatch } }),
  });
  assert.equal(second.status, "executed", second.errors.join(" "));
  assert.equal(second.baselineSource, "incumbent");
  assert.equal(second.promoted, true);
  assert.equal(calls.length, 3, "the baseline must not be re-measured");
  assert.equal(calls[2], second.candidateRepo?.commit);

  const protocol = readJson(path.join(second.root, "artifacts/protocol.json"));
  assert.equal(protocol.experiments, 1);
  assert.deepEqual(protocol.scopes, ["subset"]);
  assert.equal(protocol.baseline_commit, first.candidateRepo?.commit);

  const ledger = readJson(second.incumbentPath);
  assert.equal(ledger.commit, second.candidateRepo?.commit);
  assert.deepEqual(ledger.metrics, { loss: 0.5 });
  assert.equal(ledger.history.length, 2);
});

test("a policy or environment change invalidates the incumbent and re-measures the baseline", async () => {
  for (const change of ["env", "tampered-ledger"] as const) {
    const ctx = setup();
    const outDir = tempDir("rsi-incumbent-drift-");
    let calls = 0;
    const runner: Runner = { async run(): Promise<ExperimentResult> {
      calls++;
      return { metrics: { loss: calls === 1 ? 2 : calls === 2 ? 1 : 0.9 }, status: "ok", stderr: "", stdout: "", log_path: "", wall_time_s: 0 };
    } };
    const first = await runIteration({ ...ctx.opts, runner, outDir, runId: "one" });
    assert.equal(first.promoted, true);
    if (change === "tampered-ledger") {
      const ledger = readJson(first.incumbentPath);
      delete ledger.metrics.loss;
      fs.writeFileSync(first.incumbentPath, JSON.stringify(ledger));
    }
    const before = calls;
    const second = await runIteration({
      ...ctx.opts, runner, outDir, runId: "two",
      ...(change === "env" ? { env: { TRAIN_STEPS: "9" } } : {}),
    });
    assert.equal(second.baselineSource, "measured", change);
    assert.equal(calls - before, 2, `${change}: baseline and candidate both measured`);
  }
});

test("the bounded flow derives a generous wall from the fixture timeout and has no user-facing LLM cap", async () => {
  const ctx = setup();
  delete (ctx.problem.remote as { timeout_s?: number }).timeout_s;
  const runner: Runner = { async run(): Promise<ExperimentResult> {
    return { metrics: { loss: 1 }, status: "ok", stderr: "", stdout: "", log_path: "", wall_time_s: 0 };
  } };
  const result = await runIteration({ ...ctx.opts, runner, baselineMode: "reuse" });
  const protocol = readJson(path.join(result.root, "artifacts/protocol.json"));
  assert.equal(protocol.experiment_timeout_s, 3600);
  assert.equal((result.summary.budget as any).limits.max_llm_calls, 64);
});
