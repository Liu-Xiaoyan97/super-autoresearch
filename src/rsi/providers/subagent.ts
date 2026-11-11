/**
 * Subagent-backed LLM provider.
 *
 * Every RSI agent call runs in its own Pi subagent session: a dedicated system
 * prompt, an isolated in-memory conversation, no tools, and the same provider /
 * model as the parent session. This is the multi-agent architecture the pipeline
 * was designed around — agents do not share context, so a critic cannot see the
 * generator's private reasoning and a coding agent cannot contaminate the
 * drafting agent's history.
 *
 * It uses the public Pi SDK (`createAgentSession`) at runtime. The import is
 * dynamic so the offline CLI and tests never need a Pi installation.
 */

import { LLMError, type LLMRequest, type LLMResponse } from "./base.ts";
import { PiLLMProvider, usageOf, type PiProviderOptions } from "./pi.ts";

export interface SubagentProviderOptions extends PiProviderOptions {
  cwd: string;
  thinkingLevel?: string;
  /** Per-agent tool allowlist. Empty means a pure reasoning subagent. */
  tools?: string[];
  /** Tasks allowed to use web_search (default: novelty + reference audit). */
  webTasks?: ReadonlySet<string>;
  /** Master switch for web-enabled subagents. */
  webSearch?: boolean;
}

const DEFAULT_WEB_TASKS: ReadonlySet<string> = new Set(["ideas.novelty", "integrity.refs"]);

type SubagentSession = {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  abort(): Promise<void>;
  dispose(): void;
  messages: Array<{ role?: string; usage?: unknown }>;
};

export class PiSubagentProvider extends PiLLMProvider {
  readonly name = "pi-subagent";
  readonly cwd: string;
  readonly thinkingLevel: string;
  readonly tools: string[];
  readonly webTasks: ReadonlySet<string>;
  readonly webSearch: boolean;
  private sdkPromise: Promise<any> | null = null;
  private loaders = new Map<string, Promise<any>>();

  constructor(opts: SubagentProviderOptions) {
    super(opts);
    this.cwd = opts.cwd;
    this.thinkingLevel = opts.thinkingLevel ?? "high";
    this.tools = opts.tools ?? [];
    this.webTasks = opts.webTasks ?? DEFAULT_WEB_TASKS;
    this.webSearch = opts.webSearch ?? true;
  }

  /** Tools for this agent task. Only retrieval agents get web access. */
  private toolsFor(req: LLMRequest): string[] {
    if (this.tools.length) return this.tools;
    if (this.webSearch && this.webTasks.has(req.task)) return ["web_search"];
    return [];
  }

  private async sdk(): Promise<any> {
    if (!this.sdkPromise) {
      this.sdkPromise = import("@earendil-works/pi-coding-agent").catch((error) => {
        throw new LLMError(
          `Pi subagents are unavailable in this process (${(error as Error).message}). ` +
            "Use agents=inline or run inside a Pi session.",
        );
      });
    }
    return this.sdkPromise;
  }

  /**
   * One resource loader per (system prompt, web) pair. Web-enabled agents load
   * extensions so `web_search` is registered; other agents stay isolated and
   * skip extension discovery entirely.
   */
  private async loaderFor(systemPrompt: string, withExtensions: boolean): Promise<any> {
    const key = `${withExtensions ? "web" : "plain"}:${systemPrompt}`;
    let pending = this.loaders.get(key);
    if (!pending) {
      pending = (async () => {
        const sdk = await this.sdk();
        const loader = new sdk.DefaultResourceLoader({
          cwd: this.cwd,
          agentDir: sdk.getAgentDir(),
          noExtensions: !withExtensions,
          noSkills: !withExtensions,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt,
        });
        await loader.reload();
        return loader;
      })();
      this.loaders.set(key, pending);
    }
    return pending;
  }

  private usage(message: { usage?: unknown } | undefined): Record<string, number> {
    return usageOf(message);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.resolveModel(req);
    const started = Date.now();
    const sdk = await this.sdk();
    const tools = this.toolsFor(req);
    const loader = await this.loaderFor(req.system, tools.length > 0);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.signal?.aborted) throw new DOMException("aborted", "AbortError");
      let session: SubagentSession | null = null;
      try {
        const created = await sdk.createAgentSession({
          cwd: this.cwd,
          model,
          thinkingLevel: this.thinkingLevel,
          noTools: tools.length ? undefined : "all",
          tools: tools.length ? tools : undefined,
          resourceLoader: loader,
          sessionManager: sdk.SessionManager.inMemory(),
        });
        session = created.session as SubagentSession;
        const abort = () => void session?.abort();
        this.signal?.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(req.user);
        } finally {
          this.signal?.removeEventListener("abort", abort);
        }
        const text = (session.getLastAssistantText() ?? "").trim();
        if (!text) throw new Error("subagent returned no text");
        const assistants = session.messages.filter((message) => message.role === "assistant");
        return {
          text,
          model: `${model.provider}/${model.id}`,
          usage: this.usage(assistants[assistants.length - 1]),
          latencyS: (Date.now() - started) / 1000,
        };
      } catch (error) {
        lastError = error;
        if ((error as Error)?.name === "AbortError" || this.signal?.aborted) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 750));
      } finally {
        session?.dispose();
      }
    }
    if ((lastError as Error)?.name === "AbortError") throw lastError;
    throw new LLMError(
      `pi subagent failed (${model.provider}/${model.id}): ${(lastError as Error)?.message ?? String(lastError)}`,
    );
  }
}
