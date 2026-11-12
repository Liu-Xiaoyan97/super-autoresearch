/**
 * LLM provider backed by Pi's model registry.
 *
 * Inside a Pi extension every model call goes through
 * `ctx.modelRegistry.streamSimple()`, so provider registration, authentication,
 * proxies, OAuth refresh and cost accounting are Pi's — not reimplemented here.
 * Unpinned routes inherit the Pi session model and native output/sampling policy.
 */

import { LLMError, LLMProvider, type LLMRequest, type LLMResponse, textOf, validateMaxTokens } from "./base.ts";

export interface PiRegistry {
  find(provider: string, modelId: string): any | undefined;
  getAvailable(): any[];
  hasConfiguredAuth(model: any): boolean;
  complete(model: any, context: unknown, options?: Record<string, unknown>): Promise<any>;
  /** Native provider-neutral controls; complete-only registries remain usable by older mocks. */
  streamSimple?(model: any, context: unknown, options?: Record<string, unknown>): { result(): Promise<any> };
}

export interface PiProviderOptions {
  registry: PiRegistry;
  providerId?: string;
  /** Model used when a route does not pin one. Falls back to the session model. */
  defaultModel?: string;
  sessionModel?: { provider?: string; id?: string } | null;
  /** Pi session id; opencode-go requires it for request routing. */
  sessionId?: string;
  /** Effective native Pi session thinking level (including "off"); not vendor-specific effort. */
  thinkingLevel?: string;
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

/** Safe diagnostics only: never include thinking, generated code, credentials or request payloads. */
function diagnosticsOf(message: any, model: any, requestedMaxTokens: number | undefined, maxTokens: number | undefined, thinkingLevel?: string): Record<string, unknown> {
  return {
    model: `${model.provider}/${model.id}`,
    stopReason: message?.stopReason,
    outputLimitPolicy: requestedMaxTokens === undefined ? "inherited" : "explicit",
    ...(requestedMaxTokens !== undefined ? { requestedMaxTokens, maxTokens } : {}),
    ...(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? { modelMaxTokens: model.maxTokens } : {}),
    ...(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    thinkingLevel,
    blocks: Array.isArray(message?.content) ? message.content.map((block: any) => ({
      type: block?.type,
      text_length: typeof block?.text === "string" ? block.text.length : 0,
      thinking_length: typeof block?.thinking === "string" ? block.thinking.length : 0,
    })) : [],
    usage: usageOf(message),
    // An interrupted stream can report zeros without terminal usage. Never infer zero billing.
    usageAccounting: message?.stopReason === "aborted" ? "partial_or_unavailable" : "reported_not_billing_verification",
  };
}

/** Retry backoff must not outlive a request/session deadline. */
function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class PiLLMProvider extends LLMProvider {
  readonly name: string = "pi";
  readonly registry: PiRegistry;
  readonly providerId: string;
  readonly defaultModel: string;
  readonly sessionModel: PiProviderOptions["sessionModel"];
  readonly sessionId?: string;
  readonly thinkingLevel?: string;
  readonly signal?: AbortSignal;

  constructor(opts: PiProviderOptions) {
    super();
    this.registry = opts.registry;
    // Legacy headless fallback belongs here, never in shared/native route defaults.
    this.providerId = opts.providerId || opts.sessionModel?.provider || "opencode-go";
    this.defaultModel = opts.defaultModel || opts.sessionModel?.id || "deepseek-v4.1-flash";
    this.sessionModel = opts.sessionModel ?? null;
    this.sessionId = opts.sessionId;
    this.thinkingLevel = opts.thinkingLevel;
    this.signal = opts.signal;
  }

  resolveModel(req: LLMRequest): any {
    let provider = req.provider || this.providerId;
    let modelId = req.model || this.defaultModel || this.sessionModel?.id || "";
    // Native IDs may themselves contain slashes (for example OpenRouter IDs).
    // Prefer the exact registry entry before interpreting provider/model syntax.
    let model = modelId ? this.registry.find(provider, modelId) : undefined;
    if (!model && modelId.includes("/")) {
      const [nextProvider, ...rest] = modelId.split("/");
      provider = nextProvider;
      modelId = rest.join("/");
      model = this.registry.find(provider, modelId);
    }
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
    const signals = [this.signal, req.signal].filter((signal): signal is AbortSignal => !!signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    validateMaxTokens(req.maxTokens);
    const model = this.resolveModel(req);
    const started = Date.now();
    // Keep the registry's exact model object/metadata. Only explicit request limits
    // are bounded by a valid declared model output capability (not contextWindow).
    const maxTokens = req.maxTokens === undefined ? undefined
      : Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
        ? Math.min(req.maxTokens, model.maxTokens) : req.maxTokens;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        const context = {
          systemPrompt: req.system || undefined,
          messages: [{ role: "user", content: req.user, timestamp: Date.now() }],
        };
        // Temperature is optional, and Codex Responses rejects it outright.
        // Respect declared compatibility and let that native API use its own default.
        const supportsTemperature = model.compat?.supportsTemperature !== false && model.api !== "openai-codex-responses";
        const options = { signal, sessionId: this.sessionId,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(supportsTemperature && req.temperature !== undefined ? { temperature: req.temperature } : {}) };
        // Only streamSimple accepts provider-neutral reasoning. Pi owns clamping, off semantics,
        // model mappings, authentication and session routing; never guess vendor request fields.
        const message = this.registry.streamSimple
          ? await this.registry.streamSimple(model, context, { ...options, reasoning: this.thinkingLevel }).result()
          : await this.registry.complete(model, context, options);
        signal?.throwIfAborted();
        if (message?.stopReason === "aborted") throw new DOMException("aborted", "AbortError");
        // Even a git-applicable text prefix is unsafe when the model exhausted its budget.
        // Fail closed without repeating the same request or silently increasing spend.
        if (message?.stopReason === "length") {
          const diagnostics = diagnosticsOf(message, model, req.maxTokens, maxTokens, this.thinkingLevel);
          throw new LLMError(`model completion truncated (token budget exhausted): ${JSON.stringify(diagnostics)}`, diagnostics);
        }
        if (message?.stopReason === "error" || message?.errorMessage) {
          const error = message.errorMessage || `model returned ${message.stopReason}`;
          if (/unsupported parameter|unknown parameter/i.test(error)) {
            const diagnostics = diagnosticsOf(message, model, req.maxTokens, maxTokens, this.thinkingLevel);
            throw new LLMError(`model API rejected request options: ${error}`, diagnostics);
          }
          throw new Error(error);
        }
        const text = textOf(message?.content);
        if (!text) {
          const diagnostics = diagnosticsOf(message, model, req.maxTokens, maxTokens, this.thinkingLevel);
          throw new LLMError(`model returned no text content: ${JSON.stringify(diagnostics)}`, diagnostics);
        }
        return {
          text,
          model: `${message?.provider ?? model.provider}/${message?.model ?? model.id}`,
          usage: usageOf(message),
          latencyS: (Date.now() - started) / 1000,
          diagnostics: diagnosticsOf(message, model, req.maxTokens, maxTokens, this.thinkingLevel),
          raw: message,
        };
      } catch (error) {
        lastError = error;
        signal?.throwIfAborted();
        if (error instanceof LLMError || ["AbortError", "TimeoutError"].includes((error as Error)?.name)) throw error;
        if (attempt === 0) await retryDelay(750, signal);
      }
    }
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
