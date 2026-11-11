import test from "node:test";
import assert from "node:assert/strict";

import { loadProblem } from "../src/rsi/run.ts";
import { fixture } from "./helpers.ts";

test("the dfm-ssm fixture targets the real repository and injects its runner", () => {
  const problem = loadProblem(fixture("dfm_ssm"));
  assert.equal(problem.id, "dfm-ssm-wikitext-ppl");
  assert.equal(problem.repo, "vendor/dfm-ssm");
  assert.equal(problem.repo_ref, "rsi-bench");
  assert.deepEqual(problem.experiment_command?.slice(0, 2), ["{python}", "bench/rsi_dfm_train_eval.py"]);
  assert.deepEqual(problem.metrics.map((metric) => metric.name), ["word_ppl"]);
  assert.equal(problem.metrics[0].direction, "min");
  assert.equal(problem.remote?.gpu_ids, "0");
  assert.equal(problem.remote?.env.RSI_DFM_OFFLINE, "1");
  assert.ok(problem.forbidden.includes("modifying bench/rsi_dfm_train_eval.py"));
  assert.ok(problem.directions.some((direction) => direction.id === "dfm-objective"));
});

test("every shipped fixture parses as a Problem", () => {
  for (const name of ["ood_frozen_encoder", "abort_case", "meta_refine", "dfm_ssm"]) {
    const problem = loadProblem(fixture(name));
    assert.ok(problem.id);
    assert.ok(problem.statement);
    assert.ok(problem.metrics.length > 0);
  }
});
