import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { inspectRun, reconstructDecisionPath, replayRun } from "../src/rsi/run.ts";
import { mockRun, fixture, readJson } from "./helpers.ts";

test("offline happy path runs §3.1–§3.6 and exports artifacts", async () => {
  const result = await mockRun();
  assert.equal(result.final.aborted, false);
  const state = result.state as any;
  assert.ok(state.limitations.length >= 3);
  assert.ok(state.seeds.length > 0);
  assert.ok(state.best_idea && state.best_evidence);
  assert.ok(state.baseline_full, "a candidate reached full, so the lazy full baseline was measured");
  assert.ok(result.final.decision_path.includes("baseline.full.ok"));
  assert.ok(state.ablations.length > 0);
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

test("the full baseline is lazy and is not measured when no candidate reaches full", async () => {
  const result = await mockRun({ configOverrides: { subsetMargin: 10 } });
  const state = result.state as any;
  assert.ok(state.baseline, "the subset baseline is still measured");
  assert.equal(state.baseline_full, null);
  assert.equal(result.final.decision_path.includes("baseline.full.ok"), false);
  assert.equal(result.final.decision_path.includes("baseline.full.bad"), false);
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "no_good_ideas");
});

test("the data gate blocks paper writing without multi-round evidence", async () => {
  const result = await mockRun({ configOverrides: { minGoodTraces: 99 } });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "data_gate_not_met");
  assert.equal((result.state as any).manuscript, null);
  assert.equal(result.final.decision_path.some((token) => token.startsWith("peer.")), false);
});

test("abort case dead-ends with no_good_ideas and still exports", async () => {
  const result = await mockRun({ problem: fixture("abort_case") });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "no_good_ideas");
  const traces = (result.state as any).traces as any[];
  assert.ok(traces.length > 0);
  assert.ok(traces.every((trace) => trace.decision !== "good"));
  assert.equal(readJson(path.join(result.root, "final.json")).aborted, true);
});

test("replay rebuilds the path from traces only and detects tampering", async () => {
  const result = await mockRun();
  const replay = replayRun({ outDir: path.dirname(result.root), runId: result.runId });
  assert.equal(replay.match, true);
  assert.deepEqual(replay.reconstructed, replay.recorded);

  const stateFile = path.join(result.root, "state.json");
  const state = readJson(stateFile);
  state.decision_path.push("tampered.transition");
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
  const tampered = replayRun({ outDir: path.dirname(result.root), runId: result.runId });
  assert.equal(tampered.match, false);
});

test("inspect reads a run without a provider or workspace", async () => {
  const result = await mockRun();
  const inspected = inspectRun({ outDir: path.dirname(result.root), runId: result.runId });
  assert.equal(inspected.decisionPath.length, result.final.decision_path.length);
  assert.equal((inspected.state as any).aborted, false);
});

test("scripted meta-refinement adopts a measured improvement and accepts", async () => {
  const result = await mockRun({
    problem: fixture("meta_refine"),
    mockScript: (await import("../src/rsi/run.ts")).loadScript(fixture("mock_script")),
  });
  assert.equal(result.final.aborted, false);
  assert.equal(result.final.meta_review?.decision, "accept");
  assert.equal(result.final.extra.accepted, true);
  assert.ok(result.final.decision_path.includes("adopt.meta:" + (result.state as any).best_idea.id) ||
    result.final.decision_path.some((token) => token.startsWith("adopt.meta:")));
});

test("without the script the meta refinement is not adopted", async () => {
  const result = await mockRun({ problem: fixture("meta_refine") });
  assert.equal(result.final.aborted, false);
  assert.equal(result.final.extra.accepted, false);
  assert.equal((result.state as any).export_reason, "meta_refinement_not_strictly_better");
});
