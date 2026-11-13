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
  const base = name.endsWith(".json") ? name.slice(0, -5) : name;
  const candidates = [
    path.join(repoRoot, "tests", "fixtures", `${base}.json`),
    path.join(repoRoot, "examples", `${base}.json`),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`missing fixture ${name}`);
  return file;
}

export function tempDir(prefix = "rsi-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const defaultMockPlan = {
  "ablation.plan": {
    plans: [
      "safe component C",
      "residual-alignment refinement",
      "structural ablation: primary mechanism",
      "structural ablation: auxiliary loss/regularizer",
      "calibration gate",
    ]
      .map((component, index) => ({
        id: `A${index + 1}`,
        component,
        description: "Remove the component and re-measure the same subset protocol.",
        expects: "Removing it lowers auroc by 0.01 on the subset control.",
        variant_of: "h6",
      })),
    hypothesis: "Pinned mock ablation plans.",
  },
};

export async function mockRun(
  over: Partial<RunOptions> = {},
): Promise<Awaited<ReturnType<typeof runResearch>>> {
  return runResearch({
    problem: fixture("ood_frozen_encoder"),
    outDir: tempDir("rsi-run-"),
    mock: true,
    seed: 7,
    mockScript: defaultMockPlan,
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
    llm: new MockLLMProvider(defaultMockPlan, config.seed),
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

// Keep project-global baseline writes out of the developer home during tests.
process.env.RSI_BASELINE_DIR ??= tempDir("rsi-baseline-home-");
process.env.RSI_LEDGER_DIR ??= tempDir("rsi-ledger-home-");
process.env.RSI_LEDGER_RENDER ??= "0";
