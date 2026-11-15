/**
 * Minimal read-only LSP diagnostics client.
 *
 * The client only initializes a language server, opens changed files, collects
 * diagnostics and shuts down. It never sends rename, format, applyEdit or
 * executeCommand requests. LSP is an optional check signal; compiler/test
 * commands remain the source of truth.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CheckSeverity } from "./checks.ts";

export interface LspSpec {
  command: string[];
  root?: string;
  env?: Record<string, string>;
  severity?: CheckSeverity;
}

export interface LspDiagnostic {
  file: string;
  line?: number;
  character?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface LspResult {
  status: "ok" | "failed" | "timeout" | "unavailable";
  diagnostics: LspDiagnostic[];
  stderr: string;
}

const LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

function safeEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...(extra ?? {}) };
}

function diagnosticFile(root: string, uri: string): string {
  try {
    return path.relative(root, decodeURIComponent(new URL(uri).pathname));
  } catch {
    return uri;
  }
}

/** Run a language server once and return diagnostics for the given files. */
export async function lspDiagnostics(
  root: string,
  spec: LspSpec,
  files: string[],
  timeoutMs = 8000,
): Promise<LspResult> {
  const abs = files
    .map((file) => path.resolve(root, file))
    .filter((file) => file.startsWith(path.resolve(root) + path.sep));
  if (!spec.command.length || !abs.length) return { status: "ok", diagnostics: [], stderr: "" };

  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: path.resolve(root, spec.root ?? "."),
    env: safeEnv({ ...spec.env, ...(spec.root ? { PWD: path.resolve(root, spec.root) } : {}) }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  let settled = false;
  let opened = 0;
  const pending = new Map<number, (value: unknown) => void>();
  const diagnostics = new Map<string, LspDiagnostic[]>();
  const finish = (status: LspResult["status"]): LspResult => {
    if (settled) return { status, diagnostics: [...diagnostics.values()].flat(), stderr: stderr.slice(-4000) };
    settled = true;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 250).unref?.();
    return { status, diagnostics: [...diagnostics.values()].flat(), stderr: stderr.slice(-4000) };
  };
  const send = (message: Record<string, unknown>): void => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const openFiles = (): void => {
    for (const file of abs) {
      const ext = path.extname(file);
      const languageId = LANGUAGE[ext] ?? "plaintext";
      const text = fs.readFileSync(file, "utf8");
      send({
        method: "textDocument/didOpen",
        params: { textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text } },
      });
      opened += 1;
    }
  };
  const allDiagnostics = (): boolean => abs.every((file) => diagnostics.has(pathToFileURL(file).href));
  let resolveDone: (value: LspResult) => void = () => undefined;
  const done = new Promise<LspResult>((resolve) => { resolveDone = resolve; });
  const timer = setTimeout(() => resolveDone(finish(allDiagnostics() ? "ok" : "timeout")), timeoutMs);
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("error", (error) => {
    stderr += `${error.message}\n`;
    resolveDone(finish((error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "failed"));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const header = buffer.indexOf("\r\n\r\n");
      if (header < 0) break;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.slice(0, header));
      if (!match) { buffer = buffer.slice(header + 4); continue; }
      const length = Number(match[1]);
      if (buffer.length < header + 4 + length) break;
      const body = buffer.slice(header + 4, header + 4 + length);
      buffer = buffer.slice(header + 4 + length);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body) as Record<string, unknown>; } catch { continue; }
      if (typeof message.id === "number" && message.method) {
        // Respond to server-initiated requests without granting write access.
        const method = String(message.method);
        send({ id: message.id, result: method === "workspace/configuration" ? [] : null });
        continue;
      }
      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        setTimeout(openFiles, 50);
        continue;
      }
      if (message.method === "textDocument/publishDiagnostics") {
        const params = (message.params ?? {}) as { uri?: string; diagnostics?: Array<Record<string, unknown>> };
        if (params.uri) {
          diagnostics.set(params.uri, (params.diagnostics ?? []).map((item) => ({
            file: diagnosticFile(root, params.uri!),
            line: typeof item.range === "object" && item.range !== null ? Number(((item.range as Record<string, unknown>).start as Record<string, unknown>)?.line) + 1 : undefined,
            character: typeof item.range === "object" && item.range !== null ? Number(((item.range as Record<string, unknown>).start as Record<string, unknown>)?.character) + 1 : undefined,
            severity: Number(item.severity) === 1 ? "error" : Number(item.severity) === 2 ? "warning" : "info",
            message: String(item.message ?? ""),
          })));
          if (opened > 0 && allDiagnostics()) resolveDone(finish("ok"));
        }
        continue;
      }
      if (typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
      }
    }
  });
  send({
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: pathToFileURL(path.resolve(root, spec.root ?? ".")).href,
      capabilities: { textDocument: { publishDiagnostics: {} }, workspace: { workspaceFolders: true } },
      workspaceFolders: [{ uri: pathToFileURL(path.resolve(root, spec.root ?? ".")).href, name: "target" }],
    },
  });
  const result = await done;
  clearTimeout(timer);
  const errors = result.diagnostics.filter((item) => item.severity === "error");
  return { ...result, status: result.status === "ok" && errors.length ? "failed" : result.status };
}

export function lspLanguageId(file: string): string {
  return LANGUAGE[path.extname(file)] ?? "plaintext";
}
