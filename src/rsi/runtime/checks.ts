/**
 * Target-owned deterministic checks.
 *
 * A check is a command, not a model opinion. It runs in the candidate worktree
 * after writePatch and before any GPU experiment. Language differences belong
 * to the target adapter; the core only knows CheckSpec/CheckReport.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Problem, RepoRef } from "../types.ts";
import { ArtifactStore } from "./store.ts";
import { matchesProtected, protectedPattern } from "./protections.ts";

export type CheckSeverity = "required" | "advisory";

export interface CheckSpec {
  id: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutS: number;
  severity: CheckSeverity;
  paths?: string[];
  kind?: "syntax" | "test";
}

export interface LanguageSpec {
  id: string;
  extensions: string[];
  manifests?: string[];
  checks: CheckSpec[];
  /** Target-owned Python interpreter, relative to the target repository. */
  python?: string;
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
  kind?: "syntax" | "test";
  executed_tests?: string[];
  language?: string;
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
  environment_fingerprint?: string;
}

export interface AdapterSpec {
  schema?: number;
  problem?: string;
  source_fixture?: string;
  protected_paths?: string[];
  mutable_paths?: string[];
  /** Runs in the experiment session before the first target command. */
  preflight?: string[];
  languages?: Record<string, Partial<LanguageSpec>>;
}

const BUILTIN: Record<string, LanguageSpec> = {
  python: {
    id: "python",
    extensions: [".py"],
    manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
    checks: [
      { id: "compile", command: ["{python}", "-m", "py_compile", "{changed_python_files}"], timeoutS: 60, severity: "required" },
      { id: "tests", command: ["{python}", "-m", "pytest", "-q", "-x"], timeoutS: 300, severity: "required" },
    ],
  },
  rust: {
    id: "rust",
    extensions: [".rs"],
    manifests: ["Cargo.toml", "rust-toolchain.toml"],
    checks: [
      { id: "tests", command: ["cargo", "test", "--locked", "--all-targets"], timeoutS: 900, severity: "required" },
    ],
  },
  go: {
    id: "go",
    extensions: [".go"],
    manifests: ["go.mod", "go.sum"],
    checks: [
      { id: "tests", command: ["go", "test", "-v", "./..."], timeoutS: 600, severity: "required" },
    ],
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
      id,
      extensions: override.extensions ?? builtin.extensions,
      manifests: override.manifests ?? builtin.manifests,
      checks: (override.checks ?? builtin.checks).filter((check) =>
        !["pyright", "pyright-langserver", "gopls", "rust-analyzer"].includes(path.basename(check.command[0] ?? ""))),
      python: override.python ?? builtin.python,
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

function resolveCheckPython(repo: RepoRef, spec: LanguageSpec): string {
  if (!spec.python) return process.env.RSI_PYTHON || "python3";
  if (path.isAbsolute(spec.python)) return spec.python;
  // The adapter lives in the source checkout. Candidate worktrees do not
  // contain its untracked test venv, so resolve relative paths against the
  // canonical target repository, not the candidate checkout.
  return path.resolve(repo.repo ?? repo.path, spec.python);
}

function expand(command: string[], repo: RepoRef, python: string, changedFiles: string[]): string[] {
  const expanded = command.flatMap((token) => token === "{changed_python_files}"
    ? changedFiles.filter((file) => file.endsWith(".py") && fs.existsSync(path.join(repo.path, file)))
    : [token]);
  return expanded.map((token) => token
    .replaceAll("{repo}", repo.path)
    .replaceAll("{commit}", repo.commit ?? "")
    .replaceAll("{python}", python));
}

/** Probe the actual executor and installed target dependencies before cache lookup. */
export function checkEnvironment(repo: RepoRef, specs: Record<string, LanguageSpec>, languages: string[]): string | undefined {
  const material: unknown[] = [process.version, process.platform, process.arch];
  try {
    for (const language of languages) {
      const spec = specs[language];
      const python = resolveCheckPython(repo, spec);
      if (language === "python") {
        const probe = spawnSync(python, ["-c", [
          "import importlib.metadata as m, json, sys, os",
          "items = []",
          "for d in m.distributions():",
          " files = []",
          " for f in d.files or []:",
          "  if '__pycache__' in f.parts or f.suffix in ('.pyc', '.pyo'): continue",
          "  p = d.locate_file(f)",
          "  if p.is_file():",
          "   s = p.stat(); files.append((str(f), s.st_size, s.st_mtime_ns))",
          " items.append((d.metadata.get('Name', ''), d.version, sorted(files)))",
          "print(json.dumps([sys.version, sys.executable, sorted(items)]))",
        ].join("\n")], { encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
        if (probe.status !== 0 || !probe.stdout.trim()) return undefined;
        material.push(JSON.parse(probe.stdout));
      }
      for (const check of spec.checks) {
        const binary = check.command[0]?.replaceAll("{python}", python);
        if (!binary) return undefined;
        const searchPath = check.env?.PATH ?? process.env.PATH ?? "";
        const file = binary.includes(path.sep) ? path.resolve(repo.path, binary)
          : searchPath.split(path.delimiter).map((dir) => path.join(dir, binary)).find((candidate) => fs.existsSync(candidate));
        if (!file) return undefined;
        const stat = fs.statSync(fs.realpathSync(file));
        material.push([file, stat.size, stat.mtimeMs, check.env ?? {}]);
      }
    }
    return createHash("sha256").update(JSON.stringify(material)).digest("hex");
  } catch { return undefined; }
}

function applies(check: CheckSpec, changedFiles: string[]): boolean {
  if (!check.paths?.length) return true;
  return changedFiles.some((file) => check.paths!.some((glob) =>
    matchesProtected(file, protectedPattern(glob))));
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
  probeOnly = false,
): CheckReport {
  const environment = checkEnvironment(repo, specs, languages);
  const checks: CheckResult[] = [];
  const safe = safeCheckLabel(label);
  const checkHome = path.join(store.path("checks", safe), "home");
  fs.mkdirSync(checkHome, { recursive: true });
  checksLoop: for (const language of probeOnly ? [] : languages) {
    const spec = specs[language];
    if (!spec) continue;
    const python = resolveCheckPython(repo, spec);
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
      if (check.command.includes("{changed_python_files}") && !changedFiles.some((file) =>
        file.endsWith(".py") && fs.existsSync(path.join(repo.path, file)))) continue;
      const command = expand(check.command, repo, python, changedFiles);
      const testReport = path.join(store.path("checks", safe), `${safeCheckLabel(check.id)}.junit.xml`);
      const pytest = command.some((token) => path.basename(token) === "pytest");
      if (pytest) {
        fs.rmSync(testReport, { force: true });
        command.push(`--junitxml=${testReport}`, "-o", "junit_family=legacy");
      }
      const started = Date.now();
      const result = spawnSync(command[0], command.slice(1), {
        cwd,
        env: { ...safeEnv(check.env, checkHome), PYTHONPATH: [repo.path, path.join(repo.path, "src"), check.env?.PYTHONPATH].filter(Boolean).join(path.delimiter) },
        encoding: "utf8",
        timeout: Math.max(1, check.timeoutS) * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      let status: CheckResult["status"] = timedOut ? "timeout" : missing ? "unavailable" : (result.status ?? 1) === 0 ? "ok" : "failed";
      let executedTests: string[] | undefined;
      if (pytest && status === "ok") {
        const parsed = spawnSync(python, ["-c",
          "import json,sys,xml.etree.ElementTree as e; print(json.dumps([str(t.get('file',''))+':'+str(t.get('name','')) for t in e.parse(sys.argv[1]).iter('testcase') if t.find('skipped') is None]))", testReport],
        { encoding: "utf8", timeout: 10000 });
        try { executedTests = JSON.parse(parsed.stdout); } catch { executedTests = []; }
        if (parsed.status !== 0 || !executedTests?.length) status = "unavailable";
      }
      if (language === "rust" && command[1] === "test" && status === "ok") {
        executedTests = [...String(result.stdout).matchAll(/^test (.+) \.\.\. ok$/gm)].map((match) => match[1]);
        if (!executedTests.length) status = "unavailable";
      }
      if (language === "go" && command[1] === "test" && status === "ok") {
        executedTests = [...String(result.stdout).matchAll(/^--- PASS: (\S+)/gm)].map((match) => match[1]);
        if (!executedTests.length) status = "unavailable";
      }
      checks.push({
        id: check.id,
        command,
        status,
        severity: check.severity,
        exit_code: result.status ?? null,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? result.error?.message ?? ""),
        duration_s: (Date.now() - started) / 1000,
        kind: check.kind ?? (/^(compile|syntax|typecheck|lint|fmt|clippy|vet|build|check)$/.test(check.id) ||
          command.includes("py_compile") || command.includes("compileall") ? "syntax" : "test"),
        executed_tests: executedTests,
        language,
      });
      if (check.severity === "required" && status !== "ok") break checksLoop;
    }
  }
  const required = checks.filter((check) => check.severity === "required");
  const failed = required.some((check) => check.status !== "ok");
  const missingTests = languages.filter((language) => !required.some((check) => check.language === language && check.kind === "test" && check.status === "ok"));
  const status: CheckReport["status"] = failed ? "failed" : !probeOnly && languages.length > 0 && !missingTests.length ? "ok" : "unavailable";
  if (!failed && !probeOnly && missingTests.length) checks.push({ id: "required-tests", command: [], severity: "required", status: "unavailable",
    exit_code: null, stdout: "", stderr: `required dynamic tests are missing for: ${missingTests.join(", ")}`, duration_s: 0 });
  const report: CheckReport = {
    commit: repo.commit ?? "",
    parent: repo.parent,
    languages,
    changed_files: changedFiles,
    status,
    checks,
    environment_fingerprint: environment,
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

/** Upper bound for one target-owned check job. */
export function checkTimeoutMs(
  specs: Record<string, LanguageSpec>,
  languages: string[],
  changedFiles: string[],
): number {
  let total = 0;
  for (const language of languages) {
    for (const check of specs[language]?.checks ?? []) {
      if (applies(check, changedFiles)) total += Math.max(1, check.timeoutS) * 1000;
    }
  }
  return Math.min(total + 60_000, 3_600_000);
}

/** Run the target's module and dynamic checks in their declared order. */
export async function runCheckJob(
  store: ArtifactStore,
  repo: RepoRef,
  label: string,
  specs: Record<string, LanguageSpec>,
  languages: string[],
  changedFiles: string[],
  probeOnly = false,
): Promise<CheckReport> {
  return runChecks(store, repo, label, specs, languages, changedFiles, probeOnly);
}

export { BUILTIN };
