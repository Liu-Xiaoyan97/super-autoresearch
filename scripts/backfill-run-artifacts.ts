#!/usr/bin/env node
/**
 * Backfill the restart-safety artifacts for runs that finished before those
 * mechanisms existed:
 *
 *   - `artifacts/candidates.jsonl`: one line per measured (idea, commit, seed)
 *   - `runs/.rsi-cache/measurements/<key>.json`: reusable measurements
 *
 * Every number is copied from the run's own recorded state; nothing is
 * re-measured and nothing is invented. Entries are only written for samples
 * that carry finite metrics, so failed runs never become cache hits.
 *
 *   node scripts/backfill-run-artifacts.ts runs/<run_id> [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";

import { subsetBudgetEnv, MeasurementCache, measurementKey, measurementParts } from "../src/rsi/runtime/workspace.ts";
import { defaultConfig, type Config } from "../src/rsi/config.ts";

export interface BackfillSummary {
  run: string;
  ledger: string;
  ledgerRows: number;
  cacheRoot: string;
  cacheWrites: number;
  cacheHitsExisting: number;
  skipped: number;
}

interface Evidence {
  idea_id: string;
  scope: string;
  label: string;
  metrics: Record<string, number>;
  baseline_metrics: Record<string, number>;
  code?: { commit?: string; parent?: string | null } | null;
  samples?: Array<{ seed: number; metrics: Record<string, number> }>;
}

export function backfillRun(runDir: string, opts: { dryRun?: boolean } = {}): BackfillSummary {
  const root = path.resolve(runDir);
  const stateFile = path.join(root, "state.json");
  if (!fs.existsSync(stateFile)) throw new Error(`no state.json in ${root}`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    problem: Record<string, unknown>;
    config: Record<string, unknown>;
    traces?: Array<{ idea?: { id?: string }; round?: number; evidence?: Evidence[]; decision?: string }>;
    checkpoints?: Record<string, { stage?: string; verdict?: { decision?: string; feedback?: string } }>;
  };
  const config = defaultConfig(state.config as Partial<Config>);
  const problem = state.problem as unknown as Parameters<typeof subsetBudgetEnv>[0];
  const outDir = path.resolve(String((state.config as { outDir?: string }).outDir ?? "runs"));
  const cacheRoot = path.join(outDir, ".rsi-cache", "measurements");
  const ledger = path.join(root, "artifacts", "candidates.jsonl");

  const rows: Array<Record<string, unknown>> = [];
  let cacheWrites = 0;
  let cacheHitsExisting = 0;
  let skipped = 0;

  for (const trace of state.traces ?? []) {
    const ideaId = trace.idea?.id ?? "";
    for (const evidence of trace.evidence ?? []) {
      const samples = evidence.samples?.length
        ? evidence.samples
        : [{ seed: null as unknown as number, metrics: evidence.metrics }];
      for (const sample of samples) {
        const metrics = sample.metrics ?? {};
        if (!Object.keys(metrics).length) {
          skipped += 1;
          continue;
        }
        const commit = evidence.code?.commit ?? "";
        rows.push({
          idea_id: ideaId,
          round: trace.round ?? 0,
          scope: evidence.scope,
          label: evidence.label,
          commit,
          parent: evidence.code?.parent ?? null,
          seed: sample.seed,
          metrics,
          aggregate: evidence.metrics,
          baseline_metrics: evidence.baseline_metrics,
          recovered: true,
        });

        if (!commit) {
          skipped += 1;
          continue;
        }
        const env = subsetBudgetEnv(problem, config, evidence.scope as never);
        const seedEnv = problem.budget?.seed_env;
        if (seedEnv && typeof sample.seed === "number") env[seedEnv] = String(sample.seed);
        // Same invariants the live runner hashes: one definition, two callers.
        const parts = measurementParts({
          runner: config.runner,
          problem,
          commit,
          scope: evidence.scope,
          seed: typeof sample.seed === "number" ? sample.seed : null,
          datasets: evidence.scope === "subset" ? problem.subset_datasets : problem.datasets,
          metrics: problem.metrics.map((metric) => metric.name),
          env,
        });
        const key = measurementKey(parts);
        const cache = new MeasurementCache(cacheRoot, key, parts);
        if (cache.read()) {
          cacheHitsExisting += 1;
          continue;
        }
        if (!opts.dryRun) {
          cache.write({
            metrics,
            status: "ok",
            log_path: path.join(root, "artifacts", "experiments"),
            stdout: "",
            stderr: "",
            wall_time_s: 0,
          });
          cacheWrites += 1;
        }
      }
    }
  }

  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  }
  return {
    run: path.basename(root),
    ledger,
    ledgerRows: rows.length,
    cacheRoot,
    cacheWrites,
    cacheHitsExisting,
    skipped,
  };
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  if (!args.length) {
    console.error("usage: node scripts/backfill-run-artifacts.ts <run_dir> [--dry-run]");
    process.exit(2);
  }
  for (const dir of args) console.log(JSON.stringify(backfillRun(dir, { dryRun }), null, 2));
}
