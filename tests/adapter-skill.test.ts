import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { fixture, repoRoot, tempDir } from "./helpers.ts";

const scaffold = path.join(
  repoRoot,
  "skills",
  "rsi-adapter",
  "scripts",
  "scaffold_adapter.py",
);

function python(args: string[]) {
  return spawnSync("python3", args, { encoding: "utf8" });
}

test("the adapter skill ships a scaffold and memory of the contract", () => {
  const skill = fs.readFileSync(
    path.join(repoRoot, "skills", "rsi-adapter", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: rsi-adapter\n/m);
  assert.match(skill, /experiment_command/);
  assert.match(skill, /--scope/);
  assert.match(skill, /\.gitignore|rsync/);
});

test("scaffold generates a contract adapter from a Problem fixture", () => {
  const out = path.join(tempDir("rsi-adapter-"), "integration");
  const result = python([
    scaffold,
    "--problem",
    fixture("ood_frozen_encoder"),
    "--repo",
    "/tmp/target-project",
    "--out",
    out,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const adapter = fs.readFileSync(path.join(out, "run_experiment.py"), "utf8");
  assert.doesNotMatch(adapter, /@@[A-Z_]+@@/);
  assert.match(adapter, /METRICS =/);
  assert.match(adapter, /auroc/);
  assert.match(adapter, /--scope/);
  assert.match(adapter, /status.*failed/);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "adapter.json"), "utf8"));
  assert.equal(manifest.problem, "ood-frozen-encoder");
  assert.equal(manifest.metrics[0].name, "auroc");
  assert.equal(manifest.metrics[0].direction, "max");
  assert.deepEqual(manifest.scopes, ["subset", "full", "ablation", "rebuttal"]);
  assert.ok(fs.existsSync(path.join(out, "setup.sh")));

  const help = python([path.join(out, "run_experiment.py"), "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--repo/);
});

test("unfinished scaffold fails closed instead of fabricating metrics", () => {
  const out = path.join(tempDir("rsi-adapter-fail-"), "integration");
  const scaffolded = python([
    scaffold,
    "--problem",
    fixture("ood_frozen_encoder"),
    "--repo",
    repoRoot,
    "--out",
    out,
  ]);
  assert.equal(scaffolded.status, 0, scaffolded.stderr);

  const report = path.join(tempDir("rsi-adapter-report-"), "report.json");
  const result = python([
    path.join(out, "run_experiment.py"),
    "--repo",
    repoRoot,
    "--scope",
    "subset",
    "--out",
    report,
  ]);
  assert.equal(result.status, 1);
  const data = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(data.status, "failed");
  assert.deepEqual(data.metrics, {});
});
