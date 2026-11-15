import test from "node:test";
import assert from "node:assert/strict";

import { PiWorker } from "../src/rsi/providers/superagent.ts";
import { LSP_TOOL_NAMES } from "../src/rsi/runtime/lsp-tools.ts";
import type { LanguageSpec } from "../src/rsi/runtime/checks.ts";
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

function specs(): Record<string, LanguageSpec> {
  return {
    python: {
      id: "python",
      extensions: [".py"],
      checks: [],
      lsp: { command: ["fake-lsp"], severity: "advisory" },
    },
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

test("code workers receive read-only LSP tools; critics do not", async () => {
  const captured: { options?: Record<string, unknown> } = {};
  const worker = new PiWorker({
    cwd: "/tmp",
    registry: registry(),
    sdk: sdk(captured),
    modelRuntime: {},
    providerId: MODEL.provider,
    defaultModel: MODEL.id,
    lsp: { root: "/tmp", specs: specs() },
  });
  const outcome = await worker.run(ticket("code.subset"), new AbortController().signal);
  assert.equal(outcome.state, "ready");
  const tools = captured.options?.tools as string[];
  const custom = (captured.options?.customTools as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of LSP_TOOL_NAMES) assert.ok(tools.includes(name), name);
  for (const name of LSP_TOOL_NAMES) assert.ok(custom.includes(name), name);

  const criticCaptured: { options?: Record<string, unknown> } = {};
  const critic = new PiWorker({
    cwd: "/tmp",
    registry: registry(),
    sdk: sdk(criticCaptured),
    modelRuntime: {},
    providerId: MODEL.provider,
    defaultModel: MODEL.id,
    lsp: { root: "/tmp", specs: specs() },
  });
  await critic.run(ticket("critic.subset"), new AbortController().signal);
  const criticTools = criticCaptured.options?.tools as string[];
  assert.equal(criticTools.some((name) => (LSP_TOOL_NAMES as readonly string[]).includes(name)), false);
  await worker.close();
  await critic.close();
});
