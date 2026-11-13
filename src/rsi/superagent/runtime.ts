/**
 * Superagent protocol — runtime.
 *
 * Glue between the protocol and the RSI pipeline. One `RunSession` is one
 * accepted run: its durable store (`runs/<run_id>/superagent/`), its Engine, its
 * worker, and the SOP driver that executes the run ticket.
 *
 * The runtime is what a foreground tool talks to:
 *   dispatch(...)          accept a request and start the SOP
 *   session(runId)         the live engine of a run, when this process has it
 *   list() / status(...)   read every run on disk, live or not
 *
 * A run that ended in a previous process stays readable; it is not resumed,
 * because the SOP holds no mid-loop checkpoint and pretending otherwise would
 * manufacture a result. Restarting it creates a new run, at a new directory.
 */

import fs from "node:fs";
import path from "node:path";

import { str } from "../json.ts";
import { runResearch, type RunResult } from "../run.ts";
import { loadProblem, newRunId } from "../run.ts";
import { CompositeExecutor, RunExecutor, TaskExecutor, type RunDriver, type TaskWorker } from "./executor.ts";
import { Engine, PolicyHoldError, type Notice, type ReportInput } from "./engine.ts";
import {
  type Assignment,
  type PolicySettings,
  type RunSpec,
  type Stage,
  type Ticket,
  type TicketOutcome,
  key,
  latestReport,
  liveTicket,
  ticketStage,
} from "./model.ts";
import { defaultPolicySettings, makePolicy } from "./policy.ts";
import { stageSpec, stageOfTask } from "./sop.ts";
import { FileRepositories, MemoryRepositories, type Repositories, type Snapshot } from "./store.ts";
import { SuperagentLLMProvider } from "../providers/superagent.ts";

export interface WorkerContext {
  spec: RunSpec;
  cwd: string;
  signal: AbortSignal;
}

export type WorkerFactory = (context: WorkerContext) => TaskWorker;

export interface RuntimeOptions {
  cwd: string;
  /** Builds the worker for one run: Pi sessions, in-process calls or a mock. */
  workerFactory: WorkerFactory;
  policy?: PolicySettings;
  onNotice?: (notice: Notice) => void;
  onTrace?: (kind: string, data: Record<string, unknown>) => void;
  clock?: () => Date;
  /** Send task start/ready reports to the foreground UI; failures always notify. */
  notifyTaskReports?: boolean;
  /** Keep the run store in memory (tests). */
  inMemory?: boolean;
}

export interface DispatchParams {
  problem: string;
  out?: string;
  seed?: number;
  mode?: "provider" | "mock";
  agents?: "subagent" | "inline";
  runner?: "simulated" | "subprocess";
  provider?: string;
  model?: string;
  coding_model?: string;
  title?: string;
  actor?: string;
  sessionId?: string;
  options?: Record<string, unknown>;
  thinking?: string;
}

export interface RunStatus {
  run_id: string;
  root: string;
  /** The run ticket id, the id a person uses to inspect or stop the run. */
  run_ticket_id?: string;
  /** Previous run id when this run is a resumed attempt. */
  resumed_from?: string;
  title: string;
  state: string;
  ended?: { outcome: TicketOutcome; at: string; reason?: string };
  attention?: string;
  mode?: string;
  runner?: string;
  stages: Array<{ stage: Stage; section: string; title: string; state: string; tasks: number; done: number }>;
  tickets: Array<Record<string, unknown>>;
  progress?: { state: string; summary: string; at: string };
  policy: { version: string; mode: string; paused: boolean };
}

export interface RunSummary {
  run_id: string;
  root: string;
  title: string;
  state: string;
  updated_at: string;
}

/** One accepted run, live in this process. */
export class RunSession {
  readonly runId: string;
  readonly root: string;
  readonly engine: Engine;
  readonly ticketId: string;
  readonly spec: RunSpec;
  private readonly driver: SopDriver;
  private readonly worker: TaskWorker;
  private readonly controller = new AbortController();

  constructor(options: {
    spec: RunSpec;
    cwd: string;
    store: Repositories;
    policy: PolicySettings;
    workerFactory: WorkerFactory;
    onNotice?: (notice: Notice) => void;
    onTrace?: (kind: string, data: Record<string, unknown>) => void;
    clock?: () => Date;
    notifyTaskReports?: boolean;
  }) {
    this.spec = options.spec;
    this.runId = path.basename(options.spec.root);
    this.root = options.spec.root;
    this.worker = options.workerFactory({ spec: options.spec, cwd: options.cwd, signal: this.controller.signal });
    let engineRef: Engine | null = null;
    const resumedFrom = str(options.spec.options.resumed_from) || undefined;
    this.driver = new SopDriver({
      spec: options.spec,
      cwd: options.cwd,
      resumeFrom: resumedFrom,
      engine: () => {
        if (!engineRef) throw new Error("engine is not ready");
        return engineRef;
      },
      worker: this.worker,
    });
    const executor = new CompositeExecutor(
      new TaskExecutor(this.worker, () => engineRef!),
      new RunExecutor(this.driver),
    );
    engineRef = new Engine({
      store: options.store,
      policy: makePolicy(options.policy),
      executor,
      clock: options.clock,
      onTrace: options.onTrace,
      onNotice: options.onNotice,
      notifyTaskReports: options.notifyTaskReports ?? false,
    });
    this.engine = engineRef;
    const trigger = this.engine.intake({
      source: options.spec.mode === "mock" ? "cli" : "human",
      kind: "request",
      human: true,
      actor: options.spec.options.actor as string | undefined,
      addressed: true,
      text: str(options.spec.options.title),
      thread: { id: str(options.spec.options.session_id) || this.runId, title: str(options.spec.options.title) || this.runId },
      meta: { run: options.spec, title: options.spec.options.title },
      key: key("dispatch", this.runId),
    });
    const accepted = this.engine.accept(trigger.trigger.id, options.spec, { title: str(options.spec.options.title) || this.runId });
    if (!accepted.ticket) throw new Error(`the policy refused the run: ${accepted.decision.reason}`);
    this.ticketId = accepted.ticket.id;
  }

  /** The current SOP turn: a retry replaces it with a new one. */
  get done(): Promise<RunResult | null> {
    return this.driver.wait();
  }

  get ticket(): Ticket {
    return this.engine.requireTicket(this.ticketId);
  }

  /** Idle a session: the run stops and its worker is released. */
  close(): void {
    this.driver.cancel("session closed");
    this.worker.close?.();
    this.controller.abort();
    this.engine.close();
  }

  status(): RunStatus {
    return statusOf(this.engine, this.runId);
  }
}

/** The SOP driver: executes the run ticket by running the ScientistTwo loop. */
class SopDriver implements RunDriver {
  private controller: AbortController | null = null;
  private promise: Promise<RunResult | null> = Promise.resolve(null);
  private lastProgress = 0;
  private lastProgressMessage = "";

  private readonly opts: {
    spec: RunSpec;
    cwd: string;
    resumeFrom?: string;
    engine: () => Engine;
    worker: TaskWorker;
  };

  constructor(opts: { spec: RunSpec; cwd: string; resumeFrom?: string; engine: () => Engine; worker: TaskWorker }) {
    this.opts = opts;
  }

  wait(): Promise<RunResult | null> {
    return this.promise;
  }

  start(ticket: Ticket, _assignment: Assignment): void {
    this.controller = new AbortController();
    this.promise = this.run(ticket, this.controller.signal);
  }

  deliver(): void {
    /* a run driver reads its inputs between stages, through the run report */
  }

  stop(_ticket: Ticket, _assignment: Assignment, reason: string): void {
    this.cancel(reason);
  }

  cancel(reason: string): void {
    this.controller?.abort(reason);
  }

  private progress(ticketId: string, message: string): void {
    const now = Date.now();
    // Stage transitions must be visible immediately. Throttle only repeated
    // messages, not a new stage that happens shortly after the previous one.
    if (message === this.lastProgressMessage && now - this.lastProgress < 1500) return;
    this.lastProgress = now;
    this.lastProgressMessage = message;
    const engine = this.opts.engine();
    const ticket = engine.ticket(ticketId);
    if (!ticket || !liveTicket(ticket)) return;
    engine.report(ticketId, { state: "progress", summary: message } satisfies ReportInput);
  }

  private async run(ticket: Ticket, signal: AbortSignal): Promise<RunResult | null> {
    const engine = this.opts.engine();
    const spec = this.opts.spec;
    try {
      if (spec.mode === "provider") engine.assertRule(ticket.id, "sop.spend");
      if (spec.runner === "subprocess") engine.assertRule(ticket.id, "sop.experiment");
      const provider = new SuperagentLLMProvider({
        engine,
        runTicketId: ticket.id,
        worker: this.opts.worker,
        thinkingLevel: typeof spec.options.thinking === "string" ? spec.options.thinking : undefined,
        signal,
      });
      const result = await runResearch({
        problem: spec.problem,
        cwd: this.opts.cwd,
        outDir: spec.out,
        runId: path.basename(spec.root),
        resumeFrom: this.opts.resumeFrom,
        seed: spec.seed,
        runner: spec.runner,
        mock: spec.mode === "mock",
        provider,
        providerName: spec.provider,
        model: spec.model,
        codingModel: spec.codingModel,
        maxTokens: tokenCap(spec.options.max_tokens),
        codingMaxTokens: tokenCap(spec.options.coding_max_tokens),
        strictDirections: spec.options.strict_directions === true,
        maxRefineRounds: numberOrUndefined(spec.options.max_refine_rounds),
        maxReviewRefinements: numberOrUndefined(spec.options.max_review_refinements),
        maxLlmCalls: numberOrUndefined(spec.options.max_llm_calls),
        maxWallTimeS: numberOrUndefined(spec.options.max_wall_time_s),
        ...(typeof spec.options.baseline === "string" ? { baseline: spec.options.baseline } : {}),
        signal,
        onProgress: (message) => this.progress(ticket.id, message),
      });
      engine.report(ticket.id, {
        state: "ready",
        summary: runSummary(result),
        output: { final: result.final, summary: result.summary, root: result.root, run_id: result.runId },
      });
      return result;
    } catch (error) {
      if (error instanceof PolicyHoldError) {
        engine.report(ticket.id, {
          state: "blocked",
          summary: error.message,
          question: `${error.message.replace(/\.$/, "")}. Allow this step, or run with the offline simulator.`,
        });
      } else if ((error as Error)?.name === "AbortError" || signal.aborted) {
        engine.report(ticket.id, { state: "dropped", summary: "the run was stopped" });
      } else {
        engine.report(ticket.id, { state: "failed", summary: `run failed: ${(error as Error)?.message ?? String(error)}` });
      }
      return null;
    }
  }
}

/** The runtime a foreground tool holds. */
export class SuperagentRuntime {
  readonly cwd: string;
  readonly out: string;
  private readonly sessions = new Map<string, RunSession>();
  private readonly runOuts = new Map<string, string>();
  private readonly retired = new Map<string, RunStatus>();
  private readonly byTrigger = new Map<string, string>();
  private readonly workerFactory: WorkerFactory;
  private policy: PolicySettings;
  private readonly inMemory: boolean;

  private readonly options: RuntimeOptions;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.out = path.resolve(options.cwd, "runs");
    this.workerFactory = options.workerFactory;
    this.policy = options.policy ?? defaultPolicySettings();
    this.inMemory = options.inMemory ?? false;
  }

  /** Accept a request and start the SOP. Returns immediately. */
  dispatch(params: DispatchParams): { session: RunSession; duplicate: boolean } {
    const triggerKey = key(
      "dispatch",
      params.sessionId ?? params.actor ?? "",
      params.problem,
      params.title ?? "",
      params.seed ?? 7,
      params.mode ?? "provider",
      params.agents ?? "subagent",
      params.out ?? "runs",
    );
    const existing = this.byTrigger.get(triggerKey);
    if (existing && this.sessions.has(existing)) return { session: this.sessions.get(existing)!, duplicate: true };
    const problem = loadProblem(params.problem, this.cwd);
    const out = path.resolve(this.cwd, params.out ?? "runs");
    fs.mkdirSync(out, { recursive: true });
    const seed = params.seed ?? 7;
    const runId = newRunId(out, problem, seed);
    const root = path.join(out, runId);
    const spec = this.spec(params, runId, root, out, seed);
    fs.mkdirSync(root, { recursive: true });
    const session = this.openSession(spec, params);
    this.sessions.set(runId, session);
    this.runOuts.set(runId, out);
    this.byTrigger.set(triggerKey, runId);
    return { session, duplicate: false };
  }

  private spec(params: DispatchParams, runId: string, root: string, out: string, seed: number): RunSpec {
    return {
      problem: params.problem,
      out,
      root,
      seed,
      mode: params.mode ?? "provider",
      agents: params.agents ?? "subagent",
      runner: params.runner ?? "simulated",
      provider: params.provider,
      model: params.model,
      codingModel: params.coding_model,
      options: {
        ...(params.options ?? {}),
        title: params.title,
        run_id: runId,
        session_id: params.sessionId,
        actor: params.actor,
        ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
        strict_directions: params.options?.strict_directions,
        max_refine_rounds: params.options?.max_refine_rounds,
        max_review_refinements: params.options?.max_review_refinements,
        max_llm_calls: params.options?.max_llm_calls,
        max_wall_time_s: params.options?.max_wall_time_s,
      },
    };
  }

  private openSession(spec: RunSpec, _params: DispatchParams): RunSession {
    const store: Repositories = this.inMemory
      ? new MemoryRepositories(this.policy)
      : new FileRepositories(path.join(spec.root, "superagent"), this.policy);
    return new RunSession({
      spec,
      cwd: this.cwd,
      store,
      policy: this.policy,
      workerFactory: this.workerFactory,
      onNotice: this.options.onNotice,
      onTrace: this.options.onTrace,
      clock: this.options.clock,
      notifyTaskReports: this.options.notifyTaskReports ?? true,
    });
  }

  session(runId: string): RunSession | undefined {
    return this.sessions.get(runId);
  }

  private live(runId: string): RunSession {
    const session = this.sessions.get(runId);
    if (!session) {
      throw new Error(`run ${runId} is not live in this process; status is read-only. Start a new run to continue the work.`);
    }
    return session;
  }

  /** Retry a ticket that reported failed or blocked. Live runs only. */
  retry(runId: string, ticketId: string): Ticket {
    return this.live(runId).engine.retry(ticketId);
  }

  /** Stop a ticket on a person's instruction. Live runs only. */
  stop(runId: string, ticketId: string, reason = "stopped by a person"): Ticket {
    const session = this.live(runId);
    const dir = storeDir(session.root);
    if (this.inMemory || fs.existsSync(dir)) {
      try {
        const ticket = session.engine.stop(ticketId, reason);
        // A run stop releases the whole executor, including in-flight task
        // workers; otherwise a hung worker keeps the session alive.
        if (ticket.kind === "run") session.close();
        return ticket;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // The evidence directory can vanish under a live engine (a person deleted
    // it). There is nowhere left to write the stop, so end the ticket in
    // memory, release the executor, and retire the status. Never recreate the
    // artifacts: deleting evidence is not the same as granting a new run.
    const ticket = session.engine.ticket(ticketId);
    const at = new Date().toISOString();
    if (ticket && !ticket.ended) {
      ticket.ended = { at, by: "person", outcome: "stopped", reason };
      ticket.updatedAt = at;
      for (const assignment of ticket.assignments) {
        if (assignment.state !== "ended") {
          assignment.state = "ended";
          assignment.endedAt = at;
          assignment.endedReason = reason;
        }
      }
    }
    this.retired.set(runId, session.status());
    this.sessions.delete(runId);
    try {
      session.close();
    } catch {
      /* the store is already gone; release whatever remains */
    }
    if (!ticket) throw new Error(`run ${runId} has no ticket ${ticketId}`);
    return ticket;
  }

  /** Answer an open question; the only thing that resumes blocked work. */
  answer(runId: string, ticketId: string, text: string): Ticket {
    return this.live(runId).engine.answer(ticketId, text);
  }

  /** Tell a ticket's worker a fact. It grants no authority. */
  note(runId: string, ticketId: string, text: string): Ticket {
    return this.live(runId).engine.note(ticketId, text);
  }

  /** Attach a trigger of this process to a live ticket. */
  attach(runId: string, ticketId: string, triggerId: string, note?: string): Ticket {
    return this.live(runId).engine.attach(triggerId, ticketId, note);
  }

  /** One ticket of a live or read-only run. */
  ticket(runId: string, ticketId: string): Ticket | undefined {
    const live = this.sessions.get(runId);
    if (live) return live.engine.ticket(ticketId);
    const dir = path.join(this.out, runId, "superagent");
    const snapshot = readSnapshot(dir);
    return snapshot ? findTicket(snapshot, ticketId) : undefined;
  }

  /** Domain events of a run, oldest first. */
  events(runId: string, limit = 50): unknown[] {
    const live = this.sessions.get(runId);
    if (live) return live.engine.events().slice(-limit);
    const file = path.join(this.out, runId, "superagent", "events.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);
  }

  /** Every run directory with a superagent store, newest first. */
  list(): RunSummary[] {
    const root = this.out;
    if (!fs.existsSync(root)) return [];
    const out: RunSummary[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name, "superagent");
      if (!fs.existsSync(path.join(dir, "state.json"))) continue;
      const snapshot = readSnapshot(dir);
      if (!snapshot) continue;
      const run = snapshot.tickets.find((ticket) => ticket.kind === "run");
      out.push({
        run_id: entry.name,
        root: path.dirname(dir),
        title: run?.title ?? entry.name,
        state: run ? ticketStage(run) : "unknown",
        updated_at: snapshot.updatedAt,
      });
    }
    for (const session of this.sessions.values()) {
      if (out.some((item) => item.run_id === session.runId)) continue;
      out.push({ run_id: session.runId, root: session.root, title: session.ticket.title, state: ticketStage(session.ticket), updated_at: session.ticket.updatedAt });
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** The original spec of a run, live or from its durable snapshot. */
  runSpec(runId: string): RunSpec | undefined {
    const live = this.sessions.get(runId);
    if (live) return live.spec;
    const base = this.runOuts.get(runId) ?? this.out;
    const snapshot = readSnapshot(storeDir(path.join(base, runId)));
    return snapshot?.tickets.find((ticket) => ticket.kind === "run")?.run;
  }

  /** Create a new attempt that resumes a previous ended/failed run. */
  resume(runId: string): RunSession {
    const live = this.sessions.get(runId);
    const spec = live?.spec ?? this.runSpec(runId);
    if (!spec) throw new Error(`no run spec found for ${runId}`);
    const oldStatus = live?.status() ?? this.status(runId);
    const ended = oldStatus?.ended;
    const outDir = spec.out;
    const root = spec.root || path.join(outDir, runId);
    const finalFile = path.join(root, "final.json");
    let aborted = false;
    try {
      const final = JSON.parse(fs.readFileSync(finalFile, "utf8")) as { aborted?: boolean };
      aborted = final.aborted === true;
    } catch {
      /* no final artifact; the run may have failed before export */
    }
    // A failed report keeps the run ticket open for a retry, so the normal
    // failed-run state has no `ended` entry. Accept the failed report itself;
    // `ended` is set only by a stop or a host finish, and a stop stays final.
    const failedOpen = !ended && (oldStatus?.progress?.state === "failed" || oldStatus?.state === "person/failed");
    const resumable = aborted || ended?.outcome === "failed" || ended?.outcome === "dropped" || failedOpen;
    if (!resumable) {
      if (live && !ended) throw new Error(`run ${runId} is still live; wait for it to end`);
      throw new Error(`run ${runId} ended ${ended?.outcome ?? "without a final state"}; only aborted/failed runs can resume`);
    }
    if (live) {
      this.retired.set(runId, oldStatus!);
      this.sessions.delete(runId);
      live.close();
    }
    let index = 1;
    let newId = `${runId}-r${index}`;
    while (fs.existsSync(path.join(outDir, newId))) {
      index += 1;
      newId = `${runId}-r${index}`;
    }
    const newRoot = path.join(outDir, newId);
    fs.mkdirSync(newRoot, { recursive: true });
    const resumedSpec: RunSpec = {
      ...spec,
      root: newRoot,
      options: {
        ...spec.options,
        resumed_from: runId,
        title: `${str(spec.options.title) || runId} (resume ${index})`,
      },
    };
    const session = this.openSession(resumedSpec, { problem: spec.problem });
    this.sessions.set(newId, session);
    this.runOuts.set(newId, outDir);
    return session;
  }

  status(runId: string): RunStatus | undefined {
    const live = this.sessions.get(runId);
    if (live) return live.status();
    const base = this.runOuts.get(runId) ?? this.out;
    const dir = path.join(base, runId, "superagent");
    const snapshot = readSnapshot(dir);
    if (!snapshot) return this.retired.get(runId);
    return statusOfSnapshot(snapshot, runId, path.join(base, runId));
  }

  /** Change the policy for new runs and every live one. */
  applyPolicy(settings: PolicySettings): string[] {
    this.policy = settings;
    return this.setPolicy(settings);
  }

  /** Apply a policy change to every live run. */
  setPolicy(settings: PolicySettings): string[] {
    const changed: string[] = [];
    for (const session of this.sessions.values()) {
      session.engine.setPolicy(settings);
      changed.push(session.runId);
    }
    return changed;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

function readSnapshot(dir: string): Snapshot | null {
  const file = path.join(dir, "state.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

/** A read-only status for a run that is not live in this process. */
export function statusOfSnapshot(snapshot: Snapshot, runId: string, root: string): RunStatus {
  const run = snapshot.tickets.find((ticket) => ticket.kind === "run");
  return {
    run_id: runId,
    root,
    run_ticket_id: run?.id,
    resumed_from: str(run?.run?.options.resumed_from) || undefined,
    title: run?.title ?? runId,
    state: run ? ticketStage(run) : "unknown",
    ended: run?.ended ? { outcome: run.ended.outcome, at: run.ended.at, reason: run.ended.reason } : undefined,
    attention: run?.attention?.question,
    mode: run?.run?.mode,
    runner: run?.run?.runner,
    stages: stageRows(snapshot.tickets, run, readRunFacts(root)),
    tickets: snapshot.tickets.filter((ticket) => ticket.kind === "task").map(ticketCard),
    progress: run ? latestReport(run) : undefined,
    policy: { version: snapshot.policy.version, mode: snapshot.policy.acceptMode, paused: snapshot.policy.paused },
  };
}

export function statusOf(engine: Engine, runId: string): RunStatus {
  const run = engine.runTickets().find((ticket) => ticket.runId === runId) ?? engine.runTickets().at(-1);
  const tickets = engine.tickets({ runId });
  return {
    run_id: runId,
    root: run?.run?.root ?? "",
    run_ticket_id: run?.id,
    resumed_from: str(run?.run?.options.resumed_from) || undefined,
    title: run?.title ?? runId,
    state: run ? ticketStage(run) : "unknown",
    ended: run?.ended ? { outcome: run.ended.outcome, at: run.ended.at, reason: run.ended.reason } : undefined,
    attention: run?.attention?.question,
    mode: run?.run?.mode,
    runner: run?.run?.runner,
    stages: stageRows(engine.tickets(), run, readRunFacts(run?.run?.root)),
    tickets: tickets.filter((ticket) => ticket.kind === "task").map(ticketCard),
    progress: run ? latestReport(run) : undefined,
    policy: { version: engine.policySettings().version, mode: engine.policySettings().acceptMode, paused: engine.policySettings().paused },
  };
}

interface RunFacts {
  decisionPath: string[];
  baseline: boolean;
  baselineFull: boolean;
  manuscript: boolean;
  seeds: number;
  limitations: number;
  traces: number;
  ablations: number;
}

const EMPTY_FACTS: RunFacts = {
  decisionPath: [],
  baseline: false,
  baselineFull: false,
  manuscript: false,
  seeds: 0,
  limitations: 0,
  traces: 0,
  ablations: 0,
};

/** Read the run's own state.json; it records the stage transitions and deliverables. */
function readRunFacts(root: string | undefined): RunFacts {
  if (!root) return EMPTY_FACTS;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")) as Record<string, unknown>;
    const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    return {
      decisionPath: Array.isArray(raw.decision_path) ? raw.decision_path.map(String) : [],
      baseline: raw.baseline != null,
      baselineFull: raw.baseline_full != null,
      manuscript: raw.manuscript != null,
      seeds: length(raw.seeds),
      limitations: length(raw.limitations),
      traces: length(raw.traces),
      ablations: length(raw.ablations),
    };
  } catch {
    return EMPTY_FACTS;
  }
}

function hasToken(facts: RunFacts, ...tokens: string[]): boolean {
  return facts.decisionPath.some((item) => tokens.some((token) => item === token || item.startsWith(token)));
}

/** A stage is done only when its decision-path deliverable exists. */
function stageCompleted(stage: Stage, facts: RunFacts): boolean {
  switch (stage) {
    case "run":
      return hasToken(facts, "run.");
    case "diagnose":
      return hasToken(facts, "diagnose.ok");
    case "limits":
      return hasToken(facts, "limits.ok");
    case "seeds":
      return facts.seeds > 0 && hasToken(facts, "seeds:", "seeds.partial:");
    case "baseline":
      // baseline.ok is emitted only after the subset (and full) repro finished.
      return facts.baseline && hasToken(facts, "baseline.ok");
    case "search":
      return hasToken(facts, "select:", "adopt.select:");
    case "select":
      return hasToken(facts, "adopt.");
    case "ablations":
      return hasToken(facts, "peer.", "meta.", "run.");
    case "draft":
      return facts.manuscript || hasToken(facts, "peer.", "meta.", "run.");
    case "review":
      return hasToken(facts, "meta.", "run.");
    case "meta":
      return hasToken(facts, "run.");
    case "integrity":
    case "export":
      return hasToken(facts, "run.");
  }
}

/** Which stage the run is in, from the last progress report the SOP emitted. */
function stagesFromProgress(summary: string | undefined, facts: RunFacts): Set<Stage> {
  const text = (summary ?? "").toLowerCase();
  if (!text) return new Set();
  if (text.startsWith("diagnose")) return new Set<Stage>(["diagnose"]);
  if (text.includes("extracting limitations")) return new Set<Stage>(["limits"]);
  if (text.includes("generating seed ideas")) return new Set<Stage>(["seeds"]);
  if (text.includes("reproducing the baseline")) return new Set<Stage>(["baseline"]);
  if (text.includes("searching ideas") || text.startsWith("§3.2 round")) return new Set<Stage>(["search"]);
  if (text.includes("selecting the incumbent")) return new Set<Stage>(["select"]);
  if (text.includes("running ablations")) return new Set<Stage>(["ablations"]);
  if (text.includes("drafting") || text.includes("peer review")) {
    return new Set<Stage>(facts.manuscript ? ["review"] : ["draft"]);
  }
  if (text.includes("meta-review")) return new Set<Stage>(["meta"]);
  return new Set();
}

/**
 * Stage rows are a display view, not a task-ticket count. A task ticket is one
 * model call; the stage's real deliverable (a reproduced baseline, a manuscript)
 * runs on the run ticket after that call returns. Mark a stage done only from
 * the run's decision_path, and use the SOP's declared task list for the count.
 */
function stageRows(tickets: Ticket[], run: Ticket | undefined, facts: RunFacts): RunStatus["stages"] {
  const stages = new Set<Stage>();
  for (const ticket of tickets) if (ticket.kind === "task") stages.add(ticket.stage);
  const lastProgress = [...(run?.reports ?? [])].reverse().find((report) => report.state === "progress");
  const current = stagesFromProgress(lastProgress?.summary, facts);
  for (const stage of current) stages.add(stage);
  const latest = run ? latestReport(run) : undefined;
  const failed = latest?.state === "failed" || run?.ended?.outcome === "failed";
  const stopped = run?.ended?.outcome === "stopped";
  return [...stages]
    .map((stage) => {
      const spec = stageSpec(stage);
      const stageTickets = tickets.filter((item) => item.kind === "task" && item.stage === stage);
      const declared = spec.tasks;
      // Count the SOP's declared tasks, not runtime retries or subset/full calls.
      const tasks = declared.length || stageTickets.length;
      const done = declared.length
        ? declared.filter((task) => stageTickets.some((ticket) => ticket.task === task && ticket.ended?.outcome === "completed")).length
        : stageTickets.filter((ticket) => ticket.ended?.outcome === "completed").length;
      const completed = stageCompleted(stage, facts);
      const active = current.has(stage) || stageTickets.some((ticket) => liveTicket(ticket));
      const state = completed ? "done" : active ? (failed ? "failed" : stopped ? "stopped" : "working") : "pending";
      // A stage can complete through the run decision path (for example a
      // reused baseline) without a task ticket. The SOP says its declared tasks
      // are done when the stage is done.
      return { stage, section: spec.section, title: spec.title, state, tasks, done: completed ? tasks : done };
    })
    .sort((a, b) => a.stage.localeCompare(b.stage));
}

/** The protocol's ticket card, pure so read-only views can use it. */
export function ticketCard(ticket: Ticket): Record<string, unknown> {
  const report = latestReport(ticket);
  return {
    id: ticket.id,
    kind: ticket.kind,
    stage: ticket.stage,
    task: ticket.task,
    title: ticket.title,
    state: ticketStage(ticket),
    report: report ? { state: report.state, summary: report.summary, at: report.at } : null,
    attention: ticket.attention?.question,
    ended: ticket.ended ?? null,
    mandate: { strength: ticket.mandate.strength, basis: ticket.mandate.basis, scope: ticket.mandate.scope },
  };
}

function runSummary(result: RunResult): string {
  const summary = result.summary as Record<string, unknown>;
  const accepted = Boolean(result.final.extra?.accepted);
  const state = result.final.aborted ? "aborted" : accepted ? "accepted" : "exported the incumbent";
  const scores = Array.isArray(summary.review_scores) ? summary.review_scores.join(",") : "n/a";
  return `${result.runId}: ${state}; review ${scores}/10`.slice(0, 300);
}

/** Budget options are not coerced: a missing cap inherits; an invalid explicit cap fails. */
function tokenCap(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("output token cap must be a positive safe integer when specified");
  }
  return value;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Find one ticket by id in a read-only snapshot. */
export function findTicket(snapshot: Snapshot, ticketId: string): Ticket | undefined {
  return snapshot.tickets.find((ticket) => ticket.id === ticketId);
}

/** Where a run's superagent store lives. */
export function storeDir(root: string): string {
  return path.join(root, "superagent");
}

export { stageOfTask };
