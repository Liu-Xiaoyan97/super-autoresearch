/** LLM provider contract shared by the Pi-backed and offline providers. */

import { asArray, asRecord } from "../json.ts";

export class LLMError extends Error {
  readonly diagnostics?: Record<string, unknown>;

  constructor(message: string, diagnostics?: Record<string, unknown>) {
    super(message);
    this.name = "LLMError";
    this.diagnostics = diagnostics;
  }
}

export interface LLMRequest {
  task: string;
  system: string;
  user: string;
  provider?: string;
  model?: string;
  /** Unset preserves native/model sampling defaults. */
  temperature?: number;
  /** Unset delegates output budgeting to the provider's native policy. */
  maxTokens?: number;
  schemaName?: string;
  /** Per-call cancellation/deadline, in addition to any provider-wide signal. */
  signal?: AbortSignal;
  meta: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: Record<string, number>;
  latencyS: number;
  /** Safe configuration/usage metadata, never generated content or credentials. */
  diagnostics?: Record<string, unknown>;
  raw?: unknown;
}

/** Validate explicit budgets without imposing an application-wide output cap. */
export function validateMaxTokens(maxTokens: number | undefined): void {
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new LLMError("maxTokens must be a positive safe integer when specified");
  }
}

/** A default-constructible output envelope plus a tolerant parser. */
export interface StructuredSpec<T> {
  name: string;
  /** Concrete JSON object shape shown to the model. */
  instruction?: string;
  parse(raw: unknown): T;
  fallback(): T;
}

const JSON_BLOCK = /```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/;

/** Fenced JSON block, then the first balanced object/array. */
export function extractJson(text: string): unknown {
  if (!text) return null;
  let candidate: string | null = null;
  const fenced = JSON_BLOCK.exec(text);
  if (fenced) candidate = fenced[1];
  if (candidate === null) {
    const obj = text.indexOf("{");
    const arr = text.indexOf("[");
    let start = -1;
    if (obj < 0) start = arr;
    else if (arr < 0) start = obj;
    else start = Math.min(obj, arr);
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          candidate = text.slice(start, i + 1);
          break;
        }
      }
    }
  }
  if (candidate === null) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export abstract class LLMProvider {
  abstract readonly name: string;

  abstract complete(req: LLMRequest): Promise<LLMResponse>;

  /**
   * Structured call. Malformed model output degrades to the envelope fallback;
   * scripted offline values are validated strictly.
   */
  async structured<T>(req: LLMRequest, spec: StructuredSpec<T>): Promise<T> {
    const request: LLMRequest = { ...req, schemaName: spec.name };
    const response = await this.complete(request);
    const data = extractJson(response.text);
    try {
      return spec.parse(data ?? {});
    } catch {
      return spec.fallback();
    }
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

export function textOf(blocks: unknown): string {
  return asArray(blocks)
    .map((block) => {
      const record = asRecord(block);
      return record && record.type === "text" ? String(record.text ?? "") : "";
    })
    .join("\n")
    .trim();
}
