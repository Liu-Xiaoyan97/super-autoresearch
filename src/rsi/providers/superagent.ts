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
import { LLMError, LLMProvider, extractJson, type LLMRequest, type LLMResponse } from "./base.ts";
import { PiLLMProvider, usageOf, type PiRegistry, type PiProviderOptions } from "./pi.ts";
import type { TaskWorker, WorkerOutcome } from "../superagent/executor.ts";
import { REPORT_PARAMETERS, REPORT_TOOL_NAME, normalizeEnvelope, outputText, payloadOf } from "../superagent/executor.ts";
import type { Engine } from "../superagent/engine.ts";
import type { Ticket } from "../superagent/model.ts";
import { roleOfTask } from "../superagent/sop.ts";
import { workerSystem } from "../superagent/prompts.ts";

const DEFAULT_WEB_TASKS: ReadonlySet<string> = new Set(["ideas.novelty", "integrity.refs"]);

export interface PiWorkerOptions {
  cwd: string;
  registry: PiRegistry;
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
  readonly thinkingLevel: string;
  readonly tools: string[];
  readonly webTasks: ReadonlySet<string>;
  readonly webSearch: boolean;
  private readonly resolver: PiLLMProvider;
  private readonly sdkOverride: any;
  private sdkPromise: Promise<any> | null = null;
  private loaders = new Map<string, Promise<any>>();
  private sessions = new Set<PiSession>();

  constructor(opts: PiWorkerOptions) {
    this.cwd = opts.cwd;
    this.thinkingLevel = opts.thinkingLevel ?? "low";
    this.tools = opts.tools ?? [];
    this.webTasks = opts.webTasks ?? DEFAULT_WEB_TASKS;
    this.webSearch = opts.webSearch ?? true;
    this.sdkOverride = opts.sdk;
    this.resolver = new PiLLMProvider(opts);
  }

  private toolsFor(task: string): string[] {
    if (this.tools.length) return this.tools;
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

  private async loaderFor(systemPrompt: string, withExtensions: boolean): Promise<any> {
    const key = `${withExtensions ? "web" : "plain"}:${systemPrompt}`;
    const pending = this.loaders.get(key);
    if (pending) return pending;
    const created = (async () => {
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
    })();
    this.loaders.set(key, created);
    return created;
  }

  /** The report tool; it records the envelope and answers the model. */
  private reportTool(collected: { envelope?: unknown }) {
    return {
      name: REPORT_TOOL_NAME,
      label: "RSI Report",
      description:
        "Report this task's result exactly once. state=ready with output.text holding the exact answer; " +
        "state=blocked with one question for a person; state=failed with the real error.",
      parameters: REPORT_PARAMETERS,
      execute: async (_toolCallId: string, params: unknown) => {
        collected.envelope = params;
        return { content: [{ type: "text", text: "Report recorded." }] };
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
    const model = this.resolver.resolveModel(request);
    const tools = payload.tools?.length ? payload.tools : this.toolsFor(payload.task);
    const system = workerSystem({ task: payload.task, system: payload.system });
    const loader = await this.loaderFor(system, tools.length > 0);
    const sdk = await this.sdk();
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const collected: { envelope?: unknown } = {};
      let session: PiSession | null = null;
      try {
        const created = await sdk.createAgentSession({
          cwd: this.cwd,
          model,
          thinkingLevel: payload.thinkingLevel ?? this.thinkingLevel,
          noTools: tools.length ? undefined : "all",
          tools: tools.length ? tools : undefined,
          customTools: [this.reportTool(collected)],
          resourceLoader: loader,
          sessionManager: sdk.SessionManager.inMemory(),
        });
        session = created.session as PiSession;
        this.sessions.add(session);
        const abort = () => void session?.abort();
        signal.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(payload.user);
        } finally {
          signal.removeEventListener("abort", abort);
        }
        const text = (session.getLastAssistantText() ?? "").trim();
        const envelope = normalizeEnvelope(collected.envelope, text);
        const output = outputText(envelope.output);
        if (envelope.state === "ready" && !output) {
          throw new Error("worker returned neither an output.text nor assistant text");
        }
        // A worker that writes prose/tool-call XML instead of the requested
        // structured answer is a failed task, not a ready result with a
        // permissive fallback. The ticket report is what the foreground sees.
        if (envelope.state === "ready" && payload.schemaName && extractJson(output) === null) {
          throw new Error(
            `worker returned no valid JSON for ${payload.schemaName}; report state=failed instead of ready`,
          );
        }
        const assistants = session.messages.filter((message) => message.role === "assistant");
        return {
          state: envelope.state,
          summary: envelope.summary,
          output: envelope.output,
          question: envelope.question,
          model: `${model.provider}/${model.id}`,
          usage: usageOf(assistants[assistants.length - 1]),
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

  close(): void {
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
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
  readonly thinkingLevel: string;
  readonly signal?: AbortSignal;
  readonly attempts: number;

  constructor(opts: SuperagentProviderOptions) {
    super();
    this.engine = opts.engine;
    this.runTicketId = opts.runTicketId;
    this.worker = opts.worker;
    this.thinkingLevel = opts.thinkingLevel ?? "low";
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
      this.engine.retry(ticket.id, `retry after failed attempt ${attempt}`);
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
    this.worker.close?.();
  }
}

/** The task ticket id a model response came from, for traces. */
export function ticketOf(response: LLMResponse): string | undefined {
  return asRecord(response.raw)?.ticket ? String(asRecord(response.raw)?.ticket) : undefined;
}
