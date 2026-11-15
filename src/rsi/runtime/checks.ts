/**
 * Target-owned deterministic checks.
 *
 * A check is a command, not a model opinion. It runs in the candidate worktree
 * after writePatch and before any GPU experiment. Language differences belong
 * to the target adapter; the core only knows CheckSpec/CheckReport.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Problem, RepoRef } from "../types.ts";
import { lspDiagnostics, type LspSpec } from "./lsp.ts";
import { ArtifactStore } from "./store.ts";

export type CheckSeverity = "required" | "advisory";

export interface CheckSpec {
  id: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutS: number;
  severity: CheckSeverity;
  paths?: string[];
}

export interface LanguageSpec {
  id: string;
  extensions: string[];
  manifests?: string[];
  checks: CheckSpec[];
  lsp?: {
    command: string[];
    root?: string;
    env?: Record<string, string>;
    severity?: CheckSeverity;
  };
}

export interface CheckResult {
  id: string;
  command: string[];
  status: "ok" | "failed" | "timeout" | "unavailable";
  severity: CheckSeverity;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_s: number;
}

export interface CheckReport {
  commit: string;
  parent: string | null;
  languages: string[];
  changed_files: string[];
  status: "ok" | "failed" | "unavailable";
  checks: CheckResult[];
  /** Immutable artifact reference for evidence/repair provenance. */
  report_path?: string;
}

export interface AdapterSpec {
  schema?: number;
  problem?: string;
  source_fixture?: string;
  protected_paths?: string[];
  mutable_paths?: string[];
  languages?: Record<string, Partial<LanguageSpec>>;
}

const BUILTIN: Record<string, LanguageSpec> = {
  python: {
    id: "python",
    extensions: [".py"],
    manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
    checks: [
      { id: "compile", command: ["python3", "-m", "compileall", "-q", "."], timeoutS: 60, severity: "required" },
      { id: "typecheck", command: ["pyright", "--outputjson"], timeoutS: 120, severity: "required" },
      { id: "lint", command: ["ruff", "check", "."], timeoutS: 60, severity: "advisory" },
      { id: "tests", command: ["pytest", "-q", "-x"], timeoutS: 300, severity: "required" },
    ],
    lsp: { command: ["pyright-langserver", "--stdio"], root: "." },
  },
  rust: {
    id: "rust",
    extensions: [".rs"],
    manifests: ["Cargo.toml", "rust-toolchain.toml"],
    checks: [
      { id: "check", command: ["cargo", "check", "--locked", "--all-targets"], timeoutS: 600, severity: "required" },
      { id: "fmt", command: ["cargo", "fmt", "--check"], timeoutS: 60, severity: "advisory" },
      { id: "clippy", command: ["cargo", "clippy", "--locked", "--all-targets", "--", "-D", "warnings"], timeoutS: 600, severity: "advisory" },
      { id: "tests", command: ["cargo", "test", "--locked"], timeoutS: 900, severity: "required" },
    ],
    lsp: { command: ["rust-analyzer"], root: "." },
  },
  go: {
    id: "go",
    extensions: [".go"],
    manifests: ["go.mod", "go.sum"],
    checks: [
      { id: "build", command: ["go", "build", "./..."], timeoutS: 300, severity: "required" },
      { id: "vet", command: ["go", "vet", "./..."], timeoutS: 300, severity: "required" },
      { id: "tests", command: ["go", "test", "./..."], timeoutS: 600, severity: "required" },
    ],
    lsp: { command: ["gopls"], root: "." },
  },
};

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Find the target manifest by problem/source_fixture; never by a fixed path. */
export function loadAdapter(repoPath: string, problem: Problem): AdapterSpec | null {
  const candidates: string[] = [];
  const generic = path.join(repoPath, ".rsi", "adapter.json");
  if (fs.existsSync(generic)) candidates.push(generic);
  const dir = path.join(repoPath, ".rsi", "adapter");
  try {
    for (const name of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
      candidates.push(path.join(dir, name));
    }
  } catch { /* no target adapter directory */ }
  const parsed = candidates.map((file) => readJson(file) as AdapterSpec | null).filter(Boolean) as AdapterSpec[];
  if (!parsed.length) return null;
  const exact = parsed.filter((item) => item.problem === problem.id);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const fixture = parsed.filter((item) => item.source_fixture && item.source_fixture.includes(problem.id));
  if (fixture.length) return fixture.length === 1 ? fixture[0] : null;
  // A generic manifest is valid only when it is the sole candidate and does not
  // claim another problem. Choosing the first of several would bind a run to an
  // arbitrary target.
  if (parsed.length === 1 && !parsed[0].problem && !parsed[0].source_fixture) return parsed[0];
  return null;
}

export function languageSpecs(adapter: AdapterSpec | null): Record<string, LanguageSpec> {
  const out: Record<string, LanguageSpec> = {};
  for (const [id, builtin] of Object.entries(BUILTIN)) {
    const override = adapter?.languages?.[id] ?? {};
    out[id] = {
      ...builtin,
      ...override,
      id,
      extensions: override.extensions ?? builtin.extensions,
      manifests: override.manifests ?? builtin.manifests,
      checks: override.checks ?? builtin.checks,
      lsp: override.lsp ?? builtin.lsp,
    };
  }
  return out;
}

export function detectLanguages(
  files: string[],
  specs: Record<string, LanguageSpec>,
): string[] {
  const out = new Set<string>();
  for (const file of files) {
    for (const [id, spec] of Object.entries(specs)) {
      if (spec.extensions.some((ext) => file.endsWith(ext))) out.add(id);
      if ((spec.manifests ?? []).includes(path.basename(file))) out.add(id);
    }
  }
  return [...out].sort();
}

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  // Toolchain homes are configuration, not credentials. Without them the
  // image's rustup/go proxies cannot find an installed compiler after HOME is
  // isolated to the check artifact directory.
  "RUSTUP_HOME",
  "CARGO_HOME",
  "RUSTUP_TOOLCHAIN",
  "GOTOOLCHAIN",
  "GOPATH",
  "GOBIN",
  "GOCACHE",
  "GOMODCACHE",
] as const;

function safeEnv(extra: Record<string, string> | undefined, home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (home) {
    // Do not expose /root/.ssh, /root/.pi or other credential-bearing homes to
    // target check commands.
    env.HOME = home;
    env.TMPDIR = path.join(home, "tmp");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  }
  return { ...env, ...(extra ?? {}) };
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function expand(command: string[], repo: RepoRef): string[] {
  return command.map((token) => token
    .replaceAll("{repo}", repo.path)
    .replaceAll("{commit}", repo.commit ?? "")
    .replaceAll("{python}", process.env.RSI_PYTHON || "python3"));
}

function applies(check: CheckSpec, changedFiles: string[]): boolean {
  if (!check.paths?.length) return true;
  return changedFiles.some((file) => check.paths!.some((glob) =>
    file === glob || file.startsWith(`${glob.replace(/\/$/, "")}/`)));
}

export function safeCheckLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "checks";
}

/** Run the selected checks and persist every result under artifacts/checks/<label>/. */
export function runChecks(
  store: ArtifactStore,
  repo: RepoRef,
  label: string,
  specs: Record<string, LanguageSpec>,
  languages: string[],
  changedFiles: string[],
): CheckReport {
  const checks: CheckResult[] = [];
  const safe = safeCheckLabel(label);
  const checkHome = path.join(store.path("checks", safe), "home");
  fs.mkdirSync(checkHome, { recursive: true });
  for (const language of languages) {
    const spec = specs[language];
    if (!spec) continue;
    for (const check of spec.checks) {
      if (!applies(check, changedFiles)) continue;
      const cwd = path.resolve(repo.path, check.cwd ?? ".");
      if (!inside(repo.path, cwd)) {
        checks.push({
          id: check.id, command: check.command, status: "failed", severity: check.severity,
          exit_code: null, stdout: "", stderr: `check cwd escapes candidate worktree: ${cwd}`, duration_s: 0,
        });
        continue;
      }
      const started = Date.now();
      const result = spawnSync(expand(check.command, repo)[0], expand(check.command, repo).slice(1), {
        cwd,
        env: safeEnv(check.env, checkHome),
        encoding: "utf8",
        timeout: Math.max(1, check.timeoutS) * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      const status: CheckResult["status"] = timedOut ? "timeout" : missing ? "unavailable" : (result.status ?? 1) === 0 ? "ok" : "failed";
      checks.push({
        id: check.id,
        command: expand(check.command, repo),
        status,
        severity: check.severity,
        exit_code: result.status ?? null,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? result.error?.message ?? ""),
        duration_s: (Date.now() - started) / 1000,
      });
    }
  }
  const required = checks.filter((check) => check.severity === "required");
  const failed = required.some((check) => check.status !== "ok");
  const status: CheckReport["status"] = failed ? "failed" : checks.length ? "ok" : "unavailable";
  const report: CheckReport = {
    commit: repo.commit ?? "",
    parent: repo.parent,
    languages,
    changed_files: changedFiles,
    status,
    checks,
    report_path: store.artifact(`checks/${safe}/report.json`),
  };
  const root = store.path("checks", safe);
  fs.mkdirSync(root, { recursive: true });
  for (const check of checks) {
    const file = path.join(root, `${safeCheckLabel(check.id)}.log`);
    fs.writeFileSync(file, `command: ${check.command.join(" ")}\nstatus: ${check.status}\nexit: ${check.exit_code}\n\n${check.stdout}\n${check.stderr}\n`, "utf8");
  }
  store.writeJson(`checks/${safe}/report.json`, report);
  return report;
}

/** Upper bound for one check job, including optional LSP diagnostics. */
export function checkTimeoutMs(
  specs: Record<string, LanguageSpec>,
  languages: string[],
  changedFiles: string[],
  lspSpecs: Record<string, LspSpec> = {},
): number {
  let total = 0;
  for (const language of languages) {
    const spec = specs[language];
    if (!spec) continue;
    for (const check of spec.checks) {
      if (applies(check, changedFiles)) total += Math.max(1, check.timeoutS) * 1000;
    }
    if (lspSpecs[language]) total += Math.max(1, changedFiles.length) * 8000 + 15_000;
  }
  return Math.min(total + 60_000, 3_600_000);
}

/**
 * Run deterministic checks and optional LSP diagnostics as one job.
 *
 * The local executor and the secret-free worker share this function, so their
 * reports and artifacts are identical. LSP stays advisory unless the target
 * adapter marks that language's server as required.
 */
export async function runCheckJob(
  store: ArtifactStore,
  repo: RepoRef,
  label: string,
  specs: Record<string, LanguageSpec>,
  languages: string[],
  changedFiles: string[],
  lspSpecs: Record<string, LspSpec> = {},
): Promise<CheckReport> {
  const report = runChecks(store, repo, label, specs, languages, changedFiles);
  const safe = safeCheckLabel(label);
  const checkHome = store.path("checks", safe, "home");
  fs.mkdirSync(path.join(checkHome, "tmp"), { recursive: true });
  for (const language of languages) {
    const lsp = lspSpecs[language];
    if (!lsp) continue;
    const started = Date.now();
    const result = await lspDiagnostics(repo.path, {
      ...lsp,
      env: { ...(lsp.env ?? {}), HOME: checkHome, TMPDIR: path.join(checkHome, "tmp") },
    }, changedFiles);
    const severity = lsp.severity ?? "advisory";
    report.checks.push({
      id: `lsp-${language}`,
      command: lsp.command,
      status: result.status === "ok" ? "ok" : result.status,
      severity,
      exit_code: null,
      stdout: "",
      stderr: result.stderr,
      duration_s: (Date.now() - started) / 1000,
    });
    if (severity === "required" && result.status !== "ok") report.status = "failed";
    store.writeText(`checks/${safe}/lsp-${language}.log`, JSON.stringify(result, null, 2));
  }
  report.report_path = store.artifact(`checks/${safe}/report.json`);
  store.writeJson(`checks/${safe}/report.json`, report);
  return report;
}

export { BUILTIN };
