import test from "node:test";
import assert from "node:assert/strict";

import { SubsetCoder } from "../src/rsi/agents/coding.ts";
import { SubsetCritic } from "../src/rsi/agents/critics.ts";
import { ResearchState } from "../src/rsi/core/state.ts";
import { makeContext } from "./helpers.ts";
import {
  makeEvidence,
  makeIdea,
  makeTrace,
  type Evidence,
  type ExperimentResult,
} from "../src/rsi/types.ts";

const code = {
  path: "/tmp/worktree",
  label: "h1-subset",
  parent: "base-commit",
  patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
  repo: "/tmp/repo",
  commit: "base-commit",
  branch: "rsi/h1",
};

const ok = (metrics: Record<string, number>): ExperimentResult => ({
  metrics,
  status: "ok",
  log_path: "",
  stdout: "",
  stderr: "",
  wall_time_s: 1,
});

test("successful evidence cannot claim the parent commit as its own", () => {
  assert.throws(
    () => makeEvidence({
      idea_id: "h1",
      scope: "subset",
      metrics: { auroc: 0.9 },
      code,
      result: ok({ auroc: 0.9 }),
    }),
    /candidate commit equals its parent/,
  );
});

test("full and rebuttal may reuse the incumbent commit when only the protocol changes", () => {
  const full = makeEvidence({
    idea_id: "h1",
    scope: "full",
    metrics: { auroc: 0.9 },
    code: { ...code, patch: "", commit: "base-commit", parent: "base-commit" },
    result: ok({ auroc: 0.9 }),
  });
  assert.equal(full.scope, "full");
});

test("a protocol-only full experiment still needs a real measured result", async () => {
  const ctx = makeContext();
  const baseline = makeEvidence({
    idea_id: "baseline", scope: "full", metrics: { auroc: 0.5 },
    code: { ...code, label: "baseline", parent: null, patch: "", commit: "base-commit" },
    result: ok({ auroc: 0.5 }),
  });
  const bare = makeEvidence({
    idea_id: "h1", scope: "full", metrics: { auroc: 0.9 },
    code: { ...code, patch: "", commit: "base-commit", parent: "base-commit" },
  });
  const verdict = await new SubsetCritic(ctx).judge(bare, { baseline });
  assert.equal(verdict.invalid, true);
});

test("the subset critic treats a parent-commit proxy as invalid, not a refutation", async () => {
  const ctx = makeContext();
  const baseline = makeEvidence({
    idea_id: "baseline",
    scope: "subset",
    metrics: { auroc: 0.5 },
    code: { ...code, label: "baseline", parent: null, patch: "", commit: "base-commit" },
    result: ok({ auroc: 0.5 }),
  });
  // Bypass the constructor guard for the critic's independent defense.
  const proxy: Evidence = {
    ...makeEvidence({ idea_id: "h1", scope: "subset", metrics: { auroc: 0.6 }, code: null }),
    code,
    result: ok({ auroc: 0.6 }),
  };
  const verdict = await new SubsetCritic(ctx).judge(proxy, { baseline });
  assert.equal(verdict.decision, "engineer");
  assert.equal(verdict.invalid, true);
  assert.match(verdict.feedback, /provenance|not.*refutation/i);
});

test("an invalid implementation is not added to evaluated_ids or nextSeeds", () => {
  const ctx = makeContext();
  const state = new ResearchState(ctx.problem, ctx.config);
  const idea = makeIdea({ id: "h-invalid" });
  state.seeds = [idea];
  state.record(makeTrace({ idea, decision: "bad", invalid: true, evidence: [] }));
  assert.equal(state.evaluatedIds.has(idea.id), false);
  assert.deepEqual(state.nextSeeds(1).map((item) => item.id), []);
});

test("a rejected implementation never reaches the runner and becomes invalid evidence", async () => {
  const ctx = makeContext();
  let runs = 0;
  ctx.workspace = {
    brief: () => "",
    writePatch: async () => { throw new Error("patch contains no unified diff"); },
    run: async () => {
      runs += 1;
      throw new Error("runner must not be called for rejected evidence");
    },
  } as any;
  const base = makeEvidence({
    idea_id: "baseline",
    scope: "subset",
    metrics: { auroc: 0.5 },
    code: { ...code, label: "baseline", parent: null, patch: "", commit: "base-commit" },
    result: ok({ auroc: 0.5 }),
  });
  const evidence = await new SubsetCoder(ctx).implement(
    makeIdea({ id: "h1", mechanism: "alignment", hypothesis: "alignment helps" }),
    { base, seeds: [7, 8, 9] },
  );
  assert.equal(runs, 0);
  assert.equal(evidence.result?.status, "failed");
  assert.match(evidence.result?.stderr ?? "", /no unified diff/);
  const verdict = await new SubsetCritic(ctx).judge(evidence, { baseline: base });
  assert.equal(verdict.invalid, true);
});

test("a resumed run sanitizes old parent-commit proxies before trusting them", () => {
  const ctx = makeContext();
  const idea = makeIdea({ id: "h6" });
  const proxy: Evidence = {
    ...makeEvidence({ idea_id: "h6", scope: "subset", metrics: { auroc: 0.9 } }),
    code: { ...code },
    result: ok({ auroc: 0.9 }),
  };
  const raw = {
    traces: [{ idea, evidence: [proxy], decision: "good", feedback: "", round: 0, lessons: [] }],
    evaluated_ids: ["h6"],
    best_idea: idea,
    best_evidence: proxy,
    best_code: proxy.code,
    checkpoints: {},
  };
  const state = ResearchState.fromDict(ctx.problem, ctx.config, raw);
  assert.equal(state.traces[0].invalid, true);
  assert.equal(state.traces[0].decision, "bad");
  assert.equal(state.evaluatedIds.has("h6"), false);
  assert.equal(state.bestEvidence, null);
  assert.equal(state.bestCode, null);
});
