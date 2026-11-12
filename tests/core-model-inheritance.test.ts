import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, defaultModelRoutes, modelRoute } from "../src/rsi/config.ts";
import { OpenAICompatProvider } from "../src/rsi/providers/openai.ts";
import { BaseAgent, type AgentContext } from "../src/rsi/agents/base.ts";
import { LLMProvider, type LLMRequest, type LLMResponse } from "../src/rsi/providers/base.ts";

// Offline contract tests only: no real provider/model inference is performed.
const request: LLMRequest = { task: "test", system: "test", user: "test", meta: {} };

function withModelEnv(env: { model?: string; coding?: string }, run: () => void): void {
  const before = { model: process.env.RSI_MODEL, coding: process.env.RSI_CODING_MODEL };
  try {
    delete process.env.RSI_MODEL;
    delete process.env.RSI_CODING_MODEL;
    if (env.model !== undefined) process.env.RSI_MODEL = env.model;
    if (env.coding !== undefined) process.env.RSI_CODING_MODEL = env.coding;
    run();
  } finally {
    if (before.model === undefined) delete process.env.RSI_MODEL;
    else process.env.RSI_MODEL = before.model;
    if (before.coding === undefined) delete process.env.RSI_CODING_MODEL;
    else process.env.RSI_CODING_MODEL = before.coding;
  }
}

test("default routes serialize honestly without model/provider/output/sampling pins", () => {
  withModelEnv({}, () => {
    assert.deepEqual(modelRoute(), {});
    const routes = defaultModelRoutes();
    assert.deepEqual(routes, { default: {}, coding: {}, ablation: {}, rebuttal: {}, draft_enhancer: {} });
    assert.deepEqual(JSON.parse(JSON.stringify(defaultConfig().modelRoutes)), routes);
    assert.ok(!JSON.stringify(routes).includes("8192"));
    assert.deepEqual(modelRoute({ maxTokens: undefined, temperature: undefined }), { maxTokens: undefined, temperature: undefined });
    assert.deepEqual(JSON.parse(JSON.stringify(modelRoute({ maxTokens: undefined }))), {});
  });
});

test("explicit RSI environment model routes are retained without injecting unrelated defaults", () => {
  withModelEnv({ model: "custom/deepseek", coding: "other/coder" }, () => {
    const routes = defaultModelRoutes();
    assert.deepEqual(routes.default, { model: "custom/deepseek" });
    for (const role of ["coding", "ablation", "rebuttal", "draft_enhancer"]) {
      assert.deepEqual(routes[role], { model: "other/coder" });
    }
  });
  withModelEnv({ model: "custom/deepseek" }, () => {
    assert.deepEqual(defaultModelRoutes().coding, { model: "custom/deepseek" });
  });
  withModelEnv({ coding: "other/coder" }, () => {
    assert.deepEqual(defaultModelRoutes().default, {});
    assert.deepEqual(defaultModelRoutes().coding, { model: "other/coder" });
  });
});

for (const value of [8192, 131073, 384000, Number.MAX_SAFE_INTEGER]) {
  test(`explicit route output limit ${value} has no application-wide clamp`, () => {
    assert.deepEqual(modelRoute({ maxTokens: value }), { maxTokens: value });
  });
}
for (const value of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
  test(`invalid route output limit ${String(value)} rejects`, () => {
    assert.throws(() => modelRoute({ maxTokens: value as number }), /positive safe integer/);
  });
}

test("BaseAgent forwards unset route fields to its injected provider without resolving a model", async () => {
  let received: LLMRequest | undefined;
  class CaptureProvider extends LLMProvider {
    readonly name = "offline-capture";
    async complete(req: LLMRequest): Promise<LLMResponse> {
      received = req;
      return { text: '{"ok":true}', model: "native/model", usage: {}, latencyS: 0 };
    }
  }
  class ProbeAgent extends BaseAgent {
    readonly NAME = "probe";
    readonly task = "test";
  }
  const ctx = {
    config: defaultConfig({ modelRoutes: { default: modelRoute() } }),
    llm: new CaptureProvider(),
    budget: { chargeLlm() {} },
    traces: { append() {} },
  } as unknown as AgentContext;
  const result = await new ProbeAgent(ctx).ask({ name: "probe", parse: (raw) => raw, fallback: () => ({}) }, { system: "test" });
  assert.deepEqual(result, { ok: true });
  for (const key of ["provider", "model", "temperature", "maxTokens"] as const) assert.equal(received?.[key], undefined);
  const serialized = JSON.parse(JSON.stringify(received));
  for (const key of ["provider", "model", "temperature", "maxTokens"]) assert.equal(Object.hasOwn(serialized, key), false);
});

for (const maxTokens of [undefined, 8192, 131073, 384000]) {
  test(`OpenAI-compatible HTTP mock ${maxTokens === undefined ? "omits inherited" : "preserves explicit " + maxTokens} output limit`, async () => {
    let calls = 0;
    const provider = new OpenAICompatProvider({
      apiKey: "", baseUrl: "https://offline.invalid/v1", model: "configured",
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(Object.hasOwn(body, "max_tokens"), maxTokens !== undefined);
        assert.equal(body.max_tokens, maxTokens);
        assert.equal(Object.hasOwn(body, "temperature"), false);
        return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 });
      },
    });
    await provider.complete({ ...request, ...(maxTokens !== undefined ? { maxTokens } : {}) });
    assert.equal(calls, 1);
  });
}

test("OpenAI-compatible HTTP mock retains explicitly configured temperature", async () => {
  const provider = new OpenAICompatProvider({ apiKey: "", baseUrl: "https://offline.invalid/v1", fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).temperature, 0.2);
    return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 });
  } });
  await provider.complete({ ...request, temperature: 0.2 });
});

for (const value of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
  test(`OpenAI-compatible rejects invalid explicit output limit ${String(value)} before HTTP`, async () => {
    const provider = new OpenAICompatProvider({ fetchImpl: async () => { throw new Error("must not call HTTP"); } });
    await assert.rejects(provider.complete({ ...request, maxTokens: value as number }), /positive safe integer/);
  });
}
