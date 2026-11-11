import test from "node:test";
import assert from "node:assert/strict";

import { LLMError, type LLMRequest } from "../src/rsi/providers/base.ts";
import { OpenAICompatProvider } from "../src/rsi/providers/openai.ts";
import { VerdictSpec } from "../src/rsi/schemas.ts";

const request: LLMRequest = {
  task: "judge",
  system: "system",
  user: "user",
  temperature: 0.2,
  maxTokens: 100,
  meta: {},
};

function fakeFetch(payload: unknown, status = 200): { calls: Array<{ url: string; init: any }>; fn: typeof fetch } {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERROR",
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch;
  return { calls, fn };
}

test("OpenAI-compatible transport sends a JSON-mode request and parses a string reply", async () => {
  const { calls, fn } = fakeFetch({
    model: "local-model",
    choices: [{ message: { content: '{"decision":"accept","feedback":"ok"}' } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });
  const provider = new OpenAICompatProvider({
    apiKey: "explicit-key",
    baseUrl: "http://localhost/v1/",
    model: "configured-model",
    fetchImpl: fn,
  });
  const verdict = await provider.structured(request, VerdictSpec);
  assert.equal(verdict.decision, "accept");
  assert.equal(verdict.feedback, "ok");
  const [{ url, init }] = calls;
  assert.equal(url, "http://localhost/v1/chat/completions");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "configured-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.equal(init.headers.authorization, "Bearer explicit-key");
});

test("OpenAI-compatible transport surfaces HTTP failures as LLMError", async () => {
  const { fn } = fakeFetch({ error: "nope" }, 500);
  const provider = new OpenAICompatProvider({ apiKey: "k", fetchImpl: fn });
  await assert.rejects(() => provider.complete(request), LLMError);
});
