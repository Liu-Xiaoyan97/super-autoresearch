import test from "node:test";
import assert from "node:assert/strict";

import { stage } from "../src/rsi/core/stage.ts";
import { makeVerdict } from "../src/rsi/types.ts";

test("stage returns immediately on GOOD", async () => {
  let calls = 0;
  const result = await stage(
    1,
    async () => {
      calls += 1;
      return makeVerdict({ decision: "good", feedback: "done" });
    },
    async (value) => value + 1,
    5,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.value, 1);
  assert.equal(calls, 1);
  assert.equal(result.rounds, 1);
});

test("stage refines until acceptance", async () => {
  const decisions = ["refine", "engineer", "accept"] as const;
  let index = 0;
  const result = await stage(
    0,
    async () => makeVerdict({ decision: decisions[index++], feedback: `round ${index}` }),
    async (value, feedback) => value + feedback.length,
    5,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.rounds, 3);
  assert.ok(result.value && result.value > 0);
  assert.equal(result.history.length, 3);
});

test("stage discards on BAD and on exhausted rounds", async () => {
  const bad = await stage(
    0,
    async () => makeVerdict({ decision: "bad", feedback: "no" }),
    async (value) => value + 1,
    3,
  );
  assert.equal(bad.accepted, false);
  assert.equal(bad.value, null);
  assert.equal(bad.rounds, 1);

  const exhausted = await stage(
    0,
    async () => makeVerdict({ decision: "refine", feedback: "again" }),
    async (value) => value + 1,
    2,
  );
  assert.equal(exhausted.accepted, false);
  assert.equal(exhausted.value, null);
  assert.equal(exhausted.rounds, 2);
  assert.equal(exhausted.verdict?.decision, "refine");
});
