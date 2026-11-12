import test from "node:test";
import assert from "node:assert/strict";

import { ResultComparison } from "../src/rsi/agents/critics.ts";
import { BaselineCoder } from "../src/rsi/agents/coding.ts";
import { LLMError, LLMProvider, type LLMRequest, type LLMResponse } from "../src/rsi/providers/base.ts";
import { BaselinePatch } from "../src/rsi/schemas.ts";
import { makeContext, mockRun } from "./helpers.ts";
import { makeEvidence } from "../src/rsi/types.ts";

class FailingProvider extends LLMProvider {
  readonly name = "failing";
  private readonly message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }

  async complete(_req: LLMRequest): Promise<LLMResponse> {
    throw new LLMError(this.message);
  }
}

test("a failed baseline patch falls back to the unmodified snapshot", async () => {
  const ctx = makeContext();
  ctx.llm = new FailingProvider("task code.baseline reported failed: placeholder");
  const calls: { wrote: string[]; ran: string[] } = { wrote: [], ran: [] };
  ctx.workspace = {
    baselineRepo: async () => ({
      path: "/tmp/base",
      label: "baseline",
      parent: null,
      patch: "",
      repo: "fixture",
      commit: "abc123",
      branch: "detached",
    }),
    writePatch: async (repo: any, patch: string, label: string) => {
      calls.wrote.push(patch);
      return { ...repo, label, patch, branch: `b/${label}` };
    },
    run: async (_repo: any, scope: string) => {
      calls.ran.push(scope);
      return { metrics: { score: 1 }, status: "ok" as const, log_path: "", stdout: "", stderr: "", wall_time_s: 0 };
    },
  } as any;
  const evidence = await new BaselineCoder(ctx).reproduce();
  assert.deepEqual(evidence.metrics, { score: 1 });
  assert.deepEqual(calls.wrote, [""], "an empty patch is recorded, not invented");
  assert.deepEqual(calls.ran, ["subset", "subset", "subset"], "the base commit runs once per screen seed");
  assert.ok(ctx.traces.readAll().some((record) => record.kind === "baseline.patch.skipped"));
});

test("a blocked baseline report still needs a person", async () => {
  const ctx = makeContext();
  ctx.llm = new FailingProvider("task code.baseline reported blocked: choose a checkpoint");
  await assert.rejects(new BaselineCoder(ctx).reproduce(), /reported blocked/);
});

test("the baseline schema asks for an empty patch, not an invented diff", () => {
  assert.match(BaselinePatch.instruction ?? "", /empty string for the unmodified baseline snapshot/);
});

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
