import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { refreshLedger, modelDefinitionFile } from "../src/rsi/runtime/ledger.ts";
import { tempDir } from "./helpers.ts";

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeRepo(): { repo: string; first: string; second: string; codeChange: string } {
  const repo = tempDir("rsi-ledger-repo-");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.mkdirSync(path.join(repo, "models"), { recursive: true });
  fs.writeFileSync(path.join(repo, "models", "model.py"), "class Model:\n    pass\n");
  fs.writeFileSync(path.join(repo, "stage.json"), JSON.stringify({ lr: 1 }));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  const first = git(repo, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(repo, "stage.json"), JSON.stringify({ lr: 2 }));
  git(repo, "add", "stage.json");
  git(repo, "commit", "-qm", "hyperparameter only");
  const second = git(repo, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(repo, "models", "model.py"), "class Model:\n    width = 2\n");
  git(repo, "add", "models/model.py");
  git(repo, "commit", "-qm", "model definition change");
  const codeChange = git(repo, "rev-parse", "HEAD");
  return { repo, first, second, codeChange };
}

test("ledger groups hyperparameter-only commits into one model family", () => {
  const { repo, first, second, codeChange } = makeRepo();
  const project = tempDir("rsi-ledger-project-");
  const run = path.join(project, "runs", "run-a");
  fs.mkdirSync(run, { recursive: true });
  const problem = {
    id: "ledger-problem",
    repo,
    repo_ref: first,
    remote: { env: { RSI_CORAL_MODEL_FILE: "models/model.py" } },
    datasets: ["dev"],
    metrics: [{ name: "acc", direction: "max", tolerance: 0.01, weight: 1, bounds: [0, 1] }],
  };
  const evidence = (commit: string, parent: string | null, scope: "subset" | "full", value: number) => ({
    idea_id: "h1",
    scope,
    metrics: { acc: value },
    baseline_metrics: { acc: 0.5 },
    code: { commit, parent, repo, path: run, label: `${scope}-${commit.slice(0, 6)}`, patch: "" },
    result: null,
    label: `${scope}-${commit.slice(0, 6)}`,
    samples: [],
  });
  fs.writeFileSync(path.join(run, "state.json"), JSON.stringify({
    problem,
    baseline: evidence(first, null, "subset", 0.5),
    baseline_full: evidence(first, null, "full", 0.5),
    traces: [
      { idea: { id: "h1", hypothesis: "x", mechanism: "y" }, decision: "good", feedback: "", round: 0, lessons: [], evidence: [evidence(second, first, "subset", 0.6)] },
      { idea: { id: "h2", hypothesis: "x", mechanism: "z" }, decision: "good", feedback: "", round: 0, lessons: [], evidence: [evidence(codeChange, second, "subset", 0.7)] },
    ],
    ablations: [], rebuttals: [], best_evidence: null, best_code: null,
    decision_path: [], aborted: false,
  }));
  const ledgerDir = path.join(project, "ledger");
  const snapshot = refreshLedger({ projectRoot: project, runsRoots: [path.join(project, "runs")], ledgerDir });
  assert.equal(snapshot.families.length, 2, "hyperparameter-only commit shares the first family; model change is a second family");
  const baseline = snapshot.experiments.find((item) => item.kind === "baseline" && item.scope === "subset")!;
  const hyper = snapshot.experiments.find((item) => item.commit === second)!;
  const changed = snapshot.experiments.find((item) => item.commit === codeChange)!;
  assert.equal(hyper.family_id, baseline.family_id);
  assert.notEqual(changed.family_id, baseline.family_id);
  assert.equal(hyper.parent_id, baseline.id);
  assert.ok(fs.existsSync(path.join(ledgerDir, "ledger.json")));
  assert.ok(fs.existsSync(path.join(ledgerDir, "graph.md")));
  assert.ok(fs.existsSync(path.join(ledgerDir, "tree.txt")));
  assert.ok(fs.existsSync(path.join(ledgerDir, "lineage.json")));
  assert.equal(modelDefinitionFile(problem as any), "models/model.py");

  // Two runs with identical measurements remain two run experiments; a run is
  // part of experiment identity just like the model-family blob.
  const secondRun = path.join(project, "runs", "run-b");
  fs.cpSync(run, secondRun, { recursive: true });
  const withSecond = refreshLedger({ projectRoot: project, runsRoots: [path.join(project, "runs")], ledgerDir });
  assert.equal(withSecond.experiments.filter((item) => item.kind === "baseline" && item.scope === "subset").length, 2);
  assert.equal(withSecond.families.length, 2);
});

test("candidate and engineer generations are linked, and subset→full is dashed", () => {
  const { repo, first, second, codeChange } = makeRepo();
  const project = tempDir("rsi-ledger-chain-");
  const run = path.join(project, "runs", "run-chain");
  fs.mkdirSync(run, { recursive: true });
  const problem = {
    id: "ledger-chain",
    repo,
    repo_ref: first,
    remote: { env: { RSI_CORAL_MODEL_FILE: "models/model.py" } },
    datasets: ["dev"],
    metrics: [{ name: "acc", direction: "max", tolerance: 0.01, weight: 1, bounds: [0, 1] }],
  };
  const ev = (commit: string, parent: string | null, scope: "subset" | "full", value: number, idea: string, patch: string) => ({
    idea_id: idea, scope, metrics: { acc: value }, baseline_metrics: { acc: 0.5 },
    code: { commit, parent, repo, path: run, label: `${idea}-${scope}`, patch }, result: null, label: `${idea}-${scope}`, samples: [],
  });
  const candidate = ev(second, first, "subset", 0.6, "h1", "Mechanism: candidate mechanism\nHypothesis: candidate hypothesis\n");
  const engineer = ev(codeChange, second, "subset", 0.65, "h1", "Mechanism: engineer mechanism\nCritique: improve candidate\n");
  const full = ev(codeChange, codeChange, "full", 0.7, "h1", "Mechanism: engineer mechanism\n");
  fs.writeFileSync(path.join(run, "state.json"), JSON.stringify({
    problem,
    baseline: ev(first, null, "subset", 0.5, "baseline", ""),
    baseline_full: null,
    traces: [{ idea: { id: "h1", hypothesis: "candidate hypothesis", mechanism: "candidate mechanism" }, decision: "good", feedback: "", round: 0, lessons: [], evidence: [candidate, engineer, full] }],
    ablations: [], rebuttals: [], best_evidence: full, best_code: full.code,
    decision_path: [], aborted: false,
  }));
  const ledgerDir = path.join(project, "ledger");
  const snapshot = refreshLedger({ projectRoot: project, runsRoots: [path.join(project, "runs")], ledgerDir });
  const baseline = snapshot.experiments.find((item) => item.kind === "baseline")!;
  const candidateNode = snapshot.experiments.find((item) => item.kind === "candidate")!;
  const engineerNode = snapshot.experiments.find((item) => item.kind === "engineer")!;
  const fullNode = snapshot.experiments.find((item) => item.kind === "full")!;
  assert.match(candidateNode.core, /candidate mechanism/);
  assert.match(engineerNode.core, /engineer mechanism/);
  assert.equal(candidateNode.parent_id, baseline.id);
  assert.equal(engineerNode.parent_id, candidateNode.id);
  assert.equal(fullNode.parent_id, engineerNode.id);
  assert.equal(fullNode.edge, "dashed");
  assert.deepEqual(snapshot.parent_warnings, [], "every lineage edge must satisfy its parent invariant");
  assert.notEqual(engineerNode.family_id, candidateNode.family_id, "model-definition change is a new family");
});
