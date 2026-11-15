#!/usr/bin/env node
// Minimal stdio LSP fixture for tests. It implements only the read-only
// methods the RSI client uses and publishes one error for bad.py. Like
// rust-analyzer, it waits for a well-formed workspace/configuration response
// before publishing diagnostics.
import path from "node:path";
import { pathToFileURL } from "node:url";

let buffer = "";
let nextServerRequest = 100;
let configurationReady = false;
let pendingOpen = null;

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function uriOf(file) {
  return pathToFileURL(path.resolve(process.cwd(), file)).href;
}

function range(line = 0, character = 0) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}

function publish(uri) {
  const bad = uri.endsWith("/bad.py");
  send({
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: bad
        ? [{ range: range(1, 0), severity: 1, message: "boom" }]
        : [],
    },
  });
}

function handle(message) {
  const id = message.id;
  if (message.method === "initialize") {
    send({
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
        },
      },
    });
    return;
  }
  if (message.method === "initialized") {
    send({
      id: nextServerRequest++,
      method: "workspace/configuration",
      params: { items: [{ section: "rsi" }, { section: "rust-analyzer" }] },
    });
    return;
  }
  if (id === 100 && Array.isArray(message.result)) {
    configurationReady = message.result.length === 2;
    if (configurationReady && pendingOpen) {
      publish(pendingOpen);
      pendingOpen = null;
    }
    return;
  }
  if (message.method === "textDocument/didOpen") {
    const uri = message.params?.textDocument?.uri ?? "";
    if (configurationReady) publish(uri);
    else pendingOpen = uri;
    return;
  }
  if (message.method === "textDocument/definition") {
    const uri = message.params?.textDocument?.uri ?? "";
    send({ id, result: [{ uri, range: range(1, 0) }] });
    return;
  }
  if (message.method === "textDocument/references") {
    const uri = message.params?.textDocument?.uri ?? "";
    send({
      id,
      result: uri.endsWith("/unref.py")
        ? []
        : [{ uri, range: range(0, 0) }, { uri, range: range(2, 0) }],
    });
    return;
  }
  if (message.method === "textDocument/hover") {
    send({ id, result: { contents: { kind: "markdown", value: "**hover**" }, range: range(0, 0) } });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      id,
      result: [{ name: "foo", kind: 12, range: range(0, 0), selectionRange: range(0, 0) }],
    });
    return;
  }
  if (message.method === "workspace/symbol") {
    send({
      id,
      result: [{ name: "foo", kind: 12, location: { uri: uriOf("bad.py"), range: range(0, 0) } }],
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
  if (id !== undefined && message.method) {
    send({ id, result: null });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) break;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.slice(0, header));
    if (!match) {
      buffer = buffer.slice(header + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < header + 4 + length) break;
    const body = buffer.slice(header + 4, header + 4 + length);
    buffer = buffer.slice(header + 4 + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // ignore malformed fixture input
    }
  }
});
