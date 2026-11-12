import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { adapterSmoke } from "../src/rsi/adapter-smoke.ts";
import type { RemoteTransport } from "../src/rsi/runtime/workspace.ts";
import rsiExtension from "../extensions/rsi.ts";
import { readJson, tempDir } from "./helpers.ts";

// Explicitly fabricated metadata for transport tests, never training evidence.
const mockedPipeline = {
  training_skipped: false, executed_train_steps: 1, checkpoint_step: 1,
  checkpoint: "/mock-only/new-training/checkpoint-1", raw_metrics: "/mock-only/eval.json",
};

/** Real pinned git worktree; transport boundary is mocked: no SSH, GPU or training. */
function harness(t: TestContext) {
  const root = fs.realpathSync(tempDir("rsi-native-smoke-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "target repo");
  const out = path.join(root, "smoke output");
  const fixture = path.join(root, "problem.json");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "adapter.py"), "# committed adapter\n");
  function git(args: string[]) {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "-q"]);
  git(["add", "adapter.py"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline"]);
  const commit = git(["rev-parse", "HEAD"]);
  const problem = {
    id: "native-smoke", repo, repo_ref: commit,
    experiment_command: ["{python}", "adapter.py", "--scope", "{scope}", "--out", "{out}"],
    metrics: [{ name: "accuracy", direction: "max", bounds: [0, 1] }, { name: "loss", direction: "min", bounds: [0, 10] }],
    reported_metrics: { accuracy: 0.99, loss: 0.01 },
    remote: { host: "mock-host", dir: "/remote/smoke", gpu_ids: "3", python: "/env/bin/python", env: { ACTUAL_PROTOCOL: "documented", TEST_VALUE: "fixture" }, worktree: "", out: "" },
  };
  let report: any = { status: "ok", metrics: { accuracy: 0.75, loss: 2 }, details: { ...mockedPipeline } };
  let raw: string | undefined;
  let exit = 0;
  let fetchExit = 0;
  const calls: Array<{ binary: string; args: readonly string[]; signal?: AbortSignal; timeout?: number }> = [];
  let controller: AbortController | undefined;
  const transport: RemoteTransport = async (binary, args, opts) => {
    calls.push({ binary, args, signal: opts.signal, timeout: opts.timeoutS });
    if (binary === "rsync") {
      const source = args.at(-2)!.replace(/\/$/, "");
      assert.equal(fs.readFileSync(path.join(source, "adapter.py"), "utf8"), "# committed adapter\n");
      assert.ok(args.includes("--delete"));
    }
    const command = args.at(-1) ?? "";
    if (command.startsWith("bash -lc")) {
      if (controller) controller.abort();
      return { code: exit, stdout: "adapter stdout retained\n", stderr: exit ? "remote original failure" : "", killed: Boolean(controller) };
    }
    if (command.startsWith("cat ")) return { code: fetchExit, stdout: raw ?? JSON.stringify(report), stderr: fetchExit ? "report missing" : "", killed: false };
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  const save = () => fs.writeFileSync(fixture, JSON.stringify(problem));
  const run = async (extra: Record<string, any> = {}, options: Record<string, any> = {}) => {
    save();
    return adapterSmoke({ problem: fixture, out, timeout_s: 10, ...extra }, { cwd: root, transport, ...options });
  };
  save();
  return { root, repo, out, fixture, commit, problem, calls, run, save,
    summary: () => readJson(path.join(out, "artifacts/smoke-summary.json")),
    report: () => readJson(path.join(out, "artifacts/smoke-report.json")),
    setReport: (value: any) => { report = value; }, setRaw: (value: string) => { raw = value; },
    setExit: (value: number) => { exit = value; }, setFetchExit: (value: number) => { fetchExit = value; },
    abortDuringRun: (value: AbortController) => { controller = value; },
  };
}

test("native smoke runs the pinned real baseline with actual protocol env, exact metrics and retained raw evidence", async t => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.repo, "adapter.py"), "# dirty source must not run\n");
  const result = await h.run({ env: { TEST_VALUE: "override with spaces=preserved" } });
  assert.equal(result.status, "ok", result.error);
  assert.equal(result.readiness, "unverified");
  const summary = h.summary();
  assert.equal(summary.repo.commit, h.commit);
  assert.equal(summary.repo.repo, h.repo);
  assert.equal(summary.repo.path, path.join(h.out, "worktree"));
  assert.equal(summary.purpose.includes("plumbing-only"), true);
  assert.deepEqual(summary.metrics, { accuracy: 0.75, loss: 2 });
  assert.equal(summary.result.stdout, "adapter stdout retained\n");
  assert.equal(fs.readFileSync(path.join(h.out, "artifacts/smoke-stdout.txt"), "utf8"), summary.result.stdout);
  assert.deepEqual(h.report().metrics, summary.metrics);
  assert.equal(summary.invocation.remote_exit, 0);
  assert.match(summary.invocation.command, /ACTUAL_PROTOCOL=documented/);
  assert.match(summary.invocation.command, /TEST_VALUE='override with spaces=preserved'/);
  assert.match(summary.invocation.command, /CUDA_VISIBLE_DEVICES=3/);
  assert.match(summary.invocation.command, /timeout 10/);
  assert.match(summary.invocation.command, /--scope subset/);
  assert.ok(summary.invocation.remote_worktree.includes(result.run_id));
  assert.ok(summary.invocation.remote_out.includes(result.run_id));
  assert.ok(!summary.invocation.remote_out.startsWith(`${summary.invocation.remote_worktree}/`));
  assert.ok(h.calls.every(call => call.binary === "ssh" || call.binary === "rsync"));
  assert.equal(h.calls.filter(call => call.args.at(-1)?.startsWith("cat ")).length, 1);
});

for (const field of ["worktree", "out"] as const) {
  for (const template of ["/remote/static", "/remote/{run_id}/../shared", "/remote/./{run_id}", "/remote/{run_id}/child/..", "relative/{run_id}"]) {
    test(`smoke rejects unsafe remote.${field} ${template} before transport`, async t => {
      const h = harness(t);
      h.problem.remote[field] = template;
      await assert.rejects(h.run(), /run_id|traversal|absolute POSIX/);
      assert.equal(h.calls.length, 0);
      assert.equal(fs.existsSync(h.out), false);
    });
  }
}

test("effective normalized output must stay outside rsync tree", async t => {
  const h = harness(t);
  h.problem.remote.worktree = "/remote//{run_id}/tree/";
  h.problem.remote.out = "/remote/{run_id}//tree/out/";
  await assert.rejects(h.run(), /outside and separate/);
  assert.equal(h.calls.length, 0);
});

test("default output is per-run even for a custom direct-child worktree", async t => {
  const h = harness(t);
  h.problem.remote.worktree = "/remote/custom-{run_id}";
  const first = await h.run({ out: undefined });
  const second = await h.run({ out: undefined });
  const a = readJson(first.summary_path), b = readJson(second.summary_path);
  assert.notEqual(first.root, second.root);
  assert.notEqual(a.remote_out_dir, b.remote_out_dir);
  assert.ok(a.remote_out_dir.includes(first.run_id));
  assert.ok(b.remote_out_dir.includes(second.run_id));
  assert.match(a.remote_out_dir, /\/rsi\/adapter-smoke-.*\/out$/);
});

test("no stale local output or synthetic repository fallback", async t => {
  const h = harness(t);
  fs.mkdirSync(h.out);
  fs.writeFileSync(path.join(h.out, "sentinel"), "keep");
  await assert.rejects(h.run(), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(h.out, "sentinel"), "utf8"), "keep");
  assert.equal(h.calls.length, 0);
  h.problem.repo = "";
  await assert.rejects(h.run(), /real local target repository/);
  assert.equal(fs.existsSync(path.join(h.out, "synthetic")), false);
});

test("explicit repo_ref and valid timeout/env are required", async t => {
  const h = harness(t);
  h.problem.repo_ref = "";
  await assert.rejects(h.run(), /repo_ref is required/);
  h.problem.repo_ref = h.commit;
  for (const timeout_s of [0, -1, 1.5, NaN]) await assert.rejects(h.run({ timeout_s }), /positive integer/);
  await assert.rejects(h.run({ env: { "BAD;KEY": "injection" } }), /invalid remote environment/);
  assert.equal(h.calls.length, 0);
});

for (const [name, report, error] of [
  ["missing", { status: "ok", metrics: { loss: 2 } }, /metric keys/],
  ["extra", { status: "ok", metrics: { accuracy: 0.7, loss: 2, extra: 1 } }, /metric keys/],
  ["numeric string", { status: "ok", metrics: { accuracy: "0.7", loss: 2 } }, /finite number/],
  ["null", { status: "ok", metrics: { accuracy: null, loss: 2 } }, /finite number/],
  ["lower bound", { status: "ok", metrics: { accuracy: -0.01, loss: 2 } }, /outside bounds/],
  ["upper bound", { status: "ok", metrics: { accuracy: 1.01, loss: 2 } }, /outside bounds/],
  ["failed status", { status: "failed", metrics: { accuracy: 0.7, loss: 2 } }, /report.status is not ok/],
  ["skipped training", { status: "ok", metrics: { accuracy: 0.7, loss: 2 }, details: { training_skipped: true } }, /training_skipped must be false/],
] as const) {
  test(`strict original-report gate rejects ${name}`, async t => {
    const h = harness(t);
    h.setReport(report);
    const result = await h.run();
    assert.equal(result.status, "failed");
    assert.match(result.error!, error);
    assert.equal(h.summary().status, "failed");
    assert.deepEqual(h.report(), report);
    assert.equal(fs.readFileSync(path.join(h.out, "artifacts/smoke-report.raw.txt"), "utf8"), JSON.stringify(report));
  });
}

for (const accuracy of [0, 1]) test(`metric boundary ${accuracy} is inclusive`, async t => {
  const h = harness(t);
  h.setReport({ status: "ok", metrics: { accuracy, loss: 2 }, details: { ...mockedPipeline } });
  assert.equal((await h.run()).status, "ok");
});

for (const [name, details, error] of [
  ["missing metadata", undefined, /training_skipped must be false/],
  ["missing training flag", { ...mockedPipeline, training_skipped: undefined }, /training_skipped must be false/],
  ["string training flag", { ...mockedPipeline, training_skipped: "false" }, /training_skipped must be false/],
  ["zero steps", { ...mockedPipeline, executed_train_steps: 0 }, /positive integer/],
  ["fractional steps", { ...mockedPipeline, executed_train_steps: 1.5 }, /positive integer/],
  ["string steps", { ...mockedPipeline, executed_train_steps: "1" }, /positive integer/],
  ["missing steps", { ...mockedPipeline, executed_train_steps: undefined }, /positive integer/],
  ["old checkpoint step", { ...mockedPipeline, checkpoint_step: 3000 }, /must match/],
  ["missing checkpoint step", { ...mockedPipeline, checkpoint_step: undefined }, /must match/],
  ["empty checkpoint", { ...mockedPipeline, checkpoint: "  " }, /checkpoint must identify/],
  ["empty raw metrics", { ...mockedPipeline, raw_metrics: "" }, /raw_metrics must identify/],
  ["nonpath raw metrics", { ...mockedPipeline, raw_metrics: {} }, /raw_metrics must identify/],
] as const) test(`readiness rejects ${name} despite valid measured metric shape`, async t => {
  const h = harness(t);
  h.setReport({ status: "ok", metrics: { accuracy: 0.75, loss: 2 }, details });
  const result = await h.run();
  assert.equal(result.status, "failed");
  assert.match(result.error!, error);
  assert.equal(h.summary().pipeline_metadata_validated, undefined);
});

test("nonzero remote exit preserves original failure JSON and raw stdout", async t => {
  const h = harness(t);
  h.setExit(3);
  const report = { status: "failed", metrics: {}, details: { missing_asset: "/documented/path" } };
  h.setReport(report);
  const result = await h.run();
  assert.equal(result.status, "failed");
  assert.match(result.error!, /remote original failure.*\nremote command exited with status 3/);
  assert.deepEqual(h.report(), report);
  assert.equal(h.summary().invocation.remote_exit, 3);
  assert.match(h.summary().result.stdout, /stdout retained/);
});

test("invalid and nonfinite report bytes survive JSON summary serialization", async t => {
  const h = harness(t);
  const raw = '{"status":"ok","metrics":{"accuracy":1e999,"loss":2}}';
  h.setRaw(raw);
  assert.equal((await h.run()).status, "failed");
  assert.equal(fs.readFileSync(path.join(h.out, "artifacts/smoke-report.raw.txt"), "utf8"), raw);
  assert.match(h.summary().error, /not finite/);
});

test("fetch failures and malformed JSON retain transport diagnostics", async t => {
  const h = harness(t);
  h.setFetchExit(1);
  h.setRaw("not JSON");
  assert.equal((await h.run()).status, "failed");
  assert.equal(h.summary().invocation.fetch.stderr, "report missing");
  assert.match(h.summary().report_parse_error, /SyntaxError/);
  assert.equal(fs.readFileSync(path.join(h.out, "artifacts/smoke-report.raw.txt"), "utf8"), "not JSON");
});

test("abort signal propagates through transport and stops a smoke", async t => {
  const h = harness(t);
  const controller = new AbortController();
  h.abortDuringRun(controller);
  const result = await h.run({}, { signal: controller.signal });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /Abort/);
    assert.ok(h.calls.filter(call => call.signal !== undefined).every(call => call.signal === controller.signal));
  // The cleanup SSH is intentionally fresh: an aborted signal must not skip it.
  assert.ok(h.calls.some(call => call.signal === undefined && String(call.args.at(-1)).includes("kill -TERM")));
  assert.equal(h.summary().status, "failed");
});

test("already-aborted smoke never touches transport or creates output", async t => {
  const h = harness(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.run({}, { signal: controller.signal }), /Abort/);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.out), false);
});

function native(t: TestContext) {
  const h = harness(t);
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  const notes: Array<{ message: string; level: string }> = [];
  let approved = false, confirmations = 0;
  rsiExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage: () => {} } as any);
  const ctx = { cwd: h.root, hasUI: true, sessionManager: { getSessionId: () => h.root }, ui: {
    notify: (message: string, level: string) => notes.push({ message, level }),
    confirm: async () => { confirmations++; return approved; },
  } } as any;
  return { ...h, tools, commands, ctx, notes, approve: () => { approved = true; }, confirmations: () => confirmations };
}

test("extension registers native smoke schema and fails closed without execution authority", async t => {
  const h = native(t);
  const tool = h.tools.get("rsi_adapter_smoke");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["problem"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["problem", "repo", "out", "env", "timeout_s"]);
  assert.equal(tool.executionMode, "sequential");
  const response = await tool.execute("call", { problem: h.fixture }, undefined, undefined, { ...h.ctx, hasUI: false });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /fresh authorization/);
  assert.equal(h.confirmations(), 0);
  assert.equal(fs.existsSync(h.out), false);
});

test("native tool refusal and abort cannot execute GPU work", async t => {
  const h = native(t);
  const tool = h.tools.get("rsi_adapter_smoke");
  const refused = await tool.execute("refuse", { problem: h.fixture }, undefined, undefined, h.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not authorized/);
  const controller = new AbortController(); controller.abort();
  const aborted = await tool.execute("abort", { problem: h.fixture }, controller.signal, undefined, h.ctx);
  assert.equal(aborted.isError, true);
  assert.match(aborted.content[0].text, /Abort/);
  assert.equal(h.confirmations(), 1);
});

test("/rsi smoke reuses native parser including quoted repo/out, timeout and repeated env", async t => {
  const h = native(t);
  h.approve();
  h.problem.repo_ref = "missing-pinned-ref"; // fails locally before SSH; summary proves parser forwarding
  h.save();
  await h.commands.get("rsi").handler(`smoke "${h.fixture}" --repo "${h.repo}" --out "${h.out}" --timeout 17 --env FIRST=one --env "SECOND=two words=three"`, h.ctx);
  assert.equal(h.confirmations(), 1);
  const summary = h.summary();
  assert.equal(summary.status, "failed");
  assert.match(summary.error, /git rev-parse missing-pinned-ref/);
  assert.deepEqual(summary.env_overrides, { FIRST: "one", SECOND: "two words=three" });
  assert.match(h.notes.at(-1)!.message, /Evidence:/);
  assert.equal(h.notes.at(-1)!.level, "warning");
});

test("/rsi smoke gives usage and rejects malformed arguments before authorization", async t => {
  const h = native(t);
  const command = h.commands.get("rsi");
  await command.handler("smoke", h.ctx);
  assert.match(h.notes.at(-1)!.message, /usage: \/rsi smoke/);
  for (const args of ["--env invalid", "--env", "--timeout nope", "--timeout"]) {
    await command.handler(`smoke "${h.fixture}" ${args}`, h.ctx);
    assert.match(h.notes.at(-1)!.message, /expected KEY=VALUE|requires/);
  }
  assert.equal(h.confirmations(), 0);
});
