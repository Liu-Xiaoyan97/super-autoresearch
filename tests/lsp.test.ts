import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { LspClient, lspDiagnostics, type LspSpec } from "../src/rsi/runtime/lsp.ts";
import { LSP_TOOL_NAMES, lspTools } from "../src/rsi/runtime/lsp-tools.ts";
import type { LanguageSpec } from "../src/rsi/runtime/checks.ts";
import { repoRoot, tempDir } from "./helpers.ts";

const fixture = path.join(repoRoot, "tests", "fixtures", "fake-lsp-server.mjs");

function workspace(): string {
  const root = tempDir("rsi-lsp-");
  fs.writeFileSync(path.join(root, "good.py"), "value = 1\n", "utf8");
  fs.writeFileSync(path.join(root, "bad.py"), "def value(:\n    return 1\n", "utf8");
  return root;
}

function spec(): LspSpec {
  return { command: [process.execPath, fixture], severity: "advisory" };
}

function languageSpec(): Record<string, LanguageSpec> {
  return {
    python: {
      id: "python",
      extensions: [".py"],
      checks: [],
      lsp: spec(),
    },
  };
}

async function call(tools: ReturnType<typeof lspTools>, name: string, params: unknown) {
  const tool = tools.tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool.execute("test", params);
}

test("diagnostics report errors and clean files", async () => {
  const root = workspace();
  const bad = await lspDiagnostics(root, spec(), ["bad.py"], 3000);
  assert.equal(bad.status, "failed");
  assert.equal(bad.diagnostics.length, 1);
  assert.equal(bad.diagnostics[0].severity, "error");
  assert.match(bad.diagnostics[0].message, /boom/);
  const good = await lspDiagnostics(root, spec(), ["good.py"], 3000);
  assert.equal(good.status, "ok");
  assert.deepEqual(good.diagnostics, []);
});

test("an unavailable server is explicit, never a silent pass", async () => {
  const root = workspace();
  const result = await lspDiagnostics(root, { command: ["definitely-not-a-real-lsp-xyz"] }, ["good.py"], 1000);
  assert.equal(result.status, "unavailable");
  assert.match(result.stderr, /not found/);
});

test("a hung server times out", async () => {
  const root = workspace();
  const result = await lspDiagnostics(root, {
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  }, ["good.py"], 250);
  assert.equal(result.status, "timeout");
});

test("model-facing tools expose only read-only queries", async () => {
  const root = workspace();
  const tools = lspTools({ root, specs: languageSpec(), timeoutMs: 3000 });
  assert.deepEqual(tools.tools.map((item) => item.name), [...LSP_TOOL_NAMES]);

  const definition = await call(tools, "lsp_definition", { path: "bad.py", line: 2, character: 1 });
  assert.equal(definition.isError, undefined);
  assert.match(definition.content[0].text, /bad\.py/);

  const references = await call(tools, "lsp_references", { path: "bad.py", line: 2, character: 1 });
  assert.equal(references.isError, undefined);
  assert.match(references.content[0].text, /bad\.py/);

  const hover = await call(tools, "lsp_hover", { path: "bad.py", line: 2, character: 1 });
  assert.match(hover.content[0].text, /hover/);

  const symbols = await call(tools, "lsp_document_symbols", { path: "bad.py" });
  assert.match(symbols.content[0].text, /foo/);

  const workspaceSymbols = await call(tools, "lsp_workspace_symbols", { query: "foo" });
  assert.match(workspaceSymbols.content[0].text, /bad\.py/);

  const diagnostics = await call(tools, "lsp_diagnostics", { path: "bad.py" });
  assert.match(diagnostics.content[0].text, /boom/);

  await tools.close();
});

test("LSP tools reject paths outside the worker root", async () => {
  const root = workspace();
  const tools = lspTools({ root, specs: languageSpec(), timeoutMs: 3000 });
  const escaped = await call(tools, "lsp_diagnostics", { path: "../outside.py" });
  assert.equal(escaped.isError, true);
  assert.match(escaped.content[0].text, /escapes/);
  await tools.close();
});

test("LSP client stops its server without leaving a live child", async () => {
  const root = workspace();
  const client = new LspClient(root, spec(), { timeoutMs: 3000 });
  await client.start();
  const diagnostics = await client.diagnostic("good.py", 3000);
  assert.deepEqual(diagnostics, []);
  await client.stop();
  await assert.rejects(() => client.request("textDocument/hover", {
    textDocument: { uri: "file:///nope.py" },
    position: { line: 0, character: 0 },
  }, 100));
});
