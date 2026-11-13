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
