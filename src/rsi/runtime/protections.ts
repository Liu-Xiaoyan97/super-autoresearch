import path from "node:path";

export function protectedPattern(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`protected path must be repo-relative: ${value}`);
  }
  return normalized;
}

export function matchesProtected(file: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return file === pattern || file.startsWith(`${pattern}/`);
  // Small, dependency-free glob matcher. ** spans directories; * does not.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\u0001").replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*").replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*").replaceAll("\u0001", "(?:.*/)?");
  return new RegExp(`^${escaped}$`).test(file);
}

