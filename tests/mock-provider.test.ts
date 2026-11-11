import test from "node:test";
import assert from "node:assert/strict";

import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import type { StructuredSpec } from "../src/rsi/providers/base.ts";
import { IdeaBatch, MetaReviewSpec, VerdictSpec } from "../src/rsi/schemas.ts";
import type { LLMRequest } from "../src/rsi/providers/base.ts";

const req = (task: string, meta: Record<string, unknown> = {}): LLMRequest => ({
  task,
  system: "",
  user: "",
  temperature: 0.2,
  maxTokens: 100,
  meta,
});

test("mock synthesis is deterministic, unique, and bounded by n", async () => {
  const left = new MockLLMProvider(null, 19);
  const right = new MockLLMProvider(null, 19);
  const outputs = [];
  const repeated = [];
  for (let i = 0; i < 3; i++) {
    outputs.push(await left.structured(req("brand.new.task", { n: 4, round: 2 }), IdeaBatch));
    repeated.push(await right.structured(req("brand.new.task", { n: 4, round: 2 }), IdeaBatch));
  }
  assert.deepEqual(outputs, repeated);
  assert.ok(outputs.every((batch) => batch.ideas.length === 4));
  const ids = outputs.flatMap((batch) => batch.ideas.map((idea) => idea.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const idea of outputs.flatMap((batch) => batch.ideas)) {
    assert.ok(idea.id.length > 0);
    assert.ok(idea.hypothesis.length > 0);
    assert.ok(idea.mechanism.length > 0);
  }
  assert.equal(left.count("brand.new.task"), 3);
  assert.equal(left.count("missing"), 0);
  assert.deepEqual(left.last("brand.new.task")?.meta, { n: 4, round: 2 });
  assert.equal(left.last("missing"), null);
  assert.equal(left.calls[0].schemaName, "IdeaBatch");
});

test("n=0 yields an empty list; raw unknown calls return {}", async () => {
  const provider = new MockLLMProvider();
  const empty = await provider.structured(req("empty", { n: 0 }), IdeaBatch);
  assert.deepEqual(empty.ideas, []);
  const raw = await provider.complete(req("unknown.raw"));
  assert.deepEqual(JSON.parse(raw.text), {});
});

test("decisions cycle through values allowed by each schema", async () => {
  const provider = new MockLLMProvider();
  const decisions = [];
  for (let i = 0; i < 5; i++) decisions.push((await provider.structured(req("judge"), VerdictSpec)).decision);
  assert.deepEqual(decisions, ["refine", "good", "accept", "bad", "engineer"]);
  const metas = [0, 1].map(async () => (await provider.structured(req("review.meta"), MetaReviewSpec)).decision);
  assert.deepEqual(await Promise.all(metas), ["refine", "accept"]);
});

test("scripts replay in order and repeat the last value", async () => {
  const provider = new MockLLMProvider(
    {
      judge: [
        { decision: "accept", feedback: "pinned" },
        { decision: "refine" },
      ],
    },
    7,
  );
  assert.equal((await provider.structured(req("judge"), VerdictSpec)).feedback, "pinned");
  assert.equal((await provider.structured(req("judge"), VerdictSpec)).decision, "refine");
  assert.equal((await provider.structured(req("judge"), VerdictSpec)).decision, "refine");
});

test("dynamic hook overrides scripts and can be async", async () => {
  const provider = new MockLLMProvider(null, 7);
  provider.scriptDynamic = (request) => ({ decision: "accept", feedback: request.task });
  assert.equal((await provider.structured(req("judge"), VerdictSpec)).feedback, "judge");
  provider.scriptDynamic = async (request) =>
    request.meta.dynamic ? { decision: "refine", feedback: "dynamic" } : null;
  assert.equal((await provider.structured(req("judge", { dynamic: true }), VerdictSpec)).decision, "refine");
  assert.notEqual((await provider.structured(req("judge"), VerdictSpec)).feedback, "dynamic");
});

test("scripted values are validated strictly", async () => {
  const strict: StructuredSpec<{ decision: "accept" | "refine" }> = {
    name: "StrictJudgment",
    parse(raw) {
      const value = raw as { decision?: string };
      if (value?.decision !== "accept" && value?.decision !== "refine") {
        throw new Error("invalid decision");
      }
      return { decision: value.decision };
    },
    fallback: () => ({ decision: "refine" }),
  };
  const provider = new MockLLMProvider({ strict: { decision: "not-allowed" } });
  await assert.rejects(() => provider.structured(req("strict"), strict), /invalid decision/);
});
