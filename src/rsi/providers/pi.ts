/**
 * LLM provider backed by Pi's model registry.
 *
 * Inside a Pi extension every model call goes through
 * `ctx.modelRegistry.complete()`, so provider registration, authentication,
 * proxies, OAuth refresh and cost accounting are Pi's — not reimplemented here.
 * The default route is opencode-go/deepseek-v4.1-flash; `/rsi` can override it.
 */

import { LLMError, LLMProvider, type LLMRequest, type LLMResponse, textOf } from "./base.ts";

export interface PiRegistry {
  find(provider: string, modelId: string): any | undefined;
  getAvailable(): any[];
  hasConfiguredAuth(model: any): boolean;
  complete(model: any, context: unknown, options?: Record<string, unknown>): Promise<any>;
}

export interface PiProviderOptions {
  registry: PiRegistry;
  providerId?: string;
  /** Model used when a route does not pin one. Falls back to the session model. */
  defaultModel?: string;
  sessionModel?: { provider?: string; id?: string } | null;
  /** Pi session id; opencode-go requires it for request routing. */
  sessionId?: string;
  signal?: AbortSignal;
}

export function usageOf(message: any): Record<string, number> {
  const usage = message?.usage ?? {};
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  if (typeof usage?.cost?.total === "number") out.cost_total = usage.cost.total;
  return out;
}

export class PiLLMProvider extends LLMProvider {
  readonly name: string = "pi";
  readonly registry: PiRegistry;
  readonly providerId: string;
  readonly defaultModel: string;
  readonly sessionModel: PiProviderOptions["sessionModel"];
  readonly sessionId?: string;
  readonly signal?: AbortSignal;

  constructor(opts: PiProviderOptions) {
    super();
    this.registry = opts.registry;
    this.providerId = opts.providerId || "opencode-go";
    this.defaultModel = opts.defaultModel || "";
    this.sessionModel = opts.sessionModel ?? null;
    this.sessionId = opts.sessionId;
    this.signal = opts.signal;
  }

  resolveModel(req: LLMRequest): any {
    let provider = req.provider || this.providerId;
    let modelId = req.model || this.defaultModel || this.sessionModel?.id || "";
    if (modelId.includes("/")) {
      const [nextProvider, ...rest] = modelId.split("/");
      provider = nextProvider;
      modelId = rest.join("/");
    }
    let model = modelId ? this.registry.find(provider, modelId) : undefined;
    if (!model && modelId) {
      const candidates = this.registry.getAvailable().filter((item) => item?.id === modelId);
      if (candidates.length === 1) model = candidates[0];
      else if (candidates.length > 1) {
        throw new LLMError(
          `model '${modelId}' exists in several providers; specify provider/model (providers: ${candidates
            .map((item) => item.provider)
            .join(", ")})`,
        );
      }
    }
    if (!model) {
      const available = this.registry
        .getAvailable()
        .map((item) => `${item.provider}/${item.id}`)
        .slice(0, 40)
        .join(", ");
      throw new LLMError(
        `model '${provider}/${modelId || "(none)"}' is not available. Configure a route with a model from: ${available || "(no authenticated models)"}`,
      );
    }
    if (!this.registry.hasConfiguredAuth(model)) {
      throw new LLMError(
        `no credential for ${model.provider}/${model.id}. Set OPENCODE_API_KEY or run /login ${model.provider}.`,
      );
    }
    return model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.resolveModel(req);
    const started = Date.now();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.signal?.aborted) throw new DOMException("aborted", "AbortError");
      try {
        const message = await this.registry.complete(
          model,
          {
            systemPrompt: req.system || undefined,
            messages: [{ role: "user", content: req.user, timestamp: Date.now() }],
          },
          {
            signal: this.signal,
            temperature: req.temperature,
            maxTokens: Math.min(req.maxTokens, model.maxTokens || req.maxTokens),
            sessionId: this.sessionId,
          },
        );
        if (message?.stopReason === "aborted") throw new DOMException("aborted", "AbortError");
        if (message?.stopReason === "error" || message?.errorMessage) {
          throw new Error(message.errorMessage || `model returned ${message.stopReason}`);
        }
        const text = textOf(message?.content);
        if (!text) throw new Error("model returned no text content");
        return {
          text,
          model: `${message?.provider ?? model.provider}/${message?.model ?? model.id}`,
          usage: usageOf(message),
          latencyS: (Date.now() - started) / 1000,
          raw: message,
        };
      } catch (error) {
        lastError = error;
        if ((error as Error)?.name === "AbortError" || this.signal?.aborted) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    if ((lastError as Error)?.name === "AbortError") throw lastError;
    throw new LLMError(
      `pi completion failed (${model.provider}/${model.id}): ${(lastError as Error)?.message ?? String(lastError)}`,
    );
  }
}

/** Human-readable catalogue for `/rsi models`. */
export function listModels(registry: PiRegistry, provider?: string): string[] {
  return registry
    .getAvailable()
    .filter((model) => !provider || model?.provider === provider)
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
}
