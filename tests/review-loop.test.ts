import test from "node:test";
import assert from "node:assert/strict";

import { mockRun } from "./helpers.ts";

function peerRounds(path: string[]): string[] {
  return path.filter((token) => token.startsWith("peer.r"));
}

test("the review loop respects max_peer_rounds and max_review_refinements", async () => {
  const result = await mockRun();
  const rounds = peerRounds(result.final.decision_path);
  assert.ok(rounds.length >= 1);
  assert.ok(rounds.length <= 2, `got ${rounds.length} peer rounds`);
  assert.equal(rounds[0].startsWith("peer.r0"), true);
});

test("a low threshold stops after round 0", async () => {
  const result = await mockRun({ configOverrides: { reviewThreshold: 1 } });
  const rounds = peerRounds(result.final.decision_path);
  assert.equal(rounds.length, 1);
  assert.ok(rounds[0].startsWith("peer.r0"));
});

test("zero review refinements stops after round 0", async () => {
  const result = await mockRun({ maxReviewRefinements: 0 });
  assert.equal(peerRounds(result.final.decision_path).length, 1);
});

test("meta-review never accepts below the peer threshold", async () => {
  const result = await mockRun({ configOverrides: { reviewThreshold: 10 } });
  assert.equal(result.final.aborted, false);
  assert.notEqual(result.final.meta_review?.decision, "accept");
  assert.equal(result.final.extra.accepted, false);
});
