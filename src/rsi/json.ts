/** Tolerant JSON accessors used to normalize model output. */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  return fallback;
}

export function pick<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function numRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const record = asRecord(value);
  if (!record) return out;
  for (const [key, raw] of Object.entries(record)) {
    const n = num(raw, Number.NaN);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

export function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const record = asRecord(value);
  if (!record) return out;
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export function sortedKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

/** JSON-safe deep clone with sorted object keys (deterministic serialization). */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Json).sort()) {
      out[key] = canonical((value as Json)[key]);
    }
    return out;
  }
  return value;
}

export function stableString(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Build a valid value from `raw` with an explicit fallback on any failure. */
export function parseOrDefault<T>(raw: unknown, parse: (value: unknown) => T, fallback: () => T): T {
  try {
    return parse(raw);
  } catch {
    return fallback();
  }
}
