#!/usr/bin/env node
/** Offline-first CLI: run, inspect, replay. The Pi extension exposes the same API. */

import path from "node:path";

import { OpenAICompatProvider } from "./providers/openai.ts";
import {
  type RunOptions,
  inspectRun,
  listRuns,
  loadScript,
  replayRun,
  runResearch,
} from "./run.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function flagString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function flagNumber(args: Args, ...names: string[]): number | undefined {
  const value = flagString(args, ...names);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function printSummary(result: Awaited<ReturnType<typeof runResearch>>): void {
  const s = result.summary as any;
  console.log(`Run: ${result.runId} (${result.final.extra.accepted ? "accepted" : "exported incumbent"})`);
  console.log(`Limitations: ${s.limitations}; seeds: ${s.seeds}`);
  for (const round of s.rounds as Array<{ round: number; idea: string; decision: string }>) {
    console.log(`  round ${round.round}: ${round.idea} ${round.decision}`);
  }
  console.log(`h_best: ${s.h_best ?? "none"}`);
  console.log(`Ablation verdict: ${s.ablation_verdict ?? "none"}`);
  console.log(`Review scores: ${(s.review_scores as number[]).join(", ") || "none"}`);
  console.log(`Meta decision: ${s.meta_decision ?? "none"}`);
  console.log(`Decision path: ${result.final.decision_path.join(" -> ")}`);
  if (result.final.aborted) console.log(`ABORTED: ${result.final.abort_reason}`);
  console.log(`Artifacts: ${path.join(result.root, "state.json")}, ${path.join(result.root, "traces.jsonl")}, ${path.join(result.root, "final.json")}`);
}

function usage(): void {
  console.log(
    [
      "usage:",
      "  rsi run <problem.json> [--mock] [--script file.json] [--provider opencode]",
      "          [--model ID] [--out runs] [--seed 7] [--runner simulated|subprocess]",
      "          [--max-refine-rounds N] [--max-review-refinements N] [--strict-directions]",
      "  rsi inspect <run_id> [--out runs]",
      "  rsi replay <run_id> [--out runs]",
      "  rsi list [--out runs]",
      "  rsi models",
    ].join("\n"),
  );
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const outDir = flagString(args, "out") ?? "runs";
  switch (args.command) {
    case "run": {
      const fixture = args.positional[0];
      if (!fixture) {
        usage();
        return 2;
      }
      const mock = Boolean(args.flags.mock) || flagString(args, "provider") === "mock";
      const providerName = flagString(args, "provider") ?? (mock ? "mock" : "opencode");
      if (!mock && providerName === "mock") {
        usage();
        return 2;
      }
      const opts: RunOptions = {
        problem: fixture,
        outDir,
        seed: flagNumber(args, "seed"),
        runner: (flagString(args, "runner") as RunOptions["runner"]) ?? "simulated",
        mock,
        model: flagString(args, "model"),
        strictDirections: Boolean(args.flags["strict-directions"]),
        maxRefineRounds: flagNumber(args, "max-refine-rounds"),
        maxReviewRefinements: flagNumber(args, "max-review-refinements"),
      };
      if (args.flags.script) opts.mockScript = loadScript(String(args.flags.script));
      if (!mock) {
        opts.provider = new OpenAICompatProvider({
          baseUrl: flagString(args, "base-url"),
          apiKeyEnv: flagString(args, "api-key-env"),
          model: opts.model,
        });
      }
      const result = await runResearch(opts);
      printSummary(result);
      return result.final.aborted ? 2 : 0;
    }
    case "inspect": {
      const runId = args.positional[0];
      if (!runId) {
        usage();
        return 2;
      }
      const inspected = inspectRun({ outDir, runId });
      console.log(`Run: ${runId}; traces: ${inspected.records.length}; aborted: ${inspected.state.aborted === true}`);
      console.log(`Decision path: ${inspected.decisionPath.join(" -> ")}`);
      return 0;
    }
    case "replay": {
      const runId = args.positional[0];
      if (!runId) {
        usage();
        return 2;
      }
      const replay = replayRun({ outDir, runId });
      console.log(`Decision path: ${replay.reconstructed.join(" -> ")}`);
      if (!replay.match) {
        console.error(`Replay mismatch: recorded=${JSON.stringify(replay.recorded)}, reconstructed=${JSON.stringify(replay.reconstructed)}`);
        return 1;
      }
      console.log(`Replay matches (${replay.reconstructed.length} transitions; no model or workspace used).`);
      return 0;
    }
    case "list": {
      for (const run of listRuns(outDir)) console.log(run);
      return 0;
    }
    case "models": {
      console.log("Models are discovered from Pi at runtime; use `/rsi models` inside a Pi session.");
      console.log("CLI default provider: opencode-go/deepseek-v4.1-flash via OPENCODE_API_KEY.");
      return 0;
    }
    default:
      usage();
      return 0;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exitCode = code)
  .catch((error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
