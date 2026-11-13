import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Orchestrator } from "../src/rsi/core/orchestrator.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import { loadProblem } from "../src/rsi/run.ts";
import type { DiagnosisResult } from "../src/rsi/runtime/diagnosis.ts";
import type { DiagnosisFinding } from "../src/rsi/types.ts";
import { fixture, makeContext, tempDir } from "./helpers.ts";

const findings: DiagnosisFinding[] = [
  {
    id: "d1",
    title: "History convolution loses precision under autocast",
    axis: "numerical-precision",
    evidence: "measured fp16 overflow rate 3.2% in the history kernel",
    severity: 0.9,
    actionable: true,
    measured: true,
    metric: "fp16_overflow_rate",
    value: 0.032,
    artifact: "artifacts/diagnosis/history.json",
  },
  {
    id: "d2",
    title: "Attention-free mixing may under-use long context",
    axis: "long-context",
    evidence: "hypothesis only: no measurement supplied",
    severity: 0.4,
    actionable: true,
    measured: false,
  },
];

function diagnosisProblem(name = "ood_frozen_encoder") {
  const problem = loadProblem(fixture(name));
  problem.diagnose_command = ["{python}", "bench/diagnose.py", "--repo", "{repo}", "--out", "{out}"];
  return problem;
}

function gitRepo(): string {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(tempDir("rsi-diag-repo-")), "target-"));
  fs.writeFileSync(path.join(repo, "model.py"), "rate = 1\n");
  const run = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q");
  run("add", "-A");
  run("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline");
  return repo;
}

function harness(options: {
  policy?: "depth" | "breadth";
  result?: DiagnosisResult;
  name?: string;
} = {}) {
  const ctx = makeContext({ problemName: options.name ?? "ood_frozen_encoder" });
  ctx.problem.repo = gitRepo();
  ctx.problem.repo_ref = "HEAD";
  ctx.problem.diagnose_command = ["{python}", "bench/diagnose.py", "--repo", "{repo}", "--out", "{out}"];
  ctx.config.searchPolicy = options.policy ?? "depth";
  const calls: Array<{ commit?: string; repo: string; timeoutS: number }> = [];
  const diagnoseFn = async (
    _problem: unknown,
    repo: { commit?: string; repo?: string },
    store: typeof ctx.store,
    opts: { timeoutS: number },
  ): Promise<DiagnosisResult> => {
    calls.push({ commit: repo.commit, repo: String(repo.repo), timeoutS: opts.timeoutS });
    store.writeJson("diagnosis/findings.json", { findings });
    return options.result ?? {
      status: "ok",
      findings,
      stdout: "measured two signals",
      stderr: "",
      log_path: store.artifact("diagnosis/findings.json"),
      wall_time_s: 0.25,
    };
  };
  const orchestrator = new Orchestrator(ctx, undefined, undefined, diagnoseFn);
  return { ctx, calls, orchestrator };
}

test("diagnose runs on the reproduced baseline before limitations and seeds", async () => {
  const h = harness();
  const final = await h.orchestrator.run();
  assert.equal(final.aborted, false, final.abort_reason);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].commit, "diagnosis must use the reproduced baseline commit");
  assert.equal(h.calls[0].repo, h.ctx.problem.repo);
  assert.ok(h.calls[0].commit);

  const state = h.orchestrator.state;
  assert.equal(state.diagnosis?.findings.length, 2);
  assert.ok(state.limitations.some((item) => item.id === "D1" && item.text.includes("History convolution")));
  assert.ok(state.limitations.some((item) => item.id === "D2"));

  const path = state.decisionPath;
  const baseline = path.findIndex((token) => token === "baseline.ok");
  const diagnose = path.findIndex((token) => token.startsWith("diagnose.ok"));
  const limits = path.findIndex((token) => token.startsWith("limits.ok"));
  const seeds = path.findIndex((token) => token.startsWith("seeds:"));
  assert.ok(baseline >= 0 && diagnose > baseline, `baseline ${baseline}, diagnose ${diagnose}`);
  assert.ok(limits > diagnose && seeds > limits, `diagnose ${diagnose}, limits ${limits}, seeds ${seeds}`);

  // Depth mode narrows the measured defect, but evaluates the full seed pool.
  assert.equal(state.seeds.length, 8);
  assert.equal(state.traces.length, 8);
  assert.ok(state.seeds.some((idea) => idea.target_limitations.includes("D1")));
});

test("a failed or unmeasured diagnosis aborts before any seed or candidate", async () => {
  const failed = harness({
    result: { status: "failed", findings: [], stdout: "", stderr: "analysis crashed", log_path: "", wall_time_s: 0.1, error: "analysis crashed" },
  });
  const final = await failed.orchestrator.run();
  assert.equal(final.aborted, true);
  assert.equal(final.abort_reason, "diagnosis_failed");
  assert.equal(failed.orchestrator.state.seeds.length, 0);
  assert.equal(failed.orchestrator.state.traces.length, 0);
  assert.ok(failed.orchestrator.state.decisionPath.includes("diagnose.failed"));
});

test("diagnosis findings are persisted for resume and replay", async () => {
  const h = harness();
  await h.orchestrator.run();
  const stateFile = path.join(h.orchestrator.ctx.store.root, "state.json");
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(saved.diagnosis.findings.length, 2);
  assert.equal(saved.diagnosis.findings[0].measured, true);
  const reloaded = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(reloaded.limitations.some((item: { id: string }) => item.id === "D1"));
});

test("breadth policy runs the multi-seed search before the data gate", async () => {
  const h = harness({ policy: "breadth" });
  // This test isolates the breadth search. The offline ablation fixture has a
  // dead component, so the new attribution gate correctly stops before writing.
  const final = await h.orchestrator.run();
  const goodRounds = h.orchestrator.state.traces
    .filter((trace) => trace.decision === "good")
    .map((trace) => trace.round)
    .sort();
  assert.ok(goodRounds.length >= 2, `expected multiple good traces, got ${JSON.stringify(goodRounds)}`);
  assert.ok(new Set(goodRounds).size >= 2, `expected multiple rounds, got ${JSON.stringify(goodRounds)}`);
  assert.ok(h.orchestrator.state.diagnosis?.findings.length, "diagnosis still runs in breadth mode");
  assert.ok(h.orchestrator.state.seeds.length >= 1);
  assert.equal(final.aborted, false, final.abort_reason);
});

test("a problem without diagnose_command keeps the original order and no diagnosis", async () => {
  const ctx = makeContext({ problemName: "ood_frozen_encoder" });
  assert.equal(ctx.problem.diagnose_command, null);
  assert.equal(ctx.problem.repo, null);
  let called = 0;
  const orchestrator = new Orchestrator(ctx, undefined, undefined, async () => {
    called += 1;
    throw new Error("must not diagnose without a declared command");
  });
  const final = await orchestrator.run();
  assert.equal(final.aborted, false, final.abort_reason);
  assert.equal(called, 0);
  assert.equal(orchestrator.state.diagnosis, null);
  const path = orchestrator.state.decisionPath;
  assert.ok(path.findIndex((token) => token.startsWith("limits.ok")) < path.findIndex((token) => token === "baseline.ok"));
});

test("depth policy config defaults to depth and accepts an explicit breadth override", () => {
  assert.equal(defaultConfig().searchPolicy, "depth");
  assert.equal(defaultConfig({ searchPolicy: "breadth" }).searchPolicy, "breadth");
  assert.ok(diagnosisProblem().diagnose_command?.includes("{repo}"));
});
