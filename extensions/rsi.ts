/**
 * RSI — the ScientistTwo closed research loop as a Pi extension.
 *
 * The extension registers:
 *   - rsi_research : run §3.1 → §3.6 end-to-end and export artifacts
 *   - rsi_inspect  : read state/traces/final of a run
 *   - rsi_replay   : rebuild the decision path without a model or workspace
 *   - /rsi         : human-facing command (run/inspect/replay/list/models)
 *
 * Model calls go through ctx.modelRegistry, so the default route is
 * opencode-go/deepseek-v4.1-flash and every other Pi provider works unchanged.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { LLMProvider } from "../src/rsi/providers/base.ts";
import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { PiLLMProvider, listModels } from "../src/rsi/providers/pi.ts";
import { PiSubagentProvider } from "../src/rsi/providers/subagent.ts";
import {
  type InspectResult,
  type ReplayResult,
  type RunResult,
  inspectRun,
  listRuns,
  loadScript,
  replayRun,
  runResearch,
} from "../src/rsi/run.ts";
import path from "node:path";

type JsonSchema = Record<string, unknown>;
type ToolContext = ExtensionContext;
type Progress = ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined;

const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = process.env.RSI_MODEL || "deepseek-v4.1-flash";

interface ResearchParams {
  problem: string;
  mode?: "provider" | "mock";
  agents?: "subagent" | "inline";
  thinking?: "off" | "low" | "medium" | "high";
  web_search?: boolean;
  provider?: string;
  model?: string;
  coding_model?: string;
  script?: string;
  out?: string;
  seed?: number;
  runner?: "simulated" | "subprocess";
  max_refine_rounds?: number;
  max_review_refinements?: number;
  strict_directions?: boolean;
  max_llm_calls?: number;
  max_wall_time_s?: number;
}

const RESEARCH_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    problem: {
      type: "string",
      description:
        "Path to a Problem JSON fixture (for example examples/ood_frozen_encoder.json) or an inline JSON object.",
    },
    mode: {
      type: "string",
      enum: ["provider", "mock"],
      description:
        "provider = real model calls through Pi (opencode-go by default); mock = deterministic offline dry run.",
    },
    agents: {
      type: "string",
      enum: ["subagent", "inline"],
      description:
        "subagent = each pipeline agent runs in its own isolated Pi session (default); inline = nested model calls.",
    },
    thinking: {
      type: "string",
      enum: ["off", "low", "medium", "high"],
      description: "Thinking level for subagent sessions (default low; coding roles inherit it).",
    },
    web_search: {
      type: "boolean",
      description:
        "Give novelty/reference-audit subagents the web_search tool (default true; requires pi-web-search).",
    },
    provider: { type: "string", description: `Pi provider id (default ${DEFAULT_PROVIDER}).` },
    model: { type: "string", description: `Model id for the default route (default ${DEFAULT_MODEL}).` },
    coding_model: {
      type: "string",
      description: "Model id for coding/ablation/rebuttal/draft-enhancer roles (defaults to model).",
    },
    script: {
      type: "string",
      description: "Optional task-keyed mock script JSON (only with mode=mock).",
    },
    out: { type: "string", description: "Output directory relative to the workspace (default runs)." },
    seed: { type: "number", description: "Deterministic seed (default 7)." },
    runner: {
      type: "string",
      enum: ["simulated", "subprocess"],
      description:
        "simulated = deterministic offline metrics; subprocess = execute the problem repository's run_experiment.py.",
    },
    max_refine_rounds: { type: "number" },
    max_review_refinements: { type: "number" },
    strict_directions: {
      type: "boolean",
      description: "Treat directions marked must_include as a hard gate.",
    },
    max_llm_calls: { type: "number" },
    max_wall_time_s: { type: "number" },
  },
  required: ["problem"],
};

const INSPECT_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "Run directory name, e.g. ood-frozen-encoder-s7." },
    out: { type: "string", description: "Runs directory (default runs)." },
  },
  required: ["run_id"],
};

const REPLAY_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "Run directory name." },
    out: { type: "string", description: "Runs directory (default runs)." },
  },
  required: ["run_id"],
};

function runDirectory(ctx: ToolContext, out?: string): string {
  return path.resolve(ctx.cwd, out ?? "runs");
}

function providerFor(
  ctx: ToolContext,
  params: Pick<
    ResearchParams,
    "mode" | "agents" | "thinking" | "web_search" | "provider" | "model" | "script" | "seed"
  >,
  signal: AbortSignal | undefined,
): LLMProvider {
  if (params.mode === "mock") {
    const script = params.script ? loadScript(params.script, ctx.cwd) : null;
    return new MockLLMProvider(script, params.seed ?? 7);
  }
  const common = {
    registry: ctx.modelRegistry,
    providerId: params.provider || DEFAULT_PROVIDER,
    defaultModel: params.model || DEFAULT_MODEL,
    sessionModel: ctx.model,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    signal,
  };
  if (params.agents === "inline") return new PiLLMProvider(common);
  return new PiSubagentProvider({
    ...common,
    cwd: ctx.cwd,
    thinkingLevel: params.thinking ?? "low",
    webSearch: params.web_search ?? true,
  });
}

function runDetails(result: RunResult): Record<string, unknown> {
  return {
    run_id: result.runId,
    root: result.root,
    summary: result.summary,
    final: result.final,
    artifacts: {
      state: path.join(result.root, "state.json"),
      traces: path.join(result.root, "traces.jsonl"),
      final: path.join(result.root, "final.json"),
      manuscript: result.final.paper.latex_path || null,
    },
  };
}

function runText(result: RunResult): string {
  const s = result.summary as any;
  const lines = [
    `RSI run ${result.runId} ${result.final.aborted ? "ABORTED" : result.final.extra.accepted ? "ACCEPTED" : "EXPORTED INCUMBENT"}`,
    `limitations: ${s.limitations}, seeds: ${s.seeds}, evaluated: ${s.rounds.length}`,
    ...(s.rounds as Array<{ round: number; idea: string; decision: string }>).map(
      (round) => `  round ${round.round}: ${round.idea} ${round.decision}`,
    ),
    `h_best: ${s.h_best ?? "none"}`,
    result.final.code?.commit
      ? `best commit: ${result.final.code.commit} (${result.final.code.branch ?? "detached"})`
      : "best commit: none",
    `review scores: ${(s.review_scores as number[]).join(", ") || "none"}; meta: ${s.meta_decision ?? "none"}`,
    `decision path: ${(s.decision_path as string[]).join(" -> ")}`,
    ...(result.final.aborted ? [`abort: ${result.final.abort_reason}`] : []),
    `artifacts: ${result.root}`,
  ];
  return lines.join("\n");
}

function inspectText(inspected: InspectResult): string {
  const state = inspected.state as any;
  const code = state.best_evidence?.code;
  const codeLine = code?.commit
    ? `best commit: ${code.commit} (${code.branch ?? "detached"}) in ${code.repo ?? "unknown repo"}`
    : "best commit: none";
  return [
    `run: ${path.basename(inspected.root)}; traces: ${inspected.records.length}; aborted: ${state.aborted === true}`,
    `h_best: ${state.best_idea?.id ?? "none"}; review: ${state.review?.score ?? "none"}; meta: ${state.meta_review?.decision ?? "none"}`,
    codeLine,
    `decision path: ${inspected.decisionPath.join(" -> ")}`,
    `state: ${path.join(inspected.root, "state.json")}`,
    `final: ${path.join(inspected.root, "final.json")}`,
  ].join("\n");
}

function replayText(replay: ReplayResult): string {
  return replay.match
    ? `replay matches (${replay.reconstructed.length} transitions; no model or workspace used).`
    : `replay MISMATCH\nrecorded: ${JSON.stringify(replay.recorded)}\nreconstructed: ${JSON.stringify(replay.reconstructed)}`;
}

async function executeResearch(
  params: ResearchParams,
  ctx: ToolContext,
  signal: AbortSignal | undefined,
  onUpdate: Progress,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const provider = providerFor(ctx, params, signal);
  const report = (message: string) =>
    onUpdate?.({
      content: [{ type: "text", text: message }],
      details: { stage: message },
    });
  report(`RSI: starting ${params.mode === "mock" ? "offline" : `${params.provider || DEFAULT_PROVIDER}/${params.model || DEFAULT_MODEL}`} run`);
  const result = await runResearch({
    problem: params.problem,
    cwd: ctx.cwd,
    outDir: params.out ?? "runs",
    seed: params.seed,
    runner: params.runner,
    mock: params.mode === "mock",
    mockScript: params.script ? loadScript(params.script, ctx.cwd) : null,
    provider,
    model: params.model,
    codingModel: params.coding_model,
    strictDirections: params.strict_directions,
    maxRefineRounds: params.max_refine_rounds,
    maxReviewRefinements: params.max_review_refinements,
    maxLlmCalls: params.max_llm_calls,
    maxWallTimeS: params.max_wall_time_s,
    signal,
    onProgress: report,
  });
  return { content: [{ type: "text", text: runText(result) }], details: runDetails(result) };
}

function parseCommandArgs(args: string): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^["']|["']$/g, "");
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1]?.replace(/^["']|["']$/g, "");
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
  return { positional, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flagString(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function rsiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "rsi_research",
    label: "RSI Research Loop",
    description:
      "Run the ScientistTwo closed research loop on a problem: limitations → seed ideas → reproduce baseline → " +
      "subset/full experiments with critics and engineering → ablations → draft + peer review → meta-review. " +
      "Every promotion requires a strict measured improvement over the reproduced baseline. " +
      "Artifacts (state.json, traces.jsonl, final.json, code snapshots, manuscript) are written to disk.",
    parameters: RESEARCH_PARAMS,
    promptSnippet:
      "Run the autonomous ScientistTwo/RSI research loop on a problem JSON and export a reproducible artifact tree.",
    promptGuidelines: [
      "Use rsi_research when the user asks for an autonomous research run, an RSI/ScientistTwo loop, or an experiment-backed paper draft.",
      "Use rsi_research with mode=mock for an offline dry run before spending real model calls; omit mode or use provider for a real run.",
      "After rsi_research, use rsi_inspect to summarize a run and rsi_replay to verify the decision path instead of dumping large state.json files into the conversation.",
    ],
    executionMode: "sequential",
    async execute(_toolCallId, params: ResearchParams, signal, onUpdate, ctx) {
      const result = await executeResearch(params, ctx, signal, onUpdate);
      return result;
    },
  });

  pi.registerTool({
    name: "rsi_inspect",
    label: "RSI Inspect Run",
    description: "Inspect an RSI run directory: decision path, incumbent, review/meta status, artifact paths.",
    parameters: INSPECT_PARAMS,
    promptSnippet: "Summarize an exported RSI/ScientistTwo run (state, traces count, decision path).",
    promptGuidelines: [
      "Use rsi_inspect after rsi_research, or when the user names an existing run_id, to read its summary instead of reading state.json directly.",
    ],
    async execute(_toolCallId, params: { run_id: string; out?: string }, _signal, _onUpdate, ctx) {
      const inspected = inspectRun({ outDir: params.out ?? "runs", runId: params.run_id, cwd: ctx.cwd });
      return {
        content: [{ type: "text", text: inspectText(inspected) }],
        details: {
          run_id: params.run_id,
          root: inspected.root,
          decision_path: inspected.decisionPath,
          state: inspected.state,
          final: inspected.final,
        },
      };
    },
  });

  pi.registerTool({
    name: "rsi_replay",
    label: "RSI Replay Decisions",
    description:
      "Rebuild the state-machine decision path from traces.jsonl and compare it with the recorded path. " +
      "Uses no model and no workspace, so it verifies reproducibility.",
    parameters: REPLAY_PARAMS,
    promptSnippet: "Verify that an RSI run's recorded decision path is reproducible from its traces alone.",
    promptGuidelines: [
      "Use rsi_replay when the user asks whether an RSI run is reproducible or after editing replay/state code.",
    ],
    async execute(_toolCallId, params: { run_id: string; out?: string }, _signal, _onUpdate, ctx) {
      const replay = replayRun({ outDir: params.out ?? "runs", runId: params.run_id, cwd: ctx.cwd });
      return {
        content: [{ type: "text", text: replayText(replay) }],
        details: {
          run_id: params.run_id,
          root: replay.root,
          match: replay.match,
          recorded: replay.recorded,
          reconstructed: replay.reconstructed,
        },
        isError: !replay.match,
      };
    },
  });

  pi.registerCommand("rsi", {
    description: "RSI research loop: run | inspect | replay | list | models | help",
    async handler(rawArgs, ctx) {
      const args = parseCommandArgs(rawArgs ?? "");
      const sub = args.positional[0] ?? "help";
      const out = flagString(args.flags, "out") ?? "runs";

      if (sub === "help" || sub === "--help") {
        ctx.ui.notify(
          [
            "/rsi run <problem.json> [--mock] [--inline] [--thinking low] [--seed 7] [--runner simulated|subprocess] [--out runs]",
            "         [--provider opencode-go] [--model ID]",
            "/rsi inspect <run_id> [--out runs]",
            "/rsi replay <run_id> [--out runs]",
            "/rsi list [--out runs]",
            "/rsi models [provider]",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "list" || sub === "runs") {
        const runs = listRuns(out, ctx.cwd);
        ctx.ui.notify(runs.length ? runs.join("\n") : `no runs under ${runDirectory(ctx, out)}`, "info");
        return;
      }

      if (sub === "models") {
        const provider = args.positional[1];
        const models = listModels(ctx.modelRegistry, provider);
        ctx.ui.notify(models.length ? models.slice(0, 120).join("\n") : "no authenticated models found", "info");
        return;
      }

      if (sub === "inspect") {
        const runId = args.positional[1];
        if (!runId) {
          ctx.ui.notify("usage: /rsi inspect <run_id> [--out runs]", "warning");
          return;
        }
        const inspected = inspectRun({ outDir: out, runId, cwd: ctx.cwd });
        ctx.ui.notify(inspectText(inspected), "info");
        return;
      }

      if (sub === "replay") {
        const runId = args.positional[1];
        if (!runId) {
          ctx.ui.notify("usage: /rsi replay <run_id> [--out runs]", "warning");
          return;
        }
        const replay = replayRun({ outDir: out, runId, cwd: ctx.cwd });
        ctx.ui.notify(replayText(replay), replay.match ? "info" : "error");
        return;
      }

      if (sub !== "run") {
        ctx.ui.notify(`unknown /rsi subcommand: ${sub}. Try /rsi help.`, "warning");
        return;
      }

      const problem = args.positional[1];
      if (!problem) {
        ctx.ui.notify("usage: /rsi run <problem.json> [--mock] [--seed 7]", "warning");
        return;
      }
      const mode = args.flags.mock ? "mock" : "provider";
      const provider = flagString(args.flags, "provider") ?? DEFAULT_PROVIDER;
      const model = flagString(args.flags, "model") ?? DEFAULT_MODEL;
      if (mode === "provider") {
        const ok = await ctx.ui.confirm(
          "Run RSI with real models?",
          `${provider}/${model}\nProblem: ${problem}\nArtifacts: ${path.join(runDirectory(ctx, out), "<run-id>")}`,
        );
        if (!ok) {
          ctx.ui.notify("RSI run cancelled.", "info");
          return;
        }
      }
      const script = flagString(args.flags, "script");
      const seed = flagNumber(args.flags, "seed") ?? 7;
      const result = await executeResearch(
        {
          problem,
          mode,
          provider,
          model,
          coding_model: flagString(args.flags, "coding-model"),
          script,
          out,
          seed,
          runner: (flagString(args.flags, "runner") as ResearchParams["runner"]) ?? "simulated",
          max_refine_rounds: flagNumber(args.flags, "max-refine-rounds"),
          max_review_refinements: flagNumber(args.flags, "max-review-refinements"),
          strict_directions: Boolean(args.flags["strict-directions"]),
          max_llm_calls: flagNumber(args.flags, "max-llm-calls"),
          max_wall_time_s: flagNumber(args.flags, "max-wall-time-s"),
          agents: args.flags.inline ? "inline" : "subagent",
          thinking: (flagString(args.flags, "thinking") as ResearchParams["thinking"]) ?? "low",
        },
        ctx,
        undefined,
        undefined,
      );
      ctx.ui.notify(String(result.content[0]?.text ?? "RSI run finished."), "info");
    },
  });
}
