/**
 * Minimal read-only LSP client.
 *
 * The client only initializes a language server, opens files, collects
 * diagnostics and answers a small read-only query set: definition, references,
 * hover, document symbols and workspace symbols. It never sends rename,
 * format, applyEdit or executeCommand requests. LSP is an optional check
 * signal; compiler/test commands remain the source of truth.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CheckSeverity } from "./checks.ts";

export interface LspSpec {
  command: string[];
  root?: string;
  env?: Record<string, string>;
  /** Diagnostics severity; default advisory. */
  severity?: CheckSeverity;
  /** Static changed-symbol reference severity; default advisory. */
  referenceSeverity?: CheckSeverity;
  initializationOptions?: Record<string, unknown>;
}

export interface LspDiagnostic {
  file: string;
  line?: number;
  character?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export type LspStatus = "ok" | "failed" | "timeout" | "unavailable";

export interface LspResult {
  status: LspStatus;
  diagnostics: LspDiagnostic[];
  stderr: string;
}

export class LspUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspUnavailableError";
  }
}

export class LspTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspTimeoutError";
  }
}

const LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  // The language server is launched by a rustup/go proxy; keep the toolchain
  // homes visible after HOME is isolated to the check artifact directory.
  "RUSTUP_HOME",
  "CARGO_HOME",
  "RUSTUP_TOOLCHAIN",
  "GOTOOLCHAIN",
  "GOPATH",
  "GOBIN",
  "GOCACHE",
  "GOMODCACHE",
] as const;
const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function safeEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...(extra ?? {}) };
}

/** Resolve a target-relative path without leaving the target worktree. */
export function resolveLspFile(root: string, file: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, file);
  const relative = path.relative(base, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`LSP path escapes the worktree: ${file}`);
  }
  // A symlink inside the worktree can still point outside it. Resolve both
  // sides when the file exists so read-only tools cannot be used to read
  // arbitrary host files.
  try {
    const realBase = fs.realpathSync(base);
    const realAbs = fs.realpathSync(abs);
    const realRelative = path.relative(realBase, realAbs);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`LSP path escapes the worktree through a symlink: ${file}`);
    }
    return realAbs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return abs;
    throw error;
  }
}

function diagnosticFile(root: string, uri: string): string {
  try {
    return path.relative(root, fileURLToPath(uri));
  } catch {
    return uri;
  }
}

/** Make a server result safe to show: relative file names, bounded text. */
export function formatLspValue(root: string, value: unknown, maxChars = 20000): string {
  const shown = JSON.stringify(value, (key, item) => {
    if ((key === "uri" || key === "targetUri") && typeof item === "string" && item.startsWith("file:")) {
      try {
        return path.relative(root, fileURLToPath(item));
      } catch {
        return item;
      }
    }
    return item;
  }, 2) ?? "null";
  return shown.length > maxChars ? `${shown.slice(0, maxChars)}\n... truncated` : shown;
}

/**
 * One language server for one worktree. Every request is read-only; the only
 * writes are JSON-RPC initialization messages and didOpen notifications.
 */
export class LspClient {
  readonly root: string;
  private readonly spec: LspSpec;
  private readonly timeoutMs: number;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private failed: Error | null = null;
  private buffer = "";
  private nextId = 2;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly waiters = new Map<string, Array<{
    resolve: (value: LspDiagnostic[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>>();
  private readonly opened = new Set<string>();
  private stderrText = "";

  constructor(root: string, spec: LspSpec, opts: { timeoutMs?: number } = {}) {
    this.root = path.resolve(root);
    this.spec = spec;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  stderr(): string {
    return this.stderrText.slice(-4000);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.failed) throw this.failed;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      await this.starting;
    } catch (error) {
      this.failed = error as Error;
      throw error;
    } finally {
      this.starting = null;
    }
  }

  private async launch(): Promise<void> {
    if (!this.spec.command.length) throw new LspUnavailableError("LSP command is empty");
    const [command, ...args] = this.spec.command;
    const root = path.resolve(this.root, this.spec.root ?? ".");
    const child = spawn(command, args, {
      cwd: root,
      env: safeEnv({ ...this.spec.env, ...(this.spec.root ? { PWD: root } : {}) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => { this.stderrText += chunk.toString("utf8"); });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      this.fail(new LspUnavailableError(
        code === "ENOENT" ? `LSP command not found: ${command}` : `LSP server failed: ${error.message}`,
      ));
    });
    child.on("exit", (code, signal) => {
      if (this.stopping) return;
      this.fail(new LspUnavailableError(`LSP server exited (${signal ?? code ?? "unknown"})`));
    });
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    const initialize = new Promise<unknown>((resolve, reject) => {
      this.trackRequest(1, resolve, reject, this.timeoutMs);
      try {
        this.send({
          id: 1,
          method: "initialize",
          params: {
            processId: process.pid,
            rootUri: pathToFileURL(root).href,
            capabilities: {
              textDocument: {
                publishDiagnostics: {},
                definition: {},
                references: {},
                hover: {},
                documentSymbol: {},
              },
              workspace: { symbol: {}, workspaceFolders: true, configuration: true },
            },
            workspaceFolders: [{ uri: pathToFileURL(root).href, name: "target" }],
            ...(this.spec.initializationOptions ? { initializationOptions: this.spec.initializationOptions } : {}),
          },
        });
      } catch (error) {
        reject(error as Error);
      }
    });
    await initialize;
    this.send({ method: "initialized", params: {} });
    this.started = true;
  }

  private trackRequest(
    id: number,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    timeoutMs: number,
  ): void {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new LspTimeoutError(`LSP request ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { resolve, reject, timer });
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new LspUnavailableError("LSP server is not running");
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private fail(error: Error): void {
    if (this.failed && this.failed.message === error.message) return;
    this.failed = error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    for (const list of this.waiters.values()) {
      for (const item of list) {
        clearTimeout(item.timer);
        item.reject(error);
      }
    }
    this.waiters.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_BUFFER) {
      this.fail(new LspUnavailableError("LSP output exceeded the buffer limit"));
      return;
    }
    for (;;) {
      const header = this.buffer.indexOf("\r\n\r\n");
      if (header < 0) break;
      const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, header));
      if (!match) {
        this.buffer = this.buffer.slice(header + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE) {
        this.fail(new LspUnavailableError("LSP sent an invalid Content-Length"));
        return;
      }
      if (this.buffer.length < header + 4 + length) break;
      const body = this.buffer.slice(header + 4, header + 4 + length);
      this.buffer = this.buffer.slice(header + 4 + length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (message.method && hasId) {
      // A server request. answer only read-only/no-op methods; never apply edits.
      const method = String(message.method);
      let result: unknown = null;
      if (method === "workspace/configuration") {
        const params = message.params as { items?: unknown[] } | undefined;
        result = Array.isArray(params?.items) ? params.items.map(() => null) : [];
      } else if (method === "workspace/workspaceFolders") {
        result = [{ uri: pathToFileURL(this.root).href, name: "target" }];
      } else if (method === "workspace/applyEdit") {
        result = { applied: false, failureReason: "LSP client is read-only" };
      }
      try {
        this.send({ id: message.id, result });
      } catch {
        /* the server is gone; the pending request path reports it */
      }
      return;
    }
    if (hasId && (Object.prototype.hasOwnProperty.call(message, "result") || message.error !== undefined)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown; code?: unknown };
        pending.reject(new Error(`LSP request failed: ${String(error?.message ?? error?.code ?? "unknown error")}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = (message.params ?? {}) as { uri?: string; diagnostics?: Array<Record<string, unknown>> };
      if (!params.uri) return;
      const diagnostics = (params.diagnostics ?? []).map((item) => ({
        file: diagnosticFile(this.root, params.uri!),
        line: typeof item.range === "object" && item.range !== null
          ? Number(((item.range as Record<string, unknown>).start as Record<string, unknown>)?.line) + 1
          : undefined,
        character: typeof item.range === "object" && item.range !== null
          ? Number(((item.range as Record<string, unknown>).start as Record<string, unknown>)?.character) + 1
          : undefined,
        severity: Number(item.severity) === 1 ? "error" : Number(item.severity) === 2 ? "warning" : "info",
        message: String(item.message ?? ""),
      })) as LspDiagnostic[];
      this.diagnostics.set(params.uri, diagnostics);
      const list = this.waiters.get(params.uri);
      if (list) {
        this.waiters.delete(params.uri);
        for (const item of list) {
          clearTimeout(item.timer);
          item.resolve(diagnostics);
        }
      }
    }
  }

  async openFile(file: string): Promise<{ abs: string; uri: string }> {
    await this.start();
    const abs = resolveLspFile(this.root, file);
    const uri = pathToFileURL(abs).href;
    if (!this.opened.has(uri)) {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`LSP file is too large: ${file}`);
      const text = fs.readFileSync(abs, "utf8");
      this.send({
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: lspLanguageId(abs),
            version: 1,
            text,
          },
        },
      });
      this.opened.add(uri);
    }
    return { abs, uri };
  }

  async request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    await this.start();
    if (this.failed) throw this.failed;
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.trackRequest(id, resolve, reject, timeoutMs);
      try {
        this.send({ id, method, params });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
        }
        reject(error as Error);
      }
    });
  }

  async diagnostic(file: string, timeoutMs = this.timeoutMs): Promise<LspDiagnostic[]> {
    const { uri } = await this.openFile(file);
    if (this.diagnostics.has(uri)) return this.diagnostics.get(uri)!;
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(uri);
        if (list) {
          const index = list.findIndex((item) => item.timer === timer);
          if (index >= 0) list.splice(index, 1);
          if (!list.length) this.waiters.delete(uri);
        }
        reject(new LspTimeoutError(`LSP diagnostics timed out for ${file}`));
      }, timeoutMs);
      timer.unref?.();
      const list = this.waiters.get(uri) ?? [];
      list.push({ resolve, reject, timer });
      this.waiters.set(uri, list);
    });
  }

  async definition(file: string, line: number, character: number, timeoutMs = this.timeoutMs): Promise<unknown> {
    const { uri } = await this.openFile(file);
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    }, timeoutMs);
  }

  async references(file: string, line: number, character: number, includeDeclaration = true, timeoutMs = this.timeoutMs): Promise<unknown> {
    const { uri } = await this.openFile(file);
    return this.request("textDocument/references", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      context: { includeDeclaration },
    }, timeoutMs);
  }

  async hover(file: string, line: number, character: number, timeoutMs = this.timeoutMs): Promise<unknown> {
    const { uri } = await this.openFile(file);
    return this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    }, timeoutMs);
  }

  async documentSymbols(file: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    const { uri } = await this.openFile(file);
    return this.request("textDocument/documentSymbol", { textDocument: { uri } }, timeoutMs);
  }

  async workspaceSymbols(query: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    return this.request("workspace/symbol", { query }, timeoutMs);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    this.fail(new LspUnavailableError("LSP client stopped"));
    if (!child) return;
    try {
      this.send({ id: this.nextId++, method: "shutdown" });
      this.send({ method: "exit" });
    } catch {
      /* already gone */
    }
    try { child.stdin?.end(); } catch { /* already closed */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 250).unref?.();
  }
}

/** Run a language server once and return diagnostics for the given files. */
export async function lspDiagnostics(
  root: string,
  spec: LspSpec,
  files: string[],
  timeoutMs = 8000,
): Promise<LspResult> {
  if (!spec.command.length || !files.length) return { status: "ok", diagnostics: [], stderr: "" };
  const client = new LspClient(root, spec, { timeoutMs });
  const diagnostics: LspDiagnostic[] = [];
  let status: LspStatus = "ok";
  let stderr = "";
  try {
    await client.start();
    for (const file of files) {
      try {
        diagnostics.push(...await client.diagnostic(file, timeoutMs));
      } catch (error) {
        if (error instanceof LspTimeoutError) status = "timeout";
        else {
          status = "failed";
          stderr += `${(error as Error).message}\n`;
          break;
        }
      }
    }
    if (status === "ok" && diagnostics.some((item) => item.severity === "error")) status = "failed";
  } catch (error) {
    status = error instanceof LspUnavailableError
      ? "unavailable"
      : error instanceof LspTimeoutError ? "timeout" : "failed";
    stderr += `${(error as Error).message}\n`;
  } finally {
    stderr += client.stderr();
    await client.stop();
  }
  return { status, diagnostics, stderr: stderr.slice(-4000) };
}

export function lspLanguageId(file: string): string {
  return LANGUAGE[path.extname(file)] ?? "plaintext";
}

export { LANGUAGE as LSP_LANGUAGE_IDS };
