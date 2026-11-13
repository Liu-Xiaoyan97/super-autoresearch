import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig } from "../src/rsi/run.ts";
import { LLMProvider, type LLMRequest } from "../src/rsi/providers/base.ts";
import { PiLLMProvider } from "../src/rsi/providers/pi.ts";
import { PiWorker } from "../src/rsi/providers/superagent.ts";
import { InlineWorker, payloadOf } from "../src/rsi/superagent/executor.ts";
import type { Ticket, TicketPayload } from "../src/rsi/superagent/model.ts";

const selected = Object.freeze({
  provider: "configured", id: "deepseek", api: "openai-completions",
  maxTokens: 384000, contextWindow: 1000000, reasoning: true,
  samplingParams: Object.freeze({ temperature: 0.7, top_p: 0.95 }),
  samplingParamsByThinkingLevel: Object.freeze({ high: Object.freeze({ top_k: 20 }) }),
});

function payload(overrides: Partial<TicketPayload> = {}): TicketPayload {
  return payloadOf({ task: "critic.subset", role: "critic", system: "system", user: "user", meta: {}, ...overrides });
}

function ticket(overrides: Partial<TicketPayload> = {}): Ticket {
  return { id: "budget-task", payload: payload(overrides) } as Ticket;
}

function workerFixture(
  thinkingLevel?: string,
  modelRuntime?: unknown,
  reportText = '{"ok":true}',
  envelopes: Array<Record<string, unknown>> = [{ state: "ready", summary: "done", output: { text: reportText } }],
) {
  const calls: any[] = [];
  const nativeRequests: any[] = [];
  const loaders: any[] = [];
  const runtimeOptions: any[] = [];
  const runtimes: any[] = [];
  const registrations = new Map<string, { native?: any; config?: any }>();
  const copied: any[] = [];
  const reports: any[] = [];
  let settled = 0;
  const configuredProvider = {
    id: selected.provider,
    streamSimple: (model: any, _context: unknown, options: any = {}) => {
      nativeRequests.push({ model, options, maxTokens: options.maxTokens ?? model.maxTokens });
      return { result: async () => ({ content: [{ type: "text", text: '{"ok":true}' }], stopReason: "stop", usage: {} }) };
    },
  };
  const registry = {
    find: () => selected,
    getAvailable: () => [selected],
    hasConfiguredAuth: () => true,
    complete: async () => { throw new Error("streamSimple must be used"); },
    streamSimple: configuredProvider.streamSimple,
    getRegisteredProviderIds: () => [...registrations.keys()],
    getRegisteredNativeProvider: (id: string) => registrations.get(id)?.native,
    getRegisteredProviderConfig: (id: string) => registrations.get(id)?.config,
    getProvider: (id: string) => id === selected.provider ? configuredProvider : registrations.get(id)?.native,
  };
  Object.defineProperty(registry, "runtime", { get() { throw new Error("private facade access forbidden"); } });
  const sdk = {
    ModelRuntime: { create: async (options: any) => {
      runtimeOptions.push(options);
      const providers = new Map<string, any>([[selected.provider, configuredProvider]]);
      const runtime = {
        getProvider: (id: string) => providers.get(id),
        registerNativeProvider: (provider: any) => { copied.push({ native: provider }); providers.set(provider.id, provider); },
        registerProvider: (id: string, config: any) => { copied.push({ id, config }); providers.set(id, config); },
        unregisterProvider: (id: string) => { providers.delete(id); },
        streamSimple: (model: any, context: unknown, opts: any) => providers.get(model.provider).streamSimple(model, context, opts),
        settleCredentialWrites: async () => { settled++; },
      };
      runtimes.push(runtime);
      return runtime;
    } },
    getAgentDir: () => "/tmp/rsi-test-agent",
    DefaultResourceLoader: class {
      constructor(options: any) { loaders.push(options); }
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (options: any) => {
      calls.push(options);
      return { session: {
        prompt: async () => {
          // Mirror the verified SDK boundary: native requests default to the
          // supplied model.maxTokens, not an RSI session maxTokens option.
          const nativeOptions = { reasoning: options.thinkingLevel };
          // One model request per turn. A rejected report keeps the turn open,
          // so the next scripted envelope plays the model's corrected report.
          for (const envelope of envelopes) {
            await options.modelRuntime.streamSimple(options.model, {}, nativeOptions).result();
            const report = await options.customTools[0].execute("report", envelope);
            reports.push(report);
            if (report.terminate) break;
          }
        },
        getLastAssistantText: () => '{"ok":true}',
        abort: async () => {}, dispose: () => {},
        messages: [
          { role: "user" },
          { role: "assistant", usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.1 } } },
          { role: "toolResult" },
          { role: "assistant", usage: { input: 30, output: 40, totalTokens: 70, cost: { total: 0.2 } } },
        ],
      } };
    },
  };
  return { registry, sdk, calls, nativeRequests, loaders, runtimeOptions, runtimes, registrations, copied, reports,
    settled: () => settled,
    worker: new PiWorker({ cwd: "/tmp", registry, sdk, thinkingLevel, modelRuntime,
      sessionModel: { provider: selected.provider, id: selected.id } }) };
}

test("native worker inherits the exact 384k model allowance, million-token context and settings thinking", async () => {
  const { worker, calls, loaders, nativeRequests, reports, runtimes, runtimeOptions } = workerFixture();
  const outcome = await worker.run(ticket(), new AbortController().signal);
  assert.equal(calls[0].model, selected);
  assert.equal(calls[0].model.maxTokens, 384000);
  assert.equal(calls[0].model.contextWindow, 1000000);
  assert.equal(calls[0].model.samplingParams, selected.samplingParams);
  assert.equal(calls[0].model.samplingParamsByThinkingLevel, selected.samplingParamsByThinkingLevel);
  assert.equal(calls[0].modelRuntime, runtimes[0]);
  assert.deepEqual(runtimeOptions, [{ allowModelNetwork: false }]);
  assert.equal(Object.hasOwn(calls[0], "modelRegistry"), false);
  assert.equal(Object.hasOwn(calls[0], "settingsManager"), false, "leave native compaction/settings defaults untouched");
  assert.equal(nativeRequests.length, 1, "report skips the automatic follow-up LM request");
  assert.equal(reports[0].terminate, true);
  assert.deepEqual(reports[0].details, {});
  assert.equal(Object.hasOwn(calls[0], "maxTokens"), false);
  assert.equal(Object.hasOwn(calls[0], "thinkingLevel"), false);
  assert.equal(calls[0].noTools, "all");
  assert.deepEqual(calls[0].tools, ["rsi_report"]);
  assert.deepEqual(calls[0].customTools.map((tool: any) => tool.name), ["rsi_report"]);
  assert.equal(loaders[0].noExtensions, true);
  assert.equal(loaders[0].noContextFiles, true);
  assert.equal(outcome.state, "ready");
  assert.deepEqual(outcome.usage, { input: 40, output: 60, totalTokens: 100, cost_total: 0.1 + 0.2 });
});

for (const maxTokens of [8192, 131073, 384000, 500000]) {
  test(`inline/native boundary parity for explicit ${maxTokens} output cap`, async () => {
    const { worker, calls, nativeRequests, registry } = workerFixture("xhigh");
    await worker.run(ticket({ maxTokens }), new AbortController().signal);
    await new InlineWorker(new PiLLMProvider({ registry, sessionModel: selected, thinkingLevel: "xhigh" }))
      .run(ticket({ maxTokens }), new AbortController().signal);
    assert.equal(nativeRequests.length, 2);
    assert.equal(nativeRequests[0].maxTokens, Math.min(maxTokens, selected.maxTokens));
    assert.equal(nativeRequests[0].maxTokens, nativeRequests[1].maxTokens);
    assert.equal(calls[0].model.contextWindow, selected.contextWindow);
    assert.equal(selected.maxTokens, 384000);
    if (maxTokens < selected.maxTokens) assert.notEqual(calls[0].model, selected);
    else assert.equal(calls[0].model, selected);
    assert.equal(calls[0].thinkingLevel, "xhigh");
  });
}

test("worker passes a host-supplied canonical runtime through the documented SDK option", async () => {
  const modelRuntime = { marker: "shared-parent-runtime", streamSimple: () => ({ result: async () => ({}) }) };
  const { worker, calls, runtimeOptions, copied } = workerFixture("xhigh", modelRuntime);
  await worker.run(ticket(), new AbortController().signal);
  assert.equal(calls[0].modelRuntime, modelRuntime);
  assert.equal(Object.hasOwn(calls[0], "modelRegistry"), false);
  assert.deepEqual(runtimeOptions, []);
  assert.deepEqual(copied, []);
});

test("worker replays live native/config providers via public APIs into one cached canonical runtime", async () => {
  const { worker, registry, registrations, calls, runtimes, runtimeOptions, copied } = workerFixture();
  let nativeCalls = 0;
  const native = {
    id: selected.provider,
    streamSimple: (model: any, context: unknown, options: any) => {
      nativeCalls++;
      return registry.streamSimple(model, context, options);
    },
  };
  const config = { api: "openai-completions", baseUrl: "https://example.invalid/v1", models: [selected] };
  registrations.set(native.id, { native });
  registrations.set("team-config", { config });
  await worker.run(ticket(), new AbortController().signal);
  assert.equal(nativeCalls, 1, "child requests use the live parent's native provider");
  assert.equal(runtimes[0].getProvider(native.id), native);
  assert.equal(runtimes[0].getProvider("team-config"), config);
  assert.ok(copied.some((entry) => entry.id === "team-config" && entry.config === config));
  assert.equal(calls[0].modelRuntime, runtimes[0]);

  const replacement = { ...native };
  registrations.set(native.id, { native: replacement });
  registrations.delete("team-config");
  await worker.run(ticket(), new AbortController().signal);
  assert.equal(runtimes[0].getProvider(native.id), replacement);
  assert.equal(runtimes[0].getProvider("team-config"), undefined);
  assert.equal(nativeCalls, 2);
  assert.equal(calls[1].modelRuntime, calls[0].modelRuntime);
  assert.equal(runtimeOptions.length, 1);
  await worker.close();
});

test("worker copies an effective global provider when it is not an extension registration", async () => {
  const { worker, registry, copied, runtimes } = workerFixture();
  assert.deepEqual(registry.getRegisteredProviderIds(), []);
  await worker.run(ticket(), new AbortController().signal);
  const provider = registry.getProvider(selected.provider);
  assert.equal(copied[0].native, provider);
  assert.equal(runtimes[0].getProvider(selected.provider), provider);
  await worker.close();
});

test("worker fails clearly rather than silently losing a live provider on an older SDK", async () => {
  const { worker, sdk, calls } = workerFixture();
  (sdk as any).ModelRuntime = undefined;
  await assert.rejects(worker.run(ticket(), new AbortController().signal), /public SDK ModelRuntime.create.*host-supplied modelRuntime/);
  assert.equal(calls.length, 0);
  await assert.doesNotReject(worker.close());
});

test("worker refuses registered providers whose definitions cannot be copied through public APIs", async () => {
  const { worker, registrations, calls } = workerFixture();
  registrations.set("missing-public-definition", {});
  await assert.rejects(worker.run(ticket(), new AbortController().signal), /cannot inherit provider 'missing-public-definition'.*public SDK APIs/);
  assert.equal(calls.length, 0);
  await worker.close();
});

test("worker settles native credential writes on close, including safe synchronous-host teardown", async () => {
  const { worker, settled, runtimes } = workerFixture();
  await worker.run(ticket(), new AbortController().signal);
  await worker.close();
  assert.equal(settled(), 1);
  runtimes[0].settleCredentialWrites = async () => { throw new Error("credential write failed"); };
  await assert.doesNotReject(worker.close());
});

test("a real ready report must still contain JSON when the task requires a schema", async () => {
  const bad = { state: "ready", summary: "done", output: { text: "not a JSON answer" } };
  const { worker } = workerFixture(undefined, undefined, undefined, [bad, bad, bad]);
  await assert.rejects(worker.run(ticket({ schemaName: "LimitationBatch" }), new AbortController().signal), /no valid JSON for LimitationBatch/);
  await worker.close();
});

test("the answer's JSON fields directly on output are the answer, not a missing output.text", async () => {
  const verdict = { decision: "accept", feedback: "Keep word_ppl as the measured metric.", metrics: { score: 1 }, notes: "" };
  const { worker, reports } = workerFixture(undefined, undefined, undefined, [
    { state: "ready", summary: "Verdict ready", output: verdict },
  ]);
  const outcome = await worker.run(ticket({ schemaName: "Verdict" }), new AbortController().signal);
  assert.equal(outcome.state, "ready");
  assert.deepEqual(outcome.output, { text: JSON.stringify(verdict) });
  assert.equal(reports[0].terminate, true);
  await worker.close();
});

test("an unusable report is rejected in-turn and the corrected report is accepted", async () => {
  const { worker, reports, nativeRequests } = workerFixture(undefined, undefined, undefined, [
    { state: "ready", summary: "no answer yet" },
    { state: "ready", summary: "done", output: { text: '{"ok":true}' } },
  ]);
  const outcome = await worker.run(ticket({ schemaName: "Verdict" }), new AbortController().signal);
  assert.equal(outcome.state, "ready");
  assert.equal(reports.length, 2);
  assert.equal(reports[0].isError, true);
  assert.equal(reports[0].terminate, undefined);
  assert.match(reports[0].content[0].text, /output\.text/);
  assert.equal(reports[1].terminate, true);
  assert.equal(nativeRequests.length, 2, "the correction is another turn in the same session");
  await worker.close();
});

test("native worker keeps precise role tool scopes, with rsi_report always available", async () => {
  const { worker, calls, loaders } = workerFixture();
  await worker.run(ticket({ task: "ideas.novelty" }), new AbortController().signal);
  await worker.run(ticket({ tools: ["read", "rsi_report", "read"] }), new AbortController().signal);
  await worker.run(ticket({ task: "code.subset" }), new AbortController().signal);
  assert.deepEqual(calls[0].tools, ["web_search", "rsi_report"]);
  assert.deepEqual(calls[1].tools, ["read", "rsi_report"]);
  assert.deepEqual(calls[2].tools, ["read", "grep", "find", "ls", "rsi_report"]);
  assert.equal(calls.every((call) => call.noTools === "all"), true);
  assert.equal(loaders.every((loader) => loader.noExtensions === false), true);
  await worker.close();
});

test("inline/native inherited output policy has no RSI cap", async () => {
  const { worker, registry, nativeRequests } = workerFixture();
  await worker.run(ticket(), new AbortController().signal);
  await new InlineWorker(new PiLLMProvider({ registry, sessionModel: selected }))
    .run(ticket(), new AbortController().signal);
  assert.equal(nativeRequests[0].maxTokens, 384000);
  assert.equal(nativeRequests[1].maxTokens, 384000);
  assert.equal(Object.hasOwn(nativeRequests[1].options, "maxTokens"), false);
});

for (const level of ["off", "xhigh", "high", "medium", "max"]) {
  test(`worker inherits parent thinking ${level} and honors explicit off`, async () => {
    const { worker, calls } = workerFixture(level);
    await worker.run(ticket(), new AbortController().signal);
    await worker.run(ticket({ thinkingLevel: "off" }), new AbortController().signal);
    assert.equal(calls[0].thinkingLevel, level);
    assert.equal(calls[1].thinkingLevel, "off");
  });
}

test("worker rejects invalid explicit caps without opening a session", async () => {
  const { worker, calls } = workerFixture();
  for (const maxTokens of [0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1, "8192"]) {
    await assert.rejects(worker.run(ticket({ maxTokens: maxTokens as number }), new AbortController().signal), /positive safe integer/);
  }
  assert.equal(calls.length, 0);
});

test("payload serialization honestly omits inherited budgets and thinking", () => {
  const serialized = JSON.parse(JSON.stringify(payload()));
  assert.equal(Object.hasOwn(serialized, "maxTokens"), false);
  assert.equal(Object.hasOwn(serialized, "thinkingLevel"), false);
  assert.equal(Object.hasOwn(serialized, "temperature"), false);
  assert.equal(JSON.parse(JSON.stringify(payload({ maxTokens: 384000, thinkingLevel: "off" }))).maxTokens, 384000);
});

test("inline workers forward optional budgets and cancellation unchanged", async () => {
  let received: LLMRequest | undefined;
  class Capture extends LLMProvider {
    readonly name = "capture";
    async complete(req: LLMRequest) {
      received = req;
      return { text: "ok", model: "capture/model", usage: {}, latencyS: 0 };
    }
  }
  const signal = new AbortController().signal;
  await new InlineWorker(new Capture()).run(ticket(), signal);
  assert.equal(received?.signal, signal);
  assert.equal(received?.maxTokens, undefined);
  await new InlineWorker(new Capture()).run(ticket({ maxTokens: 131073 }), signal);
  assert.equal(received?.maxTokens, 131073);
});

test("run routes honor frozen provider/model and global cap with coding override", () => {
  const config = buildConfig({ problem: "unused", providerName: "parent", model: "deepseek", codingModel: "coder", maxTokens: 384000, codingMaxTokens: 131073 });
  for (const [role, route] of Object.entries(config.modelRoutes)) {
    assert.equal(route.provider, "parent");
    const coding = ["coding", "ablation", "rebuttal", "draft_enhancer"].includes(role);
    assert.equal(route.model, coding ? "coder" : "deepseek");
    assert.equal(route.maxTokens, coding ? 131073 : 384000);
  }
  const inherited = buildConfig({ problem: "unused" });
  assert.equal(Object.values(inherited.modelRoutes).every((route) => route.maxTokens === undefined), true);
});

test("explicit run caps do not erase configured routes or sampling preferences", () => {
  const config = buildConfig({ problem: "unused", codingMaxTokens: 384000, configOverrides: {
    modelRoutes: { default: { provider: "configured", model: "existing", temperature: 0.3, maxTokens: 131073 } },
  } });
  assert.deepEqual(config.modelRoutes.default, { provider: "configured", model: "existing", temperature: 0.3, maxTokens: 131073 });
  assert.deepEqual(config.modelRoutes.coding, { provider: "configured", model: "existing", temperature: 0.3, maxTokens: 384000 });
  for (const maxTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildConfig({ problem: "unused", maxTokens }), /positive safe integer/);
  }
});
