import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultConfig, type Config } from "../src/rsi/config.ts";
import type { AgentContext } from "../src/rsi/agents/base.ts";
import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { Budget } from "../src/rsi/runtime/budget.ts";
import { ArtifactStore, TraceStore } from "../src/rsi/runtime/store.ts";
import { GitWorkspace } from "../src/rsi/runtime/workspace.ts";
import { loadProblem, runResearch, type RunOptions } from "../src/rsi/run.ts";

export const repoRoot = path.resolve(import.meta.dirname, "..");

export function fixture(name: string): string {
  const file = path.join(repoRoot, "examples", name.endsWith(".json") ? name : `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`missing fixture ${file}`);
  return file;
}

export function tempDir(prefix = "rsi-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function mockRun(
  over: Partial<RunOptions> = {},
): Promise<Awaited<ReturnType<typeof runResearch>>> {
  return runResearch({
    problem: fixture("ood_frozen_encoder"),
    outDir: tempDir("rsi-run-"),
    mock: true,
    seed: 7,
    ...over,
  });
}

export function makeContext(over: {
  problemName?: string;
  config?: Partial<Config>;
  root?: string;
} = {}): AgentContext {
  const problem = loadProblem(fixture(over.problemName ?? "ood_frozen_encoder"), repoRoot);
  const root = over.root ?? tempDir("rsi-ctx-");
  const config = defaultConfig(over.config ?? {});
  const store = new ArtifactStore(root);
  return {
    problem,
    config,
    llm: new MockLLMProvider(null, config.seed),
    workspace: new GitWorkspace(problem, config, root),
    store,
    traces: new TraceStore(path.join(root, "traces.jsonl")),
    budget: new Budget({
      maxLlmCalls: config.maxLlmCalls,
      maxExperiments: config.maxExperiments,
      maxWallTimeS: config.maxWallTimeS,
    }),
    scratch: {},
  };
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
