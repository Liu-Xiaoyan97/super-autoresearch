import test from "node:test";
import assert from "node:assert/strict";

import { PiWorker } from "../src/rsi/providers/superagent.ts";
import type { Ticket } from "../src/rsi/superagent/model.ts";

const MODEL = { provider: "test", id: "model", maxTokens: 1024, contextWindow: 8192 };

function registry() {
  return {
    find: (provider: string, id: string) => provider === MODEL.provider && id === MODEL.id ? MODEL : undefined,
    getAvailable: () => [MODEL],
    hasConfiguredAuth: () => true,
    complete: async () => ({ text: "{}" }),
  };
}

function sdk(captured: { options?: Record<string, unknown> }) {
  class Loader {
    constructor(_options: unknown) {}
    async reload(): Promise<void> {}
  }
  return {
    DefaultResourceLoader: Loader,
    getAgentDir: () => "/tmp/agent",
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (options: Record<string, unknown>) => {
      captured.options = options;
      const tools = options.customTools as Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
      return {
        session: {
          prompt: async () => {
            const report = tools.find((tool) => tool.name === "rsi_report");
            assert.ok(report);
            await report.execute("test", { state: "ready", summary: "done", output: { text: "{}" } });
          },
          getLastAssistantText: () => "{}",
          abort: async () => {},
          dispose: () => {},
          messages: [],
        },
      };
    },
  };
}

function ticket(task: string): Ticket {
  return {
    id: "ticket-1",
    shortName: "task",
    title: "task",
    kind: "task",
    stage: "evaluation",
    decisionId: "decision-1",
    payload: {
      task,
      role: "coding",
      system: "system",
      user: "user",
      meta: {},
    },
  } as unknown as Ticket;
}

test("code workers receive source-reading tools and critics receive reporting only", async () => {
  const captured: { options?: Record<string, unknown> } = {};
  const worker = new PiWorker({
    cwd: "/tmp",
    registry: registry(),
    sdk: sdk(captured),
    modelRuntime: {},
    providerId: MODEL.provider,
    defaultModel: MODEL.id,
  });
  const outcome = await worker.run(ticket("code.subset"), new AbortController().signal);
  assert.equal(outcome.state, "ready");
  const tools = captured.options?.tools as string[];
  const custom = (captured.options?.customTools as Array<{ name: string }>).map((tool) => tool.name);
  assert.deepEqual(tools, ["read", "grep", "find", "ls", "rsi_report"]);
  assert.deepEqual(custom, ["rsi_report"]);

  const criticCaptured: { options?: Record<string, unknown> } = {};
  const critic = new PiWorker({
    cwd: "/tmp",
    registry: registry(),
    sdk: sdk(criticCaptured),
    modelRuntime: {},
    providerId: MODEL.provider,
    defaultModel: MODEL.id,
  });
  await critic.run(ticket("critic.subset"), new AbortController().signal);
  const criticTools = criticCaptured.options?.tools as string[];
  assert.deepEqual(criticTools, ["rsi_report"]);
  await worker.close();
  await critic.close();
});
