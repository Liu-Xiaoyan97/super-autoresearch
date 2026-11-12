/**
 * Superagent protocol — executors.
 *
 * An Executor is outside the domain: it takes a Ticket and an Assignment and
 * reports back through the Engine. Two implementations exist because the SOP
 * has two levels of work:
 *
 *   TaskExecutor  runs one agent call in one worker (a Pi session or an
 *                 in-process model call) and reports its structured result.
 *   RunExecutor   runs the SOP itself: the driver advances §3.1–§3.6 and
 *                 reports progress. Only one run ticket exists per request.
 *
 * A CompositeExecutor routes by ticket kind, so the Engine sees one port.
 */

import { asRecord, str } from "../json.ts";
import type { Engine } from "./engine.ts";
import { type Assignment, type ReportState, type Ticket, type TicketPayload } from "./model.ts";
import type { LLMProvider } from "../providers/base.ts";

export interface Executor {
  start(ticket: Ticket, assignment: Assignment): void;
  deliver(ticket: Ticket, assignment: Assignment): void;
  stop(ticket: Ticket, assignment: Assignment, reason: string): void;
}

/** What a worker returns; the Engine turns it into a Report. */
export interface WorkerOutcome {
  state: ReportState;
  summary: string;
  output?: unknown;
  usage?: Record<string, number>;
  model?: string;
  latencyS?: number;
  question?: string;
}

export interface TaskWorker {
  run(ticket: Ticket, signal: AbortSignal): Promise<WorkerOutcome>;
  close?(): void;
}

export interface RunDriver {
  start(ticket: Ticket, assignment: Assignment): void;
  deliver?(ticket: Ticket, assignment: Assignment): void;
  stop(ticket: Ticket, assignment: Assignment, reason: string): void;
}

/** Runs task tickets in a worker, one Assignment at a time. */
export class TaskExecutor implements Executor {
  private readonly controllers = new Map<string, AbortController>();
  private readonly worker: TaskWorker;
  private readonly engine: () => Engine;

  constructor(worker: TaskWorker, engine: () => Engine) {
    this.worker = worker;
    this.engine = engine;
  }

  start(ticket: Ticket, assignment: Assignment): void {
    const controller = new AbortController();
    this.controllers.set(ticket.id, controller);
    void this.run(ticket, assignment, controller.signal);
  }

  private async run(ticket: Ticket, assignment: Assignment, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await this.worker.run(ticket, signal);
      if (signal.aborted) return;
      this.engine().report(
        ticket.id,
        { ...outcome, latencyS: outcome.latencyS ?? (Date.now() - started) / 1000 },
        assignment.id,
      );
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === "AbortError") return;
      this.engine().report(
        ticket.id,
        {
          state: "failed",
          summary: `worker failed: ${(error as Error)?.message ?? String(error)}`.slice(0, 2000),
          question: undefined,
        },
        assignment.id,
      );
    } finally {
      this.controllers.delete(ticket.id);
    }
  }

  deliver(): void {
    /* a task worker is one call; it takes no follow-ups mid-turn */
  }

  stop(ticket: Ticket, _assignment: Assignment, _reason: string): void {
    this.controllers.get(ticket.id)?.abort();
    this.controllers.delete(ticket.id);
  }

  close(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.worker.close?.();
  }
}

/** Routes run tickets to the SOP driver. */
export class RunExecutor implements Executor {
  private readonly driver: RunDriver;

  constructor(driver: RunDriver) {
    this.driver = driver;
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.driver.start(ticket, assignment);
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    this.driver.deliver?.(ticket, assignment);
  }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.driver.stop(ticket, assignment, reason);
  }
}

/** The one port the Engine uses: task tickets to workers, run tickets to the driver. */
export class CompositeExecutor implements Executor {
  private readonly task: TaskExecutor;
  private readonly run: RunExecutor;

  constructor(task: TaskExecutor, run: RunExecutor) {
    this.task = task;
    this.run = run;
  }

  private of(ticket: Ticket): Executor {
    return ticket.kind === "run" ? this.run : this.task;
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.of(ticket).start(ticket, assignment);
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    this.of(ticket).deliver(ticket, assignment);
  }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.of(ticket).stop(ticket, assignment, reason);
  }

  close(): void {
    this.task.close();
  }
}

/**
 * An in-process worker: one model call through an LLM provider.
 *
 * Used by `--inline`, by the offline CLI and by tests, so the ticket and report
 * protocol is exercised even when no Pi session exists. Isolation is the
 * provider's own (system prompt + one user message), not a separate session.
 */
export class InlineWorker implements TaskWorker {
  readonly name = "inline";
  private readonly provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async run(ticket: Ticket, signal: AbortSignal): Promise<WorkerOutcome> {
    const payload = ticket.payload;
    if (!payload) throw new Error(`task ticket ${ticket.id} has no payload`);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const response = await this.provider.complete({
      task: payload.task,
      system: payload.system,
      user: payload.user,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      schemaName: payload.schemaName,
      meta: payload.meta,
      signal,
    });
    return {
      state: "ready",
      summary: `${payload.task} returned ${response.text.length} characters via ${response.model}`,
      output: { text: response.text },
      usage: response.usage,
      model: response.model,
      latencyS: response.latencyS,
    };
  }

  close(): void {
    void this.provider.close();
  }
}

/**
 * The report envelope a worker session calls once, and the same envelope the
 * Pi worker tool uses. One shape for both transports.
 */
export const REPORT_TOOL_NAME = "rsi_report";

export const REPORT_PARAMETERS = {
  type: "object",
  properties: {
    state: {
      type: "string",
      enum: ["ready", "blocked", "failed"],
      description: "ready = the task produced its answer; blocked = a person must decide; failed = the task could not be done.",
    },
    summary: {
      type: "string",
      description: "One sentence on what the task produced or why it could not.",
    },
    output: {
      type: "object",
      description:
        "The answer envelope, never the answer's fields directly. For state=ready, output.text is required: " +
        "a string holding the exact answer (the JSON object the task asked for, serialized as text).",
      properties: {
        text: { type: "string", description: "The exact answer text; the JSON text for JSON tasks." },
      },
    },
    question: {
      type: "string",
      description: "With state=blocked: the one concrete question a person must answer.",
    },
  },
  required: ["state", "summary"],
};

export interface WorkerReportEnvelope {
  state: ReportState;
  summary: string;
  output?: unknown;
  question?: string;
}

/**
 * Normalize whatever a worker reported into the envelope the Engine accepts.
 *
 * A worker may answer with `output: {decision, feedback, ...}` instead of
 * wrapping that JSON in `output.text`. Those fields are the answer, not a
 * missing answer, so the envelope canonicalizes every accepted shape to
 * `{ text }` once. Validation (JSON when the task requires a schema) still
 * happens on the text, so tolerance for the wrapper never weakens the answer.
 */
export function normalizeEnvelope(raw: unknown, fallbackText = ""): WorkerReportEnvelope {
  const record = asRecord(raw) ?? {};
  const requested = str(record.state, "");
  const state: ReportState = requested === "ready" || requested === "blocked" || requested === "failed" ? requested : "ready";
  const answer = outputText(record.output) || fallbackText;
  return {
    state,
    summary: str(record.summary, fallbackText.slice(0, 300) || "task finished"),
    output: answer ? { text: answer } : record.output,
    question: str(record.question) || undefined,
  };
}

/**
 * The text a task ticket's answer carries, from any accepted output shape:
 * a string, `{ text }`, `{ answer }`, or the answer's own JSON fields. The
 * last shape is serialized back to the JSON text every downstream parser
 * reads; only a genuinely empty output has no text.
 */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return JSON.stringify(output);
  const record = asRecord(output);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.answer === "string") return record.answer;
  return Object.keys(record).length ? JSON.stringify(record) : "";
}

/** Build the payload a ticket carries from an LLM request-like object. */
export function payloadOf(input: {
  task: string;
  role: string;
  system: string;
  user: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  schemaName?: string;
  meta: Record<string, unknown>;
  tools?: string[];
  thinkingLevel?: string;
}): TicketPayload {
  return { ...input };
}
