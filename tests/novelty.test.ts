import test from "node:test";
import assert from "node:assert/strict";

import { NoveltyChecker } from "../src/rsi/agents/ideas.ts";
import { makeIdea } from "../src/rsi/types.ts";
import { makeContext } from "./helpers.ts";

test("novelty uses the nested scored idea when top-level fields are absent", async () => {
  const ctx = makeContext();
  ctx.llm = {
    ...ctx.llm,
    name: "mock",
    async complete() {
      return { text: "", model: "", usage: {}, latencyS: 0 };
    },
    async structured() {
      return {
        idea: makeIdea({
          id: "h1",
          hypothesis: "nested hypothesis",
          novelty_score: 0.9,
          domain_fit: 0.8,
          direction_ids: ["geometric-alignment"],
          novelty_refs: ["Wei et al., 2025"],
        }),
        novelty_score: 0,
        domain_fit: 0,
        direction_ids: [],
        novelty_refs: [],
        closest_prior_work: "",
      };
    },
    async close() {},
  } as any;
  const checker = new NoveltyChecker(ctx);
  const scored = await checker.score(makeIdea({ id: "h1", hypothesis: "nested hypothesis" }));
  assert.equal(scored.novelty_score, 0.9);
  assert.equal(scored.domain_fit, 0.8);
  assert.deepEqual(scored.direction_ids, ["geometric-alignment"]);
  assert.equal(scored.novelty_refs.length, 2);
  assert.match(scored.novelty_refs[1], /Reference unavailable/);
});
