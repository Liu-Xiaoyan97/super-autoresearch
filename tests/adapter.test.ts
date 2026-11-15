import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadAdapter } from "../src/rsi/runtime/checks.ts";
import { makeProblem } from "../src/rsi/types.ts";
import { tempDir } from "./helpers.ts";

function manifests(files: Record<string, unknown>): string {
  const root = tempDir("rsi-adapter-");
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, ".rsi", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
  }
  return root;
}

test("adapter selection uses the problem identity, not the first file", () => {
  const repo = manifests({
    "adapter/one.json": { problem: "other", languages: { python: { checks: [] } } },
    "adapter/two.json": { problem: "target", languages: { python: { checks: [] } } },
  });
  assert.equal(loadAdapter(repo, makeProblem({ id: "target" }))?.problem, "target");
});

test("adapter selection falls back to the source fixture", () => {
  const repo = manifests({
    "adapter/one.json": { source_fixture: "examples/other.json" },
    "adapter/two.json": { source_fixture: "examples/target.json" },
  });
  assert.equal(loadAdapter(repo, makeProblem({ id: "target" }))?.source_fixture, "examples/target.json");
});

test("ambiguous adapter manifests fail closed", () => {
  const repo = manifests({
    "adapter/one.json": { problem: "target" },
    "adapter/two.json": { problem: "target" },
  });
  assert.equal(loadAdapter(repo, makeProblem({ id: "target" })), null);
});

test("an unmatched manifest does not bind a run to another problem", () => {
  const repo = manifests({
    "adapter/one.json": { problem: "other" },
    "adapter/two.json": { problem: "another" },
  });
  assert.equal(loadAdapter(repo, makeProblem({ id: "target" })), null);
});

test("a sole generic manifest remains valid", () => {
  const repo = manifests({ "adapter.json": { languages: { python: { checks: [] } } } });
  assert.ok(loadAdapter(repo, makeProblem({ id: "target" })));
});

test("a sole manifest for another problem is refused", () => {
  const repo = manifests({ "adapter.json": { problem: "other" } });
  assert.equal(loadAdapter(repo, makeProblem({ id: "target" })), null);
});
