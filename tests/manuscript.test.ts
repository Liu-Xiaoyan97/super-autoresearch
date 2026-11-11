import test from "node:test";
import assert from "node:assert/strict";

import { validateManuscript } from "../src/rsi/agents/writing.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import { makeManuscript, makeProblem } from "../src/rsi/types.ts";

test("validate_manuscript reports missing sections, format, baseline and ledger", () => {
  const config = defaultConfig();
  const manuscript = makeManuscript({
    format: "wrong-format",
    sections: { abstract: "x" },
    claims: [{ text: "", metric: "", value: null, evidence_ref: "" }],
  });
  const violations = validateManuscript(manuscript, config, makeProblem());
  assert.ok(violations.some((v) => v.startsWith("Missing required section: introduction")));
  assert.ok(violations.some((v) => v.startsWith("Manuscript format must be")));
  assert.ok(violations.includes("no evidence ledger"));
  assert.ok(violations.some((v) => v.startsWith("Claim 1")));
});

test("validate_manuscript rejects claims that do not match the ledger", () => {
  const config = defaultConfig();
  const sections = Object.fromEntries(config.requiredSections.map((section) => [section, "baseline text"]));
  const manuscript = makeManuscript({
    sections,
    claims: [{ text: "auroc is 0.99", metric: "auroc", value: 0.99, evidence_ref: "full" }],
    evidence_ledger: { auroc: 0.9 },
  });
  const violations = validateManuscript(manuscript, config, makeProblem());
  assert.ok(violations.some((v) => v.includes("does not match")));
});

test("validate_manuscript enforces the guidance-direction mention", () => {
  const config = defaultConfig();
  const sections = Object.fromEntries(config.requiredSections.map((section) => [section, "baseline text"]));
  const problem = makeProblem({
    directions: [{ id: "d1", title: "spectral priors", description: "", keywords: ["DMD"], weight: 1, must_include: false }],
  });
  const manuscript = makeManuscript({ sections, evidence_ledger: { auroc: 0.9 } });
  assert.ok(
    validateManuscript(manuscript, config, problem).some((v) => v.includes("guidance direction")),
  );
  manuscript.sections.introduction = "We use DMD constraints.";
  assert.ok(
    !validateManuscript(manuscript, config, problem).some((v) => v.includes("guidance direction")),
  );
});
