/**
 * Superagent protocol through its real transports: the runtime (mock worker),
 * the LLM provider over task tickets, and the foreground tool handlers.
 */

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { PiWorker, SuperagentLLMProvider } from "../src/rsi/providers/superagent.ts";
import { Engine } from "../src/rsi/superagent/engine.ts";
import { InlineWorker, normalizeEnvelope, outputText, type Executor, type TaskWorker } from "../src/rsi/superagent/executor.ts";
import type { PolicySettings, RunSpec, Ticket } from "../src/rsi/superagent/model.ts";
import { ticketStage } from "../src/rsi/superagent/model.ts";
import { defaultPolicySettings, makePolicy } from "../src/rsi/superagent/policy.ts";
import { SuperagentRuntime, statusOfSnapshot } from "../src/rsi/superagent/runtime.ts";
import { MemoryRepositories, type Snapshot } from "../src/rsi/superagent/store.ts";
import { superagentAction } from "../src/rsi/superagent/tools.ts";
import { fixture, repoRoot, tempDir } from "./helpers.ts";

const SPEC: RunSpec = {
  problem: fixture("ood_frozen_encoder"),
  out: "/tmp/rsi-superagent-provider",
  root: "/tmp/rsi-superagent-provider/run-1",
  seed: 7,
  mode: "mock",
  agents: "inline",
  runner: "simulated",
  options: { title: "run-1" },
};

class RecordingExecutor implements Executor {
  started: Ticket[] = [];
  stopped: string[] = [];

  start(ticket: Ticket): void {
    this.started.push(ticket);
  }

  deliver(): void {}

  stop(ticket: Ticket): void {
    this.stopped.push(ticket.id);
  }
}

function providerFixture() {
  const settings = defaultPolicySettings();
  const store = new MemoryRepositories(settings);
  const executor = new RecordingExecutor();
  const engine = new Engine({ store, policy: makePolicy(settings), executor });
  const { trigger } = engine.intake({
    source: "human",
    kind: "request",
    human: true,
    actor: "tester",
    addressed: true,
    thread: { id: "provider-thread" },
    meta: { run: SPEC, title: "run-1" },
  });
  const accepted = engine.accept(trigger.id, SPEC, { title: "run-1" });
  return { engine, executor, run: accepted.ticket! };
}

function request(task: string) {
  return {
    task,
    system: "You are one agent inside the RSI pipeline.",
    user: "Do the task.",
    provider: "opencode-go",
    model: "mock-model",
    temperature: 0.2,
    maxTokens: 1024,
    meta: {},
  };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------- provider

test("stage rows follow the run's deliverables, not ended task tickets", () => {
  const root = tempDir("rsi-stage-status-");
  fs.mkdirSync(root, { recursive: true });
  const at = "2026-01-01T00:00:00.000Z";
  const policy = defaultPolicySettings();
  const progress = { id: "r1", state: "progress" as const, summary: "§3.2 reproducing the baseline", at };
  const makeSnapshot = (reports: Ticket["reports"]): Snapshot => {
    const mandate = { id: "m", policyVersion: policy.version, strength: "explicit" as const, scope: "run", basis: "explicit" as const, rules: [], sender: "tester", at };
    const common = {
      decisionId: "d", mandate, channels: [], subscriptions: [], inputs: [], undelivered: [], assignments: [],
      origin: { triggerId: "t", triggerIds: ["t"] }, createdAt: at, updatedAt: at,
    };
    const task = (id: string): Ticket => ({
      ...common, id, shortName: id, title: id, kind: "task", stage: "baseline", task: "code.baseline",
      reports: [{ id: `report-${id}`, state: "ready", summary: "model call done", at }],
      ended: { at, by: "executor", outcome: "completed" },
    }) as unknown as Ticket;
    const run = {
      ...common, id: "run-1", shortName: "run-1", title: "run-1", kind: "run", stage: "run", reports,
      run: { problem: "fixture", out: path.dirname(root), root, seed: 7, mode: "mock", agents: "inline", runner: "simulated", options: {} },
    } as unknown as Ticket;
    return {
      version: 1, createdAt: at, updatedAt: at, policy,
      triggers: [], threads: [], decisions: [], dispositions: {},
      tickets: [run, task("task-subset"), task("task-full")],
    } as Snapshot;
  };
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    decision_path: ["limits.ok:66", "seeds:4"], baseline: null, baseline_full: null, seeds: [{}, {}, {}, {}], limitations: [],
  }));
  const working = statusOfSnapshot(makeSnapshot([progress]), "run-1", root).stages.find((stage) => stage.stage === "baseline")!;
  assert.equal(working.state, "working", "two model calls do not finish the baseline experiment");
  assert.equal(working.tasks, 1, "the SOP declares one baseline task");
  assert.equal(working.done, 1);

  fs.writeFileSync(stateFile, JSON.stringify({
    decision_path: ["limits.ok:66", "seeds:4", "baseline.full.ok", "baseline.ok"],
    baseline: { metrics: { word_ppl: 1 } }, baseline_full: { metrics: { word_ppl: 1 } }, seeds: [{}, {}, {}, {}], limitations: [],
  }));
  const done = statusOfSnapshot(makeSnapshot([progress]), "run-1", root).stages.find((stage) => stage.stage === "baseline")!;
  assert.equal(done.state, "done", "the baseline.ok transition finishes the stage");
  assert.equal(done.done, 1, "a completed reused baseline shows its declared task count");

  fs.writeFileSync(stateFile, JSON.stringify({
    decision_path: ["limits.ok:66", "seeds:4"], baseline: null, baseline_full: null, seeds: [{}, {}, {}, {}], limitations: [],
  }));
  const failed = statusOfSnapshot(
    makeSnapshot([progress, { id: "r2", state: "failed", summary: "run failed: baseline", at }]),
    "run-1",
    root,
  ).stages.find((stage) => stage.stage === "baseline")!;
  assert.equal(failed.state, "failed");
});

test("a provider call is one task ticket; its report is the model response", async () => {
  const { engine, run, executor } = providerFixture();
  const provider = new SuperagentLLMProvider({
    engine,
    runTicketId: run.id,
    worker: new InlineWorker(new MockLLMProvider(null, 7)),
  });
  const pending = provider.complete({ ...request("critic.subset"), maxTokens: undefined });
  await until(() => executor.started.some((ticket) => ticket.kind === "task"));
  const task = executor.started.find((ticket) => ticket.kind === "task")!;
  assert.equal(task.payload?.maxTokens, undefined);
  assert.equal(task.payload?.thinkingLevel, undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(task.payload)), "maxTokens"), false);
  engine.report(task.id, { state: "ready", summary: "ok", output: { text: '{"decision":"good"}' }, model: "mock/m1", usage: { input: 3, output: 5 } });
  const response = await pending;
  assert.equal(response.text, '{"decision":"good"}');
  assert.equal(response.model, "mock/m1");
  assert.deepEqual(response.usage, { input: 3, output: 5 });
  const ended = engine.requireTicket(task.id);
  assert.equal(ended.task, "critic.subset");
  assert.equal(ended.ended?.outcome, "completed");
});

test("a failed report is retried on the same task ticket", async () => {
  const { engine, run, executor } = providerFixture();
  const provider = new SuperagentLLMProvider({ engine, runTicketId: run.id, worker: new InlineWorker(new MockLLMProvider(null, 7)), attempts: 2 });
  const pending = provider.complete(request("code.full"));
  await until(() => executor.started.length >= 2 && executor.started.at(-1)!.kind === "task");
  const task = executor.started.filter((ticket) => ticket.kind === "task").at(-1)!;
  engine.report(task.id, { state: "failed", summary: "transient timeout" });
  await until(() => engine.requireTicket(task.id).assignments.length === 2);
  engine.report(task.id, { state: "ready", summary: "second attempt", output: { text: '{"ok":true}' } });
  const response = await pending;
  assert.equal(response.text, '{"ok":true}');
  assert.deepEqual(
    engine.requireTicket(task.id).reports.map((report) => report.state),
    ["failed", "ready"],
  );
});

test("a task answer keeps its JSON fields when the worker puts them directly in output", () => {
  const verdict = { decision: "accept", feedback: "Keep word_ppl measured.", metrics: { score: 1 }, notes: "" };
  const envelope = normalizeEnvelope({ state: "ready", summary: "verdict", output: verdict });
  assert.deepEqual(envelope.output, { text: JSON.stringify(verdict) });
  assert.equal(outputText({ answer: "plain" }), "plain");
  assert.equal(outputText("plain"), "plain");
  assert.equal(outputText(["a", "b"]), '["a","b"]');
  assert.equal(outputText({}), "");
  assert.equal(outputText(undefined), "");
  assert.equal(normalizeEnvelope({ state: "ready", summary: "empty" }).output, undefined);
  assert.deepEqual(normalizeEnvelope(null, "fallback").output, { text: "fallback" });
});

test("a raw JSON object report is answered as text, not rejected", async () => {
  const { engine, run, executor } = providerFixture();
  const provider = new SuperagentLLMProvider({ engine, runTicketId: run.id, worker: new InlineWorker(new MockLLMProvider(null, 7)) });
  const pending = provider.complete(request("limitations.verify"));
  await until(() => executor.started.some((ticket) => ticket.kind === "task"));
  const task = executor.started.find((ticket) => ticket.kind === "task")!;
  const verdict = { decision: "accept", feedback: "Keep word_ppl measured.", metrics: {}, notes: "" };
  engine.report(task.id, { state: "ready", summary: "verdict", output: verdict });
  const response = await pending;
  assert.equal(response.text, JSON.stringify(verdict));
});

test("a blocked report becomes an LLM error carrying the question", async () => {
  const { engine, run, executor } = providerFixture();
  const provider = new SuperagentLLMProvider({ engine, runTicketId: run.id, worker: new InlineWorker(new MockLLMProvider(null, 7)) });
  const pending = provider.complete(request("code.ablation"));
  await until(() => executor.started.some((ticket) => ticket.kind === "task"));
  const task = executor.started.find((ticket) => ticket.kind === "task")!;
  engine.report(task.id, { state: "blocked", summary: "needs a decision", question: "Is a GPU available?" });
  await assert.rejects(pending, /blocked.*GPU/);
  assert.equal(ticketStage(engine.requireTicket(task.id)), "person/answer");
});

// ----------------------------------------------------------------- runtime

test("a mock run executes the SOP as task tickets and ends completed", async () => {
  const out = tempDir("rsi-superagent-run-");
  const notices: Array<{ kind: string; ticketId: string; stage?: string }> = [];
  const runtime = new SuperagentRuntime({
    cwd: repoRoot,
    inMemory: true,
    workerFactory: () => new InlineWorker(new MockLLMProvider({
      "ablation.critic": {
        decision: "good",
        feedback: "The ablation attributes the full-set gain to the core mechanism.",
        metrics: {},
        notes: "Offline fixture: accepted attribution.",
      },
      "ablation.plan": {
        plans: [
          "safe component C",
          "residual-alignment refinement",
          "structural ablation: primary mechanism",
          "structural ablation: auxiliary loss/regularizer",
          "calibration gate",
        ].map((component, index) => ({
          id: `A${index + 1}`,
          component,
          description: "Remove the component and re-measure the same subset protocol.",
          expects: "Removing it lowers auroc by 0.01 on the subset control.",
          variant_of: "h6",
        })),
        hypothesis: "Pinned mock ablation plans.",
      },
    }, 7)),
    onNotice: (notice) => notices.push(notice),
    notifyTaskReports: true,
  });
  const { session } = runtime.dispatch({
    problem: fixture("ood_frozen_encoder"),
    out,
    mode: "mock",
    agents: "inline",
    seed: 7,
    title: "protocol run",
    sessionId: "test-session",
    provider: "frozen-provider",
    model: "frozen-model",
    coding_model: "frozen-coder",
    options: { thinking: "xhigh", max_tokens: 384000, coding_max_tokens: 131073 },
  });
  assert.equal(session.engine.requireTicket(session.ticketId).kind, "run");
  const result = await session.done;
  assert.ok(result, "the mock run must finish");
  assert.equal(result!.final.aborted, false);

  const status = runtime.status(session.runId);
  assert.ok(status);
  assert.equal(status!.ended?.outcome, "completed");
  assert.equal(status!.state, "ended");
  assert.ok(status!.tickets.length >= 15, `expected many task tickets, got ${status!.tickets.length}`);
  assert.equal(status!.stages.some((stage) => stage.stage === "limits"), true);
  assert.equal(status!.stages.some((stage) => stage.stage === "seeds"), true);
  assert.equal(status!.tickets.every((ticket) => (ticket.ended as { outcome?: string } | null)?.outcome === "completed"), true);
  assert.ok(notices.some((notice) => notice.kind === "started" && notice.stage === "limits"));
  assert.ok(notices.some((notice) => notice.kind === "report" && String(notice.ticketId).startsWith("task-")));

  const tasks = session.engine.tickets({ runId: session.runId, kind: "task" });
  assert.equal(tasks.every((ticket) => ticket.mandate.basis === "run"), true);
  assert.equal(tasks.every((ticket) => ticket.payload?.provider === "frozen-provider"), true);
  assert.equal(tasks.every((ticket) => ticket.payload?.thinkingLevel === "xhigh"), true);
  assert.equal(tasks.every((ticket) => ticket.payload?.maxTokens === (ticket.payload?.model === "frozen-coder" ? 131073 : 384000)), true);
  assert.equal(tasks.some((ticket) => ticket.payload?.model === "frozen-coder"), true);
  assert.equal(tasks.some((ticket) => ticket.payload?.model === "frozen-model"), true);
  assert.equal(new Set(tasks.map((ticket) => ticket.stage)).size >= 5, true);
  assert.equal(session.engine.decisions().every((decision) => decision.kind === "accept"), true);

  // The foreground tool surface reads the same state.
  let settings: PolicySettings = defaultPolicySettings();
  const host = {
    runtime: () => runtime,
    policy: () => settings,
    applyPolicy: (next: PolicySettings) => {
      settings = next;
      return runtime.applyPolicy(next);
    },
  };
  const statusCard = await superagentAction(host, { action: "status", run_id: session.runId });
  assert.match(statusCard.content[0].text, /run /);
  assert.match(statusCard.content[0].text, new RegExp(`run ticket: ${session.ticketId}`));
  assert.match(statusCard.content[0].text, new RegExp(String(status!.tickets[0].id)));
  assert.equal((statusCard.details.status as { ended?: { outcome: string } }).ended?.outcome, "completed");

  const ticketsCard = await superagentAction(host, { action: "tickets", run_id: session.runId });
  assert.match(ticketsCard.content[0].text, /limits|seeds|baseline/);
  assert.match(ticketsCard.content[0].text, new RegExp(String(status!.tickets[0].id)));

  const one = await superagentAction(host, { action: "ticket", run_id: session.runId, ticket_id: tasks[0].id });
  assert.match(one.content[0].text, /mandate: explicit\/run/);

  const events = await superagentAction(host, { action: "events", run_id: session.runId, limit: 10 });
  assert.match(events.content[0].text, /ticket\.(created|ended)/);

  const policy = await superagentAction(host, { action: "policy" });
  assert.match(policy.content[0].text, /mode observe/);
  const changed = await superagentAction(host, { action: "policy", mode: "auto" });
  assert.match(changed.content[0].text, /auto/);
  assert.equal(settings.acceptMode, "auto");

  const refused = await superagentAction(host, { action: "answer", run_id: session.runId, ticket_id: session.ticketId, text: "go on" });
  assert.equal(refused.isError, true);

  runtime.closeAll();
});

test("a Pi worker requires a real structured report, not assistant prose or JSON", async () => {
  let assistantText = "<not a JSON answer>";
  const prompts: string[] = [];
  const model = { provider: "test", id: "model", maxTokens: 128 };
  const registry = {
    find: () => model,
    getAvailable: () => [model],
    hasConfiguredAuth: () => true,
    complete: async () => {
      throw new Error("unused");
    },
  };
  const sdk = {
    getAgentDir: () => "/tmp/rsi-pi-agent",
    DefaultResourceLoader: class {
      constructor(_: unknown) {}
      async reload() {}
    },
    createAgentSession: async () => ({
      session: {
        prompt: async (text: string) => { prompts.push(text); },
        getLastAssistantText: () => assistantText,
        abort: async () => {},
        dispose: () => {},
        messages: [],
      },
    }),
    SessionManager: { inMemory: () => ({}) },
  };
  const worker = new PiWorker({ cwd: repoRoot, registry, sdk, modelRuntime: {}, thinkingLevel: "low" });
  const ticket = {
    id: "task-json",
    kind: "task",
    stage: "limits",
    task: "limitations.extract",
    title: "limitations.extract",
    payload: {
      task: "limitations.extract",
      role: "limits",
      system: "system",
      user: "user",
      provider: "test",
      model: "model",
      schemaName: "LimitationBatch",
      temperature: 0.2,
      maxTokens: 128,
      meta: {},
    },
  } as unknown as Ticket;
  await assert.rejects(() => worker.run(ticket, new AbortController().signal), /did not call rsi_report/);
  assert.equal(prompts.length, 2, "one retry attempt");
  assert.equal(prompts[0], "user");
  assert.match(prompts[1], /previous attempt did not produce an accepted report/);
  assert.match(prompts[1], /output\.text/);
  assistantText = '{"limitations":[]}';
  delete ticket.payload!.schemaName;
  await assert.rejects(() => worker.run(ticket, new AbortController().signal), /did not call rsi_report/);
  await worker.close();
});

test("stop releases a live run after its evidence directory is deleted", async () => {
  const out = tempDir("rsi-superagent-deleted-");
  const worker: TaskWorker = {
    run: (_ticket, signal) =>
      new Promise((_, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
      }),
  };
  const runtime = new SuperagentRuntime({ cwd: repoRoot, workerFactory: () => worker });
  const { session } = runtime.dispatch({
    problem: fixture("ood_frozen_encoder"),
    out,
    mode: "mock",
    agents: "inline",
    seed: 7,
    title: "deleted evidence",
    sessionId: "deleted-evidence",
  });
  assert.equal(runtime.session(session.runId), session);
  fs.rmSync(session.root, { recursive: true, force: true });
  const stopped = runtime.stop(session.runId, session.ticketId, "test stop");
  assert.equal(stopped.ended?.outcome, "stopped");
  assert.equal(stopped.ended?.by, "person");
  assert.equal(runtime.session(session.runId), undefined);
  await session.done;
  runtime.closeAll();
});

test("a failed run that never ended can still resume", async () => {
  const out = tempDir("rsi-superagent-failed-");
  const worker: TaskWorker = { run: async () => ({ state: "failed", summary: "boom" }) };
  const runtime = new SuperagentRuntime({ cwd: repoRoot, inMemory: true, workerFactory: () => worker });
  const { session } = runtime.dispatch({
    problem: fixture("ood_frozen_encoder"),
    out,
    mode: "mock",
    agents: "inline",
    seed: 7,
    title: "failed run",
    sessionId: "failed-resume",
  });
  await session.done;
  const status = runtime.status(session.runId);
  assert.equal(status?.state, "person/failed");
  assert.equal(status?.ended, undefined, "a failed report leaves the run ticket open");
  const resumed = runtime.resume(session.runId);
  assert.equal(resumed.runId, `${session.runId}-r1`);
  assert.equal(resumed.spec.options.resumed_from, session.runId);
  await resumed.done;
  runtime.closeAll();
});

test("a stopped run is not resumable", async () => {
  const out = tempDir("rsi-superagent-stopped-");
  const worker: TaskWorker = {
    run: (_ticket, signal) =>
      new Promise((_, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
      }),
  };
  const runtime = new SuperagentRuntime({ cwd: repoRoot, inMemory: true, workerFactory: () => worker });
  const { session } = runtime.dispatch({
    problem: fixture("ood_frozen_encoder"),
    out,
    mode: "mock",
    agents: "inline",
    seed: 7,
    title: "stopped run",
    sessionId: "stopped-resume",
  });
  runtime.stop(session.runId, session.ticketId, "person stop");
  await session.done;
  assert.throws(() => runtime.resume(session.runId), /only aborted\/failed runs can resume/);
  runtime.closeAll();
});

test("an aborted run resumes as a new attempt and keeps the original ticket", async () => {
  const out = tempDir("rsi-superagent-resume-");
  const runtime = new SuperagentRuntime({
    cwd: repoRoot,
    inMemory: true,
    workerFactory: () => new InlineWorker(new MockLLMProvider(null, 7)),
  });
  const { session } = runtime.dispatch({
    problem: fixture("abort_case"),
    out,
    mode: "mock",
    agents: "inline",
    seed: 7,
    title: "abort run",
    sessionId: "resume-test",
  });
  const first = await session.done;
  assert.ok(first, "the first attempt must finish");
  assert.equal(first!.final.aborted, true);
  const parentId = session.runId;
  await until(() => runtime.status(parentId)?.ended !== undefined);
  const oldStatus = runtime.status(parentId);
  assert.ok(oldStatus?.ended);

  const resumed = runtime.resume(parentId);
  assert.equal(resumed.runId, `${parentId}-r1`);
  assert.equal(resumed.spec.options.resumed_from, parentId);
  const second = await resumed.done;
  assert.ok(second, "the resumed attempt must finish");
  assert.equal(runtime.status(parentId)?.ended?.outcome, oldStatus!.ended!.outcome);
  assert.equal(runtime.status(resumed.runId)?.resumed_from, parentId);
  runtime.closeAll();
});
