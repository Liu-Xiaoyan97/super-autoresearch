/**
 * Deterministic, schema-driven offline LLM provider (no network).
 *
 * Scripts replay task-keyed JSON in order (last value repeats). Otherwise the
 * provider synthesizes a valid output envelope from a seeded PRNG, so mock runs
 * are reproducible across processes and machines.
 */

import { crc32, mulberry32 } from "../crc32.ts";
import { asArray, asRecord, num, stableString } from "../json.ts";
import { LLMProvider, type LLMRequest, type LLMResponse, type StructuredSpec, extractJson } from "./base.ts";

export type ScriptValue = unknown;
export type MockScript = Record<string, ScriptValue | ScriptValue[]>;
export type DynamicHook = (req: LLMRequest) => ScriptValue | null | Promise<ScriptValue | null>;

const TEMPLATES: Record<string, string> = {
  title: "A Reproducible Empirical Study of the Proposed Mechanism",
  hypothesis:
    "Replacing the baseline component with the proposed mechanism improves the primary metric under an identical protocol.",
  abstract:
    "We study whether the proposed mechanism beats the reproduced human baseline under a fixed benchmark protocol.",
  summary: "The candidate was evaluated on the supplied benchmark split.",
  rationale: "The proposal targets a diagnosed limitation and stays inside the requested scope.",
  feedback: "Isolate one component, re-measure the primary metric on the same splits, and adopt only on a strict improvement.",
  critique: "Component attribution and robustness over the reproduced baseline are not yet established.",
  question: "Does the reported gain survive a held-out split with the component removed?",
  description: "Remove one component of the proposed method and re-run the full benchmark.",
  experiment: "Re-run the primary benchmark with this component ablated and report the same metrics.",
  plan: "Ablate the named component only; keep data, splits, seeds and the baseline protocol fixed.",
  expects: "Removing a contributing component should degrade the primary metric.",
  component: "auxiliary alignment term",
  strength: "The protocol is reproducible and the baseline is freshly reproduced.",
  weakness: "Component attribution and multi-dataset robustness are not yet demonstrated.",
  text: "The proposed mechanism improves the primary metric under an identical protocol.",
  note: "Offline simulation: no scientific claim is established.",
  notes: "Offline simulation: no scientific claim is established.",
  comment: "Recorded for audit.",
  statement: "Improve the reproduced human baseline under a fixed benchmark protocol.",
  novelty_ref: "Prior work does not combine these components under this protocol.",
  critique_short: "The current evidence is not yet sufficient for acceptance.",
};

const COMPONENTS = [
  "residual-alignment refinement",
  "spectral prior",
  "safety/calibration gate",
  "prototype residual",
  "input representation",
  "regularization schedule",
];

function cleanPrefix(task: string): string {
  return (task.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mock").slice(0, 48);
}

function decisionCycle(task: string, index: number): string {
  const cycle =
    task === "review.meta" ? ["refine", "accept"] : ["refine", "good", "accept", "bad", "engineer"];
  return cycle[index % cycle.length];
}

export class MockLLMProvider extends LLMProvider {
  readonly name = "mock";
  script: MockScript;
  seed: number;
  scriptDynamic: DynamicHook | null = null;
  calls: LLMRequest[] = [];
  private counts = new Map<string, number>();
  private positions = new Map<string, number>();
  private textSeq = 0;

  constructor(script: MockScript | null = null, seed = 7) {
    super();
    this.script = script ?? {};
    this.seed = seed;
  }

  count(task: string): number {
    return this.counts.get(task) ?? 0;
  }

  last(task: string): LLMRequest | null {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i].task === task) return this.calls[i];
    }
    return null;
  }

  private record(req: LLMRequest): number {
    this.calls.push({ ...req, meta: { ...req.meta } });
    const index = this.counts.get(req.task) ?? 0;
    this.counts.set(req.task, index + 1);
    return index;
  }

  private async scripted(req: LLMRequest): Promise<ScriptValue | undefined> {
    if (this.scriptDynamic) {
      const dynamic = await this.scriptDynamic(req);
      if (dynamic !== null && dynamic !== undefined) return dynamic;
    }
    const value = this.script[req.task];
    if (Array.isArray(value)) {
      const index = this.positions.get(req.task) ?? 0;
      this.positions.set(req.task, index + 1);
      return value.length ? value[Math.min(index, value.length - 1)] : undefined;
    }
    return value;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.record(req);
    const data = await this.scripted(req);
    return {
      text: JSON.stringify(data ?? {}),
      model: "mock-scientist",
      usage: {},
      latencyS: 0,
    };
  }

  async structured<T>(req: LLMRequest, spec: StructuredSpec<T>): Promise<T> {
    const request: LLMRequest = { ...req, schemaName: spec.name };
    const index = this.record(request);
    const scripted = await this.scripted(request);
    if (scripted !== undefined) {
      // Scripted values are fixtures: validate strictly instead of degrading.
      const raw = typeof scripted === "string" ? extractJson(scripted) : scripted;
      return spec.parse(raw);
    }
    const material = stableString([this.seed, request.task, request.meta]);
    const digest = crc32(material);
    const rng = mulberry32(digest);
    const prefix = `${cleanPrefix(request.task)}-${digest.toString(16).padStart(8, "0")}-${index}`;
    const data = this.synthesize(spec.name, request, rng, prefix, index);
    try {
      return spec.parse(data);
    } catch {
      return spec.fallback();
    }
  }

  private variation(name: string): string {
    this.textSeq += 1;
    return `${TEMPLATES[name] ?? name.replace(/_/g, " ")} (variant ${this.textSeq})`;
  }

  private limitation(rng: () => number, prefix: string, path: string): Record<string, unknown> {
    return {
      id: `${prefix}-${path}-id`,
      text: `${this.variation("text")} [${path}]`,
      axis: ["method", "evaluation", "efficiency", "theory", "data"][Math.floor(rng() * 5)],
      evidence: "Offline fixture limitation.",
      severity: Number((0.3 + rng() * 0.6).toFixed(3)),
      actionable: true,
    };
  }

  private idea(rng: () => number, req: LLMRequest, prefix: string, path: string, index: number): Record<string, unknown> {
    const mechanism = `${COMPONENTS[index % COMPONENTS.length]} (variant ${this.textSeq + 1})`;
    this.textSeq += 1;
    return {
      id: `${prefix}-${path}-id`,
      hypothesis: `${this.variation("hypothesis")} [${path}]`,
      mechanism,
      target_limitations: [],
      novelty_score: Number((0.55 + rng() * 0.44).toFixed(3)),
      novelty_refs: [],
      parent_ids: [],
      round: num(req.meta.round, 0),
      origin: "seed",
      expected_gain: 0,
      direction_ids: [],
      domain_fit: Number((0.65 + rng() * 0.34).toFixed(3)),
      notes: "",
    };
  }

  private synthesize(
    schema: string,
    req: LLMRequest,
    rng: () => number,
    prefix: string,
    index: number,
  ): unknown {
    const n = Math.max(0, Math.trunc(num(req.meta.n, 1)));
    switch (schema) {
      case "LimitationBatch":
        return {
          limitations: Array.from({ length: Math.max(1, n) }, (_, i) =>
            this.limitation(rng, prefix, `lim-${i}`),
          ),
          rationale: this.variation("rationale"),
        };
      case "IdeaBatch":
        return {
          ideas: Array.from({ length: n }, (_, i) => this.idea(rng, req, prefix, `idea-${i}`, i)),
          rationale: this.variation("rationale"),
        };
      case "IdeaLibrary":
        return {
          idea: null,
          novelty_score: Number((0.65 + rng() * 0.34).toFixed(3)),
          domain_fit: Number((0.65 + rng() * 0.34).toFixed(3)),
          direction_ids: [],
          novelty_refs: Array.from({ length: Math.max(1, n) }, (_, i) => `${this.variation("novelty_ref")} ref-${i + 1}`),
          closest_prior_work: "Offline simulation: no literature search was performed.",
        };
      case "Verdict":
        return {
          decision: decisionCycle(req.task, index),
          feedback: this.variation("feedback"),
          metrics: {},
          notes: this.variation("notes"),
        };
      case "Review":
        return {
          manuscript_id: String(req.meta.manuscript_id ?? ""),
          strengths: [this.variation("strength")],
          weaknesses: [this.variation("weakness")],
          questions: [this.variation("question")],
          score: Number((7 + rng() * 2.5).toFixed(2)),
          scale_max: 10,
          summary: this.variation("summary"),
          round: num(req.meta.round, 0),
        };
      case "MetaReview":
        return {
          decision: decisionCycle("review.meta", index),
          critique: this.variation("critique"),
          score: Number((7 + rng() * 2.5).toFixed(2)),
          round: num(req.meta.round, 0),
        };
      case "DraftOutput":
        return { sections: {}, claims: [] };
      case "RebuttalPlanBatch":
        return { tasks: [] };
      case "AblationPlanBatch":
        return { plans: [], hypothesis: "" };
      case "SpecAuditResult":
      case "ReferenceAuditResult":
        return { violations: [], notes: this.variation("notes") };
      case "MethodCodeAuditResult":
        return { alignment: 0, missing: [], notes: this.variation("notes") };
      case "BaselinePatch":
        return { patch: "Reproduce the unmodified reference method with the fixed benchmark protocol." };
      case "SubsetPatch":
        return { patch: "Implement the proposed mechanism on the fixed benchmark subset." };
      case "FullSetPatch":
        return { patch: "Scale the validated subset implementation to the full benchmark without changing the method." };
      case "AblationPatch":
        return { patch: "Apply only the specified component intervention; keep all other settings fixed." };
      case "RebuttalPatch":
        return { patch: "Execute the supplementary experiment with the incumbent method unchanged." };
      case "ImplementationInstruction":
        return {
          instruction: "Screen the subset first, refine within budget, and scale only after a Good verdict.",
        };
      case "SubsetEngineeringPatch":
        return {
          patch: "Inspect implementation bugs and tune hyperparameters without changing the evaluation protocol.",
        };
      case "FullSetEngineeringPatch":
        return {
          patch: "Refine the mechanism to address the critique; preserve the benchmark protocol.",
          hypothesis: this.variation("hypothesis"),
          mechanism: `${COMPONENTS[index % COMPONENTS.length]}-offline-${index}`,
        };
      default:
        return {};
    }
  }
}

/** Parse a task-keyed JSON script without throwing on the outer shape. */
export function loadMockScript(value: unknown): MockScript {
  const record = asRecord(value);
  if (!record) throw new Error("mock script must be a task-keyed JSON object");
  const out: MockScript = {};
  for (const [key, raw] of Object.entries(record)) {
    out[key] = Array.isArray(raw) ? asArray(raw) : raw;
  }
  return out;
}
