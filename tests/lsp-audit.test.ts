import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { changedLineRanges, lspReferenceAudit } from "../src/rsi/runtime/lsp-audit.ts";
import { runCheckJob } from "../src/rsi/runtime/checks.ts";
import type { CheckResult, LanguageSpec } from "../src/rsi/runtime/checks.ts";
import type { LspSpec } from "../src/rsi/runtime/lsp.ts";
import { ArtifactStore } from "../src/rsi/runtime/store.ts";
import type { RepoRef } from "../src/rsi/types.ts";
import { repoRoot, tempDir } from "./helpers.ts";

const fixture = path.join(repoRoot, "tests", "fixtures", "fake-lsp-server.mjs");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function candidateRepo(): { root: string; parent: string; commit: string } {
  const root = tempDir("rsi-lsp-audit-");
  fs.writeFileSync(path.join(root, "good.py"), "value = 1\n", "utf8");
  fs.writeFileSync(path.join(root, "unref.py"), "dead = 1\n", "utf8");
  git(root, "init", "-q");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "baseline");
  const parent = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "good.py"), "value = 2\nextra = 3\n", "utf8");
  fs.writeFileSync(path.join(root, "unref.py"), "dead = 2\nextra = 4\n", "utf8");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "candidate");
  return { root, parent, commit: git(root, "rev-parse", "HEAD") };
}

function repoRef(root: string, parent: string, commit: string): RepoRef {
  return { path: root, label: "candidate", parent, patch: "", repo: root, commit, branch: "candidate" };
}

function lsp(referenceSeverity: "required" | "advisory" = "advisory"): LspSpec {
  return {
    command: [process.execPath, fixture],
    severity: "advisory",
    referenceSeverity,
  };
}

function specs(): Record<string, LanguageSpec> {
  return {
    python: {
      id: "python",
      extensions: [".py"],
      checks: [{ id: "ok", command: ["sh", "-c", "exit 0"], timeoutS: 10, severity: "required" }],
    },
  };
}

function ids(checks: CheckResult[]): string[] {
  return checks.map((check) => check.id);
}

test("the diff parser reports added lines per changed file", () => {
  const repo = candidateRepo();
  const ranges = changedLineRanges(repo.root, repo.parent, repo.commit);
  assert.deepEqual(ranges.get("good.py"), [{ start: 1, end: 2 }]);
  assert.deepEqual(ranges.get("unref.py"), [{ start: 1, end: 2 }]);
});

test("the reference audit separates referenced and unreferenced symbols", async () => {
  const repo = candidateRepo();
  const ranges = changedLineRanges(repo.root, repo.parent, repo.commit);
  const result = await lspReferenceAudit(
    repo.root,
    lsp("required"),
    "python",
    ["good.py", "unref.py"],
    ranges,
    3000,
  );
  assert.ok(result);
  assert.equal(result.status, "failed");
  assert.equal(result.severity, "required");
  assert.match(result.stderr, /unreferenced changed symbols/);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.changed_symbols, 2);
  assert.equal(summary.referenced_symbols, 1);
  assert.deepEqual(summary.unreferenced_symbols, ["unref.py:1:foo"]);
});

test("runCheckJob orders references, checks, then diagnostics", async () => {
  const repo = candidateRepo();
  const report = await runCheckJob(
    new ArtifactStore(tempDir("rsi-lsp-audit-store-")),
    repoRef(repo.root, repo.parent, repo.commit),
    "h1-subset",
    specs(),
    ["python"],
    ["good.py"],
    { python: lsp("advisory") },
  );
  assert.equal(report.status, "ok");
  assert.deepEqual(ids(report.checks), ["lsp-references-python", "ok", "lsp-python"]);
});

test("a required reference failure stops before CheckRunner", async () => {
  const repo = candidateRepo();
  const report = await runCheckJob(
    new ArtifactStore(tempDir("rsi-lsp-audit-store-")),
    repoRef(repo.root, repo.parent, repo.commit),
    "h1-subset",
    specs(),
    ["python"],
    ["unref.py"],
    { python: lsp("required") },
  );
  assert.equal(report.status, "failed");
  assert.deepEqual(ids(report.checks), ["lsp-references-python"]);
  assert.equal(report.checks[0].status, "failed");
});
