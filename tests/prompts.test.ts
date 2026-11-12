import test from "node:test";
import assert from "node:assert/strict";

import type { RunSpec, Ticket } from "../src/rsi/superagent/model.ts";
import { defaultPolicySettings } from "../src/rsi/superagent/policy.ts";
import {
  dispatchEnvironment,
  environmentSection,
  orchestratorBriefing,
  policySection,
  promptPart,
  workerSystem,
} from "../src/rsi/superagent/prompts.ts";

const SPEC: RunSpec = {
  problem: "tests/fixtures/ood_frozen_encoder.json",
  out: "/tmp/rsi-prompts-test",
  root: "/tmp/rsi-prompts-test/run-1",
  seed: 7,
  mode: "mock",
  agents: "inline",
  runner: "simulated",
  options: { title: "run-1" },
};

/** Only the fields `dispatchEnvironment` reads; the rest of a Ticket is irrelevant here. */
const TICKET = { id: "t1", stage: "limits", kind: "task", runId: "run-1" } as Ticket;

const PARTS = ["orchestrator", "dispatch", "replies", "worker", "policy", "environment"];

test("every prompt part is read from prompts/superagent and is never empty", () => {
  for (const name of PARTS) {
    const text = promptPart(name);
    assert.ok(text.length > 0, `${name} is empty`);
    assert.doesNotMatch(text, /^\s*$/, `${name} is blank`);
  }
});

test("a prompt part that is not shipped throws instead of degrading to an empty prompt", () => {
  assert.throws(() => promptPart("nope"), /missing prompt part "nope"/);
});

test("the policy section is generated from live state and keeps no placeholder", () => {
  const section = policySection(defaultPolicySettings());
  assert.doesNotMatch(section, /\{(version|mode|explicit|rules)\}/);
  assert.match(section, /sop\.run/);
});

test("the environment section lists the run's variables", () => {
  const section = environmentSection({ RSI_RUN_ID: "run-1", RSI_MODE: "mock" });
  assert.doesNotMatch(section, /\{variables\}/);
  assert.match(section, /RSI_RUN_ID=run-1/);
  assert.match(section, /RSI_MODE=mock/);
});

test("a worker prompt is the task's own system text plus the report contract", () => {
  const text = workerSystem({ task: "limits.extract", system: "Extract the limitations." });
  assert.ok(text.startsWith("Extract the limitations."));
  assert.match(text, /rsi_report/);
  assert.match(text, /output\.text/);
  assert.match(text, /string values inside that JSON/i);
});

test("the foreground briefing carries orchestrator, dispatch and replies", () => {
  const briefing = orchestratorBriefing();
  for (const name of ["orchestrator", "dispatch", "replies"]) {
    assert.ok(briefing.includes(promptPart(name)), `${name} is missing from the briefing`);
  }
});

test("dispatch environment maps a run spec and ticket to worker variables", () => {
  const vars = dispatchEnvironment(SPEC, TICKET);
  assert.equal(vars.RSI_RUN_ID, "run-1");
  assert.equal(vars.RSI_RUN_DIR, "/tmp/rsi-prompts-test/run-1");
  assert.equal(vars.RSI_STAGE, "limits");
  assert.equal(vars.RSI_EXECUTOR, "task");
  assert.equal(vars.RSI_MODE, "mock");
  assert.equal(vars.RSI_AGENTS, "inline");
  assert.equal(vars.RSI_RUNNER, "simulated");
  assert.equal(vars.RSI_TICKET_ID, "t1");
});
