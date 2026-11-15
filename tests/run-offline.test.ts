import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { inspectRun, reconstructDecisionPath, replayRun, loadProblem } from "../src/rsi/run.ts";
import { mockRun, fixture, readJson, repoRoot } from "./helpers.ts";

let happy: ReturnType<typeof mockRun> | undefined;
const happyRun = () => happy ??= mockRun();

test("[integration] offline happy path runs §3.1–§3.6 and exports artifacts", async () => {
  const result = await happyRun();
  assert.equal(result.final.aborted, false);
  const state = result.state as any;
  assert.ok(state.limitations.length >= 3);
  assert.ok(state.seeds.length > 0);
  assert.ok(state.best_idea && state.best_evidence);
  assert.ok(state.baseline_full, "a candidate reached full, so the lazy full baseline was measured");
  assert.ok(result.final.decision_path.includes("baseline.full.ok"));
  assert.ok(state.ablations.length > 0);
  const good = state.traces.find((trace: any) => trace.decision === "good");
  assert.ok(good.evidence.length >= 2);
  assert.equal(good.evidence[0].scope, "subset");
  assert.equal(good.evidence.at(-1).scope, "full");
  assert.ok(good.lessons.length >= 2);
  assert.equal(state.ablations.length, 5);
  for (const ablation of state.ablations) {
    assert.ok(ablation.plan_id && ablation.component && ablation.evidence);
    assert.equal(ablation.evidence.scope, "ablation");
    assert.ok(Object.keys(ablation.metrics).length > 0);
  }
  const { incumbentFileFor, loadRunBaselines } = await import("../src/rsi/runtime/incumbent.ts");
  const problem = loadProblem(fixture("ood_frozen_encoder"), repoRoot);
  const ledger = readJson(incumbentFileFor(path.dirname(result.root), problem, "full"));
  assert.equal(ledger.version, 1);
  assert.equal(ledger.scope, "full");
  assert.equal(result.summary.baseline_source, "promoted");
  const seeds = loadRunBaselines(problem, path.dirname(result.root), 7);
  assert.equal(seeds.full?.evidence.code?.commit, ledger.commit);
  assert.equal(seeds.subset?.source, "incumbent");

  assert.ok(state.review && state.meta_review);
  assert.ok(result.final.decision_path.length > 0);
  assert.deepEqual(result.final.decision_path, state.decision_path);

  const evaluated = (state.traces as any[]).map((trace) => trace.idea.id);
  assert.equal(new Set(evaluated).size, evaluated.length);
  assert.ok(result.records.length > 0);
  assert.deepEqual(
    result.records.map((record) => record.seq),
    result.records.map((_, index) => index + 1),
  );
  const allowed = new Set([
    "llm",
    "state.note",
    "state.adopt",
    "run.done",
    "run.abort",
    "manuscript_validation",
    "implementation_instruction",
    "integrity",
    "style.ok",
    "style.violation",
  ]);
  for (const record of result.records) {
    assert.ok(allowed.has(record.kind) || record.kind.startsWith("stage."), record.kind);
  }
  assert.deepEqual(reconstructDecisionPath(result.records), result.final.decision_path);

  for (const file of ["state.json", "traces.jsonl", "final.json"]) {
    assert.ok(fs.existsSync(path.join(result.root, file)), file);
  }
  assert.ok(fs.existsSync(path.join(result.root, "artifacts")));
  assert.ok(fs.existsSync(path.join(result.root, "patches")));
  assert.ok(fs.existsSync(path.join(result.root, "worktree")));
  assert.ok(fs.readFileSync(path.join(result.root, "patches", "h4-subset.diff"), "utf8").length > 0);
});

test("[integration] the full baseline is lazy and is not measured when no candidate reaches full", async () => {
  const result = await mockRun({ configOverrides: { subsetMargin: 10, maxIdeaRetries: 0, nSeed: 1, maxRefineRounds: 0, maxEngRounds: 0 } });
  const state = result.state as any;
  assert.ok(state.baseline, "the subset baseline is still measured");
  assert.equal(state.baseline_full, null);
  assert.equal(result.final.decision_path.includes("baseline.full.ok"), false);
  assert.equal(result.final.decision_path.includes("baseline.full.bad"), false);
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "no_good_ideas");
});

test("[integration] a writing-contract failure aborts the run but still exports final.json", async () => {
  const bad = {
    limitations: [{
      id: "L1",
      text: "Significantly lower word ppl",
      axis: "method",
      evidence: "bad evidence",
      severity: 0.5,
      actionable: true,
    }],
    rationale: "bad",
  };
  const result = await mockRun({ mockScript: { "limitations.extract": [bad, bad, bad] } });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "style_violation");
  assert.ok(fs.existsSync(path.join(result.root, "final.json")));
});

test("[integration] limits stop after a no-progress round instead of demanding every axis", async () => {
  const limitations = [
    { id: "L1", text: "word_ppl is high", axis: "method", evidence: "measured", severity: 0.5, actionable: true },
    { id: "L2", text: "word_ppl is noisy", axis: "evaluation", evidence: "measured", severity: 0.5, actionable: true },
  ];
  const result = await mockRun({
    mockScript: {
      "limitations.extract": { limitations, rationale: "same set" },
      "limitations.verify": { decision: "refine", feedback: "missing theory axis", metrics: {}, notes: "" },
    },
  });
  assert.equal(result.final.abort_reason, "limitations_exhausted");
  assert.equal(result.final.aborted, true);
  assert.ok(fs.existsSync(path.join(result.root, "final.json")));
});

test("[integration] the data gate blocks paper writing without multi-round evidence", async () => {
  const result = await mockRun({ configOverrides: { minGoodTraces: 99 } });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "data_gate_not_met");
  assert.equal((result.state as any).manuscript, null);
  assert.equal(result.final.decision_path.some((token) => token.startsWith("peer.")), false);
});

test("[integration] abort case dead-ends with no_good_ideas and still exports", async () => {
  const result = await mockRun({ problem: fixture("abort_case"), configOverrides: { maxIdeaRetries: 0, nSeed: 1, maxRefineRounds: 0, maxEngRounds: 0 } });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "no_good_ideas");
  const traces = (result.state as any).traces as any[];
  assert.ok(traces.length > 0);
  assert.ok(traces.every((trace) => trace.decision !== "good"));
  assert.equal(readJson(path.join(result.root, "final.json")).aborted, true);
});

test("[integration] the problem's max_retry.idea bounds the retries and max_retry.paper is separate", async () => {
  const raw = readJson(fixture("abort_case"));
  const file = path.join(fs.mkdtempSync("/tmp/rsi-retry-"), "problem.json");
  fs.writeFileSync(file, JSON.stringify({ ...raw, max_retry: { idea: 1, paper: 0 } }));
  const result = await mockRun({ problem: file, configOverrides: { nSeed: 1, maxRefineRounds: 0, maxEngRounds: 0 } });
  const tokens = result.final.decision_path;
  assert.equal(result.final.abort_reason, "no_good_ideas");
  assert.ok(tokens.includes("seeds.retry:1"), "one retry was used");
  assert.ok(!tokens.includes("seeds.retry:2"), "the problem budget stops the second retry");
  assert.equal((result.state as any).idea_retries, 1);
  assert.equal((result.state as any).paper_retries, 0);
});

test("[integration] replay rebuilds the path from traces only and detects tampering", async () => {
  const result = await happyRun();
  const replay = replayRun({ outDir: path.dirname(result.root), runId: result.runId });
  assert.equal(replay.match, true);
  assert.deepEqual(replay.reconstructed, replay.recorded);

  const stateFile = path.join(result.root, "state.json");
  const state = readJson(stateFile);
  const original = fs.readFileSync(stateFile, "utf8");
  state.decision_path.push("tampered.transition");
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  const tampered = replayRun({ outDir: path.dirname(result.root), runId: result.runId });
  fs.writeFileSync(stateFile, original, "utf8");
  assert.equal(tampered.match, false);
});

test("[integration] inspect reads a run without a provider or workspace", async () => {
  const result = await happyRun();
  const inspected = inspectRun({ outDir: path.dirname(result.root), runId: result.runId });
  assert.equal(inspected.decisionPath.length, result.final.decision_path.length);
  assert.equal((inspected.state as any).aborted, false);
});
