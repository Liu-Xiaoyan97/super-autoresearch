import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  incumbentFileFor,
  ledgerFromEvidence,
  loadIncumbent,
  loadManualBaseline,
  loadRunBaselines,
  protocolFingerprint,
  writeIncumbent,
} from "../src/rsi/runtime/incumbent.ts";
import { makeEvidence, makeProblem, metricSpec } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

function repoWithCommit(): { repo: string; commit: string } {
  const repo = tempDir("rsi-incumbent-repo-");
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"]);
  return { repo, commit: git(["rev-parse", "HEAD"]) };
}

test("incumbent ledgers round-trip and validate the protocol and commit", () => {
  const { repo, commit } = repoWithCommit();
  const problem = makeProblem({
    id: "incumbent-test",
    repo,
    repo_ref: commit,
    experiment_command: ["{python}", "run.py", "--scope", "{scope}"],
    metrics: [metricSpec({ name: "score", direction: "max" })],
    subset_datasets: ["dev"],
  });
  const evidence = makeEvidence({
    scope: "full",
    metrics: { score: 0.9 },
    code: { path: repo, label: "baseline", parent: null, patch: "", repo, commit },
  });
  const protocol = protocolFingerprint(problem, {}, 7, "full");
  const ledger = ledgerFromEvidence(problem, "full", evidence, protocol, []);
  assert.ok(ledger);
  const out = tempDir("rsi-incumbent-out-");
  const file = incumbentFileFor(out, problem, "full");
  writeIncumbent(file, ledger!);
  assert.ok(loadIncumbent(file, problem, protocol, "full"));
  assert.equal(loadIncumbent(file, problem, protocol, "subset"), null);
  assert.equal(loadIncumbent(file, problem, protocolFingerprint(problem, {}, 8, "full"), "full"), null);
  const seeds = loadRunBaselines(problem, out, 7);
  assert.equal(seeds.full?.source, "incumbent");
  assert.equal(seeds.full?.evidence.metrics.score, 0.9);
  assert.equal(seeds.subset, null);
});

test("an explicit manual baseline is accepted for the requested scopes", () => {
  const { repo, commit } = repoWithCommit();
  const problem = makeProblem({
    id: "manual-test",
    repo,
    repo_ref: commit,
    metrics: [metricSpec({ name: "score", direction: "max" })],
  });
  const out = tempDir("rsi-manual-out-");
  const manual = path.join(out, "trusted-baseline.json");
  fs.writeFileSync(manual, JSON.stringify({ commit, metrics: { score: 0.5 }, scope: "subset" }));
  assert.ok(loadManualBaseline(manual, problem));
  const seeds = loadRunBaselines(problem, out, 7, manual);
  assert.equal(seeds.subset?.source, "manual");
  assert.equal(seeds.subset?.evidence.metrics.score, 0.5);
  assert.equal(seeds.full, null, "a scope-limited manual baseline leaves the other scope to reproduce");
  assert.equal(seeds.path, manual);
});

test("project baseline files are shared across output directories", () => {
  const { repo, commit } = repoWithCommit();
  const problem = makeProblem({
    id: "global-baseline-test",
    repo,
    repo_ref: commit,
    metrics: [metricSpec({ name: "score", direction: "max" })],
  });
  const first = incumbentFileFor(tempDir("rsi-global-out-a-"), problem, "full");
  const second = incumbentFileFor(tempDir("rsi-global-out-b-"), problem, "full");
  assert.equal(first, second, "run output directories must not own the baseline");
});
