/**
 * Superagent protocol providers.
 *
 * `PiWorker` is the worker of `agents=subagent`: one Pi session per task, its
 * own system prompt, no shared history, and the `rsi_report` tool as its only
 * way to speak. The session is disposed after the task, so a critic cannot see
 * the generator's reasoning and a coder cannot contaminate the drafter.
 *
 * `SuperagentLLMProvider` is the `LLMProvider` the RSI pipeline already knows:
 * every call opens one task ticket, the worker executes it, and the report's
 * text comes back as the model response. Retries are protocol retries on the
 * same ticket, so `state.json` shows them instead of hiding them.
 */

import { asRecord } from "../json.ts";
import { LLMError, LLMProvider, extractJson, validateMaxTokens, type LLMRequest, type LLMResponse } from "./base.ts";
import { PiLLMProvider, usageOf, type PiRegistry, type PiProviderOptions } from "./pi.ts";
import type { TaskWorker, WorkerOutcome } from "../superagent/executor.ts";
import { REPORT_PARAMETERS, REPORT_TOOL_NAME, normalizeEnvelope, outputText, payloadOf, type WorkerReportEnvelope } from "../superagent/executor.ts";
import type { Engine } from "../superagent/engine.ts";
import type { Ticket } from "../superagent/model.ts";
import { roleOfTask } from "../superagent/sop.ts";
import { workerSystem } from "../superagent/prompts.ts";

const DEFAULT_WEB_TASKS: ReadonlySet<string> = new Set(["ideas.novelty", "integrity.refs"]);
/** Coding workers inspect the target snapshot but never write it directly. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const CODE_TASK = /^(code|engineer|ablation|rebuttal)\./;

/** A report the worker produced but the protocol cannot accept as an answer. */
class WorkerReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerReportError";
  }
}

/**
 * Why a ready report is not an answer, or "" when it is. `outputText` already
 * accepts a JSON object in `output`; this only rejects a report with no
 * answer at all, or with prose where the task requires JSON.
 */
function reportProblem(envelope: WorkerReportEnvelope, schemaName?: string): string {
  if (envelope.state !== "ready") return "";
  const text = outputText(envelope.output);
  if (!text.trim()) {
    return "state=ready requires the answer in output.text, but output.text is missing or empty. " +
      `Call ${REPORT_TOOL_NAME} again with output.text set to the exact answer.`;
  }
  if (schemaName && extractJson(text) === null) {
    return `state=ready with no valid JSON for ${schemaName}: output.text must be exactly the JSON object the task asked for, with no prose. ` +
      `Call ${REPORT_TOOL_NAME} again with that JSON in output.text.`;
  }
  return "";
}

/** The corrective text added to a retry after a report was not accepted. */
function reportRetryHint(error: unknown): string {
  if (!(error instanceof WorkerReportError)) return "";
  return [
    "",
    "---",
    `The previous attempt did not produce an accepted report: ${error.message}`,
    `Report through ${REPORT_TOOL_NAME} with state=ready and output.text holding the exact JSON answer.`,
    "Do not answer in prose and do not put the answer's fields directly on output.",
  ].join("\n");
}

/** Public registry introspection; never unwrap the facade's private runtime. */
interface WorkerRegistry extends PiRegistry {
  getRegisteredProviderIds?(): readonly string[];
  getRegisteredNativeProvider?(providerId: string): any;
  getRegisteredProviderConfig?(providerId: string): any;
  getProvider?(providerId: string): any;
}

export interface PiWorkerOptions {
  cwd: string;
  registry: WorkerRegistry;
  /** Canonical parent runtime, when the host exposes it (SDK's public session option). */
  modelRuntime?: unknown;
  providerId?: string;
  defaultModel?: string;
  sessionModel?: PiProviderOptions["sessionModel"];
  sessionId?: string;
  thinkingLevel?: string;
  /** Per-task tool allowlist; empty means "decide from webTasks". */
  tools?: string[];
  webTasks?: ReadonlySet<string>;
  webSearch?: boolean;
  /** Test seam: use this SDK object instead of importing Pi. */
  sdk?: any;
}

type PiSession = {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  abort(): Promise<void>;
  dispose(): void;
  messages: Array<{ role?: string; usage?: unknown }>;
};

/** A worker session that reports through one tool call. */
export class PiWorker implements TaskWorker {
  readonly name = "pi-worker";
  readonly cwd: string;
  readonly thinkingLevel?: string;
  readonly tools: string[];
  readonly webTasks: ReadonlySet<string>;
  readonly webSearch: boolean;
  private readonly resolver: PiLLMProvider;
  private readonly registry: WorkerRegistry;
  private readonly modelRuntime?: unknown;
  private readonly sdkOverride: any;
  private sdkPromise: Promise<any> | null = null;
  private runtimePromise: Promise<any> | null = null;
  private copiedProviders = new Map<string, { native?: any; config?: any }>();
  private sessions = new Set<PiSession>();

  constructor(opts: PiWorkerOptions) {
    this.cwd = opts.cwd;
    this.thinkingLevel = opts.thinkingLevel;
    this.tools = opts.tools ?? [];
    this.webTasks = opts.webTasks ?? DEFAULT_WEB_TASKS;
    this.webSearch = opts.webSearch ?? true;
    this.sdkOverride = opts.sdk;
    this.modelRuntime = opts.modelRuntime;
    this.registry = opts.registry;
    this.resolver = new PiLLMProvider(opts);
  }

  private toolsFor(task: string): string[] {
    if (this.tools.length) return this.tools;
    // A coder asked to produce a diff must be able to inspect the source.
    // Keep the allowlist read-only: write/edit/bash would bypass the patch flow.
    if (CODE_TASK.test(task)) return READ_ONLY_TOOLS;
    if (this.webSearch && this.webTasks.has(task)) return ["web_search"];
    return [];
  }

  private async sdk(): Promise<any> {
    if (this.sdkOverride) return this.sdkOverride;
    if (!this.sdkPromise) {
      this.sdkPromise = import("@earendil-works/pi-coding-agent").catch((error) => {
        throw new LLMError(
          `Pi worker sessions are unavailable in this process (${(error as Error).message}). ` +
            "Use agents=inline or run inside a Pi session.",
        );
      });
    }
    return this.sdkPromise;
  }

  private async runtimeFor(providerId: string): Promise<any> {
    // A host that owns the public runtime can share it exactly, including
    // runtime-only credentials. A ModelRegistry facade is NOT a ModelRuntime.
    if (this.modelRuntime !== undefined) return this.modelRuntime;
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const sdk = await this.sdk();
        if (typeof sdk.ModelRuntime?.create !== "function") {
          throw new LLMError(
            "Pi worker requires the public SDK ModelRuntime.create API or a host-supplied modelRuntime; use agents=inline on older hosts.",
          );
        }
        // Match ordinary Pi's agent directory, models.json, cached catalog and
        // credential store. Keep initial cache restoration/availability checks;
        // only opt out of catalog network refresh (also the SDK default).
        return sdk.ModelRuntime.create({ allowModelNetwork: false });
      })();
    }
    const runtime = await this.runtimePromise;
    const registry = this.registry;
    const registered = registry.getRegisteredProviderIds?.();
    if (!registered && !registry.getProvider) {
      throw new LLMError("Pi worker cannot inherit providers through this registry's public APIs; supply modelRuntime or use agents=inline.");
    }
    const ids = new Set(registered ?? []);
    ids.add(providerId);
    for (const id of ids) {
      const native = registry.getRegisteredNativeProvider?.(id);
      const config = native ? undefined : registry.getRegisteredProviderConfig?.(id);
      // Global models.json providers are not extension registrations. The public
      // effective Provider preserves their native auth/stream behavior as well.
      const effective = native ?? (config ? undefined : registry.getProvider?.(id));
      if (!effective && !config) {
        if (registered?.includes(id) || !runtime.getProvider?.(id)) {
          throw new LLMError(`Pi worker cannot inherit provider '${id}' through public SDK APIs; supply modelRuntime or use agents=inline.`);
        }
        continue; // Already loaded from the normal agent directory.
      }
      const previous = this.copiedProviders.get(id);
      if (previous?.native === effective && previous?.config === config) continue;
      try {
        if (effective) runtime.registerNativeProvider(effective);
        else runtime.registerProvider(id, config);
      } catch {
        // Registration configs can contain secrets; don't serialize them or
        // propagate an SDK error that might include a raw config value.
        throw new LLMError(`Pi worker cannot copy provider '${id}' through public SDK registration APIs; supply modelRuntime or use agents=inline.`);
      }
      this.copiedProviders.set(id, { native: effective, config });
    }
    // Reuse one canonical runtime per worker, but honor live unregistration too.
    if (registered) {
      for (const id of this.copiedProviders.keys()) {
        if (!ids.has(id)) {
          runtime.unregisterProvider(id);
          this.copiedProviders.delete(id);
        }
      }
    }
    return runtime;
  }

  /**
   * A loader owns one session's extension instances. Reusing a loader across
   * sessions makes every later binding's extension ctx stale, and its tools
   * then fail with "This extension ctx is stale after session replacement or
   * reload" (seen as a web_search failure in novelty workers). One loader per
   * worker session is therefore deliberate.
   */
  private async loaderFor(systemPrompt: string, withExtensions: boolean): Promise<any> {
    const sdk = await this.sdk();
    const loader = new sdk.DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: sdk.getAgentDir(),
      noExtensions: !withExtensions,
      noSkills: !withExtensions,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await loader.reload();
    return loader;
  }

  /** The report tool; it records the envelope and answers the model. */
  private reportTool(collected: { envelope?: unknown }, schemaName?: string) {
    let rejected = 0;
    return {
      name: REPORT_TOOL_NAME,
      label: "RSI Report",
      description:
        "Report this task's result. state=ready: output.text holds the exact answer (the JSON object the task asked for, as text). " +
        "state=blocked: question holds one question for a person. state=failed: summary says why. " +
        "If the report is rejected, fix the named problem and call this tool again.",
      parameters: REPORT_PARAMETERS,
      execute: async (_toolCallId: string, params: unknown) => {
        const problem = reportProblem(normalizeEnvelope(params), schemaName);
        // Reject inside the turn, while the model still sees its own answer.
        // A blind second session repeats the whole task and the same lottery;
        // two corrections bound the loop, then the harness reports the failure.
        if (problem && rejected < 2) {
          rejected += 1;
          return {
            content: [{ type: "text", text: `Report rejected: ${problem}` }],
            details: {},
            isError: true,
          };
        }
        collected.envelope = params;
        return { content: [{ type: "text", text: "Report recorded." }], details: {}, terminate: true };
      },
    };
  }

  async run(ticket: Ticket, signal: AbortSignal): Promise<WorkerOutcome> {
    const payload = ticket.payload;
    if (!payload) throw new Error(`task ticket ${ticket.id} has no payload`);
    const request: LLMRequest = {
      task: payload.task,
      system: payload.system,
      user: payload.user,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      schemaName: payload.schemaName,
      meta: payload.meta,
    };
    validateMaxTokens(payload.maxTokens);
    const selectedModel = this.resolver.resolveModel(request);
    // The SDK has no session-level maxTokens option. Its native streamSimple
    // defaults to model.maxTokens, so an explicit cap belongs on a session-local
    // copy only. Preserve contextWindow and never mutate registry metadata.
    const maxTokens = payload.maxTokens === undefined ? undefined
      : Number.isSafeInteger(selectedModel.maxTokens) && selectedModel.maxTokens > 0
        ? Math.min(payload.maxTokens, selectedModel.maxTokens) : payload.maxTokens;
    const model = maxTokens === undefined || maxTokens === selectedModel.maxTokens
      ? selectedModel : { ...selectedModel, maxTokens };
    const tools = payload.tools?.length ? payload.tools : this.toolsFor(payload.task);
    const system = workerSystem({ task: payload.task, system: payload.system });
    const loader = await this.loaderFor(system, tools.length > 0);
    const sdk = await this.sdk();
    const modelRuntime = await this.runtimeFor(model.provider);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const collected: { envelope?: unknown } = {};
      let session: PiSession | null = null;
      try {
        const created = await sdk.createAgentSession({
          cwd: this.cwd,
          modelRuntime,
          model,
          ...((payload.thinkingLevel ?? this.thinkingLevel) !== undefined
            ? { thinkingLevel: payload.thinkingLevel ?? this.thinkingLevel } : {}),
          // Exact allowlist, including the reporting tool itself. noTools=all
          // without this allowlist would also disable custom rsi_report in Pi.
          noTools: "all",
          tools: [...new Set([...tools, REPORT_TOOL_NAME])],
          customTools: [this.reportTool(collected, payload.schemaName)],
          resourceLoader: loader,
          sessionManager: sdk.SessionManager.inMemory(),
        });
        session = created.session as PiSession;
        this.sessions.add(session);
        const abort = () => void session?.abort();
        signal.addEventListener("abort", abort, { once: true });
        try {
          // A protocol failure gets one correction on a fresh session: the
          // hint names the rejected report instead of repeating the same
          // prompt blind.
          await session.prompt(attempt === 0 ? payload.user : `${payload.user}${reportRetryHint(lastError)}`);
        } finally {
          signal.removeEventListener("abort", abort);
        }
        if (collected.envelope === undefined) {
          throw new WorkerReportError(`worker did not call ${REPORT_TOOL_NAME} with a structured report`);
        }
        const envelope = normalizeEnvelope(collected.envelope);
        const problem = reportProblem(envelope, payload.schemaName);
        if (problem) throw new WorkerReportError(problem);
        const assistants = session.messages.filter((message) => message.role === "assistant");
        return {
          state: envelope.state,
          summary: envelope.summary,
          output: envelope.output,
          question: envelope.question,
          model: `${model.provider}/${model.id}`,
          usage: assistants.reduce<Record<string, number>>((total, message) => {
            for (const [key, value] of Object.entries(usageOf(message))) total[key] = (total[key] ?? 0) + value;
            return total;
          }, {}),
        };
      } catch (error) {
        lastError = error;
        const aborted = (error as Error)?.name === "AbortError" || signal.aborted;
        if (aborted) throw error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 750));
      } finally {
        session?.dispose();
        if (session) this.sessions.delete(session);
      }
    }
    throw new LLMError(
      `pi worker failed (${model.provider}/${model.id}): ${(lastError as Error)?.message ?? String(lastError)}`,
    );
  }

  close(): Promise<void> {
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
    // Native OAuth refresh persists through the runtime's credential store.
    // Runtime teardown callers may be synchronous: always handle rejection so
    // neither an initialization failure nor shutdown produces an unhandled job.
    const pending = this.modelRuntime !== undefined ? Promise.resolve(this.modelRuntime) : this.runtimePromise;
    return pending?.then((runtime: any) => runtime.settleCredentialWrites?.()).catch(() => {}) ?? Promise.resolve();
  }
}

export interface SuperagentProviderOptions {
  /** The run's engine; every agent call becomes one task ticket on it. */
  engine: Engine;
  runTicketId: string;
  worker: TaskWorker;
  thinkingLevel?: string;
  signal?: AbortSignal;
  /** Attempts on a failed task report (protocol retries, same ticket). */
  attempts?: number;
}

/**
 * The RSI pipeline's provider: one task ticket per call, one report per answer.
 * A failed report is retried on the same ticket so the run's own state records
 * the retries; a blocked report becomes the run's question.
 */
export class SuperagentLLMProvider extends LLMProvider {
  readonly name = "pi-superagent";
  readonly engine: Engine;
  readonly runTicketId: string;
  readonly worker: TaskWorker;
  readonly thinkingLevel?: string;
  readonly signal?: AbortSignal;
  readonly attempts: number;

  constructor(opts: SuperagentProviderOptions) {
    super();
    this.engine = opts.engine;
    this.runTicketId = opts.runTicketId;
    this.worker = opts.worker;
    this.thinkingLevel = opts.thinkingLevel;
    this.signal = opts.signal;
    this.attempts = Math.max(1, opts.attempts ?? 2);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (this.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const { ticket, done } = this.engine.openTask({
      runTicketId: this.runTicketId,
      task: req.task,
      role: roleOfTask(req.task),
      payload: payloadOf({
        task: req.task,
        role: roleOfTask(req.task),
        system: req.system,
        user: req.user,
        provider: req.provider,
        model: req.model,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        schemaName: req.schemaName,
        meta: req.meta,
        thinkingLevel: this.thinkingLevel,
      }),
    });
    let report = await done;
    for (let attempt = 1; attempt < this.attempts && report.state === "failed"; attempt++) {
      if (this.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const next = this.engine.waitForReport(ticket.id, this.signal);
      this.engine.retry(ticket.id, `retry after failed attempt ${attempt}: ${report.summary}`.slice(0, 500));
      report = await next;
    }
    if (report.state !== "ready") {
      const reason = report.state === "blocked" ? report.question ?? report.summary : report.summary;
      throw new LLMError(`task ${req.task} reported ${report.state}: ${reason}`);
    }
    const text = outputText(report.output);
    if (!text.trim()) throw new LLMError(`task ${req.task} reported ready without text`);
    return {
      text,
      model: report.model ?? `${req.provider ?? ""}/${req.model ?? ""}`,
      usage: report.usage ?? {},
      latencyS: report.latencyS ?? 0,
      raw: { ticket: ticket.id, report: report.id, output: asRecord(report.output) },
    };
  }

  async close(): Promise<void> {
    await this.worker.close?.();
  }
}

/** The task ticket id a model response came from, for traces. */
export function ticketOf(response: LLMResponse): string | undefined {
  return asRecord(response.raw)?.ticket ? String(asRecord(response.raw)?.ticket) : undefined;
}
