/**
 * Static changed-symbol reference audit.
 *
 * This is the fail-fast phase before the target checks: it opens the clean
 * candidate files, finds symbols that intersect the diff's added lines, and
 * asks the language server for references. It proves only static reachability;
 * CheckRunner remains the dynamic-execution gate.
 */
import { spawnSync } from "node:child_process";

import type { CheckResult } from "./checks.ts";
import { LspClient, LspTimeoutError, LspUnavailableError, type LspSpec } from "./lsp.ts";

/** Cap the number of changed symbols queried per language. */
export const LSP_AUDIT_MAX_SYMBOLS = 24;

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
        const at = symbol.selectionRange?.start ?? symbol.range.start;
        try {
          const refs = await client.references(file, at.line + 1, at.character + 1, false, timeoutMs);
          if (referenceCount(refs) > 0) referenced += 1;
          else unreferenced.push(`${file}:${at.line + 1}:${symbol.name}`);
        } catch (error) {
          status = statusOf(error);
          errors.push(`${file}:${at.line + 1}: ${(error as Error).message}`);
          break;
        }
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
