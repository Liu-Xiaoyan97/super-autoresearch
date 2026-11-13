/**
 * RSI — the ScientistTwo closed research loop as a superagent extension.
 *
 * The extension registers:
 *   - rsi_iteration    : one blocking real baseline/candidate subset optimization
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
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { modelRoute } from "../src/rsi/config.ts";
import { runIteration } from "../src/rsi/iteration.ts";
import { stableString } from "../src/rsi/json.ts";
import {
  cancelJob, listLedger, readEvents, readLedger, readResult, submitJob, terminalEvent, verifyResult, waitForJob, watchJob,
  type JobEvent, type JobHandle, type JobResult,
} from "../src/rsi/runtime/jobs.ts";

import { ADAPTER_SMOKE_PARAMS, adapterSmoke, type AdapterSmokeParams } from "../src/rsi/adapter-smoke.ts";
import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { PiLLMProvider, listModels } from "../src/rsi/providers/pi.ts";
import { InlineWorker, type TaskWorker } from "../src/rsi/superagent/executor.ts";
import type { Notice } from "../src/rsi/superagent/engine.ts";
import type { PolicySettings } from "../src/rsi/superagent/model.ts";
import { defaultPolicySettings, permissivePolicySettings } from "../src/rsi/superagent/policy.ts";
import { orchestratorBriefing, policySection } from "../src/rsi/superagent/prompts.ts";
import { SuperagentRuntime, type DispatchParams, type RunStatus, type RunSummary } from "../src/rsi/superagent/runtime.ts";
import { SUPERAGENT_PARAMS, formatStatus, superagentAction } from "../src/rsi/superagent/tools.ts";
import { PiWorker } from "../src/rsi/providers/superagent.ts";
import type { RunSpec } from "../src/rsi/superagent/model.ts";
import {
  type InspectResult,
  type ReplayResult,
  type RunResult,
  inspectRun,
  listRuns,
  loadProblem,
  loadScript,
  replayRun,
} from "../src/rsi/run.ts";

type JsonSchema = Record<string, unknown>;
type ToolContext = ExtensionContext & { hasUI?: boolean };
type Progress = ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined;

/** Resolve a run from the current Pi selection, not an RSI-specific model default. */
function sessionRoute(ctx: ToolContext, provider?: string, model?: string) {
  const selectedModel = model ?? process.env.RSI_MODEL ?? ctx.model?.id;
  if (provider && !model && !process.env.RSI_MODEL && provider !== ctx.model?.provider) {
    throw new Error("Specify model when overriding the current Pi provider");
  }
  let selectedProvider = provider ?? ctx.model?.provider;
  let id = selectedModel;
  if (id?.includes("/")) {
    const [qualifiedProvider, ...parts] = id.split("/");
    if (provider && provider !== qualifiedProvider) throw new Error("provider conflicts with qualified model id");
    selectedProvider = qualifiedProvider;
    id = parts.join("/");
  }
  return { provider: selectedProvider, model: id };
}

function tokenOverride(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

interface ResearchParams {
  problem: string;
  mode?: "provider" | "mock";
  agents?: "subagent" | "inline";
  thinking?: string;
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
  max_tokens?: number;
  coding_max_tokens?: number;
  /** Trusted baseline JSON/incumbent ledger; reused instead of reproducing. */
  baseline?: string;
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
        "provider = real model calls through the current Pi model; mock = deterministic offline dry run.",
    },
    agents: {
      type: "string",
      enum: ["subagent", "inline"],
      description:
        "subagent = every SOP task runs as a task ticket in its own Pi worker session (default); inline = in-process model calls behind the same tickets.",
    },
    thinking: {
      type: "string",
      enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      description: "Explicit thinking override; omitted inherits the current Pi session setting and native model mapping.",
    },
    web_search: {
      type: "boolean",
      description:
        "Give novelty/reference-audit workers the web_search tool (default true; requires pi-web-search).",
    },
    provider: { type: "string", description: "Explicit Pi provider override; defaults to the current Pi selection." },
    model: { type: "string", description: "Explicit model override; defaults to the current Pi selection." },
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
    max_tokens: { type: "integer", minimum: 1, description: "Optional explicit per-call output cap for all roles; omitted uses native Pi/model defaults, including reasoning." },
    coding_max_tokens: { type: "integer", minimum: 1, description: "Optional explicit coding-role output cap; omitted inherits global override or native Pi/model defaults." },
    baseline: {
      type: "string",
      description:
        "Path to a trusted baseline JSON or incumbent ledger. A valid baseline is reused instead of reproduced; only a missing scope runs the reference. Promotion writes incumbent-<problem>-<scope>.json next to the run output.",
    },
    wait: {
      type: "boolean",
      description:
        "true blocks until the run ends and returns its result (CLI and tests); false dispatches and returns immediately (default).",
    },
  },
  required: ["problem"],
};

interface IterationParams {
  problem: string;
  adapter_acceptance: string;
  repo?: string;
  out?: string;
  env?: Record<string, string>;
  provider?: string;
  model?: string;
  seed?: number;
  scope?: "subset" | "full";
  max_tokens?: number;
  coding_max_tokens?: number;
  protected_paths?: string[];
  baseline_mode?: "reuse" | "paired";
}

const ITERATION_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    problem: { type: "string", minLength: 1, description: "Exact Problem JSON path or inline JSON with explicit repo_ref, command, metrics and subset datasets. Never rewrite the evaluation protocol." },
    adapter_acceptance: { type: "string", minLength: 1, description: "Path to the native adapter smoke-summary.json receipt for this exact repo_ref commit: status ok and validated training/checkpoint metadata. Operator must still inspect underlying real train → new checkpoint → reload → lm-eval artifacts." },
    repo: { type: "string", minLength: 1, description: "Optional local target git repository override; repo_ref remains unchanged." },
    out: { type: "string", minLength: 1, description: "Fresh evidence directory, not an existing runs parent. Reuse is rejected; default unique runs/iteration-* directory." },
    env: { type: "object", additionalProperties: { type: "string" }, description: "Explicit documented small-budget environment overrides, identical for baseline and candidate. No budgets or datasets are guessed." },
    provider: { type: "string", minLength: 1, description: "Configured Pi provider override; omitted inherits the current Pi model selection." },
    model: { type: "string", minLength: 1, description: "Configured Pi model override; omitted inherits the current Pi model selection." },
    seed: { type: "integer", default: 7, description: "Fixed paired seed (default 7); pass the person's requested seed explicitly." },
    scope: { type: "string", enum: ["subset", "full"], default: "subset", description: "subset = cheap screen with a separate cheap incumbent; full = formal protocol (stage budget + full test), separate formal ledger, slower." },
    max_tokens: { type: "integer", minimum: 1, description: "Optional explicit output cap for all roles; omitted uses native Pi/model defaults rather than an RSI limit." },
    coding_max_tokens: { type: "integer", minimum: 1, description: "Optional explicit coding-role output token cap, including reasoning; omitted inherits the global override or native Pi/model defaults. Only the selected model capability caps it." },
    protected_paths: { type: "array", items: { type: "string", minLength: 1 }, description: "Additional immutable repo-relative paths/globs beyond the adapter manifest and evaluator/data/tokenizer protections." },
    baseline_mode: { type: "string", enum: ["reuse", "paired"], default: "reuse", description: "reuse: measure only the candidate against the stored incumbent and promote on improvement. paired: also re-measure the baseline every iteration for drift control. A missing, invalid or protocol-mismatched incumbent falls back to measured." },
  },
  required: ["problem", "adapter_acceptance"],
  additionalProperties: false,
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
    onNotice: (notice) => {
      notify(ctx, notice);
      refreshTui();
    },
    notifyTaskReports: true,
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
    providerId: spec.provider ?? ctx.model?.provider,
    defaultModel: spec.model ?? ctx.model?.id,
    sessionModel: ctx.model,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    thinkingLevel: typeof spec.options.thinking === "string" ? spec.options.thinking : ctx.thinkingLevel,
    signal,
  };
  if (spec.agents === "inline") return new InlineWorker(new PiLLMProvider(common));
  // Coding workers need to read the target snapshot. Resolve the Problem repo
  // so `read`/`grep` inspect the project, not the RSI harness checkout.
  let workerCwd = ctx.cwd;
  try {
    const problem = loadProblem(spec.problem, ctx.cwd);
    if (problem.repo) workerCwd = path.resolve(ctx.cwd, problem.repo);
  } catch {
    /* the runtime reports a clearer load error later */
  }
  return new PiWorker({
    ...common,
    cwd: workerCwd,
    webSearch: spec.options.web_search !== false,
  });
}

/** Report to the one foreground agent as a custom message, never as a turn of its own. */
function notify(ctx: ToolContext, notice: Notice): void {
  const pi = PI;
  if (!pi?.sendMessage) return;
  const head = notice.kind === "attention"
    ? "RSI needs a person"
    : notice.kind === "result"
      ? "RSI run finished"
      : notice.kind === "failure"
        ? "RSI run problem"
        : notice.kind === "started"
          ? "RSI task started"
          : "RSI task report";
  const where = notice.runId && notice.ticketId ? ` (run ${notice.runId}, ticket ${notice.ticketId})` : "";
  const answer = notice.kind === "attention" && notice.runId && notice.ticketId
    ? `\nAnswer with rsi_superagent action=answer run_id=${notice.runId} ticket_id=${notice.ticketId}.`
    : "";
  const text = `${head}${where}: ${notice.text}${answer}`;
  const triggerTurn = notice.kind === "attention" || notice.kind === "failure" || notice.kind === "result";
  try {
    pi.sendMessage(
      { customType: "rsi-superagent", content: text, display: true, details: notice },
      { deliverAs: "followUp", triggerTurn },
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

// ---------------------------------------------------------------- TUI status

type TuiRun = { runtime: SuperagentRuntime; started: number; title?: string };
let TUI_CTX: ToolContext | null = null;
let TUI_TIMER: ReturnType<typeof setInterval> | null = null;
const TUI_RUNS = new Map<string, TuiRun>();
const TUI_STATUS_KEY = "rsi";
const TUI_WIDGET_KEY = "rsi-runs";
const TUI_WIDGET_OPTIONS = { placement: "belowEditor" } as const;
type TuiWidgetOptions = { placement: "aboveEditor" | "belowEditor" };

function setTuiWidget(ctx: ToolContext, lines: string[] | undefined): void {
  const setWidget = ctx.ui.setWidget as unknown as (
    key: string,
    content: string[] | undefined,
    options?: TuiWidgetOptions,
  ) => void;
  setWidget(TUI_WIDGET_KEY, lines, TUI_WIDGET_OPTIONS);
}

function stopTuiTimer(): void {
  if (!TUI_TIMER) return;
  clearInterval(TUI_TIMER);
  TUI_TIMER = null;
}

function startTuiTimer(): void {
  if (TUI_TIMER) return;
  TUI_TIMER = setInterval(() => refreshTui(), 1000);
  (TUI_TIMER as { unref?: () => void }).unref?.();
}

function progressMatchesStage(summary: string, stage: string | undefined): boolean {
  if (!stage) return true;
  const text = summary.toLowerCase();
  switch (stage) {
    case "diagnose":
      return text.startsWith("diagnose");
    case "limits":
      return text.includes("limitation");
    case "seeds":
      return text.includes("seed");
    case "baseline":
      return text.includes("baseline");
    case "search":
      return text.includes("search") || text.startsWith("§3.2 round");
    case "select":
      return text.includes("select");
    case "ablations":
      return text.includes("ablation");
    case "draft":
    case "review":
      return text.includes("draft") || text.includes("review");
    case "meta":
      return text.includes("meta");
    default:
      return true;
  }
}

/** Current task tickets that are actually executing in the worker. */
export function workingTuiAgents(status: RunStatus): string[] {
  const counts = new Map<string, number>();
  for (const ticket of status.tickets) {
    if (ticket.state !== "working") continue;
    const task = String(ticket.task ?? ticket.title ?? ticket.id ?? "").trim();
    if (task) counts.set(task, (counts.get(task) ?? 0) + 1);
  }
  return [...counts.entries()].map(([task, count]) => (count > 1 ? `${task} ×${count}` : task));
}

/** Two lines per live run: identity, then current stage and progress. */
function tuiStatusLines(status: RunStatus): string[] {
  const stage =
    status.stages.find((item) => item.state === "working" || item.state === "blocked") ??
    [...status.stages].reverse().find((item) => item.state !== "done");
  const stageText = stage
    ? `${stage.section} ${stage.title} (${stage.done}/${stage.tasks})`
    : status.progress?.state ?? status.state;
  const rawProgress = status.progress?.summary?.trim() ?? "";
  // During a transition the last report can still describe the previous stage.
  // The stage rows are authoritative; never show a contradictory progress line.
  const progress = rawProgress && progressMatchesStage(rawProgress, stage?.stage) ? rawProgress : "";
  const attention = status.attention ? `NEEDS PERSON: ${status.attention}` : "";
  const agents = workingTuiAgents(status);
  const agent = agents.length
    ? `${agents.length > 1 ? "Super Agents" : "Super Agent"}: ${agents.join(", ")}`
    : "";
  const clean = (line: string) => line.replace(/\s+/g, " ").slice(0, 240);
  return [
    clean(`${status.run_id} · ${status.run_ticket_id ?? "ticket pending"}`),
    clean([stageText, progress, attention, agent].filter(Boolean).join(" · ")),
  ];
}

/** Refresh the persistent widget from live run state. The footer is deliberately
 * left to other extensions: showing the same live text there duplicated it. */
function refreshTui(): void {
  const ctx = TUI_CTX;
  if (!ctx) return;
  const active: RunStatus[] = [];
  for (const [runId, entry] of TUI_RUNS) {
    const status = entry.runtime.status(runId);
    if (!status || status.ended || status.state === "ended") {
      TUI_RUNS.delete(runId);
      continue;
    }
    active.push(status);
  }
  try {
    ctx.ui.setStatus(TUI_STATUS_KEY, undefined);
    if (!active.length) {
      setTuiWidget(ctx, undefined);
      stopTuiTimer();
      return;
    }
    const lines: string[] = [];
    for (const status of active) {
      if (lines.length) lines.push("");
      lines.push(...tuiStatusLines(status));
    }
    setTuiWidget(ctx, lines);
    startTuiTimer();
  } catch {
    /* TUI/RPC UI may be unavailable; the run itself must continue */
  }
}

/** Open runs that belong to this Pi process, newest state first. */
export function currentOpenRuns(
  runs: RunSummary[],
  statusOfRun: (runId: string) => RunStatus | undefined,
  processStarted: string,
): RunSummary[] {
  return runs.filter((run) => {
    if (run.updated_at < processStarted) return false;
    const status = statusOfRun(run.run_id);
    return !!status && !status.ended && status.state !== "ended";
  });
}

/** Reattach open runs after /reload or a session switch. The run's state file
 * is the source of truth; only runs updated in this Pi process are current. */
function discoverTuiRuns(ctx: ToolContext): void {
  try {
    const runtime = runtimeFor(ctx);
    const processStarted = new Date(Date.now() - process.uptime() * 1000).toISOString();
    for (const run of currentOpenRuns(runtime.list(), (runId) => runtime.status(runId), processStarted)) {
      if (!TUI_RUNS.has(run.run_id)) {
        TUI_RUNS.set(run.run_id, { runtime, started: Date.now(), title: run.title });
      }
    }
  } catch {
    /* the widget is best-effort; protocol state remains on disk */
  }
  refreshTui();
}

function trackTuiRun(
  ctx: ToolContext,
  runtime: SuperagentRuntime,
  session: { runId: string; done: Promise<unknown> },
  title?: string,
): void {
  TUI_CTX = ctx;
  TUI_RUNS.set(session.runId, { runtime, started: Date.now(), title });
  refreshTui();
  const untrack = () => {
    TUI_RUNS.delete(session.runId);
    refreshTui();
  };
  void session.done.then(untrack, untrack);
}

function trackTuiResume(
  ctx: ToolContext,
  runtime: SuperagentRuntime,
  action: string,
  response: { details: Record<string, unknown> },
): void {
  if (action !== "resume") return;
  const runId = response.details.run_id;
  if (typeof runId !== "string") return;
  const session = runtime.session(runId);
  if (session) trackTuiRun(ctx, runtime, session, runId);
}

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
  const route = sessionRoute(ctx, params.provider, params.model);
  tokenOverride(params.max_tokens, "max_tokens");
  tokenOverride(params.coding_max_tokens, "coding_max_tokens");
  if (params.mode !== "mock" && (!route.provider || !route.model)) throw new Error("Select a model in Pi or explicitly provide provider/model");
  const dispatch: DispatchParams = {
    problem: params.problem,
    out: params.out,
    seed: params.seed,
    mode: params.mode ?? "provider",
    agents: params.agents ?? "subagent",
    runner: params.runner ?? "simulated",
    provider: route.provider,
    model: route.model,
    coding_model: params.coding_model ?? process.env.RSI_CODING_MODEL,
    title: params.title,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    thinking: params.thinking ?? ctx.thinkingLevel,
    options: {
      web_search: params.web_search ?? true,
      script: params.script,
      strict_directions: params.strict_directions,
      max_refine_rounds: params.max_refine_rounds,
      max_review_refinements: params.max_review_refinements,
      max_tokens: params.max_tokens,
      coding_max_tokens: params.coding_max_tokens,
      baseline: params.baseline,
    },
  };
  const { session, duplicate } = runtime.dispatch(dispatch);
  trackTuiRun(ctx, runtime, session, dispatch.title);
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

function parseCommandArgs(args: string): { positional: string[]; flags: Record<string, string | boolean>; repeated: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^["']|["']$/g, "");
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1]?.replace(/^["']|["']$/g, "");
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        (repeated[key] ??= []).push(next);
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags, repeated };
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

/** Real subprocess authority uses the same live sop.experiment rule as research runs. */
async function smokeResponse(params: AdapterSmokeParams, ctx: ToolContext, signal?: AbortSignal, onUpdate?: Progress) {
  try {
    signal?.throwIfAborted();
    const policy = HOST.policy.settings;
    const rule = policy.rules.find(item => item.id === "sop.experiment");
    if (policy.paused || !rule?.enabled) throw new Error("RSI experiment execution is paused or disabled by policy");
    if (rule.level === "person") {
      if (!ctx.hasUI) throw new Error("sop.experiment requires a person's fresh authorization; no UI is available. Ask the operator to authorize experiment policy explicitly.");
      const approved = await ctx.ui.confirm("Run a real remote adapter experiment?", `Problem: ${params.problem}\nRepository: ${params.repo ?? "fixture repo"}\nThis executes committed target code and can spend GPU time. No training budget is guessed.`);
      if (!approved) throw new Error("Adapter smoke cancelled: experiment not authorized");
      // A concurrent policy pause must still win over an earlier approval.
      const current = HOST.policy.settings;
      if (current.paused || !current.rules.find(item => item.id === "sop.experiment")?.enabled) throw new Error("RSI experiment execution is paused or disabled by policy");
    }
    const result = await adapterSmoke(params, {
      cwd: ctx.cwd, signal,
      onProgress: text => onUpdate?.({ content: [{ type: "text", text }], details: { stage: "adapter-smoke" } }),
    });
    return {
      content: [{ type: "text" as const, text: `Adapter smoke ${result.status}: ${result.run_id}\n${result.error ? `${result.error}\n` : ""}Plumbing only; training/end-to-end readiness remains unverified.\nEvidence: ${result.summary_path}` }],
      details: { ...result } as Record<string, unknown>,
      isError: result.status !== "ok",
    };
  } catch (error) {
    return { content: [{ type: "text" as const, text: String(error) }], details: { status: "failed", error: String(error) } as Record<string, unknown>, isError: true };
  }
}

/** Native bounded work stays in this foreground invocation, never a background SOP. */
async function iterationResponse(params: IterationParams, ctx: ToolContext, signal?: AbortSignal, onUpdate?: Progress) {
  try {
    signal?.throwIfAborted();
    if (!params.problem?.trim()) throw new Error("problem is required");
    if (typeof params.adapter_acceptance !== "string" || !params.adapter_acceptance.trim()) throw new Error("adapter_acceptance is required: pass the accepted native smoke-summary.json receipt");
    if (params.seed !== undefined && !Number.isInteger(params.seed)) throw new Error("seed must be an integer");
    tokenOverride(params.max_tokens, "max_tokens");
    tokenOverride(params.coding_max_tokens, "coding_max_tokens");
    for (const key of ["repo", "out", "provider", "model"] as const) {
      if (params[key] !== undefined && !params[key]?.trim()) throw new Error(`${key} must not be empty`);
    }
    // These are the actual existing policy rules for spending, coding and execution.
    // A direct native request carries explicit authority, like rsi_adapter_smoke;
    // a person-level rule still needs fresh UI approval or an explicit policy grant.
    const rules = ["sop.spend", "sop.search", "sop.experiment"];
    const approvals = new Set<string>();
    const checkPolicy = () => {
      const policy = HOST.policy.settings;
      if (policy.paused) throw new Error("RSI iteration execution is paused by policy");
      return rules.map(id => {
        const rule = policy.rules.find(item => item.id === id);
        if (!rule?.enabled) throw new Error(`${id} is disabled by policy`);
        return rule;
      });
    };
    // Re-read after every awaited dialog: a concurrent pause/change must win.
    for (;;) {
      const pending = checkPolicy().filter(rule => rule.level === "person" && !approvals.has(rule.id));
      if (!pending.length) break;
      if (!ctx.hasUI) throw new Error(`${pending.map(rule => rule.id).join(", ")} requires a person's fresh authorization; no UI is available. Ask the operator to authorize policy explicitly.`);
      const approved = await ctx.ui.confirm("Run one real bounded RSI iteration?", `Problem: ${params.problem}\nRepository: ${params.repo ?? "fixture repo"}\nAuthority: ${pending.map(rule => rule.id).join(", ")}\nExactly two identical-budget subset experiments: immutable baseline, then one changed candidate. Real model calls, git branches/commits and possible GPU time. No full benchmark, ablation or paper; no simulated fallback.`);
      if (!approved) throw new Error("RSI iteration cancelled: work not authorized");
      signal?.throwIfAborted();
      for (const rule of pending) approvals.add(rule.id);
    }
    const problem = loadProblem(params.problem, ctx.cwd);
    if (params.repo) problem.repo = params.repo.replace(/^@/, "");
    if (!problem.repo || !problem.repo_ref) throw new Error("adapter_acceptance requires a real local target repository and explicit problem.repo_ref");
    problem.repo = path.resolve(ctx.cwd, problem.repo);
    if (!fs.existsSync(problem.repo)) throw new Error("adapter_acceptance target repository does not exist");
    const receiptPath = path.resolve(ctx.cwd, params.adapter_acceptance.replace(/^@/, ""));
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (receipt?.status !== "ok" || receipt.pipeline_metadata_validated !== true) {
      throw new Error("adapter_acceptance requires status=ok and pipeline_metadata_validated=true");
    }
    // Receipt metadata is a gate, not independent verification of its underlying artifacts.
    const details = receipt.pipeline_details;
    if (details?.training_skipped !== false || !Number.isInteger(details.executed_train_steps) || details.executed_train_steps <= 0 ||
        details.checkpoint_step !== details.executed_train_steps ||
        ![details.checkpoint, details.raw_metrics].every(value => typeof value === "string" && value.trim())) {
      throw new Error("adapter_acceptance requires validated training/checkpoint pipeline_details from native smoke");
    }
    const resolved = spawnSync("git", ["-C", problem.repo, "rev-parse", "--verify", "--end-of-options", `${problem.repo_ref}^{commit}`], { encoding: "utf8", timeout: 10_000 });
    if (resolved.error || resolved.status !== 0) throw new Error(`adapter_acceptance cannot resolve problem.repo_ref: ${resolved.error ?? resolved.stderr}`);
    const commit = resolved.stdout.trim();
    if (receipt.repo?.commit !== commit) throw new Error(`adapter_acceptance commit mismatch: receipt ${receipt.repo?.commit ?? "missing"}, target ${commit}`);
    signal?.throwIfAborted();
    checkPolicy();
    // out names the run itself. runIteration atomically creates it and refuses reuse.
    const root = path.resolve(ctx.cwd, params.out?.replace(/^@/, "") ?? path.join("runs", `iteration-${randomUUID()}`));
    const route = sessionRoute(ctx, params.provider, params.model);
    const providerId = route.provider;
    const model = route.model;
    if (!providerId || !model) throw new Error("Select a model in Pi or explicitly provide provider/model");
    const provider = new PiLLMProvider({ registry: ctx.modelRegistry, providerId, defaultModel: model,
      sessionModel: ctx.model, sessionId: ctx.sessionManager?.getSessionId?.(), thinkingLevel: ctx.thinkingLevel, signal });
    const result = await runIteration({ problem, provider, cwd: ctx.cwd, outDir: path.dirname(root), runId: path.basename(root),
      seed: params.seed, model, maxTokens: params.max_tokens, codingMaxTokens: params.coding_max_tokens, env: params.env, protectedPaths: params.protected_paths,
      scope: params.scope,
      baselineMode: params.baseline_mode,
      signal,
      configOverrides: { modelRoutes: { default: modelRoute({ provider: providerId, model }), coding: modelRoute({ provider: providerId, model }) } },
      onProgress: text => onUpdate?.({ content: [{ type: "text", text }], details: { stage: "iteration" } }),
    });
    const artifacts = { summary: path.join(result.root, "summary.json"), iteration: path.join(result.root, "iteration.json"),
      protocol: path.join(result.root, "artifacts/protocol.json"), baseline: path.join(result.root, "artifacts/baseline.json"),
      candidate: path.join(result.root, "artifacts/candidate.json"), diff: path.join(result.root, "artifacts/candidate.diff"),
      traces: path.join(result.root, "traces.jsonl") };
    return {
      content: [{ type: "text" as const, text: [
        `RSI iteration ${result.outcome.toUpperCase()}: ${result.runId} (${result.status})`,
        result.outcome === "rejected" ? `Completed ${params.scope ?? "subset"} measurement; candidate rejected. Incumbent unchanged (${result.baselineSource} baseline). No improvement claimed.` : result.outcome === "accepted" ? (params.scope === "full"
          ? `Candidate measured better under the FULL protocol and was PROMOTED as the formal incumbent (${result.baselineSource} baseline). Retain raw report, training trace and checkpoint-reload evidence; still not a peer-reviewed claim.`
          : `Candidate measured better and was PROMOTED as the cheap subset incumbent (${result.baselineSource} baseline). This does NOT establish the formal baseline; use --scope full for that.`) : `Failed: ${result.errors.join("; ").slice(0, 4000)}`,
        "Target owns training, checkpoint save/reload and evaluation; inspect its retained raw reports for pipeline evidence.",
        `Summary: ${artifacts.summary}`, `Evidence: ${artifacts.iteration}`, `Protocol: ${artifacts.protocol}`,
      ].join("\n") }],
      details: { run_id: result.runId, root: result.root, status: result.status, executed: result.executed,
        accepted: result.accepted, promoted: result.promoted, baseline_source: result.baselineSource,
        incumbent_path: result.incumbentPath, outcome: result.outcome, summary: result.summary, errors: result.errors, artifacts } as Record<string, unknown>,
      isError: result.status === "failed",
    };
  } catch (error) {
    return { content: [{ type: "text" as const, text: String(error) }], details: { status: "failed", executed: false, accepted: false, outcome: "error", error: String(error) } as Record<string, unknown>, isError: true };
  }
}


// ---------------------------------------------------------------- remote jobs

interface JobSubmitParams {
  problem: string;
  repo?: string;
  scope?: string;
  env?: Record<string, string>;
  timeout_s?: number;
  job_worker?: string;
  wait?: boolean;
}

interface JobParams { job_id: string; timeout_s?: number }

const JOB_SUBMIT_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    problem: { type: "string", minLength: 1, description: "Problem fixture with repo, repo_ref, experiment_command and remote." },
    repo: { type: "string", description: "Local target repository override." },
    scope: { type: "string", enum: ["subset", "full", "ablation", "rebuttal"], description: "Scope passed to the adapter." },
    env: { type: "object", additionalProperties: { type: "string" }, description: "Remote environment overrides for this job." },
    timeout_s: { type: "number", exclusiveMinimum: 0, description: "Server-side job timeout (adapter training + evaluation)." },
    job_worker: { type: "string", description: "Target-owned worker path, default bench/rsi_job_worker.py." },
    wait: { type: "boolean", description: "true blocks until the job ends (headless CLI); false returns immediately and wakes this session on completion (interactive)." },
  },
  required: ["problem"],
  additionalProperties: false,
};

const EMPTY_PARAMS: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

const JOB_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    job_id: { type: "string", minLength: 1 },
    timeout_s: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["job_id"],
  additionalProperties: false,
};

const JOB_WATCHERS = new Map<string, AbortController>();

function gitOut(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}

function jobLedgerDir(ctx: ToolContext): string {
  return path.resolve(ctx.cwd, "runs", "jobs");
}

async function jobHandleOf(id: string, ctx: ToolContext): Promise<JobHandle> {
  const ledger = readLedger(jobLedgerDir(ctx), id);
  if (!ledger) throw new Error(`unknown job: ${id} (no local ledger under runs/jobs)`);
  return ledger as unknown as JobHandle;
}

function jobText(handle: JobHandle, events: JobEvent[], result?: JobResult | null, state?: string): string {
  const last = events.at(-1);
  const metrics = (result?.report as { metrics?: Record<string, number> } | null)?.metrics;
  return [
    `job ${handle.jobId}: ${state ?? last?.event ?? "submitted"}`,
    `commit ${handle.commit}  gpu ${handle.gpuIds}  host ${handle.host}`,
    metrics ? `metrics ${JSON.stringify(metrics)}` : "",
    `events ${events.length} (last seq ${last?.seq ?? 0})  dir ${handle.remoteDir}`,
    result?.error ? `error ${result.error}` : "",
  ].filter(Boolean).join("\n");
}

function notifyJob(ctx: ToolContext, handle: JobHandle, result: JobResult): void {
  const metrics = (result.report as { metrics?: Record<string, number> } | null)?.metrics ?? {};
  const text = `RSI job ${handle.jobId} ${result.status.toUpperCase()} (${Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(", ") || "no metrics"})\nEvidence: ${handle.remoteDir}`;
  try {
    PI?.sendMessage?.({ customType: "rsi-job", content: text, display: true, details: { ...handle, result } },
      { deliverAs: "followUp", triggerTurn: true });
  } catch {
    ctx.ui.notify(text, result.status === "ok" ? "info" : "warning");
  }
}

async function jobSubmitResponse(params: JobSubmitParams, ctx: ToolContext, signal?: AbortSignal) {
  const problem = loadProblem(params.problem, ctx.cwd);
  if (params.repo) problem.repo = path.resolve(ctx.cwd, params.repo.replace(/^@/, ""));
  if (!problem.repo) throw new Error("job submit requires problem.repo or --repo");
  if (!problem.remote) throw new Error("job submit requires a remote configuration");
  if (!problem.experiment_command?.length) throw new Error("problem.experiment_command is required");
  const repo = path.resolve(problem.repo);
  const commit = gitOut(repo, ["rev-parse", "--verify", "--end-of-options", `${problem.repo_ref ?? "HEAD"}^{commit}`]);
  const scope = params.scope ?? "subset";
  const timeoutS = params.timeout_s ?? problem.remote.timeout_s ?? 900;
  const env = { ...problem.remote.env, ...(params.env ?? {}), RSI_SEED: String(process.env.RSI_SEED ?? "7") };
  const digest = "sha256:" + createHash("sha256")
    .update(stableString({ command: problem.experiment_command, scope, env, metrics: problem.metrics, datasets: problem.subset_datasets }))
    .digest("hex");
  fs.mkdirSync(jobLedgerDir(ctx), { recursive: true });
  const snapshot = fs.mkdtempSync(path.join(jobLedgerDir(ctx), "snapshot-"));
  try {
    gitOut(repo, ["worktree", "add", "--detach", snapshot, commit]);
    const handle = await submitJob({
      remote: problem.remote, repoPath: snapshot, commit, scope,
      command: problem.experiment_command, env, timeoutS,
      jobWorker: params.job_worker ?? problem.job_worker ?? undefined,
      protocolDigest: digest, ledgerDir: jobLedgerDir(ctx), signal,
    });
    if (params.wait) {
      const waited = await waitForJob(handle, { timeoutS: Math.min(3600, timeoutS + 300), ledgerDir: jobLedgerDir(ctx), transport: undefined, signal });
      return { content: [{ type: "text" as const, text: jobText(handle, waited.events, waited.result, waited.state) }], details: { handle, ...waited } as Record<string, unknown>, isError: waited.state !== "ok" };
    }
    // Interactive: the turn ends now; the event stream wakes this session later.
    const controller = new AbortController();
    JOB_WATCHERS.set(handle.jobId, controller);
    void watchJob(handle, { ledgerDir: jobLedgerDir(ctx), signal: controller.signal })
      .then(({ result }) => { JOB_WATCHERS.delete(handle.jobId); notifyJob(ctx, handle, result); })
      .catch((error) => { JOB_WATCHERS.delete(handle.jobId); ctx.ui.notify(`RSI job ${handle.jobId} watcher: ${String(error)}`, "warning"); });
    return {
      content: [{ type: "text" as const, text: `${jobText(handle, [], null, "submitted")}\nThis turn ends now. The completion event will wake the session (use wait=true for headless CLI).` }],
      details: { handle } as Record<string, unknown>,
    };
  } finally {
    try { gitOut(repo, ["worktree", "remove", "--force", snapshot]); } catch { /* best effort */ }
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

async function jobStatusResponse(params: JobParams, ctx: ToolContext) {
  const handle = await jobHandleOf(params.job_id, ctx);
  const events = await readEvents(handle);
  const terminal = terminalEvent(events);
  let result: JobResult | null = null;
  if (terminal) {
    const fetched = await readResult(handle);
    if (fetched) result = verifyResult(handle, fetched.raw, fetched.result, terminal);
  }
  return { content: [{ type: "text" as const, text: jobText(handle, events, result) }], details: { handle, events, result } as Record<string, unknown> };
}

async function jobWaitResponse(params: JobParams, ctx: ToolContext) {
  const handle = await jobHandleOf(params.job_id, ctx);
  const waited = await waitForJob(handle, { timeoutS: params.timeout_s ?? 60, ledgerDir: jobLedgerDir(ctx) });
  return {
    content: [{ type: "text" as const, text: jobText(handle, waited.events, waited.result, waited.state) }],
    details: { handle, ...waited } as Record<string, unknown>,
    isError: waited.state !== "ok" && waited.state !== "running",
  };
}

async function jobCancelResponse(params: JobParams, ctx: ToolContext) {
  const handle = await jobHandleOf(params.job_id, ctx);
  await cancelJob(handle);
  return { content: [{ type: "text" as const, text: `cancel requested for ${handle.jobId}; the worker stops the process group and publishes an event` }], details: { handle } as Record<string, unknown> };
}

// ---------------------------------------------------------------- extension

export default function rsiExtension(pi: ExtensionAPI): void {
  PI = pi;

  (pi as any).on?.("session_start", async (_event: unknown, ctx: any) => {
    TUI_CTX = ctx as ToolContext;
    try {
      const processStarted = new Date(Date.now() - process.uptime() * 1000).toISOString();
      runtimeFor(TUI_CTX).recoverStaleRuns(processStarted);
    } catch {
      /* status remains readable even if recovery is unavailable */
    }
    discoverTuiRuns(TUI_CTX);
  });

  (pi as any).on?.("session_shutdown", async (event: any) => {
    const ctx = TUI_CTX;
    const reason = `session ${String(event?.reason ?? "shutdown")}`;
    // Reload/new/resume/quit all tear down this extension instance. Interrupt
    // live runs first so their state/final and protocol tickets are durable.
    const runtimes = [...HOST.runtimes.values()];
    HOST.runtimes.clear();
    for (const runtime of runtimes) {
      try {
        await runtime.interruptAll(reason);
      } catch {
        /* the runtime may already be gone */
      }
    }
    TUI_RUNS.clear();
    stopTuiTimer();
    if (ctx) {
      try {
        ctx.ui.setStatus(TUI_STATUS_KEY, undefined);
        setTuiWidget(ctx, undefined);
      } catch {
        /* the UI may already be gone */
      }
    }
    TUI_CTX = null;
  });

  pi.registerTool({
    name: "rsi_research",
    label: "RSI Research Run",
    description:
      "Accept one research request and start the ScientistTwo SOP as a superagent run: limitations → seed ideas → " +
      "reproduce baseline → subset/full experiments with critics and engineering → ablations → draft + peer review → " +
      "meta-review → integrity. Every promotion requires a strict measured improvement over the reproduced baseline. " +
      "A stored or explicitly provided baseline is reused; only a missing scope is reproduced. " +
      "Returns immediately with a run id; reports arrive when the run ends or needs a person.",
    parameters: RESEARCH_PARAMS,
    promptSnippet:
      "Accept a research request as one run ticket; the SOP's agent calls run as background task tickets.",
    promptGuidelines: [
      orchestratorBriefing(),
      "Use rsi_research for the complete autonomous ScientistTwo SOP or an experiment-backed paper draft. Use rsi_iteration instead for exactly one bounded optimization cycle; do not launch the full SOP for that request.",
      "Use rsi_research with mode=mock only when the person explicitly requests an offline dry run; never substitute it for requested real optimization.",
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
    name: "rsi_job_submit",
    label: "RSI Submit Remote Job",
    description: "Snapshot the candidate worktree, write an immutable job request and launch the target-owned worker over SSH with setsid/nohup. Returns immediately with a job id; the completion event wakes this session (wait=true for headless CLI). The server never dials back: events are read over SSH.",
    parameters: JOB_SUBMIT_PARAMS,
    promptSnippet: "Submit an event-driven remote experiment job and continue when its completion event arrives.",
    promptGuidelines: [
      "Use rsi_job_submit when a target declares bench/rsi_job_worker.py; it returns immediately and completion arrives as an rsi-job message.",
      "In headless/print mode pass wait=true, because the process exits before a background watcher can wake it.",
      "Never claim a job finished without reading its result events; a dropped SSH stream is not a job failure.",
    ],
    executionMode: "sequential",
    async execute(_toolCallId, params: JobSubmitParams, signal, _onUpdate, ctx) {
      try {
        return await jobSubmitResponse(params, ctx, signal);
      } catch (error) {
        return { content: [{ type: "text" as const, text: String(error) }], details: { status: "failed", error: String(error) } as Record<string, unknown>, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "rsi_job_status",
    label: "RSI Job Status",
    description: "Read the job event log and, on a terminal event, fetch and verify the atomic result (id, commit, protocol, hash).",
    parameters: JOB_PARAMS,
    promptSnippet: "Check an RSI remote job's events and verified result.",
    promptGuidelines: ["Use rsi_job_status after a completion notice, or when the user asks whether a job is running."],
    async execute(_toolCallId, params: JobParams, _signal, _onUpdate, ctx) {
      return jobStatusResponse(params, ctx);
    },
  });

  pi.registerTool({
    name: "rsi_job_wait",
    label: "RSI Job Wait",
    description: "Bounded wait on a remote job. A timeout returns running, never failed; the job keeps running on the server.",
    parameters: JOB_PARAMS,
    promptSnippet: "Wait a bounded time for an RSI job, without treating a timeout as failure.",
    promptGuidelines: ["Use rsi_job_wait in headless runs; keep the bound short and re-check instead of blocking indefinitely."],
    async execute(_toolCallId, params: JobParams, _signal, _onUpdate, ctx) {
      return jobWaitResponse(params, ctx);
    },
  });

  pi.registerTool({
    name: "rsi_job_cancel",
    label: "RSI Job Cancel",
    description: "Write a cancel request; the worker terminates the process group and publishes a terminal event.",
    parameters: JOB_PARAMS,
    promptSnippet: "Cancel a running RSI remote job.",
    promptGuidelines: ["Use rsi_job_cancel only when the user asks to stop a job."],
    async execute(_toolCallId, params: JobParams, _signal, _onUpdate, ctx) {
      return jobCancelResponse(params, ctx);
    },
  });

  pi.registerTool({
    name: "rsi_job_list",
    label: "RSI Jobs",
    description: "List local job ledgers under runs/jobs with state and last event sequence.",
    parameters: EMPTY_PARAMS,
    promptSnippet: "List submitted RSI jobs and their last known state.",
    promptGuidelines: ["Use rsi_job_list when the user asks which jobs exist or after restarting Pi."],
    async execute(_toolCallId, _params: Record<string, never>, _signal, _onUpdate, ctx) {
      const rows = listLedger(jobLedgerDir(ctx));
      return {
        content: [{ type: "text" as const, text: rows.length ? rows.map((row) => `${row.jobId} ${row.state ?? "?"} seq=${row.last_seq ?? 0}`).join("\n") : "no jobs under runs/jobs" }],
        details: { jobs: rows } as Record<string, unknown>,
      };
    },
  });

  pi.registerTool({
    name: "rsi_adapter_smoke",
    label: "RSI Adapter Smoke",
    description: "Execute one real remote baseline at the target repo_ref through GitWorkspace and RemoteRunner. Validate the original adapter status and exact finite bounded metrics; preserve raw reports, stdout, remote failures and JSON summary. Does not prove scientific reproduction or training. Returns concise paths, not unbounded logs. Requires experiment execution authority.",
    parameters: ADAPTER_SMOKE_PARAMS,
    promptSnippet: "Smoke-test a prepared target-repository adapter with real remote execution and retained evidence.",
    promptGuidelines: [
      "Use rsi_adapter_smoke only after a person authorizes real subprocess/GPU execution and the target adapter and protocol are prepared.",
      "Pass the actual documented protocol environment to rsi_adapter_smoke; never invent budgets or datasets, and never claim training from a plumbing-only smoke.",
    ],
    executionMode: "sequential",
    async execute(_toolCallId, params: AdapterSmokeParams, signal, onUpdate, ctx) {
      return smokeResponse(params, ctx, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "rsi_iteration",
    label: "RSI Bounded Iteration",
    description: "Execute exactly one real bounded optimization through the generic runIteration API: pinned baseline, one idea and implementation, one changed candidate, measured accept/reject and retained evidence. scope=subset is a cheap screen with a separate cheap incumbent; scope=full uses the formal stage budget and full test with its own formal ledger. Blocks until completion; no ablation, paper, background worker or simulated/mock fallback. Requires live experiment, coding and model-spend authority. Returns concise evidence paths, not raw logs.",
    parameters: ITERATION_PARAMS,
    promptSnippet: "Run exactly one real small-budget baseline/candidate subset optimization and return its measured outcome.",
    promptGuidelines: [
      "Use rsi_iteration, not rsi_research, when the person requests exactly one bounded/small-budget optimization cycle after target adapter preparation.",
      "rsi_iteration requires adapter_acceptance: the native smoke-summary.json receipt for the exact tested repo_ref commit. Before passing it, inspect the actual underlying real tiny training → new checkpoint → fresh-process reload → real lm-eval artifacts; smoke readiness intentionally remains unverified. Never use untested refs or promote/modify refs to bypass this receipt gate.",
      "Pass the person's exact problem and pinned repo_ref, documented small-budget env overrides, requested seed and fresh out directory to rsi_iteration. Baseline and candidate must share the same protocol. Never invent training budgets, change the evaluator/tokenizer/data, or run a full benchmark, paper or ablation.",
      "rsi_iteration always uses real Pi providers and subprocess execution. Never fall back automatically to mock/simulated work or claim improvement for a rejected/failed candidate. The target owns train → checkpoint save/reload → real evaluation; check raw pipeline evidence before claiming it completed.",
      "rsi_iteration inherits the current Pi model, thinking and native output policy by default. On length/no final text inspect actual usage; only use explicit max_tokens/coding_max_tokens when the user requests an override. Never confuse model context/output capability with training budgets or scientific protocol permissions.",
    ],
    executionMode: "sequential",
    async execute(_toolCallId, params: IterationParams, signal, onUpdate, ctx) {
      return iterationResponse(params, ctx, signal, onUpdate);
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
      const runtime = runtimeFor(ctx);
      const host = {
        runtime: () => runtime,
        policy: () => HOST.policy.settings,
        applyPolicy,
      };
      const response = await superagentAction(host, params);
      if (typeof params.action === "string") {
        trackTuiResume(ctx, runtime, params.action, response);
      }
      return response;
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
    description: "RSI superagent: run | smoke | iterate | status | resume | tickets | ticket | events | policy | answer | note | retry | stop | inspect | replay | list | models | help",
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
        trackTuiResume(ctx, runtime, action, response);
        ctx.ui.notify(response.content[0]?.text ?? "(no output)", response.isError ? "warning" : "info");
        return response;
      };

      if (sub === "help" || sub === "--help") {
        ctx.ui.notify(
          [
            "/rsi run <problem.json> [--mock] [--inline] [--wait] [--seed 7] [--out runs] [--provider opencode-go] [--model ID]",
            "         [--runner simulated|subprocess] [--thinking low] [--max-refine-rounds N] [--max-review-refinements N] [--baseline PATH]",
            "/rsi job submit|status|wait|cancel|list [job_id] [--repo PATH] [--scope subset] [--timeout N] [--env K=V ...] [--wait]",
            "/rsi smoke <problem.json> [--repo PATH] [--out NEW_DIR] [--timeout 900] [--env KEY=VALUE ...]",
            "/rsi iterate <problem.json> --adapter-acceptance PATH [--repo PATH] [--out NEW_DIR] [--env KEY=VALUE ...] [--provider opencode-go] [--model ID]",
            "         [--seed 7] [--max-tokens N] [--coding-max-tokens N] [--baseline-mode reuse|paired] [--protected-path PATH ...] (no artificial LLM/wall caps)",
            "/rsi status [run_id]        protocol state of a run, or all runs",
            "/rsi resume <run_id>        start a new attempt from an aborted/failed run",
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

      if (sub === "iterate") {
        const usage = "usage: /rsi iterate <problem> --adapter-acceptance PATH [--repo PATH] [--out NEW_DIR] [--env KEY=VALUE ...] [--provider ID] [--model ID] [--seed 7] [--max-tokens N] [--coding-max-tokens N] [--scope subset|full] [--baseline-mode reuse|paired] [--protected-path PATH ...]";
        const allowed = new Set(["adapter-acceptance", "repo", "out", "env", "provider", "model", "seed", "max-tokens", "coding-max-tokens", "scope", "baseline-mode", "protected-path"]);
        const fail = (message: string) => ctx.ui.notify(`${message}\n${usage}`, "warning");
        if (args.positional.length !== 2) { fail("Exactly one problem path or quoted inline JSON is required."); return; }
        for (const [key, value] of Object.entries(args.flags)) {
          if (!allowed.has(key)) { fail(`Unknown iterate flag: --${key}`); return; }
          if (value === true) { fail(`--${key} requires a value`); return; }
          if (!["env", "protected-path"].includes(key) && (args.repeated[key]?.length ?? 0) > 1) { fail(`--${key} may only be supplied once`); return; }
        }
        const adapterAcceptance = flagString(args.flags, "adapter-acceptance");
        if (!adapterAcceptance?.trim()) { fail("--adapter-acceptance PATH is required"); return; }
        const env: Record<string, string> = {};
        for (const value of args.repeated.env ?? []) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
          if (!match) { fail(`invalid --env: ${value}; expected KEY=VALUE`); return; }
          if (Object.hasOwn(env, match[1])) { fail(`Duplicate --env assignment: ${match[1]}`); return; }
          env[match[1]] = match[2];
        }
        for (const key of ["seed", "max-tokens", "coding-max-tokens"]) {
          if (args.flags[key] !== undefined && (flagString(args.flags, key)?.trim() === "" || flagNumber(args.flags, key) === undefined)) { fail(`--${key} requires a finite number`); return; }
        }
        const response = await iterationResponse({ problem: args.positional[1], adapter_acceptance: adapterAcceptance, repo: flagString(args.flags, "repo"),
          out: flagString(args.flags, "out"), env, provider: flagString(args.flags, "provider"), model: flagString(args.flags, "model"),
          seed: flagNumber(args.flags, "seed"), scope: (() => {
            const value = flagString(args.flags, "scope");
            if (value !== undefined && value !== "subset" && value !== "full") { fail("--scope must be subset or full"); return undefined; }
            return value as "subset" | "full" | undefined;
          })(), max_tokens: flagNumber(args.flags, "max-tokens"), coding_max_tokens: flagNumber(args.flags, "coding-max-tokens"),
          baseline_mode: (() => {
            const value = flagString(args.flags, "baseline-mode");
            if (value !== undefined && value !== "reuse" && value !== "paired") { fail("--baseline-mode must be reuse or paired"); return undefined; }
            return value as "reuse" | "paired" | undefined;
          })(),
          protected_paths: args.repeated["protected-path"],
        }, ctx, ctx.signal);
        ctx.ui.notify(response.content[0]?.text ?? "RSI iteration finished", response.isError ? "warning" : "info");
        return;
      }

      if (sub === "job") {
        const action = args.positional[1] ?? "list";
        try {
          if (action === "submit") {
            const problem = args.positional[2];
            if (!problem) { ctx.ui.notify("usage: /rsi job submit <problem> [--repo PATH] [--scope subset] [--timeout 900] [--env K=V ...] [--wait]", "warning"); return; }
            const env: Record<string, string> = {};
            for (const value of args.repeated.env ?? []) {
              const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
              if (!match) { ctx.ui.notify(`invalid --env: ${value}`, "warning"); return; }
              env[match[1]] = match[2];
            }
            const response = await jobSubmitResponse({
              problem, repo: flagString(args.flags, "repo"), scope: flagString(args.flags, "scope"), env,
              timeout_s: flagNumber(args.flags, "timeout"), job_worker: flagString(args.flags, "job-worker"),
              wait: args.flags.wait === true || args.flags.wait === "true",
            }, ctx, ctx.signal);
            ctx.ui.notify(response.content[0]?.text ?? "job submitted", response.isError ? "warning" : "info");
            return;
          }
          const job_id = args.positional[2];
          if (!job_id) { ctx.ui.notify(`usage: /rsi job ${action} <job_id>`, "warning"); return; }
          const response: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean } | null = action === "status" ? await jobStatusResponse({ job_id }, ctx)
            : action === "wait" ? await jobWaitResponse({ job_id, timeout_s: flagNumber(args.flags, "timeout") }, ctx)
            : action === "cancel" ? await jobCancelResponse({ job_id }, ctx)
            : null;
          if (!response) { ctx.ui.notify("usage: /rsi job submit|status|wait|cancel|list", "warning"); return; }
          ctx.ui.notify(response.content[0]?.text ?? "job", response.isError ? "warning" : "info");
        } catch (error) {
          ctx.ui.notify(String(error), "warning");
        }
        return;
      }

      if (sub === "job-list") {
        const rows = listLedger(jobLedgerDir(ctx));
        ctx.ui.notify(rows.length ? rows.map((row) => `${row.jobId} ${row.state ?? "?"} seq=${row.last_seq ?? 0}`).join("\n") : "no jobs under runs/jobs", "info");
        return;
      }

      if (sub === "smoke") {
        const problem = args.positional[1];
        if (!problem) {
          ctx.ui.notify("usage: /rsi smoke <problem> [--repo PATH] [--out NEW_DIR] [--timeout 900] [--env KEY=VALUE ...]", "warning");
          return;
        }
        const env: Record<string, string> = {};
        for (const value of args.repeated.env ?? []) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
          if (!match) {
            ctx.ui.notify(`invalid --env: ${value}; expected KEY=VALUE`, "warning");
            return;
          }
          env[match[1]] = match[2];
        }
        if (args.flags.env === true || args.flags.timeout === true || (args.flags.timeout !== undefined && flagNumber(args.flags, "timeout") === undefined)) {
          ctx.ui.notify("--env requires KEY=VALUE; --timeout requires a positive integer", "warning");
          return;
        }
        const response = await smokeResponse({ problem, repo: flagString(args.flags, "repo"), out: flagString(args.flags, "out"), timeout_s: flagNumber(args.flags, "timeout"), env }, ctx, ctx.signal);
        ctx.ui.notify(response.content[0]?.text ?? "Adapter smoke finished", response.isError ? "warning" : "info");
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

      if (sub === "resume") {
        const runId = args.positional[1];
        if (!runId) {
          ctx.ui.notify("usage: /rsi resume <run_id>", "warning");
          return;
        }
        await superagent("resume", { run_id: runId });
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
      for (const key of ["max-tokens", "coding-max-tokens"]) {
        if (args.flags[key] === undefined) continue;
        if ((args.repeated[key]?.length ?? 0) !== 1 || args.flags[key] === true || flagNumber(args.flags, key) === undefined) {
          ctx.ui.notify(`--${key} requires one positive integer`, "warning");
          return;
        }
        try { tokenOverride(flagNumber(args.flags, key), key); }
        catch (error) { ctx.ui.notify(String(error), "warning"); return; }
      }
      const mode = args.flags.mock ? "mock" : "provider";
      const route = sessionRoute(ctx, flagString(args.flags, "provider"), flagString(args.flags, "model"));
      const provider = route.provider;
      const model = route.model;
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
          thinking: flagString(args.flags, "thinking"),
          wait: Boolean(args.flags.wait),
          strict_directions: Boolean(args.flags["strict-directions"]),
          max_refine_rounds: flagNumber(args.flags, "max-refine-rounds"),
          max_review_refinements: flagNumber(args.flags, "max-review-refinements"),
          max_tokens: flagNumber(args.flags, "max-tokens"),
          coding_max_tokens: flagNumber(args.flags, "coding-max-tokens"),
          baseline: flagString(args.flags, "baseline"),
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
