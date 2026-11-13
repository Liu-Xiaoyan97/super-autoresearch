/**
 * Restart safety: a host restart must not discard measurements that were
 * already paid for. Three mechanisms are covered here:
 *   1. atomic artifact/state writes,
 *   2. mid-idea checkpoints that make the implementer resumable,
 *   3. the commit+protocol measurement cache shared across runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ArtifactStore } from "../src/rsi/runtime/store.ts";
import { GitWorkspace, MeasurementCache, measurementKey, subsetBudgetEnv } from "../src/rsi/runtime/workspace.ts";
import { ResearchState } from "../src/rsi/core/state.ts";
import { defaultConfig } from "../src/rsi/config.ts";
import { loadProblem } from "../src/rsi/run.ts";
import { makeCheckpoint, makeEvidence, makeIdea, makeTrace, type ExperimentResult } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

const okResult = (word_ppl: number): ExperimentResult => ({
  metrics: { word_ppl },
  status: "ok",
  log_path: "remote/process-0001.json",
  stdout: "",
  stderr: "",
  wall_time_s: 42,
});

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** A target repo with one commit and a command that records each invocation. */
function targetRepo(): string {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(tempDir("rsi-cache-repo-")), "target-"));
  fs.writeFileSync(path.join(repo, "model.py"), "score = 1\n");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "rsi@example.invalid");
  git(repo, "config", "user.name", "RSI");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "baseline");
  return repo;
}

function cacheProblem(repo: string) {
  return loadProblem(
    JSON.stringify({
      id: "cache-fixture",
      statement: "Measure a deterministic command so cache reuse is observable.",
      domain: "unit test",
      subfield: "restart safety",
      source_paper: "none",
      repo,
      repo_ref: "HEAD",
      datasets: ["d1"],
      subset_datasets: ["d1"],
      metrics: [{ name: "score", direction: "max", tolerance: 0.01 }],
      reported_metrics: { score: 0.5 },
      constraints: ["offline"],
      directions: [],
      forbidden: [],
      venue: "ICLR",
      // Append to calls.log so a second invocation is visible on disk.
      experiment_command: [
        "bash",
        "-c",
        "echo run >> {repo}/calls.log; printf '{\"metrics\":{\"score\":0.75}}' > {out}",
      ],
    }),
  );
}

test("artifact writes are atomic and leave no temp files", () => {
  const root = tempDir("rsi-store-");
  const store = new ArtifactStore(root);
  store.writeJson("state-probe.json", { a: 1 });
  const file = path.join(root, "artifacts", "state-probe.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
  store.appendJsonl("candidates.jsonl", { commit: "abc", seed: 7 });
  store.appendJsonl("candidates.jsonl", { commit: "abc", seed: 8 });
  const lines = fs.readFileSync(path.join(root, "artifacts", "candidates.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).seed, 8);
});

test("state round-trip keeps checkpoints and the search-complete flag", () => {
  const problem = loadProblem(
    JSON.stringify({
      id: "state-fixture",
      statement: "Round trip",
      domain: "unit test",
      subfield: "state",
      source_paper: "none",
      datasets: ["d"],
      subset_datasets: ["d"],
      metrics: [{ name: "score", direction: "max", tolerance: 0.01 }],
      reported_metrics: { score: 1 },
      constraints: [],
      directions: [],
      forbidden: [],
      venue: "ICLR",
    }),
  );
  const config = defaultConfig({ seed: 7 });
  const state = new ResearchState(problem, config);
  const trace = makeTrace({ idea: makeIdea({ id: "h1" }), evidence: [makeEvidence({ idea_id: "h1", metrics: { score: 2 } })] });
  state.checkpoint(makeCheckpoint({ idea_id: "h1", round: 1, trace, stage: "subset", verdict: null }));
  state.searchDone = true;

  const restored = ResearchState.fromDict(problem, config, JSON.parse(JSON.stringify(state.toDict())));
  assert.equal(restored.searchDone, true);
  assert.equal(restored.checkpointFor("h1")?.trace.evidence[0].metrics.score, 2);
  assert.equal(restored.evaluatedIds.has("h1"), false);
  restored.record(trace);
  assert.equal(restored.checkpointFor("h1"), null);
});

test("measurement cache reuses an identical commit+protocol and refuses tampered entries", () => {
  const root = tempDir("rsi-cache-");
  const parts = { commit: "abc123", scope: "subset", env: { RSI_STEPS: "95" } };
  const keyOf = (value: Record<string, unknown>) => measurementKey(value);
  const key = keyOf(parts);
  const cache = new MeasurementCache(root, key, parts);
  assert.equal(cache.read(), null);
  cache.write(okResult(981.19));
  const hit = cache.read();
  assert.equal(hit?.metrics.word_ppl, 981.19);
  assert.equal(hit?.cached, true);

  // Key/parts mismatch (a hand-edited or stale entry) is a miss, never evidence.
  const file = path.join(root, `${key}.json`);
  const entry = JSON.parse(fs.readFileSync(file, "utf8"));
  entry.parts.env.RSI_STEPS = "954";
  fs.writeFileSync(file, JSON.stringify(entry));
  assert.equal(cache.read(), null);

  // Failed runs are never cache hits.
  const failedParts = { commit: "x" };
  const failed = new MeasurementCache(root, keyOf(failedParts), failedParts);
  failed.write({ ...okResult(1), status: "failed", metrics: {} });
  assert.equal(failed.read(), null);

  // The simulated runner must never read or write the real cache.
  const disabled = new MeasurementCache(root, keyOf({ commit: "sim" }), { commit: "sim" }, true);
  assert.equal(disabled.read(), null);
  disabled.write(okResult(1));
  assert.equal(fs.existsSync(path.join(root, `${keyOf({ commit: "sim" })}.json`)), false);
});

test("git workspace runs the experiment once per commit+protocol", async () => {
  const repo = targetRepo();
  const problem = cacheProblem(repo);
  const outDir = tempDir("rsi-cache-out-");
  const config = defaultConfig({ seed: 7, runner: "subprocess", outDir });
  const runDir = tempDir("rsi-cache-run-");
  const workspace = new GitWorkspace(problem, config, runDir);
  const base = await workspace.baselineRepo();
  const calls = () => {
    const log = path.join(runDir, "worktree", "calls.log");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
  };

  const first = await workspace.run(base, "subset", null, 7);
  assert.equal(first.status, "ok");
  assert.equal(first.cached, undefined);
  assert.equal(calls(), 1);

  const second = await workspace.run(base, "subset", null, 7);
  assert.equal(second.cached, true);
  assert.equal(second.metrics.score, 0.75);
  assert.equal(calls(), 1, "a cached measurement must not execute the command again");

  // A different seed is a different protocol: it must execute again.
  const other = await workspace.run(base, "subset", null, 8);
  assert.equal(other.cached, undefined);
  assert.equal(calls(), 2);

  // The cache lives outside the run directory so a later run can reuse it.
  const cacheDir = path.join(outDir, ".rsi-cache", "measurements");
  const entries = fs.readdirSync(cacheDir).sort();
  assert.equal(entries.length, 2);
  const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, entries[0]), "utf8"));
  assert.equal(entry.result.metrics.score, 0.75);
  assert.equal(entry.result.status, "ok");
  assert.deepEqual(subsetBudgetEnv(problem, config, "subset"), {});
});

// ------------------------------------------------------------------ implementer

import { buildAgents } from "../src/rsi/core/orchestrator.ts";
import { makeContext } from "./helpers.ts";
import { makeVerdict, type Evidence, type Idea, type RepoRef, type Scope } from "../src/rsi/types.ts";

/** A workspace stand-in that counts measurements and never touches git. */
function fakeWorkspace() {
  const runs: Array<{ scope: Scope; seed?: number }> = [];
  let seq = 0;
  const workspace = {
    problem: {} as any,
    config: {} as any,
    root: "",
    async baselineRepo(): Promise<RepoRef> {
      return { path: "", label: "baseline", parent: null, patch: "", repo: "", commit: "base", branch: "detached" };
    },
    async writePatch(repo: RepoRef, _patch: string, label: string): Promise<RepoRef> {
      seq += 1;
      return { ...repo, label, commit: `${label}-${seq}`, parent: repo.commit ?? null };
    },
    async diff(): Promise<string> {
      return "";
    },
    async run(_repo: RepoRef, scope: Scope, _idea?: Idea | null, seed?: number) {
      runs.push({ scope, seed });
      return {
        metrics: { auroc: 0.91 + runs.length / 1000 },
        status: "ok" as const,
        log_path: "",
        stdout: "",
        stderr: "",
        wall_time_s: 0,
      };
    },
    brief: () => "",
  };
  return { workspace, runs };
}

test("implementer resumes a mid-idea checkpoint without re-measuring", async () => {
  const { workspace, runs } = fakeWorkspace();
  const ctx = makeContext({ problemName: "ood_frozen_encoder", config: { subsetSeeds: 2 } });
  ctx.workspace = workspace as any;
  ctx.scratch.baseline = makeEvidence({
    idea_id: "baseline",
    metrics: { auroc: 0.87 },
    baseline_metrics: { auroc: 0.87 },
    code: { path: "", label: "baseline", parent: null, patch: "", repo: "", commit: "base", branch: "detached" },
    result: { metrics: { auroc: 0.87 }, status: "ok", log_path: "", stdout: "", stderr: "", wall_time_s: 0 },
  });
  const agents = buildAgents(ctx);
  const idea = makeIdea({ id: "h1", mechanism: "geometric alignment", hypothesis: "aligning helps" });

  // A previous attempt measured the first subset candidate, then died while the
  // engineer refinement was pending: two seeds already paid for.
  const measured: Evidence = makeEvidence({
    idea_id: "h1",
    scope: "subset",
    metrics: { auroc: 0.91 },
    baseline_metrics: { auroc: 0.87 },
    code: { path: "", label: "h1-subset", parent: "base", patch: "", repo: "", commit: "c1", branch: "b" },
    result: { metrics: { auroc: 0.91 }, status: "ok", log_path: "", stdout: "", stderr: "", wall_time_s: 0 },
  });
  const checkpoint = makeCheckpoint({
    idea_id: "h1",
    trace: makeTrace({ idea, evidence: [measured], lessons: ["below margin"] }),
    stage: "subset",
    verdict: makeVerdict({ decision: "engineer", feedback: "below margin" }),
  });

  const trace = await agents.implementer.implement(idea, {
    round: 0,
    resume: checkpoint,
    onProgress: () => undefined,
  });

  // One refinement round × two seeds: the finished subset candidate is reused.
  assert.equal(
    runs.filter((entry) => entry.scope === "subset").length,
    2,
    "the checkpointed measurement must not be paid twice",
  );
  assert.equal(trace.evidence.length >= 2, true);
  assert.equal(trace.evidence[0], measured, "the checkpointed evidence is reused verbatim");
});

test("resuming a run keeps its id, directory and history", async () => {
  const { runResearch } = await import("../src/rsi/run.ts");
  const outDir = tempDir("rsi-inplace-");
  const opts = {
    problem: fixturePath("abort_case"),
    outDir,
    runId: "abort-case-s7",
    mock: true,
    seed: 7,
  } as const;
  const first = await runResearch({ ...opts });
  assert.equal(first.final.aborted, true);
  const before = fs.readFileSync(path.join(first.root, "traces.jsonl"), "utf8").trim().split("\n").length;

  const second = await runResearch({ ...opts, resumeFrom: "abort-case-s7" });
  assert.equal(second.runId, "abort-case-s7", "a resume must not create a new run id");
  assert.equal(second.root, first.root);
  assert.ok(fs.existsSync(path.join(first.root, "final.attempt-1.json")), "the previous attempt is kept");
  const after = fs.readFileSync(path.join(second.root, "traces.jsonl"), "utf8").trim().split("\n").length;
  assert.ok(after >= before, "the trace log continues instead of being replaced");
});

function fixturePath(name: string): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", `${name}.json`);
}
