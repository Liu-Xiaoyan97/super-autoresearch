import test from "node:test";
import assert from "node:assert/strict";
import { PiLLMProvider, type PiRegistry } from "../src/rsi/providers/pi.ts";
import { LLMError, type LLMRequest } from "../src/rsi/providers/base.ts";

const model = { provider: "test", id: "reasoner", maxTokens: 8192 };
const request: LLMRequest = { task: "code.subset", provider: "test", model: "reasoner", system: "test", user: "test", temperature: 0.2, maxTokens: 8192, meta: {} };
const success = { provider: model.provider, model: model.id, stopReason: "stop", content: [{ type: "text", text: "answer" }], usage: { input: 2, output: 3, cost: { total: 0.01 } } };
function registry(complete: PiRegistry["complete"]): PiRegistry {
  return { find: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, complete };
}

for (const level of ["low", "off", undefined]) {
  test(`native streamSimple forwards session reasoning ${level} without vendor fields`, async () => {
    let calls = 0;
    const session = new AbortController(), deadline = new AbortController();
    const native = registry(async () => { throw new Error("API-specific complete must not run"); });
    native.streamSimple = (selected, context, options) => {
      calls++;
      assert.equal(selected, model);
      assert.deepEqual(context, { systemPrompt: "test", messages: [{ role: "user", content: "test", timestamp: (context as any).messages[0].timestamp }] });
      assert.equal(options?.reasoning, level, "off must remain a native Pi level, not guessed none/false");
      assert.equal(options?.maxTokens, 8192);
      assert.equal(options?.temperature, 0.2);
      assert.equal(options?.sessionId, "routing-session");
      assert.deepEqual(Object.keys(options!).sort(), ["maxTokens", "reasoning", "sessionId", "signal", "temperature"]);
      const signal = options?.signal as AbortSignal;
      assert.ok(signal instanceof AbortSignal);
      deadline.abort();
      assert.equal(signal.aborted, true, "combined deadline must reach native stream");
      return { result: async () => success };
    };
    const provider = new PiLLMProvider({ registry: native, thinkingLevel: level, sessionId: "routing-session", signal: session.signal });
    await assert.rejects(provider.complete({ ...request, signal: deadline.signal }), /abort/i);
    assert.equal(calls, 1);
    assert.equal(session.signal.aborted, false);
  });
}

for (const metadata of [{ api: "openai-codex-responses" }, { compat: { supportsTemperature: false } }]) {
  test(`native provider omits unsupported optional temperature: ${JSON.stringify(metadata)}`, async () => {
    const native = registry(async () => { throw new Error("must use native streamSimple"); });
    native.find = () => ({ ...model, ...metadata });
    native.streamSimple = (_model, _context, options) => {
      assert.equal(Object.hasOwn(options!, "temperature"), false);
      assert.equal(options?.reasoning, "low");
      return { result: async () => success };
    };
    const response = await new PiLLMProvider({ registry: native, thinkingLevel: "low" }).complete(request);
    assert.equal(response.text, "answer");
  });
}

test("unsupported native API options are not retried with identical parameters", async () => {
  let calls = 0;
  const native = registry(async () => { throw new Error("must use native streamSimple"); });
  native.streamSimple = () => ({ result: async () => {
    calls++;
    return { stopReason: "error", errorMessage: "Codex error: Unsupported parameter: temperature", content: [] };
  } });
  await assert.rejects(new PiLLMProvider({ registry: native }).complete(request), /API rejected request options/);
  assert.equal(calls, 1);
});

test("native streamSimple result returns text/usage and never thinking as code", async () => {
  const native = registry(async () => { throw new Error("must use streamSimple"); });
  native.streamSimple = () => ({ result: async () => ({ ...success, content: [{ type: "thinking", thinking: "not code" }, ...success.content] }) });
  const response = await new PiLLMProvider({ registry: native, thinkingLevel: "low" }).complete(request);
  assert.equal(response.text, "answer");
  assert.deepEqual(response.usage, { input: 2, output: 3, cost_total: 0.01 });
});

for (const content of [
  [{ type: "thinking", thinking: "private reasoning" }],
  [{ type: "text", text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" }],
]) {
  test(`length stop rejects ${content[0].type} without identical retry and retains usage diagnostics`, async () => {
    let calls = 0;
    const usage = { input: 91, output: 8192, reasoning: 8192, cacheRead: 6272, cost: { total: 0.004947666 } };
    const native = registry(async () => { throw new Error("must use streamSimple"); });
    native.streamSimple = () => {
      calls++;
      return { result: async () => ({ ...success, stopReason: "length", content, usage }) };
    };
    const provider = new PiLLMProvider({ thinkingLevel: "low", registry: native });
    await assert.rejects(provider.complete(request), (error: unknown) => {
      assert.ok(error instanceof LLMError);
      assert.match(error.message, /truncated.*token budget exhausted/);
      assert.equal(error.diagnostics?.stopReason, "length");
      assert.equal(error.diagnostics?.thinkingLevel, "low");
      assert.deepEqual(error.diagnostics?.usage, { input: 91, output: 8192, reasoning: 8192, cacheRead: 6272, cost_total: 0.004947666 });
      assert.deepEqual(error.diagnostics?.blocks, [{ type: content[0].type, text_length: "text" in content[0] ? content[0].text.length : 0, thinking_length: "thinking" in content[0] ? content[0].thinking.length : 0 }]);
      assert.ok(!error.message.includes("private reasoning"));
      assert.ok(!error.message.includes("--- a/x"));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("reasoning-only stop is not accepted or retried even without length", async () => {
  let calls = 0;
  const provider = new PiLLMProvider({ registry: registry(async () => {
    calls++;
    return { ...success, content: [{ type: "thinking", thinking: "do not promote" }] };
  }) });
  await assert.rejects(provider.complete(request), /no text content.*thinking_length/);
  assert.equal(calls, 1);
});

test("complete-only registry remains backward compatible and transient retries stay bounded", async () => {
  let calls = 0;
  const provider = new PiLLMProvider({ thinkingLevel: "low", sessionId: "routing-session", registry: registry(async (_model, _context, options) => {
    assert.equal(options?.sessionId, "routing-session");
    assert.equal("reasoning" in options!, false, "do not pass neutral controls to API-specific complete");
    calls++;
    if (calls === 1) throw new Error("temporary network failure");
    return success;
  }) });
  assert.equal((await provider.complete(request)).text, "answer");
  assert.equal(calls, 2);
});

// All tests use fake registry metadata/streams; these are not real DeepSeek verification.
const deepseek = Object.freeze({ provider: "configured-provider", id: "deepseek-configured", api: "openai-completions", contextWindow: 1_000_000, maxTokens: 384000 });
const inheritedRequest: LLMRequest = { task: "test", system: "test", user: "test", meta: {} };
function deepseekRegistry(): PiRegistry {
  return {
    find: (provider, id) => provider === deepseek.provider && id === deepseek.id ? deepseek : undefined,
    getAvailable: () => [deepseek], hasConfiguredAuth: () => true,
    complete: async () => { throw new Error("must use streamSimple"); },
  };
}

test("native inherited output/sampling uses exact configured 1M/384k model metadata without mutation", async () => {
  const native = deepseekRegistry();
  native.streamSimple = (selected, _context, options) => {
    assert.equal(selected, deepseek);
    assert.equal(selected.contextWindow, 1_000_000);
    assert.equal(selected.maxTokens, 384000);
    assert.equal(Object.hasOwn(options!, "maxTokens"), false);
    assert.equal(Object.hasOwn(options!, "temperature"), false);
    assert.equal(options?.reasoning, "low");
    return { result: async () => ({ ...success, provider: deepseek.provider, model: deepseek.id }) };
  };
  const response = await new PiLLMProvider({ registry: native, sessionModel: deepseek, thinkingLevel: "low" }).complete(inheritedRequest);
  assert.equal(response.model, `${deepseek.provider}/${deepseek.id}`);
  assert.equal(response.diagnostics?.outputLimitPolicy, "inherited");
  assert.equal(response.diagnostics?.modelMaxTokens, 384000);
  assert.equal(response.diagnostics?.contextWindow, 1_000_000);
  assert.equal(Object.hasOwn(response.diagnostics!, "maxTokens"), false);
  assert.equal(Object.hasOwn(response.diagnostics!, "requestedMaxTokens"), false);
  assert.equal(JSON.stringify(response.diagnostics).includes("8192"), false);
  assert.equal(deepseek.maxTokens, 384000);
});

for (const requested of [8192, 131073, 384000, 500000, Number.MAX_SAFE_INTEGER]) {
  test(`native explicit output ${requested} is capped only by selected model capability`, async () => {
    const native = deepseekRegistry();
    native.streamSimple = (selected, _context, options) => {
      assert.equal(selected, deepseek);
      assert.equal(options?.maxTokens, Math.min(requested, 384000));
      assert.equal(options?.temperature, 0.2);
      return { result: async () => success };
    };
    const response = await new PiLLMProvider({ registry: native, sessionModel: deepseek }).complete({ ...inheritedRequest, maxTokens: requested, temperature: 0.2 });
    assert.equal(response.diagnostics?.outputLimitPolicy, "explicit");
    assert.equal(response.diagnostics?.requestedMaxTokens, requested);
    assert.equal(response.diagnostics?.maxTokens, Math.min(requested, 384000));
    assert.equal(response.diagnostics?.modelMaxTokens, 384000);
  });
}

for (const capability of [undefined, 0, NaN, Infinity, -1, 1.5]) {
  test(`invalid/missing model capability ${String(capability)} does not manufacture a lower budget`, async () => {
    const selected = { ...deepseek, maxTokens: capability };
    const native = deepseekRegistry();
    native.find = () => selected;
    native.streamSimple = (actual, _context, options) => {
      assert.equal(actual, selected);
      assert.equal(options?.maxTokens, 384000);
      return { result: async () => success };
    };
    await new PiLLMProvider({ registry: native, sessionModel: deepseek }).complete({ ...inheritedRequest, maxTokens: 384000 });
  });
}

for (const requested of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
  test(`native invalid explicit output ${String(requested)} rejects without retry/inference`, async () => {
    const native = deepseekRegistry();
    native.streamSimple = () => { throw new Error("must not call native inference"); };
    await assert.rejects(new PiLLMProvider({ registry: native, sessionModel: deepseek }).complete({ ...inheritedRequest, maxTokens: requested as number }), /positive safe integer/);
  });
}

test("inherited length/no-text diagnostics distinguish capability from an unspecified request budget", async () => {
  for (const stopReason of ["length", "stop"]) {
    let calls = 0;
    const native = deepseekRegistry();
    native.streamSimple = () => {
      calls++;
      return { result: async () => ({ ...success, stopReason, content: [{ type: "thinking", thinking: "private thoughts" }] }) };
    };
    await assert.rejects(new PiLLMProvider({ registry: native, sessionModel: deepseek }).complete(inheritedRequest), (error: unknown) => {
      assert.ok(error instanceof LLMError);
      assert.equal(error.diagnostics?.outputLimitPolicy, "inherited");
      assert.equal(error.diagnostics?.modelMaxTokens, 384000);
      assert.equal(Object.hasOwn(error.diagnostics!, "maxTokens"), false);
      assert.equal(error.message.includes("private thoughts"), false);
      assert.equal(error.message.includes("8192"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("explicit qualified RSI model override takes precedence over the current session model", async () => {
  const native = deepseekRegistry();
  native.streamSimple = (selected) => {
    assert.equal(selected, deepseek);
    return { result: async () => success };
  };
  await new PiLLMProvider({ registry: native, sessionModel: { provider: "other", id: "session-model" } }).complete({ ...inheritedRequest, model: `${deepseek.provider}/${deepseek.id}` });
});

test("native session model IDs containing slashes resolve exactly before qualified-route parsing", async () => {
  const selected = Object.freeze({ ...deepseek, provider: "openrouter", id: "deepseek/deepseek-configured" });
  const native = deepseekRegistry();
  native.find = (provider, id) => provider === selected.provider && id === selected.id ? selected : undefined;
  native.getAvailable = () => [selected];
  native.streamSimple = (actual, _context, options) => {
    assert.equal(actual, selected);
    assert.equal(Object.hasOwn(options!, "maxTokens"), false);
    return { result: async () => success };
  };
  await new PiLLMProvider({ registry: native, sessionModel: selected }).complete(inheritedRequest);
});

test("complete-only legacy registry also receives no synthetic inherited output/sampling budget", async () => {
  const native = deepseekRegistry();
  native.complete = async (selected, _context, options) => {
    assert.equal(selected, deepseek);
    assert.equal(Object.hasOwn(options!, "maxTokens"), false);
    assert.equal(Object.hasOwn(options!, "temperature"), false);
    return success;
  };
  await new PiLLMProvider({ registry: native, sessionModel: deepseek }).complete(inheritedRequest);
});

test("streamSimple retry backoff is cancelled by session abort", async () => {
  const session = new AbortController();
  let calls = 0;
  const native = registry(async () => { throw new Error("must use streamSimple"); });
  native.streamSimple = () => {
    calls++;
    setTimeout(() => session.abort(), 20);
    return { result: async () => { throw new Error("network error"); } };
  };
  await assert.rejects(new PiLLMProvider({ registry: native, signal: session.signal }).complete(request), /abort/i);
  assert.equal(calls, 1);
});
