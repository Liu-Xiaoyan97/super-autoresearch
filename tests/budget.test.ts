import test from "node:test";
import assert from "node:assert/strict";

import { Budget, BudgetExceeded } from "../src/rsi/runtime/budget.ts";
import { mockRun } from "./helpers.ts";

test("budget charges and throws at every hard limit", () => {
  const budget = new Budget({ maxLlmCalls: 2, maxExperiments: 2, maxWallTimeS: 1000 });
  budget.chargeLlm();
  assert.throws(() => budget.chargeLlm(), BudgetExceeded);
  const experiments = new Budget({ maxLlmCalls: 10, maxExperiments: 2, maxWallTimeS: 1000 });
  experiments.chargeExperiment();
  assert.throws(() => experiments.chargeExperiment(), BudgetExceeded);
  const time = new Budget({ maxLlmCalls: 10, maxExperiments: 10, maxWallTimeS: 0 });
  assert.throws(() => time.check(), BudgetExceeded);
});

test("an LLM-call budget abort is exported, not raised", async () => {
  const result = await mockRun({ maxLlmCalls: 3 });
  assert.equal(result.final.aborted, true);
  assert.match(result.final.abort_reason, /max_llm_calls=3/);
});

test("an experiment budget abort is exported, not raised", async () => {
  const result = await mockRun({ maxExperiments: 1 });
  assert.equal(result.final.aborted, true);
  assert.match(result.final.abort_reason, /max_experiments=1/);
});
