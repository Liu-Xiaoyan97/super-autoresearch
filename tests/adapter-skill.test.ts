import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fixture, repoRoot, tempDir } from "./helpers.ts";

const skillDir = path.join(repoRoot, "skills/rsi-adapter");
const scaffold = path.join(skillDir, "scripts/scaffold_adapter.py");
function python(args: string[]) { return spawnSync("python3", args, { encoding: "utf8" }); }
function target() {
  const repo = tempDir("rsi-target-adapter-");
  const result = spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return repo;
}
function generate(repo: string, problem = fixture("ood_frozen_encoder"), extra: string[] = []) {
  return python([scaffold, "--problem", problem, "--repo", repo, ...extra]);
}

test("adapter skill enforces native Pi and target-only complete real pipeline", () => {
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: rsi-adapter\n/m);
  assert.match(skill, /authorizes this skill to modify the target repository/);
  assert.match(skill, /Mandatory remote acceptance gate/);
  assert.match(skill, /rsi_adapter_smoke/);
  assert.match(skill, /\/rsi smoke/);
  assert.match(skill, /checkpoint save\/reload/);
  assert.match(skill, /remote-smoke-passed/);
  assert.match(skill, /mutable_paths/);
  assert.match(skill, /Failing contract tests are a blocker/);
  assert.doesNotMatch(skill, /node .*remote_smoke\.ts|--out integrations\//);
  assert.doesNotMatch(skill, /no usable eval, stop/);
});

test("scaffold writes only target adapter and target metadata, no RSI integration or setup", () => {
  const repo = target();
  const result = generate(repo);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".rsi/adapter/ood-frozen-encoder.json"), "utf8"));
  assert.equal(manifest.problem, "ood-frozen-encoder");
  assert.equal(manifest.target_repo, ".");
  assert.equal(manifest.metrics[0].name, "auroc");
  assert.equal(manifest.metrics[0].direction, "max");
  assert.ok(manifest.protected_paths.includes(manifest.adapter_path));
  assert.deepEqual(manifest.scopes, ["subset", "full", "ablation", "rebuttal"]);
  const adapter = path.join(repo, manifest.adapter_path);
  assert.match(fs.readFileSync(adapter, "utf8"), /NotImplementedError/);
  assert.doesNotMatch(fs.readFileSync(adapter, "utf8"), /@@[A-Z_]+@@/);
  const help = python([adapter, "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--repo/);
  const readme = fs.readFileSync(path.join(repo, ".rsi/adapter/ood-frozen-encoder.md"), "utf8");
  assert.match(readme, /rsi_adapter_smoke/);
  assert.match(readme, /checkpoint save\/reload/);
  assert.match(readme, /usable version only follows real remote end-to-end/);
  assert.match(result.stdout, /NOT DONE/);
  assert.equal(fs.existsSync(path.join(repo, "setup.sh")), false);
  const worker = path.join(repo, "bench/rsi_job_worker.py");
  assert.ok(fs.existsSync(worker), "the detached job worker ships with the target");
  assert.match(fs.readFileSync(worker, "utf8"), /claimed/);
  assert.ok(manifest.protected_paths.includes("bench/rsi_job_worker.py"));
  assert.equal(fs.existsSync(path.join(repo, "integrations")), false);
});

test("unfinished target scaffold fails closed instead of fabricating metrics", () => {
  const repo = target();
  assert.equal(generate(repo).status, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".rsi/adapter/ood-frozen-encoder.json"), "utf8"));
  const report = path.join(tempDir("rsi-adapter-report-"), "report.json");
  const result = python([path.join(repo, manifest.adapter_path), "--repo", repo, "--scope", "subset", "--out", report]);
  assert.equal(result.status, 1);
  const data = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(data.status, "failed");
  assert.deepEqual(data.metrics, {});
});

test("scaffold refuses overwrites, non-git targets and the RSI source root", () => {
  const repo = target();
  assert.equal(generate(repo).status, 0);
  assert.equal(generate(repo).status, 2);
  assert.equal(generate(repo, undefined, ["--force"]).status, 0);
  assert.equal(generate(tempDir("rsi-not-git-")).status, 2);
  assert.match(generate(repoRoot).stderr, /not the RSI extension repository/);
});

test("scaffold rejects escaping script paths and symlinked destinations", () => {
  for (const script of ["../escape.py", "/tmp/absolute.py", "bench/../../escape.py"]) {
    const repo = target();
    const p = path.join(tempDir("rsi-scaffold-bad-"), "problem.json");
    fs.writeFileSync(p, JSON.stringify({ id: "bad", experiment_command: ["{python}", script], metrics: [{ name: "score" }] }));
    assert.match(generate(repo, p).stderr, /safe relative target path/);
  }
  const repo = target();
  fs.symlinkSync(tempDir("rsi-scaffold-escape-"), path.join(repo, "bench"));
  const p = path.join(tempDir("rsi-scaffold-link-"), "problem.json");
  fs.writeFileSync(p, JSON.stringify({ id: "bad", experiment_command: ["{python}", "bench/run.py"], metrics: [{ name: "score" }] }));
  assert.match(generate(repo, p).stderr, /escapes target via symlink/);
});
