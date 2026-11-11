import test from "node:test";
import assert from "node:assert/strict";

import {
  isStrictlyBetter,
  makeIdea,
  metricDeltas,
  metricSpec,
  type MetricSpec,
} from "../src/rsi/types.ts";

const specs: MetricSpec[] = [
  metricSpec({ name: "auroc", direction: "max", tolerance: 0.002, bounds: [0, 1] }),
  metricSpec({ name: "latency", direction: "min", tolerance: 0.01 }),
];

test("metricDeltas normalizes direction", () => {
  const deltas = metricDeltas({ auroc: 0.92, latency: 90 }, { auroc: 0.9, latency: 100 }, specs);
  assert.ok(Math.abs(deltas.auroc - 0.92 / 0.9 + 1) < 1e-12);
  assert.ok(deltas.latency > 0, "lower latency must be a positive improvement");
});

test("isStrictlyBetter requires no regression and one improvement", () => {
  assert.equal(isStrictlyBetter({ auroc: 0.91, latency: 90 }, { auroc: 0.9, latency: 100 }, specs), true);
  assert.equal(isStrictlyBetter({ auroc: 0.89, latency: 90 }, { auroc: 0.9, latency: 100 }, specs), false);
  assert.equal(isStrictlyBetter({ auroc: 0.9005, latency: 100 }, { auroc: 0.9, latency: 100 }, specs), false);
  assert.equal(isStrictlyBetter({ auroc: 0.91 }, { auroc: 0.9, latency: 100 }, specs), true);
  assert.equal(isStrictlyBetter({ auroc: 0.91 }, { auroc: 0.9, latency: 100 }, specs, { requireAll: false }), true);
  assert.equal(isStrictlyBetter({}, {}, specs), false);
  assert.equal(isStrictlyBetter({ auroc: 1 }, { auroc: 0 }, []), false);
});

test("idea defaults match the frozen artifact contract", () => {
  const idea = makeIdea({ id: "h1", hypothesis: "x" });
  assert.equal(idea.origin, "seed");
  assert.equal(idea.round, 0);
  assert.deepEqual(idea.direction_ids, []);
  assert.equal(idea.domain_fit, 0);
});
