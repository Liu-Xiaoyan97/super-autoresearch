/**
 * Optional OpenAI-compatible transport for headless CLI runs.
 *
 * The extension itself always uses PiLLMProvider (Pi's registry). This provider
 * exists so `npm run cli -- run ... --provider opencode` works without a Pi
 * session, and so tests can exercise a real HTTP-shaped transport offline.
 */

import { LLMError, LLMProvider, type LLMRequest, type LLMResponse, textOf } from "./base.ts";

export interface OpenAICompatOptions {
  apiKey?: string | null;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatProvider extends LLMProvider {
  readonly name = "openai_compat";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatOptions = {}) {
    super();
    this.baseUrl = (opts.baseUrl || process.env.RSI_BASE_URL || "https://opencode.ai/inference/go/openai/v1").replace(
      /\/+$/,
      "",
    );
    this.model = opts.model || process.env.RSI_MODEL || "deepseek-v4.1-flash";
    this.apiKey = opts.apiKey ?? process.env[opts.apiKeyEnv || "OPENCODE_API_KEY"] ?? "";
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.user });
    const payload: Record<string, unknown> = {
      model: req.model || this.model,
      messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    };
    if (req.schemaName) payload.response_format = { type: "json_object" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText} ${detail.slice(0, 300)}`);
      }
      const data = (await response.json()) as Record<string, any>;
      const content = data?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : textOf(content);
      const usage: Record<string, number> = {};
      for (const [key, value] of Object.entries(data?.usage ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
      }
      return {
        text,
        model: String(data?.model ?? req.model ?? this.model),
        usage,
        latencyS: (Date.now() - started) / 1000,
        raw: data,
      };
    } catch (error) {
      throw new LLMError(`OpenAI-compatible completion failed (${this.baseUrl}): ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
