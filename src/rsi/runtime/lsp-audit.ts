/**
 * Static changed-symbol reference audit.
 *
 * This is the fail-fast phase before the target checks: it opens the clean
 * candidate files, finds symbols that intersect the diff's added lines, and
 * asks the language server for references. It proves only static reachability;
 * CheckRunner remains the dynamic-execution gate.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CheckResult } from "./checks.ts";
import { LspClient, LspTimeoutError, LspUnavailableError, type LspSpec } from "./lsp.ts";

/** Cap the number of changed symbols queried per language. */
export const LSP_AUDIT_MAX_SYMBOLS = 24;
/** Cap project files opened so pyright can resolve cross-file references. */
export const LSP_AUDIT_MAX_FILES = 300;

export interface LineRange {
  /** 1-based inclusive first added line. */
  start: number;
  /** 1-based inclusive last added line. */
  end: number;
}

export type ChangedLines = Map<string, LineRange[]>;

interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

interface SymbolNode {
  name: string;
  range: Range;
  selectionRange?: Range;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function position(value: unknown): Position | null {
  const record = object(value);
  if (!record) return null;
  const line = number(record.line);
  const character = number(record.character);
  if (line === null || character === null) return null;
  return { line, character };
}

function range(value: unknown): Range | null {
  const record = object(value);
  if (!record) return null;
  const start = position(record.start);
  const end = position(record.end);
  return start && end ? { start, end } : null;
}

function flattenSymbols(value: unknown, out: SymbolNode[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = object(item);
    if (!record) continue;
    const name = typeof record.name === "string" ? record.name : "";
    const own = range(record.range);
    const location = object(record.location);
    const located = range(location?.range);
    const span = own ?? located;
    if (!name || !span) continue;
    out.push({
      name,
      range: span,
      selectionRange: range(record.selectionRange) ?? undefined,
    });
    flattenSymbols(record.children, out);
  }
}

function intersects(symbol: Range, ranges: LineRange[]): boolean {
  const start = symbol.start.line + 1;
  const end = symbol.end.line + 1;
  return ranges.some((line) => start <= line.end && end >= line.start);
}

function referenceCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return value ? 1 : 0;
}

/**
 * pyright-langserver resolves cross-file references only for files it has
 * opened; rust-analyzer and gopls usually index the workspace themselves.
 * Open tracked source files of the same extensions before querying references.
 */
function sourceFiles(root: string, extensions: Set<string>): string[] {
  if (!extensions.size) return [];
  const listed = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (listed.status !== 0) return [];
  return String(listed.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file && extensions.has(path.extname(file)))
    .slice(0, LSP_AUDIT_MAX_FILES);
}

/**
 * Some servers accept a reference request only when the position is inside the
 * identifier, not exactly at its first character. Try the requested position,
 * then one character into a multi-character name. `LspClient` takes 1-based
 * positions and converts them to the 0-based LSP position.
 */
async function hasReferences(
  client: LspClient,
  file: string,
  line: number,
  character: number,
  timeoutMs: number,
): Promise<{ count: number; error?: Error }> {
  // Servers disagree about whether the position must be the first identifier
  // character, an interior character, or the token boundary. Try the token
  // boundary and its neighbors; all positions are inside the same declaration.
  const offsets = [-1, 0, 1, 2];
  let lastError: Error | undefined;
  let responded = false;
  for (const offset of offsets) {
    try {
      const refs = await client.references(file, line + 1, character + 1 + offset, false, timeoutMs);
      responded = true;
      if (referenceCount(refs) > 0) return { count: referenceCount(refs) };
    } catch (error) {
      lastError = error as Error;
    }
  }
  return { count: 0, error: responded ? undefined : lastError };
}

/**
 * A `SymbolInformation` response has no selectionRange; its range often starts
 * at `def`/`func` rather than the identifier. Find the identifier on the
 * declaration line so references are requested at a valid LSP position.
 */
function symbolPosition(root: string, file: string, symbol: SymbolNode): Position {
  if (symbol.selectionRange) return symbol.selectionRange.start;
  try {
    const lines = fs.readFileSync(path.resolve(root, file), "utf8").split(/\r?\n/);
    const first = Math.max(0, symbol.range.start.line);
    const last = Math.min(lines.length - 1, symbol.range.end.line);
    for (let line = first; line <= last; line += 1) {
      const character = lines[line].indexOf(symbol.name);
      if (character >= 0) return { line, character };
    }
  } catch {
    /* fall back to the symbol range */
  }
  return symbol.range.start;
}

/**
 * Parse the added-line ranges of a candidate diff. Deletions have no new line
 * to inspect; the resulting symbol shift is still represented by neighboring
 * added lines when git emits them.
 */
export function changedLineRanges(repoPath: string, parent: string | null, commit: string | null): ChangedLines {
  const out: ChangedLines = new Map();
  if (!parent || !commit) return out;
  const diff = spawnSync("git", [
    "-C", repoPath, "diff", "--unified=0", "--no-color", "--no-ext-diff", parent, commit,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (diff.status !== 0) return out;
  let file = "";
  for (const line of String(diff.stdout ?? "").split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length).trim();
      continue;
    }
    if (!file || !line.startsWith("@@")) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count <= 0) continue;
    const list = out.get(file) ?? [];
    list.push({ start, end: start + count - 1 });
    out.set(file, list);
  }
  return out;
}

function statusOf(error: unknown): CheckResult["status"] {
  if (error instanceof LspTimeoutError) return "timeout";
  if (error instanceof LspUnavailableError) return "unavailable";
  return "failed";
}

/**
 * Audit changed symbols in one language. Returns null when no changed line has
 * a symbol to inspect, so a config-only diff is not reported as a static pass.
 */
export async function lspReferenceAudit(
  root: string,
  spec: LspSpec,
  language: string,
  files: string[],
  changed: ChangedLines,
  timeoutMs = 8000,
): Promise<CheckResult | null> {
  const targets = files.filter((file) => {
    const ranges = changed.get(file);
    return !!ranges?.length;
  });
  if (!targets.length) return null;
  const started = Date.now();
  const client = new LspClient(root, spec, { timeoutMs });
  let status: CheckResult["status"] = "ok";
  let changedSymbols = 0;
  let referenced = 0;
  const unreferenced: string[] = [];
  const errors: string[] = [];
  try {
    await client.start();
    const extensions = new Set(targets.map((file) => path.extname(file)).filter(Boolean));
    for (const file of sourceFiles(root, extensions)) {
      try {
        await client.openFile(file);
      } catch {
        /* a large or unreadable source file must not abort the audit */
      }
    }
    for (const file of targets) {
      if (changedSymbols >= LSP_AUDIT_MAX_SYMBOLS) break;
      const ranges = changed.get(file) ?? [];
      let symbols: unknown;
      try {
        symbols = await client.documentSymbols(file, timeoutMs);
      } catch (error) {
        status = statusOf(error);
        errors.push(`${file}: ${(error as Error).message}`);
        break;
      }
      const flat: SymbolNode[] = [];
      flattenSymbols(symbols, flat);
      const touched = flat.filter((symbol) => intersects(symbol.range, ranges));
      for (const symbol of touched) {
        if (changedSymbols >= LSP_AUDIT_MAX_SYMBOLS) break;
        changedSymbols += 1;
        const at = symbolPosition(root, file, symbol);
        const found = await hasReferences(client, file, at.line, at.character, timeoutMs);
        if (found.error) {
          status = statusOf(found.error);
          errors.push(`${file}:${at.line + 1}: ${found.error.message}`);
          break;
        }
        if (found.count > 0) referenced += 1;
        else unreferenced.push(`${file}:${at.line + 1}:${symbol.name}`);
      }
      if (status !== "ok") break;
    }
  } catch (error) {
    status = statusOf(error);
    errors.push((error as Error).message);
  } finally {
    await client.stop();
  }
  if (status === "ok" && unreferenced.length) status = "failed";
  const stderr = [...errors, ...(unreferenced.length ? [`unreferenced changed symbols: ${unreferenced.join(", ")}`] : [])]
    .join("\n")
    .slice(-4000);
  return {
    id: `lsp-references-${language}`,
    command: spec.command,
    status,
    severity: spec.referenceSeverity ?? "advisory",
    exit_code: null,
    stdout: JSON.stringify({
      language,
      changed_symbols: changedSymbols,
      referenced_symbols: referenced,
      unreferenced_symbols: unreferenced,
      files: targets,
    }, null, 2),
    stderr: `${stderr}${stderr ? "\n" : ""}${client.stderr()}`.slice(-4000),
    duration_s: (Date.now() - started) / 1000,
  };
}
