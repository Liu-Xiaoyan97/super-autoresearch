/**
 * Superagent protocol through its real transports: the runtime (mock worker),
 * the LLM provider over task tickets, and the foreground tool handlers.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MockLLMProvider } from "../src/rsi/providers/mock.ts";
import { SuperagentLLMProvider } from "../src/rsi/providers/superagent.ts";
import { Engine } from "../src/rsi/superagent/engine.ts";
import { InlineWorker, type Executor } from "../src/rsi/superagent/executor.ts";
import type { PolicySettings, RunSpec, Ticket } from "../src/rsi/superagent/model.ts";
import { ticketStage } from "../src/rsi/superagent/model.ts";
import { defaultPolicySettings, makePolicy } from "../src/rsi/superagent/policy.ts";
import { SuperagentRuntime } from "../src/rsi/superagent/runtime.ts";
import { MemoryRepositories } from "../src/rsi/superagent/store.ts";
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

test("a provider call is one task ticket; its report is the model response", async () => {
  const { engine, run, executor } = providerFixture();
  const provider = new SuperagentLLMProvider({
    engine,
    runTicketId: run.id,
    worker: new InlineWorker(new MockLLMProvider(null, 7)),
  });
  const pending = provider.complete(request("critic.subset"));
  await until(() => executor.started.some((ticket) => ticket.kind === "task"));
  const task = executor.started.find((ticket) => ticket.kind === "task")!;
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
  const runtime = new SuperagentRuntime({
    cwd: repoRoot,
    inMemory: true,
    workerFactory: () => new InlineWorker(new MockLLMProvider(null, 7)),
  });
  const { session } = runtime.dispatch({
    problem: fixture("ood_frozen_encoder"),
    out,
    mode: "mock",
    agents: "inline",
    seed: 7,
    title: "protocol run",
    sessionId: "test-session",
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

  const tasks = session.engine.tickets({ runId: session.runId, kind: "task" });
  assert.equal(tasks.every((ticket) => ticket.mandate.basis === "run"), true);
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
  assert.equal((statusCard.details.status as { ended?: { outcome: string } }).ended?.outcome, "completed");

  const ticketsCard = await superagentAction(host, { action: "tickets", run_id: session.runId });
  assert.match(ticketsCard.content[0].text, /limits|seeds|baseline/);

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
