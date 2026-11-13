import test from "node:test";
import assert from "node:assert/strict";

import { InitialIdeaGenerator } from "../src/rsi/agents/ideas.ts";
import { LimitationExtractor } from "../src/rsi/agents/limitations.ts";
import { LLMProvider, type LLMRequest, type LLMResponse } from "../src/rsi/providers/base.ts";
import { StyleViolationError, isCodeSpec, lintSpec, normalizeStyleOutput, splitSentences, stylePrompt, wordCount } from "../src/rsi/writing/style.ts";
import { makeManuscript, makeProblem, metricSpec } from "../src/rsi/types.ts";
import { makeContext as context } from "./helpers.ts";

const problem = makeProblem({ id: "style", metrics: [metricSpec({ name: "word_ppl", direction: "min" })] });
const idea = (mechanism: string) => ({
  id: "h0",
  hypothesis: "A shorter kernel lowers word_ppl on the test split",
  mechanism,
  target_limitations: ["D1"],
  novelty_score: 0.5,
  novelty_refs: ["a paper"],
  parent_ids: [],
  round: 0,
  direction_ids: [],
  domain_fit: 0.8,
  expected_gain: 0,
  notes: "",
  origin: "seed",
});

test("STE-RSI rule 1: identifiers are copied exactly", () => {
  const rewritten = lintSpec("IdeaBatch", problem, { ideas: [idea("Lower word ppl with a shorter kernel")] });
  assert.ok(rewritten.some((issue) => issue.rule === "identifier-rewritten"), JSON.stringify(rewritten));
  const exact = lintSpec("IdeaBatch", problem, { ideas: [idea("Lower word_ppl with a shorter kernel")] });
  assert.deepEqual(exact, []);
});

test("STE-RSI rule 2: one claim per sentence and bounded length", () => {
  const long = `${Array.from({ length: 26 }, (_, index) => `token${index}`).join(" ")}.`;
  const issues = lintSpec("IdeaBatch", problem, { ideas: [idea(long)] });
  assert.ok(issues.some((issue) => issue.rule === "sentence-length"));
  const semicolon = lintSpec("IdeaBatch", problem, { ideas: [idea("Lower word_ppl; keep parameters fixed")] });
  assert.ok(semicolon.some((issue) => issue.rule === "multiple-claims"));
  const actions = lintSpec("Verdict", problem, {
    decision: "engineer",
    feedback: Array.from({ length: 21 }, (_, index) => `step${index}`).join(" "),
    metrics: {},
    notes: "",
  });
  assert.ok(actions.some((issue) => issue.rule === "sentence-length"), "actions use the 20-word limit");
});

test("STE-RSI rule 3: explicit numbers, no vague claims or marketing terms", () => {
  const vague = lintSpec("IdeaBatch", problem, { ideas: [idea("Significantly lower word_ppl")] });
  assert.ok(vague.some((issue) => issue.rule === "vague-quantity"));
  const comparison = lintSpec("IdeaBatch", problem, { ideas: [idea("A better kernel")] });
  assert.ok(comparison.some((issue) => issue.rule === "unsupported-comparison"));
  const marketing = lintSpec("IdeaBatch", problem, { ideas: [idea("A state-of-the-art kernel")] });
  assert.ok(marketing.some((issue) => issue.rule === "marketing-term"));
  const measured = lintSpec("IdeaBatch", problem, { ideas: [idea("Lower word_ppl from 159016.26 to 159001.00 with a shorter kernel")] });
  assert.deepEqual(measured, []);
});

test("prose fields reject embedded JSON or code", () => {
  const issues = lintSpec("IdeaBatch", problem, { ideas: [idea('{"patch":"diff"}')] });
  assert.ok(issues.some((issue) => issue.rule === "prose-not-structured"));
});

test("code specs are exempt; the manuscript lints only claims and evidence", () => {
  assert.equal(isCodeSpec("SubsetPatch"), true);
  assert.deepEqual(lintSpec("SubsetPatch", problem, { patch: "not a diff; long prose that would otherwise fail" }), []);
  const long = "This sentence is deliberately long ".repeat(6);
  const manuscript: any = makeManuscript({ sections: { abstract: long } });
  manuscript.claims = [
    { text: "word_ppl drops from 159016.26 to 159001.00", metric: "word_ppl", value: 159001, evidence_ref: "artifacts/candidate.json" },
    { text: "A better method", metric: "word_ppl", value: 1, evidence_ref: "" },
  ];
  const issues = lintSpec("DraftOutput", problem, manuscript, "manuscript");
  assert.ok(issues.every((issue) => issue.path.startsWith("claims")), JSON.stringify(issues));
  assert.ok(issues.some((issue) => issue.rule === "claim-without-evidence"));
  assert.ok(issues.some((issue) => issue.rule === "unsupported-comparison"));
  assert.ok(!issues.some((issue) => issue.path.includes("sections")));
});

test("LimitationBatch normalization splits semicolon evidence and restores metric names", () => {
  const normalized = normalizeStyleOutput("LimitationBatch", problem, {
    limitations: [{
      id: "L1",
      text: "word ppl is high; training is slow",
      axis: "method",
      evidence: "0.1; 0.2",
      severity: 0.5,
      actionable: true,
    }],
    rationale: "copy word ppl; keep it exact",
  }) as any;
  assert.equal(normalized.limitations[0].text, "word_ppl is high. training is slow");
  assert.equal(normalized.limitations[0].evidence, "0.1. 0.2");
  assert.equal(normalized.rationale, "copy word_ppl. keep it exact");
  assert.deepEqual(lintSpec("LimitationBatch", problem, normalized), []);
});

test("sentence splitting counts words deterministically", () => {
  assert.deepEqual(splitSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  assert.equal(wordCount("one two three."), 3);
});

test("a Hypothesis-labelled statement is exempt from the measured-number rules", () => {
  const labelled = lintSpec("LimitationBatch", problem, {
    limitations: [{ text: "Hypothesis: the chunked scan implementation yields few training steps." }],
  });
  assert.deepEqual(labelled, []);
  const unlabelled = lintSpec("LimitationBatch", problem, {
    limitations: [{ text: "The chunked scan implementation yields few training steps." }],
  });
  assert.ok(unlabelled.some((issue) => issue.rule === "vague-quantity"), JSON.stringify(unlabelled));
  const marketing = lintSpec("LimitationBatch", problem, {
    limitations: [{ text: "Hypothesis: a state-of-the-art kernel yields few training steps." }],
  });
  assert.ok(marketing.some((issue) => issue.rule === "marketing-term"), JSON.stringify(marketing));
});

test("stylePrompt states the three rules, the JSON contract and the manuscript exemption", () => {
  assert.match(stylePrompt(), /one term for one thing/i);
  assert.match(stylePrompt(), /25 words/);
  assert.match(stylePrompt(), /string values/i);
  assert.match(stylePrompt(), /JSON keys/i);
  assert.match(stylePrompt(), /few/);
  assert.match(stylePrompt(), /Hypothesis:/);
  assert.match(stylePrompt(), /semicolon/i);
  assert.match(stylePrompt("manuscript"), /Manuscript body/);
});

class Scripted extends LLMProvider {
  readonly name = "scripted";
  calls = 0;
  readonly replies: string[];
  constructor(replies: string[]) { super(); this.replies = replies; }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    const text = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return { text, model: "scripted/model", usage: {}, latencyS: 0 };
  }
}

function agentCtx(replies: string[]) {
  const ctx = context({ problemName: "ood_frozen_encoder" });
  ctx.problem.metrics = problem.metrics;
  ctx.llm = new Scripted(replies);
  return ctx;
}

test("LimitationExtractor uses normalized output without a repair round", async () => {
  const output = JSON.stringify({
    limitations: [{
      id: "L1",
      text: "word ppl is high; training is slow",
      axis: "method",
      evidence: "0.1; 0.2",
      severity: 0.5,
      actionable: true,
    }],
    rationale: "word ppl; measured",
  });
  const ctx = agentCtx([output, output, output]);
  const limitations = await new LimitationExtractor(ctx).extract({ findings: [] });
  assert.equal(ctx.llm instanceof Scripted ? ctx.llm.calls : -1, 1);
  assert.equal(limitations.length, 1);
  assert.equal(limitations[0].text, "word_ppl is high. training is slow");
  assert.equal(limitations[0].evidence, "0.1. 0.2");
});

test("one repair is attempted, then the compliant answer is used", async () => {
  const bad = JSON.stringify({ ideas: [idea("Significantly lower word_ppl")] });
  const good = JSON.stringify({ ideas: [idea("Lower word_ppl from 10.0 to 9.0 with a shorter kernel")] });
  const ctx = agentCtx([bad, good]);
  const generated = await new InitialIdeaGenerator(ctx).generate([]);
  assert.match(generated.mechanism, /shorter kernel/);
  assert.equal(ctx.llm instanceof Scripted ? ctx.llm.calls : -1, 2);
  const kinds = ctx.traces.readAll().map((record) => record.kind);
  assert.ok(kinds.includes("style.violation"));
  assert.ok(kinds.includes("style.ok"));
});

test("two repairs are attempted, then a third violation fails closed", async () => {
  const bad = JSON.stringify({ ideas: [idea("Significantly lower word_ppl")] });
  const ctx = agentCtx([bad, bad, bad]);
  await assert.rejects(new InitialIdeaGenerator(ctx).generate([]), StyleViolationError);
  assert.equal(ctx.llm instanceof Scripted ? ctx.llm.calls : -1, 3);
  assert.ok(ctx.traces.readAll().some((record) => record.kind === "style.violation"));
});
