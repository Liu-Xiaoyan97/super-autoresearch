import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import rsiExtension from "../extensions/rsi.ts";
import { incumbentFileFor } from "../src/rsi/runtime/incumbent.ts";
import { makeProblem, metricSpec } from "../src/rsi/types.ts";
import { readJson, tempDir } from "./helpers.ts";

const idea = { id: "h0", hypothesis: "Lower the training rate", mechanism: "Change the rate implementation only" };
const patch = (rate: number) => `--- a/train.py\n+++ b/train.py\n@@ -1 +1 @@\n-rate = 1\n+rate = ${rate}\n`;
function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Synthetic target, no real model/GPU/SSH/training. The native surface still uses
// the real PiLLMProvider, GitWorkspace and SubprocessRunner (no runner override).
function harness(rate = 0.5, reportMode = "ok") {
  const root = tempDir("rsi-native-iteration-");
  const repo = path.join(root, "target repo"), out = path.join(root, "fresh evidence");
  fs.mkdirSync(path.join(repo, ".rsi"), { recursive: true });
  fs.writeFileSync(path.join(repo, "train.py"), "rate = 1\n");
  fs.writeFileSync(path.join(repo, ".rsi", "adapter.json"), JSON.stringify({ protected_paths: [".rsi"] }));
  fs.writeFileSync(path.join(repo, ".rsi", "run.cjs"), `
const fs = require('node:fs');
const args = process.argv.slice(2);
const rate = Number(fs.readFileSync('train.py', 'utf8').split('=')[1]);
fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ status: '${reportMode}' === 'failed-status' ? 'failed' : 'ok', metrics: { loss: '${reportMode}' === 'null-metric' ? null : rate },
  details: { synthetic_test_only: true, scope: args[args.indexOf('--scope') + 1],
    run_kind: '${reportMode}' === 'full-as-smoke' ? 'smoke' : (args[args.indexOf('--scope') + 1] === 'full' ? 'full_test' : 'smoke'),
    eval_limit: args[args.indexOf('--scope') + 1] === 'full' ? null : 1,
    training_skipped: '${reportMode}' === 'skipped-training', executed_train_steps: Number(process.env.TRAIN_STEPS || 1),
    checkpoint_step: Number(process.env.TRAIN_STEPS || 1), checkpoint: '/synthetic/checkpoint',
    raw_metrics: '/synthetic/metric-artifact.json', seed: '${reportMode}' === 'wrong-seed' ? 7 : Number(process.env.RSI_SEED || 2026), effective_batch_size: '${reportMode}' === 'paired-batch-mismatch' && rate !== 1 ? 2 : 1,
    env: { TRAIN_STEPS: process.env.TRAIN_STEPS, BUDGET: process.env.BUDGET, EMPTY: process.env.EMPTY } } }));
`);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline");
  const commit = git(repo, "rev-parse", "HEAD");
  // Synthetic receipt only: no claim that this test fixture trained a model.
  const receiptPath = path.join(root, "accepted adapter", "smoke-summary.json");
  const receipt = { status: "ok", pipeline_metadata_validated: true, readiness: "unverified", repo: { commit },
    pipeline_details: { training_skipped: false, executed_train_steps: 1, checkpoint_step: 1,
      checkpoint: "/synthetic/checkpoint.pt", raw_metrics: "/synthetic/lm-eval.json" } };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const problem = makeProblem({ id: "native-generic", statement: "Synthetic native extension test only",
    repo: "missing-unless-overridden", repo_ref: commit,
    experiment_command: [process.execPath, ".rsi/run.cjs", "--scope", "{scope}", "--out", "{out}"],
    datasets: ["never-full"], subset_datasets: ["small"], metrics: [metricSpec({ name: "loss", direction: "min" })] });
  const fixture = path.join(root, "problem fixture.json");
  const save = () => fs.writeFileSync(fixture, JSON.stringify(problem));
  save();
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  const messages: unknown[] = [], notes: Array<{ text: string; level: string }> = [], calls: any[] = [];
  let approved = true, confirmations = 0;
  let onConfirm: (() => Promise<void>) | undefined;
  const model = { provider: "test-configured", id: "test-model", maxTokens: 8192 };
  const registry = {
    find(provider: string, id: string) { assert.equal(provider, model.provider); assert.equal(id, model.id); return model; },
    getAvailable: () => [model], hasConfiguredAuth: () => true,
    async complete(selected: any, context: any, options: any) {
      calls.push({ selected, context, options });
      const isIdea = context.messages[0].content.includes("Generate exactly one initial idea");
      return { provider: selected.provider, model: selected.id, stopReason: "stop", usage: { input: 2, output: 3, totalTokens: 5 },
        content: [{ type: "text", text: JSON.stringify(isIdea ? { ideas: [idea] } : { patch: patch(rate) }) }] };
    },
  };
  rsiExtension({ registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage: (...args: any[]) => messages.push(args) } as any);
  const ctx = { cwd: root, hasUI: true, modelRegistry: registry, model,
    sessionManager: { getSessionId: () => root }, ui: {
      notify: (text: string, level: string) => notes.push({ text, level }),
      confirm: async () => { confirmations++; await onConfirm?.(); return approved; },
    } } as any;
  const params = { problem: fixture, adapter_acceptance: receiptPath, repo, out, provider: model.provider, model: model.id, seed: 2026,
    env: { TRAIN_STEPS: "2", BUDGET: "small budget=paired", EMPTY: "" } };
  const execute = (over = {}, signal?: AbortSignal, progress?: any) => tools.get("rsi_iteration").execute("native", { ...params, ...over }, signal, progress, ctx);
  const policy = (extra: Record<string, unknown>) => tools.get("rsi_superagent").execute("policy", { action: "policy", ...extra }, undefined, undefined, ctx);
  return { root, repo, out, problem, fixture, commit, receipt, receiptPath, save, tools, commands, messages, notes, calls, registry, ctx, params, execute, policy,
    confirmations: () => confirmations, refuse: () => { approved = false; }, onConfirm: (fn: () => Promise<void>) => { onConfirm = fn; } };
}

// HOST policy is live and process-global. Tests below are sequential and restore pauses.
test("native iteration registers only real bounded params and routing guidance", () => {
  const h = harness();
  const tool = h.tools.get("rsi_iteration");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["problem", "adapter_acceptance", "repo", "out", "env", "provider", "model", "seed", "scope", "max_tokens", "coding_max_tokens", "protected_paths", "baseline_mode"]);
  assert.deepEqual(tool.parameters.required, ["problem", "adapter_acceptance"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.coding_max_tokens, {
    type: "integer", minimum: 1,
    description: "Optional explicit coding-role output token cap, including reasoning; omitted inherits the global override or native Pi/model defaults. Only the selected model capability caps it.",
  });
  assert.match(tool.promptGuidelines.join(" "), /inherits the current Pi model/);
  assert.equal(Object.hasOwn(tool.parameters.properties.max_tokens, "default"), false);
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.promptGuidelines.join(" "), /rsi_iteration.*rsi_research/);
  assert.match(h.tools.get("rsi_research").promptGuidelines.join(" "), /rsi_iteration instead/);
});

test("native iteration inherits the current Pi model, reasoning and large model limits without an RSI cap", async () => {
  const h = harness();
  h.ctx.model.maxTokens = 384000;
  h.ctx.model.contextWindow = 1000000;
  h.ctx.thinkingLevel = "xhigh";
  (h.registry as any).streamSimple = (model: any, context: any, options: any) => ({ result: () => h.registry.complete(model, context, options) });
  const response = await h.execute({ provider: undefined, model: undefined });
  assert.equal(response.isError, false, response.content[0].text);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(call.selected, h.ctx.model);
    assert.equal(call.selected.maxTokens, 384000);
    assert.equal(call.selected.contextWindow, 1000000);
    assert.equal(call.options.reasoning, "xhigh");
    assert.equal(Object.hasOwn(call.options, "maxTokens"), false);
  }
  const protocol = readJson(response.details.artifacts.protocol);
  assert.equal(protocol.max_tokens, null);
  assert.equal(protocol.coding_max_tokens, null);
});

for (const cap of [131073, 384000]) {
  test(`native iteration accepts explicit output cap ${cap} for all roles rather than a 131072 ceiling`, async () => {
    const h = harness();
    h.ctx.model.maxTokens = 384000;
    const response = await h.execute({ max_tokens: cap });
    assert.equal(response.isError, false, response.content[0].text);
    assert.deepEqual(h.calls.map(c => c.options.maxTokens), [cap, cap]);
    assert.equal(readJson(response.details.artifacts.protocol).max_tokens, cap);
  });
}

test("native global and coding overrides are separate explicit budgets", async () => {
  const h = harness();
  h.ctx.model.maxTokens = 384000;
  const response = await h.execute({ max_tokens: 384000, coding_max_tokens: 8192 });
  assert.equal(response.isError, false, response.content[0].text);
  assert.deepEqual(h.calls.map(c => c.options.maxTokens), [384000, 8192]);
});

test("native iteration receipt rejects missing, failed, malformed or mismatched evidence with zero activity", async () => {
  const h = harness();
  const refs = git(h.repo, "show-ref");
  const failures = [
    { params: { adapter_acceptance: undefined }, error: /adapter_acceptance is required/ },
    { params: { adapter_acceptance: " " }, error: /adapter_acceptance is required/ },
    { params: { adapter_acceptance: path.join(h.root, "missing.json") }, error: /ENOENT/ },
    { raw: "not JSON", error: /SyntaxError/ },
    { receipt: { ...h.receipt, status: "failed" }, error: /status=ok/ },
    { receipt: { ...h.receipt, pipeline_metadata_validated: false }, error: /pipeline_metadata_validated/ },
    { receipt: { ...h.receipt, pipeline_metadata_validated: "true" }, error: /pipeline_metadata_validated/ },
    { receipt: { ...h.receipt, repo: { commit: "0".repeat(40) } }, error: /commit mismatch/ },
    { receipt: { ...h.receipt, repo: { commit: h.commit.slice(0, 8) } }, error: /commit mismatch/ },
    { receipt: { ...h.receipt, repo: {} }, error: /commit mismatch/ },
    ...[
      { training_skipped: true }, { executed_train_steps: 0 }, { executed_train_steps: 1.5 },
      { checkpoint_step: 2 }, { checkpoint: "" }, { raw_metrics: " " },
    ].map(details => ({ receipt: { ...h.receipt, pipeline_details: { ...h.receipt.pipeline_details, ...details } }, error: /pipeline_details/ })),
    { params: { repo: path.join(h.root, "missing repo") }, error: /repository does not exist/ },
  ];
  for (const failure of failures) {
    fs.writeFileSync(h.receiptPath, "raw" in failure ? failure.raw! : JSON.stringify("receipt" in failure ? failure.receipt : h.receipt));
    const response = await h.execute("params" in failure ? failure.params : {});
    assert.equal(response.isError, true);
    assert.equal(response.details.status, "failed");
    assert.equal(response.details.executed, false);
    assert.match(response.content[0].text, failure.error);
    assert.equal(h.calls.length, 0);
    assert.equal(fs.existsSync(h.out), false, "no evidence directory or experiment invocation");
    assert.equal(git(h.repo, "show-ref"), refs, "no refs modified or promoted");
    assert.equal(git(h.repo, "status", "--porcelain"), "");
  }
});

test("native iteration completes one real subprocess pair through injected Pi registry and retains evidence", async () => {
  const h = harness();
  // Resolve a symbolic fixture ref to its actual commit, not a textual comparison.
  h.problem.repo_ref = "HEAD";
  h.save();
  const updates: any[] = [];
  const controller = new AbortController();
  const response = await h.execute({}, controller.signal, (update: any) => updates.push(update));
  assert.equal(response.isError, false, response.content[0].text);
  assert.equal(response.details.outcome, "accepted");
  assert.equal(response.details.status, "executed");
  assert.equal(response.details.root, h.out);
  assert.equal(h.confirmations(), 1);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.options.signal instanceof AbortSignal && !call.options.signal.aborted && call.options.sessionId === h.root));
  assert.ok(h.calls.every(call => call.selected.provider === h.params.provider));
  assert.ok(updates.length >= 3);
  assert.equal(h.messages.length, 0, "never dispatches a background research SOP");
  const config = readJson(path.join(h.out, "artifacts/config.json"));
  assert.equal(config.runner, "subprocess");
  assert.equal(config.seed, 2026);
  assert.equal(config.maxExperiments, 2);
  const protocol = readJson(response.details.artifacts.protocol);
  assert.equal(protocol.baseline_commit, h.commit);
  assert.deepEqual(protocol.scopes, ["subset", "subset"]);
  assert.deepEqual(protocol.env, { ...h.params.env, RSI_SEED: "2026" });
  const experiments = fs.readdirSync(path.join(h.out, "artifacts/experiments")).filter(file => /^process-\d+\.json$/.test(file));
  assert.equal(experiments.length, 2);
  for (const file of experiments) {
    const report = readJson(path.join(h.out, "artifacts/experiments", file));
    assert.equal(report.details.synthetic_test_only, true);
    assert.equal(report.details.scope, "subset");
    assert.deepEqual(report.details.env, h.params.env);
  }
  assert.equal(git(h.repo, "rev-parse", "HEAD"), h.commit);
  assert.equal(git(h.repo, "status", "--porcelain"), "");
  for (const file of Object.values(response.details.artifacts)) assert.ok(fs.existsSync(String(file)), String(file));
  const again = await h.execute();
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /EEXIST/);
  assert.equal(h.calls.length, 2);
});

for (const [mode, error] of [["failed-status", /report.status is not ok/], ["null-metric", /not a finite number/], ["skipped-training", /training_skipped/], ["wrong-seed", /adapter reported seed/]] as const) {
  test(`native iteration validates original JSON instead of runner coercion: ${mode}`, async () => {
    const h = harness(0.5, mode);
    const response = await h.execute();
    assert.equal(response.isError, true);
    assert.equal(h.calls.length, 0, "invalid baseline must not spend optimization model calls");
    assert.match(response.content[0].text, error);
    const summary = readJson(path.join(h.out, "summary.json"));
    assert.equal(summary.experiment_invocations, 1);
    assert.equal(summary.executed, false);
  });
}

test("native paired pipeline rejects a candidate that changed the actual effective training budget", async () => {
  const h = harness(0.5, "paired-batch-mismatch");
  const response = await h.execute();
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /paired pipeline effective_batch_size differs/);
  assert.equal(h.calls.length, 2);
  assert.equal(readJson(path.join(h.out, "summary.json")).experiment_invocations, 2);
  assert.equal(response.details.executed, false);
});

test("native rejected candidate is a completed valid outcome, not a tool error or improvement", async () => {
  const h = harness(2);
  const response = await h.execute();
  assert.equal(response.isError, false, response.content[0].text);
  assert.equal(response.details.outcome, "rejected");
  assert.equal(response.details.accepted, false);
  assert.match(response.content[0].text, /No improvement claimed/);
  assert.equal(h.calls.length, 2);
  assert.equal(readJson(response.details.artifacts.summary).experiment_invocations, 2);
});

test("native no-UI/refusal/abort fail closed before output or model work", async () => {
  const h = harness();
  h.ctx.hasUI = false;
  const noUi = await h.execute();
  assert.equal(noUi.isError, true);
  assert.match(noUi.content[0].text, /fresh authorization/);
  h.ctx.hasUI = true;
  h.refuse();
  const refused = await h.execute();
  assert.match(refused.content[0].text, /not authorized/);
  const controller = new AbortController(); controller.abort();
  const aborted = await h.execute({}, controller.signal);
  assert.match(aborted.content[0].text, /Abort/);
  assert.equal(h.confirmations(), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.out), false);
});

test("concurrent policy pause wins over native UI approval", async () => {
  const h = harness();
  h.onConfirm(async () => { await h.policy({ paused: true }); });
  try {
    const response = await h.execute();
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /paused/);
    assert.equal(h.calls.length, 0);
    assert.equal(fs.existsSync(h.out), false);
  } finally { await h.policy({ paused: false }); }
});

test("native provider errors persist failure and never trigger a simulated fallback", async () => {
  const h = harness();
  h.registry.hasConfiguredAuth = () => false;
  const response = await h.execute();
  assert.equal(response.isError, true);
  assert.equal(response.details.status, "failed");
  assert.equal(response.details.outcome, "error");
  assert.match(response.content[0].text, /no credential/);
  assert.equal(h.calls.length, 0);
  assert.equal(readJson(response.details.artifacts.summary).experiment_invocations, 1);
});

test("/rsi iterate parses quoted paths and repeated environment, forwards fixed seed/budgets, blocks to completion", async () => {
  const h = harness();
  h.ctx.thinkingLevel = "low";
  h.ctx.model.maxTokens = 65536;
  assert.equal(h.ctx.signal, undefined, "idle command context has no agent-turn signal");
  (h.registry as any).streamSimple = (model: any, context: any, options: any) => ({ result: () => h.registry.complete(model, context, options) });
  await h.commands.get("rsi").handler(`iterate "${h.fixture}" --adapter-acceptance "${h.receiptPath}" --repo "${h.repo}" --out "${h.out}" --provider test-configured --model test-model --seed 2026 --coding-max-tokens 32768 --env TRAIN_STEPS=2 --env "BUDGET=small budget=paired" --env EMPTY= --protected-path safety/ --protected-path '*.frozen'`, h.ctx);
  assert.match(h.notes.at(-1)!.text, /RSI iteration ACCEPTED/);
  assert.equal(h.notes.at(-1)!.level, "info");
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.options.reasoning === "low" && call.options.signal instanceof AbortSignal && call.options.sessionId === h.root));
  const protocol = readJson(path.join(h.out, "artifacts/protocol.json"));
  assert.deepEqual(protocol.env, { ...h.params.env, RSI_SEED: "2026" });
  assert.equal(protocol.seed, 2026);
  assert.equal(protocol.coding_max_tokens, 32768);
  assert.equal(Object.hasOwn(h.calls[0].options, "maxTokens"), false);
  assert.equal(h.calls[1].options.maxTokens, 32768);
  assert.ok(protocol.protected_paths.includes("safety"));
  assert.ok(protocol.protected_paths.includes("*.frozen"));
  assert.equal(h.messages.length, 0);
});

test("/rsi iterate rejects malformed/unknown flags and ambiguous budgets before authorization", async () => {
  const h = harness();
  const command = h.commands.get("rsi");
  await command.handler("iterate", h.ctx);
  assert.match(h.notes.at(-1)!.text, /usage: \/rsi iterate/);
  await command.handler(`iterate "${h.fixture}"`, h.ctx);
  assert.match(h.notes.at(-1)!.text, /--adapter-acceptance PATH is required/);
  for (const args of ["--adapter-acceptance", "--adapter-acceptance a --adapter-acceptance b", "--env", "--env invalid", "--env X=1 --env X=2", "--seed", "--seed nope", "--seed 1.2", "--coding-max-tokens", "--coding-max-tokens nope", "--coding-max-tokens 0", "--coding-max-tokens -1", "--coding-max-tokens 1.5", "--coding-max-tokens 9007199254740992", "--coding-max-tokens Infinity", "--coding-max-tokens 8192 --coding-max-tokens 32768", "--mock", "--runner simulated", "--wait", "--repo", "extra-positional"]) {
    await command.handler(`iterate "${h.fixture}" --adapter-acceptance "${h.receiptPath}" ${args}`, h.ctx);
    assert.equal(h.notes.at(-1)!.level, "warning", args);
  }
  assert.equal(h.confirmations(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.out), false);
});

test("/rsi iterate forwards the receipt gate and help documents the required flag", async () => {
  const h = harness();
  fs.writeFileSync(h.receiptPath, JSON.stringify({ ...h.receipt, status: "failed" }));
  await h.commands.get("rsi").handler(`iterate "${h.fixture}" --adapter-acceptance "${h.receiptPath}" --repo "${h.repo}"`, h.ctx);
  assert.equal(h.notes.at(-1)!.level, "warning");
  assert.match(h.notes.at(-1)!.text, /adapter_acceptance requires status=ok/);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.out), false);
  await h.commands.get("rsi").handler("help", h.ctx);
  assert.match(h.notes.at(-1)!.text, /iterate <problem.json> --adapter-acceptance PATH/);
});

test("native explicit coding cap reaches Pi registry and retained config/protocol, subject to model maximum", async () => {
  for (const modelCap of [65536, 16384]) {
    const h = harness();
    h.ctx.model.maxTokens = modelCap;
    const response = await h.execute({ coding_max_tokens: 32768 });
    assert.equal(response.isError, false, response.content[0].text);
    assert.equal(Object.hasOwn(h.calls[0].options, "maxTokens"), false);
    assert.equal(h.calls[1].options.maxTokens, Math.min(modelCap, 32768));
    assert.equal(readJson(path.join(h.out, "artifacts/config.json")).modelRoutes.coding.maxTokens, 32768);
    assert.equal(readJson(response.details.artifacts.protocol).coding_max_tokens, 32768);
  }
});

test("native invalid coding caps fail before authorization, evidence directories or model work", async () => {
  const h = harness();
  for (const coding_max_tokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "32768", null]) {
    const response = await h.execute({ coding_max_tokens });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /coding_max_tokens/);
  }
  assert.equal(h.confirmations(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.out), false);
});


test("scope=full runs the formal protocol in its own ledger and does not reuse the subset incumbent", async () => {
  const h = harness();
  const parent = h.root;
  const subset = await h.execute({ out: path.join(parent, "sub"), env: { ...h.params.env } });
  assert.equal(subset.isError, false, subset.content[0].text);
  assert.equal(subset.details.baseline_source, "measured");
  const ledgerProblem = { ...h.problem, repo: h.repo };
  const subsetLedger = incumbentFileFor(parent, ledgerProblem, "subset");
  const fullLedger = incumbentFileFor(parent, ledgerProblem, "full");
  assert.ok(fs.existsSync(subsetLedger), `expected project baseline at ${subsetLedger}`);
  assert.equal(fs.existsSync(fullLedger), false);

  const full = await h.execute({ out: path.join(parent, "full"), scope: "full", env: { ...h.params.env } });
  assert.equal(full.isError, false, full.content[0].text);
  assert.equal(full.details.baseline_source, "measured", "full must not reuse the subset incumbent");
  assert.equal(full.details.summary.scope, "full");
  assert.equal(full.details.summary.formal_baseline, true);
  const protocol = readJson(full.details.artifacts.protocol);
  assert.equal(protocol.scope, "full");
  assert.deepEqual(protocol.scopes, ["full", "full"]);
  assert.ok(fs.existsSync(fullLedger), `expected project baseline at ${fullLedger}`);
  const ledger = readJson(fullLedger);
  assert.equal(ledger.scope, "full");
});

test("scope=full refuses a report that is not a real full_test with no evaluation limit", async () => {
  const h = harness(0.5, "full-as-smoke");
  const response = await h.execute({ scope: "full", env: { ...h.params.env } });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /full_test report with no evaluation limit/);
  assert.equal(readJson(response.details.summary ? path.join(response.details.root, "summary.json") : h.out + "/summary.json").executed, false);
});

test("native extra protected paths prevent the second experiment", async () => {
  const h = harness();
  const response = await h.execute({ protected_paths: ["train.py"] });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /protected protocol paths/);
  assert.equal(readJson(response.details.artifacts.summary).experiment_invocations, 1);
});
