import test from "node:test";
import assert from "node:assert/strict";

import { Engine } from "../src/rsi/superagent/engine.ts";
import { MemoryRepositories } from "../src/rsi/superagent/store.ts";
import { makePolicy, permissivePolicySettings } from "../src/rsi/superagent/policy.ts";
import type { Executor } from "../src/rsi/superagent/executor.ts";
import type { RunSpec } from "../src/rsi/superagent/model.ts";

const executor: Executor = { start() {}, deliver() {}, stop() {} };

const spec: RunSpec = {
  problem: "ticket-fixture",
  out: "/tmp/rsi-ticket-out",
  root: "/tmp/rsi-ticket-run",
  seed: 7,
  mode: "mock",
  agents: "inline",
  runner: "simulated",
  options: {},
};

function engine(store: MemoryRepositories): Engine {
  const policy = permissivePolicySettings();
  return new Engine({ store, policy: makePolicy(policy), executor });
}

function open(store: MemoryRepositories, runTicketId: string) {
  const instance = engine(store);
  return instance.openTask({
    runTicketId,
    task: "code.subset",
    role: "coding",
    payload: { system: "system", user: "user", meta: {} },
  });
}

test("a resumed engine never reuses a historical ticket id", () => {
  const policy = permissivePolicySettings();
  const store = new MemoryRepositories(policy);
  const firstEngine = engine(store);
  const intake = firstEngine.intake({
    source: "cli",
    kind: "request",
    human: true,
    addressed: true,
    text: "ticket identity test",
  });
  const accepted = firstEngine.accept(intake.trigger.id, spec);
  assert.ok(accepted.ticket, "explicit request must accept a run ticket");

  const first = open(store, accepted.ticket.id);
  const second = open(store, accepted.ticket.id);
  assert.notEqual(first.ticket.id, second.ticket.id);
  assert.notEqual(first.ticket.id, accepted.ticket.id);
  assert.equal(store.tickets.list().filter((ticket) => ticket.id === first.ticket.id).length, 1);
  assert.equal(store.tickets.list().filter((ticket) => ticket.id === second.ticket.id).length, 1);
});

test("a resumed engine never reuses a historical task decision id", () => {
  const policy = permissivePolicySettings();
  const store = new MemoryRepositories(policy);
  const firstEngine = engine(store);
  const intake = firstEngine.intake({
    source: "cli",
    kind: "request",
    human: true,
    addressed: true,
    text: "decision identity test",
  });
  const accepted = firstEngine.accept(intake.trigger.id, spec);
  assert.ok(accepted.ticket);

  const first = open(store, accepted.ticket.id);
  const second = open(store, accepted.ticket.id);
  const decisions = store.decisions.list();
  assert.equal(decisions.filter((decision) => decision.ticketId === first.ticket.id).length, 1);
  assert.equal(decisions.filter((decision) => decision.ticketId === second.ticket.id).length, 1);
  assert.notEqual(first.ticket.decisionId, second.ticket.decisionId);
});
