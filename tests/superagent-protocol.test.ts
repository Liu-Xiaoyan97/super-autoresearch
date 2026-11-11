/**
 * Superagent protocol: domain, store, policy and engine.
 *
 * These tests never call a model. They drive the protocol the way the
 * prototype's own suite does: a fake Executor records what it was asked to do,
 * and the test reports the results back through the Engine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Engine, PolicyHoldError } from "../src/rsi/superagent/engine.ts";
import type { Executor } from "../src/rsi/superagent/executor.ts";
import {
  type Mandate,
  type PolicySettings,
  type ReportState,
  type RunSpec,
  type Ticket,
  key,
  threadKey,
  ticketStage,
} from "../src/rsi/superagent/model.ts";
import { defaultPolicySettings, makePolicy } from "../src/rsi/superagent/policy.ts";
import { SOP_STAGES, ruleOfTask, stageOfTask } from "../src/rsi/superagent/sop.ts";
import { FileRepositories, MemoryRepositories } from "../src/rsi/superagent/store.ts";

class FakeExecutor implements Executor {
  started: Array<{ ticket: Ticket; assignment: string }> = [];
  delivered: string[] = [];
  stopped: string[] = [];

  start(ticket: Ticket, assignment: { id: string }): void {
    this.started.push({ ticket, assignment: assignment.id });
  }

  deliver(ticket: Ticket): void {
    this.delivered.push(ticket.id);
  }

  stop(ticket: Ticket): void {
    this.stopped.push(ticket.id);
  }
}

const SPEC: RunSpec = {
  problem: "examples/ood_frozen_encoder.json",
  out: "/tmp/rsi-superagent-test",
  root: "/tmp/rsi-superagent-test/run-1",
  seed: 7,
  mode: "mock",
  agents: "inline",
  runner: "simulated",
  options: { title: "run-1" },
};

function fixture(over: Partial<PolicySettings> = {}, dir: string | null = null) {
  const settings = defaultPolicySettings(over);
  const store = dir ? new FileRepositories(dir, settings) : new MemoryRepositories(settings);
  const executor = new FakeExecutor();
  let tick = 0;
  const engine = new Engine({
    store,
    policy: makePolicy(settings),
    executor,
    clock: () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + tick++ * 1000),
  });
  return { engine, store, executor, settings };
}

function accept(engine: Engine, over: { human?: boolean; addressed?: boolean; actor?: string; source?: string } = {}) {
  const { trigger } = engine.intake({
    source: over.source ?? "human",
    kind: "request",
    human: over.human ?? true,
    actor: over.actor ?? "tester",
    addressed: over.addressed ?? true,
    text: "run",
    thread: { id: "thread-1", title: "run-1" },
    meta: { run: SPEC, title: "run-1" },
  });
  return { trigger, accepted: engine.accept(trigger.id, SPEC, { title: "run-1" }) };
}

function taskPayload(task: string) {
  return {
    task,
    role: "default",
    system: "You are one agent inside the RSI pipeline.",
    user: "Do the task.",
    temperature: 0.2,
    maxTokens: 1024,
    meta: {},
  };
}

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "m1",
    policyVersion: "p1",
    strength: "explicit",
    scope: "run",
    basis: "explicit",
    rules: ["sop.run"],
    sender: "tester",
    at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ------------------------------------------------------------------ domain

test("intake is idempotent by key and one thread accumulates its triggers", () => {
  const { engine, store } = fixture();
  const first = engine.intake({ source: "human", kind: "request", human: true, addressed: true, actor: "a", thread: { id: "t1" }, key: "same" });
  const second = engine.intake({ source: "human", kind: "request", human: true, addressed: true, actor: "a", thread: { id: "t1" }, key: "same" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.triggers.list().length, 1);
  assert.equal(first.thread.key, threadKey({ source: "human", id: "t1" }));
  assert.deepEqual(first.thread.triggers, [first.trigger.id]);
  assert.equal(store.triggers.disposition(first.trigger.id)?.disposition, "eval");
});

test("accept is idempotent by trigger and creates exactly one run ticket", () => {
  const { engine, executor } = fixture();
  const { trigger, accepted } = accept(engine);
  assert.equal(accepted.decision.kind, "accept");
  const again = engine.accept(trigger.id, SPEC, { title: "run-1" });
  assert.equal(again.ticket?.id, accepted.ticket?.id);
  assert.equal(engine.runTickets().length, 1);
  assert.equal(executor.started.length, 1);
  assert.equal(accepted.ticket?.mandate.strength, "explicit");
  assert.equal(ticketStage(accepted.ticket!), "working");
});

test("observe mode records an inferred candidate as would-accept and starts nothing", () => {
  const { engine, store } = fixture({ acceptMode: "observe" });
  const { trigger } = engine.intake({
    source: "experiment",
    kind: "benchmark",
    human: false,
    actor: "benchmark",
    addressed: false,
    thread: { id: "bench-1" },
    meta: { run: SPEC, title: "run-1" },
  });
  const decisions = engine.pass();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, "ignore");
  assert.equal(decisions[0].wouldAccept, true);
  assert.equal(engine.runTickets().length, 0);
  assert.equal(store.triggers.disposition(trigger.id)?.disposition, "decided");
});

test("auto mode accepts an inferred candidate; off mode refuses it", () => {
  const auto = fixture({ acceptMode: "auto" });
  const observed = auto.engine.intake({
    source: "experiment",
    kind: "benchmark",
    human: false,
    actor: "benchmark",
    addressed: false,
    thread: { id: "bench-auto" },
    meta: { run: SPEC, title: "run-1" },
  });
  auto.engine.pass();
  assert.equal(auto.engine.runTickets().length, 1);
  assert.equal(auto.engine.ticket(observed.trigger.id), undefined);

  const off = fixture({ acceptMode: "off" });
  off.engine.intake({
    source: "experiment",
    kind: "benchmark",
    human: false,
    actor: "benchmark",
    addressed: false,
    thread: { id: "bench-off" },
    meta: { run: SPEC },
  });
  const decisions = off.engine.pass();
  assert.equal(decisions[0].kind, "ignore");
  assert.match(decisions[0].reason, /acceptMode off/);
  assert.equal(off.engine.runTickets().length, 0);
});

test("an automated actor that is not a listed bot is never admitted", () => {
  const { engine } = fixture({ acceptMode: "auto" });
  engine.intake({
    source: "experiment",
    kind: "benchmark",
    human: false,
    actor: "stranger",
    addressed: true,
    thread: { id: "bench-x" },
    meta: { run: SPEC },
  });
  const decisions = engine.pass();
  assert.equal(decisions[0].kind, "ignore");
  assert.match(decisions[0].reason, /not a listed bot/);
});

test("a trigger on a subscribed thread fans out as an input without a decision", () => {
  const { engine, executor } = fixture();
  const { accepted } = accept(engine);
  const run = accepted.ticket!;
  const first = engine.intake({
    source: "experiment",
    kind: "benchmark",
    human: false,
    actor: "benchmark",
    addressed: false,
    thread: { id: "run-1" },
    meta: { metrics: { accuracy: 0.9 } },
  });
  engine.attach(first.trigger.id, run.id);
  const second = engine.intake({
    source: "experiment",
    kind: "review",
    human: false,
    actor: "benchmark",
    addressed: false,
    thread: { id: "run-1" },
    meta: { score: 8 },
  });
  const decisions = engine.pass();
  assert.equal(decisions.length, 0);
  assert.equal(engine.requireTicket(run.id).inputs.length, 2);
  assert.equal(executor.delivered.includes(run.id), true);
  assert.equal(engine.events().some((event) => event.type === "trigger.fanout"), true);
  void second;
});

// ------------------------------------------------------------------- tasks

test("a task ticket reports, ends the ticket and resolves its waiter", async () => {
  const { engine, executor } = fixture();
  const { accepted } = accept(engine);
  const { ticket, done } = engine.openTask({
    runTicketId: accepted.ticket!.id,
    task: "limitations.extract",
    role: "default",
    payload: taskPayload("limitations.extract"),
  });
  assert.equal(ticket.stage, "limits");
  assert.equal(ticket.mandate.basis, "run");
  assert.equal(executor.started.some((item) => item.ticket.id === ticket.id), true);
  engine.report(ticket.id, { state: "ready", summary: "4 limitations", output: { text: "{}" } });
  const report = await done;
  assert.equal(report.state, "ready");
  const ended = engine.requireTicket(ticket.id);
  assert.equal(ended.ended?.outcome, "completed");
  assert.equal(ticketStage(ended), "ended");
});

test("a question opens an attention; only an answer resumes a task ticket", () => {
  const { engine, executor } = fixture();
  const { accepted } = accept(engine);
  const { ticket } = engine.openTask({
    runTicketId: accepted.ticket!.id,
    task: "code.full",
    role: "coding",
    payload: taskPayload("code.full"),
  });
  engine.report(ticket.id, { state: "blocked", summary: "need a decision", question: "Run the full benchmark on GPU?" });
  const blocked = engine.requireTicket(ticket.id);
  assert.equal(blocked.attention?.question, "Run the full benchmark on GPU?");
  assert.equal(ticketStage(blocked), "person/answer");

  engine.answer(ticket.id, "No: stay on the subset.");
  const answered = engine.requireTicket(ticket.id);
  assert.equal(answered.attention, undefined);
  assert.equal(executor.started.filter((item) => item.ticket.id === ticket.id).length, 2);
  assert.equal(ticketStage(answered), "working");
});

test("a failed task is retried on the same ticket, and retries are recorded", () => {
  const { engine, executor } = fixture();
  const { accepted } = accept(engine);
  const { ticket } = engine.openTask({
    runTicketId: accepted.ticket!.id,
    task: "critic.subset",
    role: "default",
    payload: taskPayload("critic.subset"),
  });
  engine.report(ticket.id, { state: "failed", summary: "provider timeout" });
  assert.equal(ticketStage(engine.requireTicket(ticket.id)), "person/failed");
  engine.retry(ticket.id);
  assert.equal(engine.requireTicket(ticket.id).reports.length, 1);
  assert.equal(executor.started.filter((item) => item.ticket.id === ticket.id).length, 2);
  engine.report(ticket.id, { state: "ready", summary: "good" });
  assert.equal(engine.requireTicket(ticket.id).ended?.outcome, "completed");
});

test("a person's stop ends the ticket, withdraws the mandate and stops the executor", () => {
  const { engine, executor } = fixture();
  const { accepted } = accept(engine);
  const { ticket } = engine.openTask({
    runTicketId: accepted.ticket!.id,
    task: "write.draft",
    role: "default",
    payload: taskPayload("write.draft"),
  });
  engine.stop(ticket.id, "not needed");
  const stopped = engine.requireTicket(ticket.id);
  assert.equal(stopped.ended?.by, "person");
  assert.equal(stopped.ended?.outcome, "stopped");
  assert.equal(executor.stopped.includes(ticket.id), true);
  assert.equal(engine.retry.bind(engine, ticket.id).toString().length > 0, true);
  assert.throws(() => engine.retry(ticket.id), /ended/);
});

test("recover reports a run blocked and fails its tasks after a restart", () => {
  const { engine } = fixture();
  const { accepted } = accept(engine);
  const task = engine.openTask({
    runTicketId: accepted.ticket!.id,
    task: "ideas.novelty",
    role: "default",
    payload: taskPayload("ideas.novelty"),
  });
  const recovered = engine.recover();
  assert.equal(recovered.length, 2);
  const run = engine.requireTicket(accepted.ticket!.id);
  assert.equal(run.attention !== undefined, true);
  assert.match(run.attention!.question, /interrupted by a restart/);
  assert.equal(engine.requireTicket(task.ticket.id).reports.at(-1)?.state, "failed");
});

// ------------------------------------------------------------------ policy

test("the policy decides what the SOP may do on its own", () => {
  const policy = makePolicy(defaultPolicySettings());
  assert.equal(policy.mayRun("sop.limits", mandate()), "run");
  assert.equal(policy.mayRun("sop.spend", mandate()), "run");
  assert.equal(policy.mayRun("sop.spend", mandate({ strength: "inferred", basis: "inferred" })), "attention");
  assert.equal(policy.mayRun("sop.export", mandate({ strength: "inferred", basis: "inferred" })), "observe");
  assert.equal(policy.mayRun("sop.experiment", mandate()), "attention");
  assert.equal(policy.mayRun("sop.unknown", mandate()), "refused");
});

test("assertRule stops a paid step on a run a schedule started", () => {
  const { engine } = fixture();
  const { accepted } = accept(engine);
  const run = accepted.ticket!;
  assert.doesNotThrow(() => engine.assertRule(run.id, "sop.spend"));
  const inferredRun = engine.requireTicket(run.id);
  inferredRun.mandate = { ...inferredRun.mandate, strength: "inferred", basis: "inferred" };
  assert.throws(() => engine.assertRule(run.id, "sop.spend"), (error) => error instanceof PolicyHoldError && error.rule === "sop.spend");
});

test("a policy change re-queues undisposed triggers and updates the version", () => {
  const { engine } = fixture();
  const { trigger } = engine.intake({ source: "human", kind: "request", human: true, addressed: true, thread: { id: "t9" } });
  const before = engine.policySettings().version;
  engine.setPolicy(defaultPolicySettings({ acceptMode: "auto" }));
  assert.notEqual(engine.policySettings().version, before);
  assert.equal(engine.policySettings().acceptMode, "auto");
  assert.equal(engine.store.triggers.disposition(trigger.id)?.disposition, "eval");
  assert.equal(engine.events().some((event) => event.type === "policy.changed"), true);
});

// ------------------------------------------------------------------- store

test("a file store survives a reopen with its tickets and event log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-superagent-store-"));
  const first = fixture({}, dir);
  const { accepted } = accept(first.engine);
  first.engine.report(accepted.ticket!.id, { state: "progress", summary: "§3.1 extracting limitations" });
  first.store.close();

  const reopened = new FileRepositories(dir, first.settings);
  const tickets = reopened.tickets.list();
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].id, accepted.ticket!.id);
  assert.equal(reopened.tickets.get(accepted.ticket!.id)?.reports.at(-1)?.summary, "§3.1 extracting limitations");
  assert.equal(reopened.events().some((event) => event.type === "ticket.created"), true);
  assert.equal(reopened.events().some((event) => event.type === "report.recorded"), true);
  reopened.close();
});

// --------------------------------------------------------------------- SOP

test("every SOP stage maps its tasks and has an enabled rule", () => {
  const rules = new Set(defaultPolicySettings().rules.map((rule) => rule.id));
  for (const spec of SOP_STAGES) {
    assert.equal(rules.has(spec.rule), true, `missing rule ${spec.rule}`);
    for (const task of spec.tasks) assert.equal(stageOfTask(task), spec.stage);
  }
  assert.equal(stageOfTask("code.implement"), "search");
  assert.equal(ruleOfTask("integrity.refs"), "sop.integrity");
  assert.throws(() => stageOfTask("not.a.task"), /not part of the RSI SOP/);
});

test("ticket ids are stable for the same trigger and unique across tasks", () => {
  const { engine } = fixture();
  const { accepted } = accept(engine);
  const a = engine.openTask({ runTicketId: accepted.ticket!.id, task: "limitations.extract", role: "default", payload: taskPayload("limitations.extract") });
  const b = engine.openTask({ runTicketId: accepted.ticket!.id, task: "limitations.extract", role: "default", payload: taskPayload("limitations.extract") });
  assert.notEqual(a.ticket.id, b.ticket.id);
  assert.equal(key("same"), key("same"));
  const report: ReportState = "ready";
  assert.equal(report, "ready");
});
