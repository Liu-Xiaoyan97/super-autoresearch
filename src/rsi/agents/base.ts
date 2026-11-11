/** Shared agent scaffolding: one object per stage, all state in AgentContext. */

import type { Config } from "../config.ts";
import { type LLMProvider, type StructuredSpec } from "../providers/base.ts";
import type { Budget } from "../runtime/budget.ts";
import type { ArtifactStore, TraceStore } from "../runtime/store.ts";
import type { Workspace } from "../runtime/workspace.ts";
import { type Problem, directionText } from "../types.ts";

export interface AgentContext {
  problem: Problem;
  config: Config;
  llm: LLMProvider;
  workspace: Workspace;
  store: ArtifactStore;
  traces: TraceStore;
  budget: Budget;
  scratch: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export function guidance(ctx: AgentContext): string {
  return directionText(ctx.problem);
}

export function checkAborted(ctx: AgentContext): void {
  if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
}

export function progress(ctx: AgentContext, message: string): void {
  try {
    ctx.onProgress?.(message);
  } catch {
    /* progress reporting must never break a run */
  }
}

export interface AskOptions {
  user?: string;
  system?: string;
  meta?: Record<string, unknown>;
}

export abstract class BaseAgent {
  abstract readonly NAME: string;
  abstract readonly task: string;
  readonly role: string = "default";
  readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  systemPrompt(): string {
    const parts = [`You are ${this.NAME}, one agent inside the ScientistTwo research pipeline.`];
    const block = guidance(this.ctx);
    if (block) parts.push(block);
    return parts.join("\n\n");
  }

  async ask<T>(spec: StructuredSpec<T>, opts: AskOptions = {}): Promise<T> {
    checkAborted(this.ctx);
    const route = this.ctx.config.modelRoutes[this.role] || this.ctx.config.modelRoutes.default;
    this.ctx.budget.chargeLlm();
    const user = spec.instruction
      ? `${opts.user ?? ""}\n\nReturn ONLY a JSON object with this shape (no markdown fences):\n${spec.instruction}`
      : (opts.user ?? "");
    const output = await this.ctx.llm.structured(
      {
        task: this.task,
        system: opts.system ?? this.systemPrompt(),
        user,
        provider: route.provider,
        model: route.model,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        meta: opts.meta ?? {},
      },
      spec,
    );
    this.ctx.traces.append("llm", {
      agent: this.NAME,
      task: this.task,
      schema: spec.name,
      meta: opts.meta ?? {},
    });
    return output;
  }

  log(kind: string, payload: Record<string, unknown> = {}): void {
    this.ctx.traces.append(kind, { agent: this.NAME, ...payload });
  }
}
