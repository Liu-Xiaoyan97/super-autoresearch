/** Shared agent scaffolding: one object per stage, all state in AgentContext. */

import type { Config } from "../config.ts";
import { type LLMProvider, type StructuredSpec } from "../providers/base.ts";
import { StyleViolationError, formatIssues, isCodeSpec, lintSpec, stylePrompt } from "../writing/style.ts";
import type { Budget } from "../runtime/budget.ts";
import type { ArtifactStore, TraceStore } from "../runtime/store.ts";
import type { Workspace } from "../runtime/workspace.ts";
import { type Evidence, type Problem, directionText } from "../types.ts";

export interface AgentContext {
  problem: Problem;
  config: Config;
  llm: LLMProvider;
  workspace: Workspace;
  store: ArtifactStore;
  traces: TraceStore;
  budget: Budget;
  scratch: Record<string, unknown>;
  /** Lazy full baseline: measured on the first candidate that reaches full. */
  ensureBaselineFull?: () => Promise<Evidence>;
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
    const base = spec.instruction
      ? `${opts.user ?? ""}\n\nReturn ONLY a JSON object with this shape (no markdown fences):\n${spec.instruction}`
      : (opts.user ?? "");
    const code = isCodeSpec(spec.name);
    const profile = spec.name === "DraftOutput" ? "manuscript" as const : "strict" as const;
    const system = opts.system ?? this.systemPrompt();
    let user = base;
    let lastIssues: ReturnType<typeof lintSpec> = [];
    // Two targeted repairs, then fail closed: a single stray word must not kill
    // a multi-hour run, but non-conforming text never enters state either.
    for (let attempt = 0; attempt <= 2; attempt++) {
      checkAborted(this.ctx);
      this.ctx.budget.chargeLlm();
      const output = await this.ctx.llm.structured(
        {
          task: this.task,
          system: code ? system : `${system}\n\n${stylePrompt(profile)}`,
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
        attempt,
        meta: opts.meta ?? {},
      });
      if (code) return output;
      lastIssues = lintSpec(spec.name, this.ctx.problem, output, profile);
      if (!lastIssues.length) {
        this.ctx.traces.append("style.ok", { agent: this.NAME, schema: spec.name, attempt });
        return output;
      }
      this.ctx.traces.append("style.violation", { agent: this.NAME, schema: spec.name, attempt, issues: lastIssues });
      if (attempt === 2) break;
      // Fix only what the lint named, so a repair does not rewrite compliant values.
      user = `${base}\n\nYour previous answer violated these writing rules. Rewrite the complete JSON and fix every listed item; keep every value that is not listed unchanged.\n${formatIssues(lastIssues)}`;
    }
    throw new StyleViolationError(spec.name, lastIssues);
  }

  log(kind: string, payload: Record<string, unknown> = {}): void {
    this.ctx.traces.append(kind, { agent: this.NAME, ...payload });
  }
}
