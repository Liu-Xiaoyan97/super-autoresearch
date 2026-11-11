import test from "node:test";
import assert from "node:assert/strict";

import {
  MethodCodeAuditor,
  ReferenceAuditor,
  SpecAuditor,
  combine,
  verifyScores,
} from "../src/rsi/agents/integrity.ts";
import {
  makeEvidence,
  makeManuscript,
  makeProblem,
  type ExperimentResult,
} from "../src/rsi/types.ts";
import { makeContext } from "./helpers.ts";

function failedResult(): ExperimentResult {
  return {
    metrics: {},
    status: "failed",
    log_path: "",
    stdout: "",
    stderr: "boom",
    wall_time_s: 0,
  };
}

test("combine accumulates violations and takes the minimum alignment", () => {
  const merged = combine(
    {
      score_verified: true,
      spec_violations: ["a"],
      ref_violations: [],
      method_code_alignment: 0.8,
      checked_claims: 2,
      notes: ["n1"],
    },
    {
      score_verified: true,
      spec_violations: [],
      ref_violations: ["b"],
      method_code_alignment: 0.4,
      checked_claims: 3,
      notes: ["n2"],
    },
  );
  assert.equal(merged.score_verified, true);
  assert.deepEqual(merged.spec_violations, ["a"]);
  assert.deepEqual(merged.ref_violations, ["b"]);
  assert.equal(merged.method_code_alignment, 0.4);
  assert.equal(merged.checked_claims, 5);
  assert.deepEqual(merged.notes, ["n1", "n2"]);
  assert.equal(combine().score_verified, false);
});

test("verify_scores requires a successful run with finite metrics", () => {
  const good = makeEvidence({ metrics: { auroc: 0.9 }, result: { ...failedResult(), status: "ok" } });
  assert.equal(verifyScores(true, good), true);
  assert.equal(verifyScores(false, good), false);
  assert.equal(verifyScores(true, makeEvidence({ metrics: {}, result: { ...failedResult(), status: "ok" } })), false);
  assert.equal(verifyScores(true, makeEvidence({ metrics: { auroc: 0.9 }, result: failedResult() })), false);
});

test("spec auditor's deterministic forbidden-approach check cannot be talked away", () => {
  const ctx = makeContext();
  const auditor = new SpecAuditor(ctx);
  const evidence = makeEvidence({ metrics: { auroc: 0.9 } });
  const violations = auditor.hardViolations(
    ctx.problem,
    "We are retraining the encoder on extra data.",
    evidence,
  );
  assert.ok(violations.some((violation) => violation.includes("retraining the encoder")));
  assert.deepEqual(auditor.hardViolations(ctx.problem, "freeze and align features", evidence), []);
  assert.ok(auditor.hardViolations(ctx.problem, "", makeEvidence({ result: failedResult() })).length > 0);
});

test("reference auditor flags references with no local support", () => {
  const ctx = makeContext();
  const auditor = new ReferenceAuditor(ctx);
  assert.deepEqual(
    auditor.unknownRefs(["X-Mahalanobis (Wei et al., 2025)"], ["X-Mahalanobis"]),
    [],
  );
  assert.deepEqual(auditor.unknownRefs(["Totally Fake Paper"], ["X-Mahalanobis"]), ["Totally Fake Paper"]);
});

test("method-code auditor's lexical floor cannot be manufactured by the model", () => {
  const ctx = makeContext();
  const auditor = new MethodCodeAuditor(ctx);
  const manuscript = makeManuscript({
    sections: { method: "spectral prior alignment" },
    claims: [{ text: "spectral prior alignment", metric: "auroc", value: 0.9, evidence_ref: "full" }],
  });
  const [aligned, missing] = auditor.lexicalAlignment(manuscript, "implemented spectral prior alignment");
  assert.equal(aligned, 1);
  assert.deepEqual(missing, []);
  const [none] = auditor.lexicalAlignment(manuscript, "completely unrelated code");
  assert.equal(none, 0);
});

test("problems without forbidden phrases never produce spec violations", () => {
  const ctx = makeContext();
  const auditor = new SpecAuditor(ctx);
  const problem = makeProblem();
  assert.deepEqual(auditor.hardViolations(problem, "anything", makeEvidence({ metrics: { a: 1 } })), []);
});
