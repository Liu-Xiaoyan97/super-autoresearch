import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mockRun, defaultMockPlan, fixture, readJson } from "./helpers.ts";

test("[integration] the paper loop retries a non-accepted review within max_retry.paper", async () => {
  const raw = readJson(fixture("meta_refine"));
  const dir = fs.mkdtempSync("/tmp/rsi-paper-retry-");
  const write = (name: string, paper: number): string => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...raw, max_retry: { idea: 0, paper } }));
    return file;
  };
  // A meta-reviewer that never accepts: only the retry policy can end the loop.
  const script = { ...defaultMockPlan, "review.meta": { decision: "refine", critique: "The mechanism needs a measured algorithmic change.", score: 5 } };
  const stopped = await mockRun({ problem: write("stop", 0), mockScript: script, configOverrides: { nSeed: 1, minLimitations: 7, maxMetaRounds: 0, maxReviewRefinements: 0, maxPeerRounds: 0, reviewPanelSize: 1 } });
  const retried = await mockRun({ problem: write("retry", 1), mockScript: script, configOverrides: { nSeed: 1, minLimitations: 7, maxMetaRounds: 0, maxReviewRefinements: 0, maxPeerRounds: 0, reviewPanelSize: 1 } });
  assert.ok(!stopped.final.decision_path.some((token) => token.startsWith("paper.retry:")), "paper 0 never retries");
  assert.ok(retried.final.decision_path.includes("paper.retry:1"), "one paper retry");
  assert.ok(retried.final.decision_path.includes("paper.revised"), "the retry revises the manuscript instead of re-drafting");
  assert.ok(!retried.final.decision_path.some((token) => token.startsWith("paper.retry:2")), "the paper budget bounds it");
  assert.equal((retried.state as any).paper_retries, 1);
});

test("[integration] scripted meta-refinement adopts a measured improvement and accepts", async () => {
  const script = (await import("../src/rsi/run.ts")).loadScript(fixture("mock_script"));
  script["integrity.method_code"] = { alignment: 1, missing: [], notes: "Pinned method-code evidence for this accepted fixture." };
  const result = await mockRun({
    problem: fixture("meta_refine"),
    mockScript: script,
    configOverrides: { nSeed: 1, minLimitations: 7 },
  });
  assert.equal(result.final.aborted, false);
  assert.equal(result.final.meta_review?.decision, "accept");
  assert.equal(result.final.extra.accepted, true);
  assert.ok(result.final.decision_path.includes("adopt.meta:" + (result.state as any).best_idea.id) ||
    result.final.decision_path.some((token) => token.startsWith("adopt.meta:")));
});

test("[integration] failed meta attribution exports the candidate with paper blocked", async () => {
  const result = await mockRun({
    problem: fixture("meta_refine"),
    configOverrides: { nSeed: 1, minLimitations: 7 },
  });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "data_gate_not_met");
  assert.equal(result.final.extra.accepted, false);
  assert.ok(result.final.meta_review);
  assert.ok(result.final.decision_path.includes("ablation.refine"));
  assert.ok(fs.existsSync(path.join(result.root, "final.json")));
});
