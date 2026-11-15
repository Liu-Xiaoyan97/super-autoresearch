import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { changedLineRanges, lspReferenceAudit } from "../src/rsi/runtime/lsp-audit.ts";
import type { LspSpec } from "../src/rsi/runtime/lsp.ts";
import { tempDir } from "./helpers.ts";

function available(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repo(initial: Record<string, string>, changed: Record<string, string>) {
  const root = tempDir("rsi-lsp-lang-");
  for (const [file, text] of Object.entries(initial)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text, "utf8");
  }
  git(root, "init", "-q");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "baseline");
  const parent = git(root, "rev-parse", "HEAD");
  for (const [file, text] of Object.entries(changed)) fs.writeFileSync(path.join(root, file), text, "utf8");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@local", "commit", "-qm", "candidate");
  return { root, parent, commit: git(root, "rev-parse", "HEAD"), files: Object.keys(changed) };
}

async function audit(root: string, parent: string, commit: string, name: string, files: string[], command: string[], timeoutMs = 30000) {
  const spec: LspSpec = { command, referenceSeverity: "required" };
  const result = await lspReferenceAudit(
    root,
    spec,
    name,
    files,
    changedLineRanges(root, parent, commit),
    timeoutMs,
  );
  assert.ok(result, `${name} reference check must not be skipped`);
  return result;
}

test("python reference audit", { skip: !available("pyright-langserver") }, async () => {
  const r = repo(
    {
      "lib.py": "def add(a, b):\n    return a + b\n",
      "use.py": "from lib import add\n\nprint(add(1, 2))\n",
    },
    { "lib.py": "def add(a, b):\n    return a + b + 0\n" },
  );
  const result = await audit(r.root, r.parent, r.commit, "python", r.files, ["pyright-langserver", "--stdio"]);
  assert.equal(result.status, "ok");
  assert.equal(result.severity, "required");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.changed_symbols, 1);
  assert.equal(summary.referenced_symbols, 1);
  assert.deepEqual(summary.unreferenced_symbols, []);
});

test("rust reference audit", { skip: !available("rust-analyzer") }, async () => {
  const r = repo(
    {
      "Cargo.toml": "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
      "src/main.rs": "fn main() { println!(\"{}\", probe::add(1, 2)); }\n",
    },
    { "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b + 0 }\n" },
  );
  const result = await audit(r.root, r.parent, r.commit, "rust", r.files, ["rust-analyzer"], 45000);
  assert.equal(result.status, "ok");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.changed_symbols, 1);
  assert.equal(summary.referenced_symbols, 1);
  assert.deepEqual(summary.unreferenced_symbols, []);
});

test("go reference audit", { skip: !available("gopls") }, async () => {
  const r = repo(
    {
      "go.mod": "module probe\n\ngo 1.22\n",
      "main.go": "package main\n\nfunc add(a, b int) int { return a + b }\n\nfunc main() { println(add(1, 2)) }\n",
    },
    { "main.go": "package main\n\nfunc add(a, b int) int { return a + b + 0 }\n\nfunc main() { println(add(1, 2)) }\n" },
  );
  const result = await audit(r.root, r.parent, r.commit, "go", r.files, ["gopls"], 30000);
  assert.equal(result.status, "ok");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.changed_symbols, 1);
  assert.equal(summary.referenced_symbols, 1);
  assert.deepEqual(summary.unreferenced_symbols, []);
});
