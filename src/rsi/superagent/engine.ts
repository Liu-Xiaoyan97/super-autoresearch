/**
 * Superagent protocol — engine.
 *
 * The engine is the only writer of protocol state. Its commands follow the
 * prototype's `docs/001-domain.md`: intake records a Trigger, `pass` evaluates
 * waiting Triggers, an accept creates a Ticket with a Mandate, an Assignment
 * binds it to an Executor, and a Report ends a turn, a question or a Ticket.
 *
 * Two Ticket kinds travel through the same machinery:
 *
 *   run   one accepted research request. Its Executor is the SOP driver, which
 *         runs the ScientistTwo loop and reports `progress` as it advances.
 *   task  one agent call of the SOP, executed by one worker. A task Ticket is
 *         what a bare subagent used to be: an isolated prompt, no shared
 *         history, and a structured report instead of free text.
 *
 * The foreground agent never executes. It calls `accept`, `route`, `note`,
 * `retry`, `stop` and `answer`; everything else reports back through Notices.
 */

import { asRecord, str } from "../json.ts";
import type { Executor } from "./executor.ts";
import {
  type Assignment,
  type ChannelRef,
  type Decision,
  type DecisionKind,
  type DomainEvent,
  type Mandate,
  type PolicySettings,
  type ReportState,
  type RunSpec,
  type Stage,
  type StoredReport,
  type Strength,
  type Thread,
  type ThreadRef,
  type Ticket,
  type TicketInput,
  type TicketOutcome,
  type TicketPayload,
  type Trigger,
  type TriggerDisposition,
  latestAssignment,
  key,
  liveTicket,
  runningAssignment,
  shortName,
  threadKey,
  ticketStage,
} from "./model.ts";
import { makePolicy, type Policy } from "./policy.ts";
import { ruleOfTask, stageOfTask, stageSpec } from "./sop.ts";
import type { Repositories } from "./store.ts";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** A step the policy will not run on the SOP's own authority. */
export class PolicyHoldError extends ProtocolError {
  readonly rule: string;
  readonly verdict: "observe" | "attention";
  readonly question: string;

  constructor(rule: string, verdict: "observe" | "attention", question: string) {
    super(`${rule} needs a person: ${question}`);
    this.name = "PolicyHoldError";
    this.rule = rule;
    this.verdict = verdict;
    this.question = question;
  }
}

export interface Notice {
  kind: "started" | "report" | "attention" | "result" | "failure";
  ticketId: string;
  runId?: string;
  stage?: Stage;
  state?: ReportState;
  text: string;
  question?: string;
}

export interface EngineOptions {
  store: Repositories;
  policy: Policy;
  executor: Executor;
  clock?: () => Date;
  onEvent?: (event: DomainEvent) => void;
  onTrace?: (kind: string, data: Record<string, unknown>) => void;
  /** Reports that reach the foreground agent; progress never does. */
  onNotice?: (notice: Notice) => void;
  /** Task-level reports that need no person stay internal by default. */
  notifyTaskReports?: boolean;
}

export interface IntakeRequest {
  source: string;
  kind: string;
  human?: boolean;
  actor?: string;
  addressed?: boolean;
  text?: string;
  channel?: ChannelRef;
  thread?: { id: string; title?: string };
  meta?: Record<string, unknown>;
  at?: string;
  /** Two intakes with the same key produce one Trigger. */
  key?: string;
}

export interface ReportInput {
  state: ReportState;
  summary: string;
  /** `null` clears the open question, `undefined` keeps it. */
  question?: string | null;
  askedBy?: string;
  output?: unknown;
  usage?: Record<string, number>;
  model?: string;
  latencyS?: number;
}

export interface TaskRequest {
  runTicketId: string;
  task: string;
  role: string;
  payload: Omit<TicketPayload, "task" | "role"> & { task?: string; role?: string };
  title?: string;
  attempt?: number;
}

export interface AcceptOptions {
  title?: string;
  scope?: string;
  rule?: string;
  shortName?: string;
}

const RECOVERY_NOTE =
  "The host restarted during this ticket. Inspect the run directory before repeating any external action, then report the state you find.";

const MAX_TITLE = 200;

export class Engine {
  readonly store: Repositories;
  private readonly executor: Executor;
  private readonly clock: () => Date;
  private readonly waiters = new Map<string, { resolve: (report: StoredReport) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private closed = false;
  private readonly options: EngineOptions;
  private currentPolicy: Policy;

  constructor(options: EngineOptions) {
    this.options = options;
    this.store = options.store;
    this.executor = options.executor;
    this.clock = options.clock ?? (() => new Date());
    this.currentPolicy = options.policy;
  }

  // ---------------------------------------------------------------- accessors

  now(): string {
    return this.clock().toISOString();
  }

  policy(): Policy {
    return this.currentPolicy;
  }

  policySettings(): PolicySettings {
    return this.currentPolicy.settings();
  }

  ticket(id: string): Ticket | undefined {
    return this.store.tickets.get(id);
  }

  requireTicket(id: string): Ticket {
    const ticket = this.store.tickets.get(id);
    if (!ticket) throw new ProtocolError(`unknown ticket ${id}`);
    return ticket;
  }

  tickets(filter: { runId?: string; kind?: Ticket["kind"]; open?: boolean } = {}): Ticket[] {
    return this.store
      .tickets.list()
      .filter((ticket) => (filter.runId ? ticket.runId === filter.runId : true))
      .filter((ticket) => (filter.kind ? ticket.kind === filter.kind : true))
      .filter((ticket) => (filter.open ? ticket.ended === undefined : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  runTickets(openOnly = false): Ticket[] {
    return this.tickets({ kind: "run", open: openOnly });
  }

  threads(): Thread[] {
    return this.store.threads.list();
  }

  decisions(): Decision[] {
    return this.store.decisions.list();
  }

  events(): DomainEvent[] {
    return this.store.events();
  }

  /** What one ticket looks like to the foreground agent. */
  card(ticketId: string): Record<string, unknown> {
    const ticket = this.requireTicket(ticketId);
    const report = ticket.reports.at(-1);
    return {
      id: ticket.id,
      short_name: ticket.shortName,
      kind: ticket.kind,
      stage: ticket.stage,
      task: ticket.task,
      run_id: ticket.runId,
      title: ticket.title,
      state: ticketStage(ticket),
      attention: ticket.attention?.question,
      report: report ? { state: report.state, summary: report.summary, at: report.at } : null,
      ended: ticket.ended ?? null,
      mandate: { strength: ticket.mandate.strength, basis: ticket.mandate.basis, scope: ticket.mandate.scope },
      assignments: ticket.assignments.length,
      reports: ticket.reports.length,
    };
  }

  // ------------------------------------------------------------------ events

  private nowDate(): string {
    return this.now();
  }

  private emit(event: DomainEvent): void {
    this.store.event(event);
    try {
      this.options.onEvent?.(event);
    } catch {
      /* an event listener must never break the protocol */
    }
    try {
      this.options.onTrace?.(`superagent.${event.type}`, { ...event.data, at: event.at });
    } catch {
      /* tracing is best effort */
    }
  }

  private notice(notice: Notice): void {
    try {
      this.options.onNotice?.(notice);
    } catch {
      /* a Notice is best effort; the report is already durable */
    }
  }

  // ------------------------------------------------------------------ intake

  /**
   * Record one Trigger. Idempotent by `key` (or a stable key derived from the
   * Source and text): accepting the same event twice creates one Trigger.
   */
  intake(request: IntakeRequest): { trigger: Trigger; thread: Thread; duplicate: boolean } {
    const id = request.key ?? key("trigger", request.source, request.kind, request.at ?? "", request.text ?? "", request.meta ?? {});
    const existing = this.store.triggers.get(id);
    const ref: ThreadRef = { source: request.source, id: request.thread?.id ?? id };
    if (existing) {
      const thread = this.requireThread(threadKey(ref));
      return { trigger: existing, thread, duplicate: true };
    }
    return this.store.atomic(() => {
      const at = request.at ?? this.nowDate();
      const trigger: Trigger = {
        id,
        source: request.source,
        kind: request.kind,
        at,
        human: request.human ?? false,
        actor: request.actor,
        addressed: request.addressed ?? false,
        text: request.text,
        channel: request.channel,
        threads: [ref],
        meta: request.meta ?? {},
      };
      this.store.triggers.save(trigger);
      this.store.triggers.saveDisposition(id, { receivedAt: at, disposition: "eval" });
      let thread = this.store.threads.get(threadKey(ref));
      if (!thread) {
        thread = {
          key: threadKey(ref),
          ref,
          title: request.thread?.title ?? `${request.source}:${ref.id}`,
          triggers: [],
          tickets: [],
          decisions: [],
          createdAt: at,
          updatedAt: at,
        };
      }
      thread.triggers = [...thread.triggers, id];
      thread.updatedAt = at;
      this.store.threads.save(thread);
      this.emit({ type: "trigger.received", at, data: { triggerId: id, threads: [thread.key] } });
      return { trigger, thread, duplicate: false };
    });
  }

  private requireThread(key: string): Thread {
    const thread = this.store.threads.get(key);
    if (!thread) throw new ProtocolError(`unknown thread ${key}`);
    return thread;
  }

  // ------------------------------------------------------------------- passes

  /** Evaluate every Trigger that still waits, oldest thread first. */
  pass(): Decision[] {
    if (this.closed) return [];
    const decisions: Decision[] = [];
    for (const thread of this.store.threads.list()) {
      const pending = thread.triggers
        .map((id) => this.store.triggers.get(id))
        .filter((trigger): trigger is Trigger => !!trigger && this.store.triggers.disposition(trigger.id)?.disposition === "eval");
      for (const trigger of pending) {
        if (this.currentPolicy.paused()) break;
        const decision = this.evaluate(trigger, thread);
        if (decision) decisions.push(decision);
      }
    }
    return decisions;
  }

  /**
   * One Eval over one Trigger. Follow-ups and observations on a subscribed
   * thread fan out to its Tickets and take no Decision; everything else goes
   * through the gate.
   */
  private evaluate(trigger: Trigger, thread: Thread): Decision | undefined {
    const tickets = thread.tickets.map((id) => this.store.tickets.get(id)).filter((ticket): ticket is Ticket => !!ticket);
    const live = tickets.filter(liveTicket);
    const subscribed = (ticket: Ticket): boolean => ticket.subscriptions.includes(thread.key);
    const fanout = live.filter(subscribed);
    const disposition = this.store.triggers.disposition(trigger.id);
    const at = this.nowDate();

    // A message that reached a subscribed Ticket stays with it: no gate, no
    // authority, and an ended Ticket is not resumed by an automated trigger.
    if (fanout.length && !trigger.addressed) {
      return this.store.atomic(() => {
        for (const ticket of fanout) this.addInput(ticket, { id: key("input", ticket.id, "trigger", trigger.id), kind: "trigger", at, triggerId: trigger.id, human: trigger.human });
        if (disposition) this.store.triggers.saveDisposition(trigger.id, { ...disposition, disposition: "fanout", fanout: fanout.map((ticket) => ticket.id) });
        this.emit({ type: "trigger.fanout", at, data: { triggerId: trigger.id, ticketId: fanout[0].id } });
        for (const ticket of fanout) this.deliver(ticket.id);
        return undefined;
      });
    }

    const gate = this.currentPolicy.gate(trigger, thread, tickets);
    const evalId = key("eval", trigger.id);
    this.emit({ type: "eval.started", at, data: { evalId, thread: thread.key, triggerIds: [trigger.id], strength: gate.admissible ? gate.strength : "inferred" } });

    if (!gate.admissible) {
      return this.recordDecision(trigger, thread, {
        kind: "ignore",
        reason: gate.reason,
        strength: "inferred",
        disposition: "filtered",
      });
    }

    const mode = this.currentPolicy.acceptMode();
    const runSpec = asRecord(trigger.meta.run) as RunSpec | null;
    const inferred = gate.strength === "inferred";

    if (inferred && mode === "observe") {
      return this.recordDecision(trigger, thread, {
        kind: "ignore",
        reason: "observe mode records a positive assessment without accepting it",
        strength: "inferred",
        wouldAccept: !!runSpec,
        disposition: "decided",
      });
    }
    if (runSpec) {
      const accepted = this.accept(trigger.id, runSpec, { title: trigger.meta.title as string | undefined });
      return accepted.decision;
    }
    return this.recordDecision(trigger, thread, {
      kind: "ignore",
      reason: "the trigger carries no run specification and no ticket subscribes it",
      strength: gate.strength,
      disposition: "decided",
    });
  }

  private recordDecision(
    trigger: Trigger,
    thread: Thread,
    input: { kind: DecisionKind; reason: string; strength: Strength; ticketId?: string; wouldAccept?: boolean; disposition: TriggerDisposition["disposition"]; rules?: string[] },
  ): Decision {
    return this.store.atomic(() => {
      const at = this.nowDate();
      const id = key("decision", trigger.id);
      const decision: Decision = {
        id,
        thread: thread.key,
        triggerIds: [trigger.id],
        strength: input.strength,
        policyVersion: this.currentPolicy.version(),
        at,
        kind: input.kind,
        reason: input.reason,
        ticketId: input.ticketId,
        wouldAccept: input.wouldAccept,
        rules: input.rules,
      };
      this.store.decisions.save(decision);
      const current = this.store.triggers.disposition(trigger.id);
      if (current) this.store.triggers.saveDisposition(trigger.id, { ...current, disposition: input.disposition, decisionId: id, reason: input.reason });
      const updated = this.store.threads.get(thread.key) ?? thread;
      updated.decisions = [...updated.decisions, id];
      updated.evalId = undefined;
      updated.updatedAt = at;
      this.store.threads.save(updated);
      this.emit({ type: "decision.recorded", at, data: { decisionId: id, kind: input.kind, thread: thread.key, wouldAccept: input.wouldAccept } });
      return decision;
    });
  }

  // --------------------------------------------------------------- accepting

  /**
   * Accept a Trigger as one run. Idempotent by Trigger: a second accept
   * returns the Ticket the first one created.
   */
  accept(triggerId: string, spec: RunSpec, options: AcceptOptions = {}): { decision: Decision; ticket?: Ticket } {
    const trigger = this.store.triggers.get(triggerId);
    if (!trigger) throw new ProtocolError(`unknown trigger ${triggerId}`);
    const thread = this.requireThread(threadKey(trigger.threads[0]));
    const prior = this.store.decisions.get(key("decision", triggerId));
    if (prior?.ticketId) {
      const ticket = this.store.tickets.get(prior.ticketId);
      if (ticket) return { decision: prior, ticket };
    }
    const gate = this.currentPolicy.gate(trigger, thread, thread.tickets.map((id) => this.store.tickets.get(id)).filter((ticket): ticket is Ticket => !!ticket));
    if (!gate.admissible) {
      const decision = this.recordDecision(trigger, thread, { kind: "ignore", reason: gate.reason, strength: "inferred", disposition: "filtered" });
      return { decision };
    }
    if (gate.strength === "inferred" && !this.currentPolicy.admitsInferred([options.rule ?? "sop.run"])) {
      const decision = this.recordDecision(trigger, thread, {
        kind: "ignore",
        reason: "inferred acceptance needs accept mode auto and an enabled rule",
        strength: "inferred",
        wouldAccept: true,
        disposition: "decided",
      });
      return { decision };
    }
    return this.store.atomic(() => {
      const at = this.nowDate();
      const title = (str(options.title) || str(trigger.meta.title) || str(spec.problem)).slice(0, MAX_TITLE);
      const scope = (options.scope ?? title).slice(0, MAX_TITLE);
      const decision: Decision = {
        id: key("decision", triggerId),
        thread: thread.key,
        triggerIds: [triggerId],
        strength: gate.strength,
        policyVersion: this.currentPolicy.version(),
        at,
        kind: "accept",
        reason: "accepted",
        rules: [options.rule ?? "sop.run"],
      };
      const ticket = this.createTicket({
        kind: "run",
        title,
        stage: "run",
        runId: runIdOf(spec),
        shortName: options.shortName ?? shortName("run", runIdOf(spec)),
        decision,
        mandate: {
          id: key("mandate", triggerId),
          policyVersion: this.currentPolicy.version(),
          strength: gate.strength,
          scope,
          basis: gate.basis,
          rules: [options.rule ?? "sop.run"],
          sender: trigger.actor ?? trigger.source,
          at,
          runId: runIdOf(spec),
        },
        channels: trigger.channel ? [trigger.channel] : [],
        subscriptions: trigger.threads.map(threadKey),
        origin: { triggerId, triggerIds: [triggerId] },
        run: spec,
        at,
      });
      decision.ticketId = ticket.id;
      this.store.decisions.save(decision);
      const current = this.store.triggers.disposition(triggerId);
      if (current) this.store.triggers.saveDisposition(triggerId, { ...current, disposition: "decided", decisionId: decision.id });
      const updatedThread = this.store.threads.get(thread.key) ?? thread;
      updatedThread.decisions = [...updatedThread.decisions, decision.id];
      updatedThread.tickets = [...updatedThread.tickets, ticket.id];
      updatedThread.evalId = undefined;
      updatedThread.updatedAt = at;
      this.store.threads.save(updatedThread);
      this.emit({ type: "decision.recorded", at, data: { decisionId: decision.id, kind: "accept", thread: thread.key } });
      this.startAssignment(ticket);
      return { decision, ticket: this.requireTicket(ticket.id) };
    });
  }

  private createTicket(input: {
    kind: Ticket["kind"];
    title: string;
    stage: Stage;
    task?: string;
    runId?: string;
    shortName: string;
    decision: Decision;
    mandate: Mandate;
    channels: ChannelRef[];
    subscriptions: string[];
    origin: { triggerId: string; triggerIds: string[] };
    payload?: TicketPayload;
    run?: RunSpec;
    at: string;
  }): Ticket {
    const id = `${input.kind}-${key(input.kind, input.runId ?? "", input.task ?? "", input.decision.id, this.sequence++)}`;
    const ticket: Ticket = {
      id,
      shortName: input.shortName,
      title: input.title,
      kind: input.kind,
      stage: input.stage,
      task: input.task,
      runId: input.runId,
      decisionId: input.decision.id,
      mandate: input.mandate,
      channels: input.channels,
      subscriptions: input.subscriptions,
      inputs: [],
      undelivered: [],
      assignments: [],
      reports: [],
      origin: input.origin,
      payload: input.payload,
      run: input.run,
      createdAt: input.at,
      updatedAt: input.at,
    };
    this.store.tickets.save(ticket);
    this.emit({ type: "ticket.created", at: input.at, data: { ticketId: id, kind: input.kind, stage: input.stage, strength: input.mandate.strength, runId: input.runId } });
    return ticket;
  }

  // ------------------------------------------------------------------ tasks

  /**
   * Open one task Ticket for an agent call and start its first Assignment.
   * A step the policy does not run on the SOP's own authority throws a
   * `PolicyHoldError`; the caller reports it as a blocked run.
   */
  openTask(request: TaskRequest): { ticket: Ticket; done: Promise<StoredReport> } {
    const run = this.requireTicket(request.runTicketId);
    if (!liveTicket(run)) throw new ProtocolError(`run ticket ${run.id} has ended`);
    const stage = stageOfTask(request.task);
    const rule = ruleOfTask(request.task);
    const verdict = this.currentPolicy.mayRun(rule, run.mandate);
    if (verdict !== "run") {
      const spec = stageSpec(stage);
      throw new PolicyHoldError(rule, verdict === "observe" ? "observe" : "attention", `${spec.title} (${rule}) needs a person for run ${run.runId ?? run.id}.`);
    }
    const at = this.nowDate();
    const ticket = this.store.atomic(() => {
      const decision: Decision = {
        id: key("decision", run.id, request.task, request.attempt ?? 0, this.sequence),
        thread: run.subscriptions[0] ?? threadKey({ source: "run", id: run.runId ?? run.id }),
        triggerIds: [run.origin.triggerId],
        strength: run.mandate.strength,
        policyVersion: this.currentPolicy.version(),
        at,
        kind: "accept",
        reason: `task of run ${run.runId ?? run.id}`,
        rules: [rule],
      };
      this.store.decisions.save(decision);
      const mandate: Mandate = {
        id: key("mandate", decision.id),
        policyVersion: this.currentPolicy.version(),
        strength: run.mandate.strength,
        scope: request.task,
        basis: "run",
        rules: [rule],
        sender: run.mandate.sender,
        at,
        runId: run.runId,
      };
      const created = this.createTicket({
        kind: "task",
        title: (request.title ?? request.task).slice(0, MAX_TITLE),
        stage,
        task: request.task,
        runId: run.runId,
        shortName: shortName("task", decision.id),
        decision,
        mandate,
        channels: run.channels,
        subscriptions: [],
        origin: run.origin,
        payload: { ...request.payload, task: request.task, role: request.role },
        at,
      });
      decision.ticketId = created.id;
      this.store.decisions.save(decision);
      return created;
    });
    const done = this.waitForReport(ticket.id);
    this.startAssignment(this.requireTicket(ticket.id), request.attempt ?? 1);
    return { ticket: this.requireTicket(ticket.id), done };
  }

  // ------------------------------------------------------------- assignments

  private startAssignment(ticket: Ticket, attempt?: number): Assignment {
    const at = this.nowDate();
    const assignment: Assignment = {
      id: key("assignment", ticket.id, ticket.assignments.length + 1, at),
      state: "running",
      createdAt: at,
      startedAt: at,
      attempts: attempt ?? ticket.assignments.length + 1,
    };
    ticket.assignments = [...ticket.assignments, assignment];
    ticket.updatedAt = at;
    this.store.tickets.save(ticket);
    this.emit({ type: "assignment.started", at, data: { ticketId: ticket.id, assignmentId: assignment.id, attempt: assignment.attempts } });
    if (ticket.kind === "task") {
      this.notice({
        kind: "started",
        ticketId: ticket.id,
        runId: ticket.runId,
        stage: ticket.stage,
        text: `${ticket.task ?? ticket.id} (${ticket.stage}) started on attempt ${assignment.attempts}`,
      });
    }
    try {
      this.executor.start(ticket, assignment);
    } catch (error) {
      this.report(ticket.id, { state: "failed", summary: `executor could not start: ${(error as Error).message}` }, assignment.id);
    }
    this.deliver(ticket.id);
    return assignment;
  }

  /** End an assignment and wake the Executor on a new one, same Ticket. */
  retry(ticketId: string, reason = "retry"): Ticket {
    const ticket = this.requireTicket(ticketId);
    if (ticket.ended) throw new ProtocolError(`ticket ${ticketId} has ended`);
    const running = runningAssignment(ticket);
    if (running) this.endAssignment(ticket, running, reason, true);
    this.startAssignment(ticket, ticket.assignments.length + 1);
    return this.requireTicket(ticketId);
  }

  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string, stopExecutor = false): void {
    if (assignment.state === "ended") return;
    const at = this.nowDate();
    assignment.state = "ended";
    assignment.endedAt = at;
    assignment.endedReason = reason;
    ticket.updatedAt = at;
    this.store.tickets.save(ticket);
    if (stopExecutor) {
      try {
        this.executor.stop(ticket, assignment, reason);
      } catch {
        /* stopping is best effort; the domain already ended it */
      }
    }
    this.emit({ type: "assignment.ended", at, data: { ticketId: ticket.id, assignmentId: assignment.id, reason } });
  }

  /** Consume the undelivered Inputs on a running Assignment. */
  deliver(ticketId: string): void {
    const ticket = this.store.tickets.get(ticketId);
    if (!ticket || !liveTicket(ticket)) return;
    const assignment = runningAssignment(ticket);
    if (!assignment || !ticket.undelivered.length) return;
    const ids = ticket.undelivered.slice();
    ticket.undelivered = [];
    for (const input of ticket.inputs) {
      if (ids.includes(input.id)) {
        input.deliveredTo = assignment.id;
        input.readAt = input.readAt ?? null;
      }
    }
    ticket.updatedAt = this.nowDate();
    this.store.tickets.save(ticket);
    this.emit({ type: "input.delivered", at: ticket.updatedAt, data: { ticketId, assignmentId: assignment.id, inputIds: ids } });
    try {
      this.executor.deliver(ticket, assignment);
    } catch {
      /* a delivery failure stays visible as an undelivered input on the next pass */
    }
  }

  // ----------------------------------------------------------------- reports

  /**
   * Record a Report on the current Assignment. A `ready` or `dropped` report
   * ends its Ticket; `blocked` and `failed` hold it open for a retry or an
   * answer; a question opens an Attention that only a person can close.
   */
  report(ticketId: string, input: ReportInput, assignmentId?: string): Ticket {
    if (input.question && input.state === "ready") throw new ProtocolError("a ready report cannot carry a question");
    const ticket = this.requireTicket(ticketId);
    if (ticket.ended) return ticket;
    return this.store.atomic(() => {
      const at = this.nowDate();
      const assignment = (assignmentId ? ticket.assignments.find((item) => item.id === assignmentId) : undefined) ?? runningAssignment(ticket) ?? latestAssignment(ticket);
      const report: StoredReport = {
        id: key("report", ticket.id, ticket.reports.length + 1, at),
        state: input.state,
        summary: input.summary,
        at,
        question: input.question ?? undefined,
        askedBy: input.askedBy,
        output: input.output,
        usage: input.usage,
        model: input.model,
        latencyS: input.latencyS,
      };
      ticket.reports = [...ticket.reports, report];
      if (assignment) assignment.report = report;
      this.applyAttention(ticket, report, input.question === null || input.state === "ready" || input.state === "dropped");
      ticket.updatedAt = at;

      if (assignment && assignment.state !== "ended") {
        if (["ready", "dropped", "failed", "blocked"].includes(input.state)) {
          assignment.state = "ended";
          assignment.endedAt = at;
          assignment.endedReason = input.state;
        }
      }
      this.store.tickets.save(ticket);
      this.emit({ type: "report.recorded", at, data: { ticketId, state: input.state, summary: input.summary } });

      if (input.state === "ready" || input.state === "dropped") {
        this.endTicket(ticket, "executor", input.state === "ready" ? "completed" : "dropped", input.summary);
      }
      this.resolveWaiter(ticket, report);
      this.noticeFor(ticket, report);
      return this.requireTicket(ticketId);
    });
  }

  private applyAttention(ticket: Ticket, report: StoredReport, clear: boolean): void {
    const previous = ticket.attention;
    if (clear) {
      if (previous) {
        delete ticket.attention;
        this.emit({ type: "attention.closed", at: report.at, data: { ticketId: ticket.id } });
      }
      return;
    }
    if (!report.question) return;
    if (previous?.question === report.question) return;
    ticket.attention = {
      id: key("attention", ticket.id, report.question, report.at),
      question: report.question,
      at: report.at,
      triggerId: report.askedBy,
    };
    this.emit({ type: "attention.opened", at: report.at, data: { ticketId: ticket.id, question: report.question } });
  }

  private noticeFor(ticket: Ticket, report: StoredReport): void {
    const run = ticket.kind === "run";
    const needsPerson = report.state === "blocked" || report.state === "failed" || !!ticket.attention;
    const terminal = report.state === "ready" || report.state === "dropped";
    if (!run && !needsPerson && !this.options.notifyTaskReports) return;
    if (report.state === "progress" && !needsPerson) return;
    const kind: Notice["kind"] = ticket.attention ? "attention" : terminal ? (run ? "result" : "report") : "failure";
    const label = ticket.runId ?? ticket.id;
    const head = run ? `run ${label}` : `${ticket.task ?? ticket.id} (${ticket.stage})`;
    const text = ticket.attention ? `${head}: ${ticket.attention.question}` : `${head}: ${report.state} — ${report.summary}`;
    this.notice({ kind, ticketId: ticket.id, runId: ticket.runId, stage: ticket.stage, state: report.state, text, question: ticket.attention?.question });
  }

  private resolveWaiter(ticket: Ticket, report: StoredReport): void {
    const waiter = this.waiters.get(ticket.id);
    if (!waiter) return;
    if (report.state === "progress") return;
    this.waiters.delete(ticket.id);
    waiter.resolve(report);
  }

  /** Resolve with the next non-progress Report, or reject when the ticket is stopped. */
  waitForReport(ticketId: string, signal?: AbortSignal): Promise<StoredReport> {
    return new Promise<StoredReport>((resolve, reject) => {
      const ticket = this.requireTicket(ticketId);
      const last = ticket.reports.at(-1);
      if (last && last.state !== "progress" && ticket.ended) {
        resolve(last);
        return;
      }
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        this.waiters.delete(ticketId);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(ticketId, {
        resolve: (report) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(report);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
    });
  }

  // -------------------------------------------------------- ticket lifecycle

  private endTicket(ticket: Ticket, by: "person" | "executor" | "host", outcome: TicketOutcome, reason?: string): void {
    if (ticket.ended) return;
    const at = this.nowDate();
    for (const assignment of ticket.assignments) {
      if (assignment.state !== "ended") {
        assignment.state = "ended";
        assignment.endedAt = at;
        assignment.endedReason = `ticket ${outcome}`;
      }
    }
    ticket.ended = { at, by, outcome, reason };
    ticket.updatedAt = at;
    this.store.tickets.save(ticket);
    this.emit({ type: "ticket.ended", at, data: { ticketId: ticket.id, by, outcome, reason } });
  }

  /** A person's stop. It ends the Ticket and withdraws its Mandate; nothing resumes it. */
  stop(ticketId: string, reason = "stopped by a person"): Ticket {
    const ticket = this.requireTicket(ticketId);
    if (!liveTicket(ticket)) return ticket;
    const assignment = runningAssignment(ticket);
    if (assignment) this.endAssignment(ticket, assignment, reason, true);
    this.endTicket(ticket, "person", "stopped", reason);
    this.emit({ type: "ticket.stopped", at: this.nowDate(), data: { ticketId, reason } });
    return this.requireTicket(ticketId);
  }

  /** Close a Ticket from the host, such as a run whose artifacts were exported. */
  finish(ticketId: string, outcome: TicketOutcome, reason: string): Ticket {
    const ticket = this.requireTicket(ticketId);
    const assignment = runningAssignment(ticket);
    if (assignment) this.endAssignment(ticket, assignment, reason);
    this.endTicket(ticket, "host", outcome, reason);
    return this.requireTicket(ticketId);
  }

  // ------------------------------------------------------------------ inputs

  private addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some((item) => item.id === input.id)) return;
    ticket.inputs = [...ticket.inputs, input];
    ticket.undelivered = [...ticket.undelivered, input.id];
    ticket.updatedAt = this.nowDate();
    this.store.tickets.save(ticket);
    this.emit({ type: "input.added", at: ticket.updatedAt, data: { ticketId: ticket.id, inputId: input.id, kind: input.kind } });
  }

  /** Tell a Ticket's Executor a fact from other work. It grants no authority. */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.requireTicket(ticketId);
    if (!liveTicket(ticket)) throw new ProtocolError(`ticket ${ticketId} has ended`);
    this.addInput(ticket, { id: key("input", ticketId, "note", this.sequence++), kind: "note", at: this.nowDate(), text });
    this.deliver(ticketId);
    return this.requireTicket(ticketId);
  }

  /** Subscribe a Ticket to a Trigger's Threads and add the Trigger as an Input. */
  attach(triggerId: string, ticketId: string, note?: string): Ticket {
    const trigger = this.store.triggers.get(triggerId);
    if (!trigger) throw new ProtocolError(`unknown trigger ${triggerId}`);
    const ticket = this.requireTicket(ticketId);
    if (ticket.ended?.by === "person") throw new ProtocolError(`ticket ${ticketId} was stopped by a person`);
    return this.store.atomic(() => {
      for (const ref of trigger.threads) {
        const keyOf = threadKey(ref);
        if (!ticket.subscriptions.includes(keyOf)) ticket.subscriptions = [...ticket.subscriptions, keyOf];
        const thread = this.store.threads.get(keyOf);
        if (thread && !thread.tickets.includes(ticketId)) {
          thread.tickets = [...thread.tickets, ticketId];
          thread.updatedAt = this.nowDate();
          this.store.threads.save(thread);
        }
      }
      const at = this.nowDate();
      this.addInput(ticket, { id: key("input", ticketId, "trigger", triggerId), kind: "trigger", at, triggerId, human: trigger.human, note });
      const current = this.store.triggers.disposition(triggerId);
      if (current) this.store.triggers.saveDisposition(triggerId, { ...current, disposition: "fanout", fanout: [...new Set([...(current.fanout ?? []), ticketId])] });
      this.deliver(ticketId);
      return this.requireTicket(ticketId);
    });
  }

  /** Answer an open question: clears the Attention and wakes the Executor. */
  answer(ticketId: string, text: string): Ticket {
    const ticket = this.requireTicket(ticketId);
    if (!ticket.attention) throw new ProtocolError(`ticket ${ticketId} has no open question`);
    return this.store.atomic(() => {
      this.addInput(ticket, { id: key("input", ticketId, "resume", this.sequence++), kind: "resume", at: this.nowDate(), text });
      const current = this.requireTicket(ticketId);
      if (current.attention) {
        delete current.attention;
        this.emit({ type: "attention.closed", at: this.nowDate(), data: { ticketId } });
        this.store.tickets.save(current);
      }
      if (current.kind === "task" && !runningAssignment(current)) this.startAssignment(current, current.assignments.length + 1);
      else this.deliver(ticketId);
      return this.requireTicket(ticketId);
    });
  }

  /** Ask an idle Ticket's Executor for a status report. */
  requestStatus(ticketId: string): boolean {
    const ticket = this.requireTicket(ticketId);
    if (ticket.ended) return false;
    if (!settledAssignment(ticket)) return false;
    this.addInput(ticket, { id: key("input", ticketId, "status", this.sequence++), kind: "resume", at: this.nowDate(), text: "Report the current status. Do not restart finished work." });
    this.deliver(ticketId);
    return true;
  }

  // ------------------------------------------------------------------ policy

  /** Throw when a rule needs a person; the caller reports a blocked run. */
  assertRule(ticketId: string, rule: string): void {
    const ticket = this.requireTicket(ticketId);
    const verdict = this.currentPolicy.mayRun(rule, ticket.mandate);
    if (verdict === "run") return;
    throw new PolicyHoldError(rule, verdict === "observe" ? "observe" : "attention", `${rule} needs a person for ${ticket.runId ?? ticket.id}`);
  }

  /** Apply a new policy version; running Evals are dropped and re-queued. */
  setPolicy(settings: PolicySettings): void {
    const from = this.currentPolicy.version();
    this.store.atomic(() => {
      this.store.savePolicy(settings);
      this.currentPolicy = makePolicy(settings);
      const at = this.nowDate();
      this.emit({ type: "policy.changed", at, data: { from, to: settings.version } });
      for (const thread of this.store.threads.list()) {
        thread.evalId = undefined;
        thread.updatedAt = at;
        this.store.threads.save(thread);
        for (const triggerId of thread.triggers) {
          const disposition = this.store.triggers.disposition(triggerId);
          if (disposition?.disposition === "eval") continue;
          const trigger = this.store.triggers.get(triggerId);
          if (!trigger) continue;
          this.store.triggers.saveDisposition(triggerId, { ...(disposition ?? { receivedAt: trigger.at }), disposition: "eval" });
        }
      }
    });
  }

  // ------------------------------------------------------------- restart etc.

  /**
   * Recover after a host restart. A run cannot resume mid-loop, so it is
   * reported blocked with a recovery question; task Tickets are marked failed.
   */
  recover(): Ticket[] {
    const recovered: Ticket[] = [];
    for (const ticket of this.store.tickets.open()) {
      const assignment = runningAssignment(ticket);
      if (!assignment) continue;
      assignment.state = "ended";
      assignment.endedAt = this.nowDate();
      assignment.endedReason = "hostRestarted";
      ticket.updatedAt = this.nowDate();
      this.store.tickets.save(ticket);
      if (ticket.kind === "run") {
        recovered.push(
          this.report(ticket.id, {
            state: "blocked",
            summary: "The host restarted while the run was working.",
            question: `Run ${ticket.runId ?? ticket.id} was interrupted by a restart. Start it again, or inspect its artifacts first.`,
          }),
        );
      } else {
        recovered.push(this.report(ticket.id, { state: "failed", summary: RECOVERY_NOTE }));
      }
    }
    return recovered;
  }

  close(): void {
    this.closed = true;
    for (const [ticketId, waiter] of this.waiters) {
      waiter.reject(new ProtocolError(`engine closed while waiting for ${ticketId}`));
    }
    this.waiters.clear();
    this.store.close();
  }
}

/** A deterministic run id from the spec, used when the caller does not name one. */
export function runIdOf(spec: RunSpec): string {
  const explicit = str((spec.options as Record<string, unknown>).run_id);
  return explicit || key("run", spec.problem, spec.seed, spec.mode).slice(0, 8);
}

function settledAssignment(ticket: Ticket): boolean {
  const assignment = latestAssignment(ticket);
  return !assignment || assignment.state === "ended";
}

/** Normalize an untrusted report payload into the protocol's states. */
export function reportState(value: unknown): ReportState {
  const allowed: ReportState[] = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
  return allowed.includes(value as ReportState) ? (value as ReportState) : "failed";
}

export function usageRecord(value: unknown): Record<string, number> {
  const record = asRecord(value) ?? {};
  const out: Record<string, number> = {};
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[name] = raw;
  }
  return out;
}
