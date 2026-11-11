import test from "node:test";
import assert from "node:assert/strict";

import { ResultComparison } from "../src/rsi/agents/critics.ts";
import { makeContext, mockRun } from "./helpers.ts";
import { makeEvidence } from "../src/rsi/types.ts";

test("a good trace carries subset and full-set evidence plus lessons", async () => {
  const result = await mockRun();
  const traces = (result.state as any).traces as any[];
  const good = traces.find((trace) => trace.decision === "good");
  assert.ok(good, "the offline fixture must produce at least one Good trace");
  assert.ok(good.evidence.length >= 2);
  assert.equal(good.evidence[0].scope, "subset");
  assert.equal(good.evidence[good.evidence.length - 1].scope, "full");
  assert.ok(good.lessons.length >= 2);
  for (const evidence of good.evidence) {
    assert.ok(Object.keys(evidence.metrics).length > 0);
    assert.equal(evidence.result.status, "ok");
    assert.ok(evidence.code?.path);
  }
});

test("ablations are executable, measured, and complete", async () => {
  const result = await mockRun();
  const state = result.state as any;
  assert.equal(state.ablations.length, 5);
  for (const ablation of state.ablations) {
    assert.ok(ablation.plan_id);
    assert.ok(ablation.component);
    assert.ok(ablation.evidence);
    assert.equal(ablation.evidence.scope, "ablation");
    assert.ok(Object.keys(ablation.metrics).length > 0);
  }
  assert.ok(result.final.decision_path.some((token) => token.startsWith("ablation.")));
});

test("ResultComparison is a no-LLM strict adoption gate", async () => {
  const ctx = makeContext();
  const before = ctx.budget.llmCalls;
  const agent = new ResultComparison(ctx);
  const base = makeEvidence({ metrics: { auroc: 0.9 } });
  const better = makeEvidence({ metrics: { auroc: 0.95 } });
  const verdict = await agent.compare(better, base);
  assert.equal(verdict.decision, "good");
  assert.equal(ctx.budget.llmCalls, before);
  const worse = await agent.compare(makeEvidence({ metrics: { auroc: 0.8 } }), base);
  assert.equal(worse.decision, "refine");
});
