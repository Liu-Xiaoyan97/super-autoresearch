import test from "node:test";
import assert from "node:assert/strict";

import { filterByGuidance, rankKey } from "../src/rsi/agents/ideas.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import { loadProblem } from "../src/rsi/run.ts";
import { makeIdea, makeProblem } from "../src/rsi/types.ts";
import { fixture } from "./helpers.ts";

test("guidance is a soft domain-fit filter by default", () => {
  const problem = makeProblem({
    directions: [{ id: "d1", title: "spectral", description: "", keywords: [], weight: 1, must_include: true }],
  });
  const config = defaultConfig();
  const kept = makeIdea({ id: "h1", hypothesis: "a", domain_fit: 0.9 });
  const dropped = makeIdea({ id: "h2", hypothesis: "b", domain_fit: 0.1 });
  assert.deepEqual(filterByGuidance([kept, dropped], problem, config).map((idea) => idea.id), ["h1"]);
});

test("strict_directions makes must_include a hard gate", () => {
  const problem = makeProblem({
    directions: [{ id: "d1", title: "spectral", description: "", keywords: [], weight: 1, must_include: true }],
  });
  const config = defaultConfig({ strictDirections: true });
  const aligned = makeIdea({ id: "h1", hypothesis: "a", domain_fit: 0.9, direction_ids: ["d1"] });
  const unaligned = makeIdea({ id: "h2", hypothesis: "b", domain_fit: 0.9, direction_ids: [] });
  assert.deepEqual(filterByGuidance([aligned, unaligned], problem, config).map((idea) => idea.id), ["h1"]);
});

test("rank_key is novelty plus weighted domain fit", () => {
  const idea = makeIdea({ id: "h1", novelty_score: 0.6, domain_fit: 0.5 });
  assert.equal(rankKey(idea, 0), 0.6);
  assert.equal(rankKey(idea, 0.5), 0.85);
});

test("a hard guidance gate with no aligned seed aborts with no_eligible_seeds", async () => {
  const { mockRun } = await import("./helpers.ts");
  const result = await mockRun({
    problem: fixture("meta_refine"),
    strictDirections: true,
  });
  assert.equal(result.final.aborted, true);
  assert.equal(result.final.abort_reason, "no_eligible_seeds");
});

test("guided and unguided configs both parse the same problem fixture", () => {
  const problem = loadProblem(fixture("ood_frozen_encoder"));
  assert.equal(problem.metrics[0].name, "auroc");
  assert.equal(problem.metrics[0].direction, "max");
  assert.deepEqual(problem.metrics[0].bounds, [0, 1]);
});
