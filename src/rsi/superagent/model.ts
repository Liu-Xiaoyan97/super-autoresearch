/**
 * Superagent protocol — domain model.
 *
 * Ported from the dsh-superagent prototype (see its `docs/001-domain.md`) and
 * narrowed to what the RSI extension needs. The vocabulary is the prototype's:
 * a Source produces Triggers, a Trigger belongs to Threads, Eval decides, an
 * accept creates a Ticket with a Mandate, an Assignment binds that Ticket to
 * one Executor, and the Executor reports.
 *
 * RSI adds exactly one kind of work, the research run:
 *   - a **run** Ticket carries one ScientistTwo run and its SOP;
 *   - a **task** Ticket carries one agent call of the SOP, executed by one
 *     worker session. Task Tickets are what used to be bare subagents.
 *
 * The foreground agent (the Pi session the operator talks to) is the only
 * agent a person meets. It never executes: it accepts, routes, relays and
 * answers. Everything else runs in Executors.
 */

import { stableString } from "../json.ts";

export type ReportState = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";
export type Strength = "explicit" | "inferred";
export type DecisionKind = "accept" | "ignore" | "stop" | "unavailable";
export type TicketOutcome = "completed" | "failed" | "dropped" | "stopped" | "aborted";
export type TicketKind = "run" | "task";
export type AcceptMode = "off" | "observe" | "auto";
export type MandateBasis = "explicit" | "run" | "inferred" | "resume";
export type RuleLevel = "auto" | "explicit" | "observe" | "person";

/** SOP stage identifiers. `run` is the whole loop, the others are paper sections. */
export type Stage =
  | "run"
  | "limits"
  | "seeds"
  | "baseline"
  | "search"
  | "select"
  | "ablations"
  | "draft"
  | "review"
  | "meta"
  | "integrity"
  | "export";

export const STAGES: readonly Stage[] = [
  "run",
  "limits",
  "seeds",
  "baseline",
  "search",
  "select",
  "ablations",
  "draft",
  "review",
  "meta",
  "integrity",
  "export",
];

/** A thread address: a Source and the id that Source gives it. */
export interface ThreadRef {
  source: string;
  id: string;
}

/** The write side of a thread: where a reply, a notice or an artifact goes. */
export interface ChannelRef {
  source: string;
  id: string;
  kind: "chat" | "artifact" | "log";
}

export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`;

/** One immutable event from a Source. */
export interface Trigger {
  id: string;
  /** Source instance id, such as `human`, `cli`, `experiment` or `review`. */
  source: string;
  /** Source-specific event kind: request, resume, stop, experiment, review, retry. */
  kind: string;
  at: string;
  /** Whether a person wrote it. Automated triggers may continue work, never authorize it. */
  human: boolean;
  /** The actor in the Source's own identity space, such as a Pi session id. */
  actor?: string;
  /** Whether it addresses the agent: an explicit request rather than an observation. */
  addressed: boolean;
  text?: string;
  channel?: ChannelRef;
  threads: ThreadRef[];
  meta: Record<string, unknown>;
}

/** Triggers in time order; the unit inside which one Eval runs at a time. */
export interface Thread {
  key: string;
  ref: ThreadRef;
  title: string;
  triggers: string[];
  tickets: string[];
  decisions: string[];
  evalId?: string;
  createdAt: string;
  updatedAt: string;
}

/** The result of Eval: what may happen to one batch of Triggers. */
export interface Decision {
  id: string;
  thread: string;
  triggerIds: string[];
  strength: Strength;
  policyVersion: string;
  at: string;
  kind: DecisionKind;
  reason: string;
  ticketId?: string;
  /** A proactive accept refused by `observe` mode, recorded instead of done. */
  wouldAccept?: boolean;
  rules?: string[];
}

/** Why the work may be done, and how far it may go. Immutable. */
export interface Mandate {
  id: string;
  policyVersion: string;
  strength: Strength;
  scope: string;
  basis: MandateBasis;
  rules: string[];
  /** The identity that originated the work, in its Source's own space. */
  sender: string;
  at: string;
  runId?: string;
}

/** One SOP rule: what may happen on its own, and what needs a person. */
export interface Rule {
  id: string;
  name: string;
  instruction: string;
  level: RuleLevel;
  enabled: boolean;
}

/** One Source instance's part of the policy: who may originate work there. */
export interface SourcePolicy {
  enabled: boolean;
  /** Identities in this Source's own space, never mapped across Sources. */
  allowed: string[];
  /** Bots whose observations may become inferred candidates. */
  bots: string[];
  /** Whether the Source receives messages that do not address the agent. */
  observed: boolean;
}

/** The versioned rules: who may originate work, and how proactive work is accepted. */
export interface PolicySettings {
  version: string;
  paused: boolean;
  acceptMode: AcceptMode;
  rules: Rule[];
  sources: Record<string, SourcePolicy>;
  limits: { evalTimeoutMs: number; maxAttempts: number; maxWallTimeS: number };
}

export interface Assignment {
  id: string;
  state: "pending" | "running" | "ended";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  deliveredAt?: string;
  attempts: number;
  report?: StoredReport;
}

export interface StoredReport {
  id: string;
  state: ReportState;
  summary: string;
  at: string;
  /** An open question for a person. It survives later progress reports. */
  question?: string;
  /** The trigger whose message raised the question, so the answer goes where it was asked. */
  askedBy?: string;
  /** What the Executor produced: structured output, usage, model, latency. */
  output?: unknown;
  usage?: Record<string, number>;
  model?: string;
  latencyS?: number;
}

/** A question waiting for a person; the Ticket cannot continue on its own. */
export interface Attention {
  id: string;
  question: string;
  at: string;
  triggerId?: string;
}

export type TicketInput =
  | { id: string; kind: "trigger"; at: string; triggerId: string; human?: boolean; note?: string; readAt?: string | null; deliveredTo?: string }
  | { id: string; kind: "note"; at: string; text: string; readAt?: string | null; deliveredTo?: string }
  | { id: string; kind: "resume"; at: string; text?: string; readAt?: string | null; deliveredTo?: string };

/** What a run Ticket executes: the accepted request, frozen at accept time. */
export interface RunSpec {
  problem: string;
  out: string;
  root: string;
  seed: number;
  mode: "provider" | "mock";
  agents: "subagent" | "inline";
  runner: "simulated" | "subprocess";
  provider?: string;
  model?: string;
  codingModel?: string;
  options: Record<string, unknown>;
}

/** What an Executor needs to do for one Ticket: the exact agent request. */
export interface TicketPayload {
  task: string;
  role: string;
  system: string;
  user: string;
  schemaName?: string;
  provider?: string;
  model?: string;
  temperature: number;
  maxTokens: number;
  meta: Record<string, unknown>;
  /** Tool names the worker may use; empty means a pure reasoning worker. */
  tools?: string[];
  thinkingLevel?: string;
}

/** A unit of authorized work. */
export interface Ticket {
  id: string;
  shortName: string;
  title: string;
  kind: TicketKind;
  stage: Stage;
  /** The RSI task key for task tickets, e.g. `critic.subset`. */
  task?: string;
  runId?: string;
  decisionId: string;
  mandate: Mandate;
  channels: ChannelRef[];
  subscriptions: string[];
  inputs: TicketInput[];
  undelivered: string[];
  assignments: Assignment[];
  reports: StoredReport[];
  attention?: Attention;
  origin: { triggerId: string; triggerIds: string[] };
  payload?: TicketPayload;
  run?: RunSpec;
  createdAt: string;
  updatedAt: string;
  ended?: { at: string; by: "person" | "executor" | "host"; outcome: TicketOutcome; reason?: string };
}

export interface TriggerDisposition {
  receivedAt: string;
  /** `eval` when it waits for Eval, `fanout` when delivered to subscribed tickets. */
  disposition: "eval" | "fanout" | "decided" | "filtered";
  fanout?: string[];
  decisionId?: string;
  reason?: string;
}

export const liveTicket = (ticket: Ticket): boolean => ticket.ended === undefined;

export const latestAssignment = (ticket: Ticket): Assignment | undefined =>
  ticket.assignments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

export const runningAssignment = (ticket: Ticket): Assignment | undefined =>
  latestAssignment(ticket)?.state === "running" ? latestAssignment(ticket) : undefined;

export const latestReport = (ticket: Ticket): StoredReport | undefined => ticket.reports.at(-1);

export const settled = (ticket: Ticket): boolean => {
  const report = latestReport(ticket);
  return !!report && ["waiting", "ready", "blocked", "failed", "dropped"].includes(report.state);
};

/** The panel label of a ticket, in the prototype's order: the first match wins. */
export type TicketStage =
  | "person/delivery"
  | "person/answer"
  | "person/review"
  | "person/blocked"
  | "person/failed"
  | "working/queued"
  | "idle"
  | "working"
  | "ended";

export function ticketStage(ticket: Ticket): TicketStage {
  if (!liveTicket(ticket)) return "ended";
  const report = latestReport(ticket);
  if (ticket.undelivered.length) return "person/delivery";
  if (ticket.attention) return "person/answer";
  if (report?.state === "ready") return "person/review";
  // A person's message after the report releases the ticket to its Executor.
  const released = !!report && ticket.inputs.some((input) => (input.kind === "resume" || (input.kind === "trigger" && input.human)) && input.at > report.at);
  if (report?.state === "blocked" && !released) return "person/blocked";
  if (report?.state === "failed" && !released) return "person/failed";
  const assignment = latestAssignment(ticket);
  if (!assignment || assignment.state === "pending") return "working/queued";
  if (report?.state === "waiting" || assignment.state === "ended") return "idle";
  return "working";
}

/** Whether a person must act before the ticket can continue. */
export const waitsForPerson = (ticket: Ticket): boolean => ticketStage(ticket).startsWith("person/");

/** Whether a ticket that reported failed or blocked may be retried. */
export const canRetry = (ticket: Ticket): boolean => {
  const stage = ticketStage(ticket);
  return liveTicket(ticket) && ["person/delivery", "person/blocked", "person/failed"].includes(stage);
};

/** A short, stable ticket name usable as a directory or a branch segment. */
export function shortName(prefix: string, id: string): string {
  const tail = id.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-24);
  return `${prefix}-${tail}`.toLowerCase();
}

export const key = (...parts: unknown[]): string => {
  const text = parts.map((part) => (typeof part === "string" ? part : stableString(part))).join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** Domain events, what the host and the trace store observe after a change. */
export type DomainEvent =
  | { type: "trigger.received"; at: string; data: { triggerId: string; threads: string[] } }
  | { type: "trigger.fanout"; at: string; data: { triggerId: string; ticketId: string } }
  | { type: "eval.started"; at: string; data: { evalId: string; thread: string; triggerIds: string[]; strength: Strength } }
  | { type: "decision.recorded"; at: string; data: { decisionId: string; kind: DecisionKind; thread: string; wouldAccept?: boolean } }
  | { type: "ticket.created"; at: string; data: { ticketId: string; kind: TicketKind; stage: Stage; strength: Strength; runId?: string } }
  | { type: "ticket.ended"; at: string; data: { ticketId: string; by: string; outcome: TicketOutcome; reason?: string } }
  | { type: "assignment.started"; at: string; data: { ticketId: string; assignmentId: string; attempt: number } }
  | { type: "assignment.ended"; at: string; data: { ticketId: string; assignmentId: string; reason: string } }
  | { type: "report.recorded"; at: string; data: { ticketId: string; state: ReportState; summary: string } }
  | { type: "attention.opened"; at: string; data: { ticketId: string; question: string } }
  | { type: "attention.closed"; at: string; data: { ticketId: string } }
  | { type: "input.added"; at: string; data: { ticketId: string; inputId: string; kind: string } }
  | { type: "input.delivered"; at: string; data: { ticketId: string; assignmentId: string; inputIds: string[] } }
  | { type: "ticket.stopped"; at: string; data: { ticketId: string; reason: string } }
  | { type: "policy.changed"; at: string; data: { from: string; to: string } };
