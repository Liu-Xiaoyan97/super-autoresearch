import test from "node:test";
import assert from "node:assert/strict";

import { loadProblem } from "../src/rsi/run.ts";
import { fixture } from "./helpers.ts";

test("every test/example fixture parses as a Problem", () => {
  for (const name of ["ood_frozen_encoder", "abort_case", "meta_refine", "dfm_ssm_external"]) {
    const problem = loadProblem(fixture(name));
    assert.ok(problem.id);
    assert.ok(problem.statement);
    assert.ok(problem.metrics.length > 0);
  }
});

test("the external dfm-ssm fixture keeps GPU and runner wiring explicit", () => {
  const problem = loadProblem(fixture("dfm_ssm_external"));
  assert.equal(problem.metrics[0].name, "word_ppl");
  assert.equal(problem.metrics[0].direction, "min");
  assert.equal(problem.remote?.gpu_ids, "0");
  assert.equal(problem.remote?.env.RSI_DFM_TRAIN_STEPS, "3815");
  assert.equal(problem.remote?.env.RSI_DFM_TRAIN_DATA, "/home/sl/SlimPajama-10B/train");
  assert.equal(problem.remote?.env.RSI_DFM_TOKENIZER, "/home/sl/mamba/checkpoints");
  assert.match(problem.remote?.env.RSI_DFM_TRAIN_LAUNCHER ?? "", /accelerate launch/);
  assert.deepEqual(problem.experiment_command?.slice(0, 2), ["{python}", "bench/rsi_dfm_train_eval.py"]);
});

test("repo paths expand ${ENV} placeholders", () => {
  const previous = process.env.RSI_TARGET_REPO;
  process.env.RSI_TARGET_REPO = "/repos/external-project";
  try {
    const problem = loadProblem(fixture("dfm_ssm_external"));
    assert.equal(problem.repo, "/repos/external-project");
  } finally {
    if (previous === undefined) delete process.env.RSI_TARGET_REPO;
    else process.env.RSI_TARGET_REPO = previous;
  }
});
