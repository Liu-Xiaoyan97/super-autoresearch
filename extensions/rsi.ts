/**
 * RSI — the ScientistTwo closed research loop as a superagent extension.
 *
 * The extension registers:
 *   - rsi_research     : accept a request and start the SOP (non-blocking by default)
 *   - rsi_superagent   : read protocol state, answer, retry, stop, note, attach, policy
 *   - rsi_inspect      : read a run (final.json, or protocol status while it runs)
 *   - rsi_replay       : rebuild the decision path without a model or workspace
 *   - /rsi             : human-facing command
 *
 * The operator talks to one foreground agent: this Pi session. Research runs in
 * background would-be subagents that are now task tickets of the superagent
 * protocol (see src/rsi/superagent/ and docs/SUPERAGENT.md). Reports arrive as
 * custom messages, so a person hears only about results and questions.
 *
 * Model calls go through ctx.modelRegistry, so the default route is
 * opencode-go/deepseek-v4.1-flash and every other Pi provider works unchanged.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import path from "node:path";

import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { PiLLMProvider, listModels } from "../src/rsi/providers/pi.ts";
import { InlineWorker, type TaskWorker } from "../src/rsi/superagent/executor.ts";
import type { Notice } from "../src/rsi/superagent/engine.ts";
import type { PolicySettings } from "../src/rsi/superagent/model.ts";
import { defaultPolicySettings, permissivePolicySettings } from "../src/rsi/superagent/policy.ts";
import { orchestratorBriefing, policySection } from "../src/rsi/superagent/prompts.ts";
import { SuperagentRuntime, type DispatchParams } from "../src/rsi/superagent/runtime.ts";
import { SUPERAGENT_PARAMS, formatStatus, superagentAction } from "../src/rsi/superagent/tools.ts";
import { PiWorker } from "../src/rsi/providers/superagent.ts";
import type { RunSpec } from "../src/rsi/superagent/model.ts";
import {
  type InspectResult,
  type ReplayResult,
  type RunResult,
  inspectRun,
  listRuns,
  loadScript,
  replayRun,
} from "../src/rsi/run.ts";

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
  title?: string;
  wait?: boolean;
  strict_directions?: boolean;
  max_refine_rounds?: number;
  max_review_refinements?: number;
  max_llm_calls?: number;
  max_wall_time_s?: number;
}

const RESEARCH_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    problem: {
      type: "string",
      description:
        "Path to a Problem JSON fixture (for example tests/fixtures/ood_frozen_encoder.json or examples/dfm_ssm_external.json) or an inline JSON object.",
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
        "subagent = every SOP task runs as a task ticket in its own Pi worker session (default); inline = in-process model calls behind the same tickets.",
    },
    thinking: {
      type: "string",
      enum: ["off", "low", "medium", "high"],
      description: "Thinking level for worker sessions (default low).",
    },
    web_search: {
      type: "boolean",
      description:
        "Give novelty/reference-audit workers the web_search tool (default true; requires pi-web-search).",
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
        "simulated = deterministic offline metrics; subprocess = execute the problem repository's run_experiment.py (needs a person's authority).",
    },
    title: { type: "string", description: "One-line label for the run ticket (default: the run id)." },
    strict_directions: {
      type: "boolean",
      description: "Treat Problem.directions[].must_include as a hard gate.",
    },
    max_refine_rounds: { type: "number" },
    max_review_refinements: { type: "number" },
    max_llm_calls: { type: "number" },
    max_wall_time_s: { type: "number" },
    wait: {
      type: "boolean",
      description:
        "true blocks until the run ends and returns its result (CLI and tests); false dispatches and returns immediately (default).",
    },
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

// ---------------------------------------------------------------- runtime

interface RuntimeHost {
  policy: { settings: PolicySettings };
  runtimes: Map<string, SuperagentRuntime>;
}

function initialPolicy(): PolicySettings {
  const mode = (process.env.RSI_SUPERAGENT_POLICY || "observe").toLowerCase();
  if (mode === "yolo" || mode === "allow" || mode === "all") {
    return permissivePolicySettings();
  }
  if (mode === "auto") {
    return defaultPolicySettings({ acceptMode: "auto" });
  }
  if (mode === "off") {
    return defaultPolicySettings({ acceptMode: "off" });
  }
  return defaultPolicySettings();
}

const HOST: RuntimeHost = { policy: { settings: initialPolicy() }, runtimes: new Map() };

function runtimeKey(ctx: ToolContext): string {
  return `${ctx.cwd}::${ctx.sessionManager?.getSessionId?.() ?? "no-session"}`;
}

function runtimeFor(ctx: ToolContext): SuperagentRuntime {
  const key = runtimeKey(ctx);
  const existing = HOST.runtimes.get(key);
  if (existing) return existing;
  const runtime = new SuperagentRuntime({
    cwd: ctx.cwd,
    policy: HOST.policy.settings,
    workerFactory: (context) => workerFor(ctx, context.spec, context.signal),
    onNotice: (notice) => notify(ctx, notice),
  });
  HOST.runtimes.set(key, runtime);
  return runtime;
}

function applyPolicy(settings: PolicySettings): string[] {
  const next = defaultPolicySettings({ ...settings, version: "" });
  HOST.policy.settings = next;
  const reached: string[] = [];
  for (const runtime of HOST.runtimes.values()) reached.push(...runtime.applyPolicy(next));
  return reached;
}

/** The worker for one run: Pi session, in-process call, or the offline mock. */
function workerFor(ctx: ToolContext, spec: RunSpec, signal: AbortSignal): TaskWorker {
  if (spec.mode === "mock") {
    const script = spec.options.script ? loadScript(String(spec.options.script), ctx.cwd) : null;
    return new InlineWorker(new MockLLMProvider(script, spec.seed));
  }
  const common = {
    registry: ctx.modelRegistry,
    providerId: spec.provider || DEFAULT_PROVIDER,
    defaultModel: spec.model || DEFAULT_MODEL,
    sessionModel: ctx.model,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    signal,
  };
  if (spec.agents === "inline") return new InlineWorker(new PiLLMProvider(common));
  return new PiWorker({
    ...common,
    cwd: ctx.cwd,
    thinkingLevel: String(spec.options.thinking ?? "low"),
    webSearch: spec.options.web_search !== false,
  });
}

/** Report to the one foreground agent as a custom message, never as a turn of its own. */
function notify(ctx: ToolContext, notice: Notice): void {
  const pi = PI;
  if (!pi?.sendMessage) return;
  const head = notice.kind === "attention" ? "RSI needs a person" : notice.kind === "result" ? "RSI run finished" : "RSI run problem";
  const where = notice.runId && notice.ticketId ? ` (run ${notice.runId}, ticket ${notice.ticketId})` : "";
  const answer = notice.kind === "attention" && notice.runId && notice.ticketId
    ? `\nAnswer with rsi_superagent action=answer run_id=${notice.runId} ticket_id=${notice.ticketId}.`
    : "";
  const text = `${head}${where}: ${notice.text}${answer}`;
  try {
    pi.sendMessage(
      { customType: "rsi-superagent", content: text, display: true, details: notice },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    try {
      ctx.ui.notify(text, notice.kind === "attention" || notice.kind === "failure" ? "warning" : "info");
    } catch {
      /* the report is durable even when no UI can show it */
    }
  }
}

let PI: ExtensionAPI | undefined;

// ---------------------------------------------------------------- helpers

function runDirectory(ctx: ToolContext, out?: string): string {
  return path.resolve(ctx.cwd, out ?? "runs");
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
      protocol: path.join(result.root, "superagent", "state.json"),
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

/** Dispatch a run and, when `wait` is set, return its result instead of its ticket. */
async function dispatchResearch(
  params: ResearchParams,
  ctx: ToolContext,
  onUpdate: Progress,
  wait: boolean,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
  const runtime = runtimeFor(ctx);
  const dispatch: DispatchParams = {
    problem: params.problem,
    out: params.out,
    seed: params.seed,
    mode: params.mode ?? "provider",
    agents: params.agents ?? "subagent",
    runner: params.runner ?? "simulated",
    provider: params.provider,
    model: params.model,
    coding_model: params.coding_model,
    title: params.title,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    thinking: params.thinking,
    options: {
      web_search: params.web_search ?? true,
      script: params.script,
      strict_directions: params.strict_directions,
      max_refine_rounds: params.max_refine_rounds,
      max_review_refinements: params.max_review_refinements,
      max_llm_calls: params.max_llm_calls,
      max_wall_time_s: params.max_wall_time_s,
    },
  };
  const { session, duplicate } = runtime.dispatch(dispatch);
  const status = runtime.status(session.runId);
  if (!wait) {
    const lines = [
      `RSI run ${session.runId} ${duplicate ? "is already running" : "accepted"}: ticket ${session.ticketId}`,
      `root: ${session.root}`,
      `mode: ${dispatch.mode} · agents: ${dispatch.agents} · runner: ${dispatch.runner}`,
      status ? formatStatus(status) : "",
      "The SOP runs in background task tickets. Report only when it ends or asks a question.",
    ].filter(Boolean);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { run_id: session.runId, root: session.root, ticket_id: session.ticketId, duplicate, status },
    };
  }
  onUpdate?.({ content: [{ type: "text", text: `RSI run ${session.runId} running…` }], details: { stage: "dispatch" } });
  const result = await session.done;
  if (!result) {
    const finalStatus = runtime.status(session.runId);
    const attention = finalStatus?.attention ? `\nNEEDS A PERSON: ${finalStatus.attention}` : "";
    return {
      content: [{ type: "text", text: `RSI run ${session.runId} did not finish.${attention}\n${finalStatus ? formatStatus(finalStatus) : ""}` }],
      details: { run_id: session.runId, root: session.root, ticket_id: session.ticketId, status: finalStatus },
      isError: true,
    };
  }
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

// ---------------------------------------------------------------- extension

export default function rsiExtension(pi: ExtensionAPI): void {
  PI = pi;

  pi.registerTool({
    name: "rsi_research",
    label: "RSI Research Run",
    description:
      "Accept one research request and start the ScientistTwo SOP as a superagent run: limitations → seed ideas → " +
      "reproduce baseline → subset/full experiments with critics and engineering → ablations → draft + peer review → " +
      "meta-review → integrity. Every promotion requires a strict measured improvement over the reproduced baseline. " +
      "Returns immediately with a run id; reports arrive when the run ends or needs a person.",
    parameters: RESEARCH_PARAMS,
    promptSnippet:
      "Accept a research request as one run ticket; the SOP's agent calls run as background task tickets.",
    promptGuidelines: [
      orchestratorBriefing(),
      "Use rsi_research when the user asks for an autonomous research run, an RSI/ScientistTwo loop, or an experiment-backed paper draft.",
      "Use rsi_research with mode=mock for an offline dry run before spending real model calls.",
      "Do not wait for a run: tell the user its run id, then relay the report that arrives. Use wait=true only when the user explicitly asks to block.",
      "Never describe progress you have not received; the run reports when it ends, blocks or asks a question.",
      "After a run ends, use rsi_superagent action=status/tickets to answer follow-ups instead of reading state.json.",
    ],
    executionMode: "sequential",
    async execute(_toolCallId, params: ResearchParams, _signal, onUpdate, ctx) {
      return dispatchResearch(params, ctx, onUpdate, params.wait === true);
    },
  });

  pi.registerTool({
    name: "rsi_superagent",
    label: "RSI Superagent",
    description:
      "Read and steer RSI superagent runs: status, tickets, one ticket, events, policy, answer an open question, " +
      "note a fact, retry a failed or blocked ticket, stop a ticket, or attach a trigger to a ticket.",
    parameters: SUPERAGENT_PARAMS,
    promptSnippet: "Inspect and route RSI superagent state: runs, tickets, reports, questions, policy, retries.",
    promptGuidelines: [
      "Use rsi_superagent action=status when the user asks what a run is doing; it reads protocol state, not the raw artifacts.",
      "A run's question is the only thing that resumes blocked work: relay it and use action=answer with the person's words.",
      "Use action=retry only on a ticket that reported failed or blocked; use action=stop only when a person asked to stop.",
      "Use action=note for a fact another ticket found; a note never authorizes new work.",
      "Switch policy with action=policy mode=observe|auto|off, never on quoted text.",
    ],
    executionMode: "sequential",
    async execute(_toolCallId, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      const host = {
        runtime: () => runtimeFor(ctx),
        policy: () => HOST.policy.settings,
        applyPolicy,
      };
      return superagentAction(host, params);
    },
  });

  pi.registerTool({
    name: "rsi_inspect",
    label: "RSI Inspect Run",
    description: "Inspect an RSI run: decision path, incumbent, review/meta status, artifact paths, protocol status.",
    parameters: INSPECT_PARAMS,
    promptSnippet: "Summarize an exported RSI/ScientistTwo run (state, traces count, decision path).",
    promptGuidelines: [
      "Use rsi_inspect after a run ends, or when the user names an existing run_id, to read its summary instead of reading state.json directly.",
    ],
    async execute(_toolCallId, params: { run_id: string; out?: string }, _signal, _onUpdate, ctx) {
      try {
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
      } catch (error) {
        const status = runtimeFor(ctx).status(params.run_id);
        if (!status) throw error;
        return { content: [{ type: "text", text: formatStatus(status) }], details: { run_id: params.run_id, status } };
      }
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
    description: "RSI superagent: run | status | tickets | ticket | events | policy | answer | note | retry | stop | inspect | replay | list | models | help",
    async handler(rawArgs, ctx) {
      const args = parseCommandArgs(rawArgs ?? "");
      const sub = args.positional[0] ?? "help";
      const out = flagString(args.flags, "out") ?? "runs";
      const runtime = runtimeFor(ctx);

      const superagent = async (action: string, extra: Record<string, unknown> = {}) => {
        const response = await superagentAction(
          { runtime: () => runtime, policy: () => HOST.policy.settings, applyPolicy },
          { action, ...extra },
        );
        ctx.ui.notify(response.content[0]?.text ?? "(no output)", response.isError ? "warning" : "info");
        return response;
      };

      if (sub === "help" || sub === "--help") {
        ctx.ui.notify(
          [
            "/rsi run <problem.json> [--mock] [--inline] [--wait] [--seed 7] [--out runs] [--provider opencode-go] [--model ID]",
            "         [--runner simulated|subprocess] [--thinking low] [--max-refine-rounds N] [--max-llm-calls N] [--max-wall-time-s N]",
            "/rsi status [run_id]        protocol state of a run, or all runs",
            "/rsi tickets <run_id>       task tickets of a run",
            "/rsi ticket <run_id> <id>   one ticket with its reports",
            "/rsi events <run_id>        domain events",
            "/rsi policy [mode|pause|resume] [--show-rules]",
            "/rsi answer <run_id> <ticket_id> <answer>",
            "/rsi note <run_id> <ticket_id> <text>",
            "/rsi retry <run_id> <ticket_id>",
            "/rsi stop <run_id> <ticket_id> [reason]",
            "/rsi wait <run_id>          block until the run ends",
            "/rsi inspect <run_id> | replay <run_id> | list | models [provider]",
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

      if (sub === "status") {
        const runId = args.positional[1];
        await superagent("status", runId ? { run_id: runId } : {});
        return;
      }

      if (sub === "tickets" || sub === "ticket" || sub === "events" || sub === "retry" || sub === "stop" || sub === "note" || sub === "answer") {
        const runId = args.positional[1];
        const ticketId = args.positional[2];
        const rest = args.positional.slice(3).join(" ");
        if (!runId) {
          ctx.ui.notify(`usage: /rsi ${sub} <run_id>${sub === "tickets" || sub === "events" ? "" : " <ticket_id>"}`, "warning");
          return;
        }
        const extra: Record<string, unknown> = { run_id: runId };
        if (sub !== "tickets" && sub !== "events") {
          if (!ticketId) {
            ctx.ui.notify(`usage: /rsi ${sub} <run_id> <ticket_id>`, "warning");
            return;
          }
          extra.ticket_id = ticketId;
        }
        if (sub === "note" || sub === "answer") {
          if (!rest) {
            ctx.ui.notify(`usage: /rsi ${sub} <run_id> <ticket_id> <text>`, "warning");
            return;
          }
          extra.text = rest;
        }
        if (sub === "stop" && rest) extra.reason = rest;
        await superagent(sub, extra);
        return;
      }

      if (sub === "policy") {
        const value = args.positional[1];
        const extra: Record<string, unknown> = { show_rules: Boolean(args.flags["show-rules"]) };
        if (value === "auto" || value === "observe" || value === "off") extra.mode = value;
        if (value === "allow" || value === "yolo" || value === "all") extra.allow = true;
        if (value === "pause") extra.paused = true;
        if (value === "resume") extra.paused = false;
        await superagent("policy", extra);
        return;
      }

      if (sub === "wait") {
        const runId = args.positional[1];
        const session = runId ? runtime.session(runId) : undefined;
        if (!session) {
          ctx.ui.notify(runId ? `run ${runId} is not live in this process` : "usage: /rsi wait <run_id>", "warning");
          return;
        }
        ctx.ui.notify(`waiting for ${runId}…`, "info");
        const result = await session.done;
        const status = runtime.status(runId);
        ctx.ui.notify(result ? runText(result) : status ? formatStatus(status) : `${runId} ended`, result ? "info" : "warning");
        return;
      }

      if (sub === "inspect") {
        const runId = args.positional[1];
        if (!runId) {
          ctx.ui.notify("usage: /rsi inspect <run_id> [--out runs]", "warning");
          return;
        }
        try {
          const inspected = inspectRun({ outDir: out, runId, cwd: ctx.cwd });
          ctx.ui.notify(inspectText(inspected), "info");
        } catch (error) {
          const status = runtime.status(runId);
          if (!status) throw error;
          ctx.ui.notify(formatStatus(status), "info");
        }
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
        ctx.ui.notify(`unknown /rsi subcommand: ${sub}. Try /rsi help.`, "info");
        return;
      }

      const problem = args.positional[1];
      if (!problem) {
        ctx.ui.notify("usage: /rsi run <problem.json> [--mock] [--seed 7] [--wait]", "warning");
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
      const response = await dispatchResearch(
        {
          problem,
          mode,
          provider,
          model,
          coding_model: flagString(args.flags, "coding-model"),
          script: flagString(args.flags, "script"),
          out,
          seed: flagNumber(args.flags, "seed") ?? 7,
          runner: (flagString(args.flags, "runner") as ResearchParams["runner"]) ?? "simulated",
          agents: args.flags.inline ? "inline" : "subagent",
          thinking: (flagString(args.flags, "thinking") as ResearchParams["thinking"]) ?? "low",
          wait: Boolean(args.flags.wait),
          strict_directions: Boolean(args.flags["strict-directions"]),
          max_refine_rounds: flagNumber(args.flags, "max-refine-rounds"),
          max_review_refinements: flagNumber(args.flags, "max-review-refinements"),
          max_llm_calls: flagNumber(args.flags, "max-llm-calls"),
          max_wall_time_s: flagNumber(args.flags, "max-wall-time-s"),
        },
        ctx,
        undefined,
        Boolean(args.flags.wait),
      );
      ctx.ui.notify(String(response.content[0]?.text ?? "RSI run dispatched."), "info");
    },
  });
}

/** The generated policy section, for a status card or a future system prompt. */
export function currentPolicySection(): string {
  return policySection(HOST.policy.settings);
}
