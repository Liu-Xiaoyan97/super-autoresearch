/** Append-only artifact + trace persistence (reproducibility, invariant I8). */

import fs from "node:fs";
import path from "node:path";

export function asJsonable(value: unknown): unknown {
  if (value instanceof Error) return { error: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(asJsonable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = asJsonable(item);
    return out;
  }
  return value;
}

export function jsonText(value: unknown): string {
  return JSON.stringify(asJsonable(value), null, 2);
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(path.join(this.root, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "patches"), { recursive: true });
  }

  path(...parts: string[]): string {
    const file = path.join(this.root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  }

  artifact(rel: string): string {
    return this.path("artifacts", rel);
  }

  writeText(rel: string, text: string): string {
    const file = this.artifact(rel);
    fs.writeFileSync(file, text, "utf8");
    return file;
  }

  writeJson(rel: string, value: unknown): string {
    return this.writeText(rel, jsonText(value));
  }

  readJson(rel: string): unknown {
    return JSON.parse(fs.readFileSync(this.artifact(rel), "utf8"));
  }

  readText(rel: string): string {
    return fs.readFileSync(this.artifact(rel), "utf8");
  }
}

export interface TraceRecord {
  seq: number;
  kind: string;
  ts: number;
  data: unknown;
  [key: string]: unknown;
}

export class TraceStore {
  readonly path: string;
  private seq = 0;

  constructor(file: string) {
    this.path = path.resolve(file);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (fs.existsSync(this.path)) {
      this.seq = fs
        .readFileSync(this.path, "utf8")
        .split("\n")
        .filter((line) => line.trim()).length;
    }
  }

  append(kind: string, data: unknown, extra: Record<string, unknown> = {}): TraceRecord {
    this.seq += 1;
    const record: TraceRecord = {
      seq: this.seq,
      kind,
      ts: Date.now() / 1000,
      data: asJsonable(data),
      ...(asJsonable(extra) as Record<string, unknown>),
    } as TraceRecord;
    fs.appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  readAll(): TraceRecord[] {
    if (!fs.existsSync(this.path)) return [];
    return fs
      .readFileSync(this.path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TraceRecord);
  }

  kinds(): string[] {
    return this.readAll().map((record) => record.kind);
  }
}
