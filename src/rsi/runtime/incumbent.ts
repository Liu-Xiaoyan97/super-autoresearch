/**
 * Incumbent ledgers: the measured baseline a promotion leaves behind.
 *
 * The bounded iteration and the SOP share one format so a promoted candidate
 * can become the next run's baseline without re-running the reference. A ledger
 * is valid only for the same problem, scope, protocol, seed and metric set; the
 * commit must still exist in the target repository.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { stableString } from "../json.ts";
import type { Evidence, Problem, RepoRef } from "../types.ts";
import { makeEvidence } from "../types.ts";

export interface IncumbentLedger {
  version: 1;
  problem: string;
  scope: string;
  commit: string;
  metrics: Record<string, number>;
  protocol: unknown;
  pipeline: Record<string, unknown> | null;
  evidence: { report: string; raw: string } | null;
  evidence_sha256?: string;
  history: Array<{ commit: string; metrics: Record<string, number>; at: string }>;
}

/** The protocol identity an incumbent measurement belongs to. Seed env keys are
 * excluded because the numeric seed is its own field and per-report validated. */
export function protocolFingerprint(problem: Problem, env: Record<string, string>, seed: number, scope: string): unknown {
  const normalizedEnv = Object.fromEntries(Object.entries(env)
    .filter(([key]) => key !== "RSI_SEED" && !key.endsWith("_SEED"))
    .sort(([a], [b]) => a.localeCompare(b)));
  const metrics = problem.metrics.map((metric) => ({
    name: metric.name, dataset: metric.dataset ?? null, direction: metric.direction,
    tolerance: metric.tolerance, bounds: metric.bounds,
  })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    repo: problem.repo ? path.resolve(problem.repo) : null,
    scope,
    command: problem.experiment_command,
    env: normalizedEnv,
    seed,
    metrics,
    datasets: [...problem.subset_datasets].sort(),
    remote: problem.remote
      ? { host: problem.remote.host, dir: problem.remote.dir, python: problem.remote.python, gpu_ids: problem.remote.gpu_ids }
      : null,
  };
}

function slugOf(problem: Problem): string {
  return problem.id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "problem";
}

/**
 * One baseline store per project, shared by every RSI run. The target repo is
 * the project identity: its `.rsi/baseline` directory survives run/output
 * directories. `RSI_BASELINE_DIR` can point at an external project cache;
 * simulated problems without a repo fall back to the caller's directory.
 */
export function projectKey(problem: Problem): string {
  const repo = problem.repo ? path.resolve(problem.repo) : "";
  const digest = createHash("sha256").update(repo).digest("hex").slice(0, 12);
  return `${slugOf(problem)}-${digest}`;
}

export function projectBaselineDir(problem: Problem, fallbackDir = "."): string {
  if (problem.repo && fs.existsSync(path.resolve(problem.repo))) {
    const override = process.env.RSI_BASELINE_DIR;
    if (override) return path.join(path.resolve(override), projectKey(problem));
    return path.join(os.homedir(), ".rsi", "projects", projectKey(problem));
  }
  // No project repo (simulated fixture): keep the store next to the run output
  // so separate simulations cannot contaminate each other.
  return path.join(path.resolve(fallbackDir), ".rsi", "baseline");
}

export function incumbentFileFor(_outDir: string, problem: Problem, scope: string): string {
  return path.join(projectBaselineDir(problem, _outDir), `incumbent-${slugOf(problem)}-${scope}.json`);
}

/** Pre-project-store location, kept for migrating existing run ledgers. */
export function legacyIncumbentFileFor(outDir: string, problem: Problem, scope: string): string {
  return path.join(outDir, `incumbent-${slugOf(problem)}-${scope}.json`);
}

/** Load an incumbent only when its commit, protocol and metrics are still valid. */
export function loadIncumbent(
  file: string,
  problem: Problem,
  expected: unknown,
  scope: string,
): { ledger: IncumbentLedger; note: string } | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as IncumbentLedger;
    if (raw.version !== 1 || raw.problem !== problem.id) return null;
    if (raw.scope !== scope) return null;
    if (stableString(raw.protocol) !== stableString(expected)) return null;
    if (!/^[0-9a-f]{40}$/i.test(raw.commit)) return null;
    const names = problem.metrics.map((metric) => metric.name).sort();
    if (stableString(Object.keys(raw.metrics ?? {}).sort()) !== stableString(names)) return null;
    if (!names.every((name) => typeof raw.metrics[name] === "number" && Number.isFinite(raw.metrics[name]))) return null;
    // A ledger is local state, not a signature. Bind its numbers to the stored
    // report when that report exists, and keep physical bounds authoritative.
    for (const spec of problem.metrics) {
      const value = raw.metrics[spec.name];
      if (spec.bounds && (value < spec.bounds[0] || value > spec.bounds[1])) return null;
    }
    if (raw.evidence_sha256 && raw.evidence?.report && fs.existsSync(raw.evidence.report)) {
      const digest = createHash("sha256").update(fs.readFileSync(raw.evidence.report)).digest("hex");
      if (digest !== raw.evidence_sha256) return null;
    }
    if (problem.repo) {
      const exists = spawnSync("git", ["-C", problem.repo, "cat-file", "-e", `${raw.commit}^{commit}`], { encoding: "utf8" });
      if (exists.status !== 0) return null;
    }
    return { ledger: raw, note: `reusing incumbent ${raw.commit}` };
  } catch {
    return null;
  }
}

export function writeIncumbent(file: string, ledger: IncumbentLedger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export interface BaselineSeed {
  scope: "subset" | "full";
  evidence: Evidence;
  source: "incumbent" | "manual" | "promoted";
  path: string;
}

/** Build the baseline evidence a reused ledger represents. */
export function evidenceFromLedger(problem: Problem, scope: "subset" | "full", ledger: IncumbentLedger, pathUsed: string, source: BaselineSeed["source"]): Evidence {
  const code: RepoRef = {
    path: problem.repo ? path.resolve(problem.repo) : "",
    label: `baseline-${source}`,
    parent: null,
    patch: "",
    repo: problem.repo ?? undefined,
    commit: ledger.commit,
    branch: "detached",
  };
  return makeEvidence({
    idea_id: "baseline",
    scope,
    metrics: ledger.metrics,
    code,
    result: {
      metrics: ledger.metrics,
      status: "ok",
      log_path: ledger.evidence?.report ?? pathUsed,
      stdout: `reused ${source} baseline ${ledger.commit}`,
      stderr: "",
      wall_time_s: 0,
    },
    label: code.label,
  });
}

export interface ManualBaseline {
  commit: string;
  metrics: Record<string, number>;
  scope?: "subset" | "full";
  note?: string;
}

/**
 * A person can point at a trusted baseline JSON. Unlike the automatic ledger,
 * this is an explicit decision: the protocol does not have to match, but the
 * commit, metric names and finite values are still checked.
 */
export function loadManualBaseline(file: string, problem: Problem): ManualBaseline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<IncumbentLedger> & Partial<ManualBaseline>;
    const commit = String(raw.commit ?? "");
    if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
    const metrics = raw.metrics ?? {};
    const names = problem.metrics.map((metric) => metric.name).sort();
    if (stableString(Object.keys(metrics).sort()) !== stableString(names)) return null;
    if (!names.every((name) => typeof metrics[name] === "number" && Number.isFinite(metrics[name]))) return null;
    if (problem.repo) {
      const exists = spawnSync("git", ["-C", problem.repo, "cat-file", "-e", `${commit}^{commit}`], { encoding: "utf8" });
      if (exists.status !== 0) return null;
    }
    const scope = raw.scope === "subset" || raw.scope === "full" ? raw.scope : undefined;
    return { commit, metrics, scope, note: raw.note };
  } catch {
    return null;
  }
}

/** Ledger view of an evidence that was just promoted inside a run. */
export function ledgerFromEvidence(
  problem: Problem,
  scope: "subset" | "full",
  evidence: Evidence,
  protocol: unknown,
  history: IncumbentLedger["history"],
): IncumbentLedger | null {
  const commit = evidence.code?.commit;
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) return null;
  const report = evidence.result?.log_path ?? "";
  const raw = evidence.code?.patch ? "" : "";
  return {
    version: 1,
    problem: problem.id,
    scope,
    commit,
    metrics: evidence.metrics,
    protocol,
    pipeline: null,
    evidence: report ? { report, raw } : null,
    evidence_sha256: report && fs.existsSync(report)
      ? createHash("sha256").update(fs.readFileSync(report)).digest("hex")
      : undefined,
    history,
  };
}

export interface RunBaselineSeeds {
  subset: BaselineSeed | null;
  full: BaselineSeed | null;
  source: BaselineSeed["source"] | null;
  path: string;
}

/**
 * Load the baselines a new run may reuse. An explicit path is a person's
 * decision and is accepted after commit/metric validation; otherwise only a
 * scope- and protocol-matching incumbent ledger is reused. Missing scopes stay
 * null so the SOP reproduces exactly what is absent.
 */
export function loadRunBaselines(
  problem: Problem,
  outDir: string,
  seed: number,
  explicitPath?: string,
): RunBaselineSeeds {
  const result: RunBaselineSeeds = { subset: null, full: null, source: null, path: "" };
  if (explicitPath) {
    const file = path.resolve(explicitPath);
    const manual = loadManualBaseline(file, problem);
    if (!manual) throw new Error(`baseline file is invalid or its commit/metrics do not match: ${file}`);
    const scopes: Array<"subset" | "full"> = manual.scope ? [manual.scope] : ["subset", "full"];
    for (const scope of scopes) {
      const ledger: IncumbentLedger = {
        version: 1, problem: problem.id, scope, commit: manual.commit, metrics: manual.metrics,
        protocol: null, pipeline: null, evidence: null, history: [],
      };
      result[scope] = {
        scope,
        evidence: evidenceFromLedger(problem, scope, ledger, file, "manual"),
        source: "manual",
        path: file,
      };
    }
    result.source = "manual";
    result.path = file;
  }
  for (const scope of ["subset", "full"] as const) {
    if (result[scope]) continue;
    const file = incumbentFileFor(outDir, problem, scope);
    const expected = protocolFingerprint(problem, problem.remote?.env ?? {}, seed, scope);
    let used = file;
    let loaded = loadIncumbent(file, problem, expected, scope);
    if (!loaded) {
      // Migrate a ledger written by an older run under its output directory.
      const legacy = legacyIncumbentFileFor(outDir, problem, scope);
      loaded = loadIncumbent(legacy, problem, expected, scope);
      if (loaded) {
        try {
          writeIncumbent(file, loaded.ledger);
          used = file;
        } catch {
          used = legacy;
        }
      }
    }
    if (!loaded) continue;
    result[scope] = {
      scope,
      evidence: evidenceFromLedger(problem, scope, loaded.ledger, used, "incumbent"),
      source: "incumbent",
      path: used,
    };
    if (!result.source) {
      result.source = "incumbent";
      result.path = file;
    }
  }
  return result;
}
