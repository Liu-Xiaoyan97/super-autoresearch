/**
 * Tolerant parsers for model output (the port of the Python pydantic envelopes).
 *
 * Every parser accepts partial JSON and fills the Python defaults. Top-level
 * envelopes are default-constructible; nested domain objects get deterministic
 * fallback ids so two malformed ideas cannot silently collapse into one.
 */

import { crc32 } from "./crc32.ts";
import { asArray, asRecord, bool, num, numRecord, pick, str, strArray, stringRecord } from "./json.ts";
import type { StructuredSpec } from "./providers/base.ts";
import {
  type AblationPlan,
  type Claim,
  type Idea,
  type Limitation,
  type Manuscript,
  type MetaReview,
  type RebuttalTask,
  type Review,
  type Verdict,
  makeIdea,
  makeManuscript,
  makeReview,
  makeVerdict,
} from "./types.ts";

function recordArray(value: unknown): Record<string, unknown>[] {
  return asArray(value)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
}

function fallbackId(kind: string, text: string): string {
  return `${kind}-${crc32(text).toString(16).padStart(8, "0")}`;
}

export function parseLimitation(raw: unknown, index = 0): Limitation {
  const item = asRecord(raw) ?? {};
  const text = str(item.text);
  return {
    id: str(item.id, `L${index + 1}-${crc32(text).toString(16).slice(0, 6)}`),
    text,
    axis: str(item.axis, "method"),
    evidence: str(item.evidence),
    severity: Math.min(1, Math.max(0, num(item.severity, 0.5))),
    actionable: bool(item.actionable, true),
  };
}

export function parseIdea(raw: unknown): Idea {
  const item = asRecord(raw) ?? {};
  const hypothesis = str(item.hypothesis);
  const mechanism = str(item.mechanism);
  return makeIdea({
    id: str(item.id, fallbackId("h", hypothesis || mechanism || "idea")),
    hypothesis,
    mechanism,
    target_limitations: strArray(item.target_limitations),
    novelty_score: Math.min(1, Math.max(0, num(item.novelty_score, 0))),
    novelty_refs: strArray(item.novelty_refs),
    parent_ids: strArray(item.parent_ids),
    round: Math.max(0, Math.trunc(num(item.round, 0))),
    origin: pick(item.origin, ["seed", "evolved", "meta"] as const, "seed"),
    expected_gain: num(item.expected_gain, 0),
    direction_ids: strArray(item.direction_ids),
    domain_fit: Math.min(1, Math.max(0, num(item.domain_fit, 0))),
    notes: str(item.notes),
  });
}

export function parsePlan(raw: unknown): AblationPlan {
  const item = asRecord(raw) ?? {};
  const component = str(item.component);
  return {
    id: str(item.id, fallbackId("ablation", component)),
    component,
    description: str(item.description),
    expects: str(item.expects),
    variant_of: str(item.variant_of),
  };
}

export function parseReview(raw: unknown): Review {
  const item = asRecord(raw) ?? {};
  return makeReview({
    manuscript_id: str(item.manuscript_id ?? item.manuscriptId),
    strengths: strArray(item.strengths),
    weaknesses: strArray(item.weaknesses),
    questions: strArray(item.questions),
    score: num(item.score, 1),
    scale_max: num(item.scale_max, 10),
    summary: str(item.summary),
    round: Math.max(0, Math.trunc(num(item.round, 0))),
  });
}

export function parseClaim(raw: unknown): Claim {
  const item = asRecord(raw) ?? {};
  const value = item.value === null || item.value === undefined ? null : num(item.value, Number.NaN);
  return {
    text: str(item.text),
    metric: str(item.metric),
    value: Number.isFinite(value) ? (value as number) : null,
    evidence_ref: str(item.evidence_ref ?? item.evidenceRef),
  };
}

export function parseManuscript(raw: unknown, format = "iclr2025", round = 0): Manuscript {
  const item = asRecord(raw) ?? {};
  return makeManuscript({
    id: str(item.id),
    title: str(item.title),
    abstract: str(item.abstract),
    sections: stringRecord(item.sections),
    claims: recordArray(item.claims).map(parseClaim),
    evidence_ledger: numRecord(item.evidence_ledger),
    latex_path: str(item.latex_path),
    format: str(item.format, format),
    round: Math.max(0, Math.trunc(num(item.round, round))),
  });
}

// --------------------------------------------------------------------------- //
// structured specs
// --------------------------------------------------------------------------- //

export const LimitationBatch: StructuredSpec<{ limitations: Limitation[]; rationale: string }> = {
  name: "LimitationBatch",
  instruction: '{"limitations":[{"id":"L1","text":"actionable limitation","axis":"method|evaluation|efficiency|theory|data","evidence":"support","severity":0.5,"actionable":true}],"rationale":"why these are new"}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      limitations: recordArray(item.limitations).map(parseLimitation),
      rationale: str(item.rationale),
    };
  },
  fallback: () => ({ limitations: [], rationale: "" }),
};

export const IdeaBatch: StructuredSpec<{ ideas: Idea[]; rationale: string }> = {
  name: "IdeaBatch",
  instruction: '{"ideas":[{"id":"h1","hypothesis":"testable claim","mechanism":"short unique handle","target_limitations":["L1"],"novelty_score":0.0,"novelty_refs":[],"parent_ids":[],"round":0,"direction_ids":["d1"],"domain_fit":0.0}],"rationale":"why these are novel"}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return { ideas: recordArray(item.ideas).map(parseIdea), rationale: str(item.rationale) };
  },
  fallback: () => ({ ideas: [], rationale: "" }),
};

export const IdeaLibrary: StructuredSpec<{
  idea: Idea | null;
  novelty_score: number;
  domain_fit: number;
  direction_ids: string[];
  novelty_refs: string[];
  closest_prior_work: string;
}> = {
  name: "IdeaLibrary",
  instruction: '{"idea":null,"novelty_score":0.0,"domain_fit":0.0,"direction_ids":["d1"],"novelty_refs":["citation or Reference unavailable"],"closest_prior_work":"..."}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      idea: item.idea === null || item.idea === undefined ? null : parseIdea(item.idea),
      novelty_score: Math.min(1, Math.max(0, num(item.novelty_score, 0))),
      domain_fit: Math.min(1, Math.max(0, num(item.domain_fit, 0))),
      direction_ids: strArray(item.direction_ids),
      novelty_refs: strArray(item.novelty_refs),
      closest_prior_work: str(item.closest_prior_work),
    };
  },
  fallback: () => ({
    idea: null,
    novelty_score: 0,
    domain_fit: 0,
    direction_ids: [],
    novelty_refs: [],
    closest_prior_work: "",
  }),
};

export const VerdictSpec: StructuredSpec<Verdict> = {
  name: "Verdict",
  instruction: '{"decision":"good|bad|engineer|refine|accept","feedback":"specific next action","metrics":{},"notes":""}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return makeVerdict({
      decision: pick(item.decision, ["good", "bad", "engineer", "refine", "accept"] as const, "bad"),
      feedback: str(item.feedback),
      metrics: numRecord(item.metrics),
      notes: str(item.notes),
    });
  },
  fallback: () => makeVerdict(),
};

function patchSpec(name: string, fallback: string): StructuredSpec<{ patch: string }> {
  return {
    name,
    instruction: '{"patch":"unified diff only: --- a/path, +++ b/path, @@ hunks; no prose, no shell code"}',
    parse(raw) {
      const item = asRecord(raw) ?? {};
      return { patch: str(item.patch, fallback) };
    },
    fallback: () => ({ patch: fallback }),
  };
}

export const BaselinePatch = patchSpec(
  "BaselinePatch",
  "Reproduce the unmodified reference method with the fixed benchmark protocol.",
);
export const SubsetPatch = patchSpec(
  "SubsetPatch",
  "Implement the proposed mechanism on the fixed benchmark subset.",
);
export const FullSetPatch = patchSpec(
  "FullSetPatch",
  "Scale the validated subset implementation to the full benchmark without changing the method.",
);
export const AblationPatch = patchSpec(
  "AblationPatch",
  "Apply only the specified component intervention; keep all other settings fixed.",
);
export const RebuttalPatch = patchSpec(
  "RebuttalPatch",
  "Execute the supplementary experiment with the incumbent method unchanged.",
);
export const SubsetEngineeringPatch = patchSpec(
  "SubsetEngineeringPatch",
  "Inspect implementation bugs and tune hyperparameters without changing the evaluation protocol.",
);

export const ImplementationInstruction: StructuredSpec<{ instruction: string }> = {
  name: "ImplementationInstruction",
  instruction: '{"instruction":"ordered screening/refinement/scaling steps"}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      instruction: str(
        item.instruction,
        "Screen the subset first, refine within budget, and scale only after a Good verdict.",
      ),
    };
  },
  fallback: () => ({
    instruction: "Screen the subset first, refine within budget, and scale only after a Good verdict.",
  }),
};

export const FullSetEngineeringPatch: StructuredSpec<{
  patch: string;
  hypothesis: string;
  mechanism: string;
}> = {
  name: "FullSetEngineeringPatch",
  instruction: '{"patch":"unified diff only against the snapshot (git apply -p1); no prose","hypothesis":"revised testable claim","mechanism":"short unique handle"}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      patch: str(item.patch, "Refine the mechanism to address the critique; preserve the benchmark protocol."),
      hypothesis: str(item.hypothesis),
      mechanism: str(item.mechanism),
    };
  },
  fallback: () => ({
    patch: "Refine the mechanism to address the critique; preserve the benchmark protocol.",
    hypothesis: "",
    mechanism: "",
  }),
};

export const AblationPlanBatch: StructuredSpec<{ plans: AblationPlan[]; hypothesis: string }> = {
  name: "AblationPlanBatch",
  instruction: '{"plans":[{"id":"...","component":"one removable component","description":"intervention and protocol","expects":"expected degradation","variant_of":"idea id"}],"hypothesis":""}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return { plans: recordArray(item.plans).map(parsePlan), hypothesis: str(item.hypothesis) };
  },
  fallback: () => ({ plans: [], hypothesis: "" }),
};

export const ReviewSpec: StructuredSpec<Review> = {
  name: "Review",
  instruction: '{"manuscript_id":"...","strengths":["..."],"weaknesses":["..."],"questions":["..."],"score":8.0,"scale_max":10,"summary":"..."}',
  parse: parseReview,
  fallback: () => makeReview(),
};

export const RebuttalPlanBatch: StructuredSpec<{ tasks: RebuttalTask[] }> = {
  name: "RebuttalPlanBatch",
  instruction: '{"tasks":[{"id":"...","question":"reviewer question","plan":"targeted plan","experiment":"control, intervention, data, splits, seeds, metrics, logs"}]}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      tasks: recordArray(item.tasks).map((task, index) => ({
        id: str(task.id, `rebuttal-${index + 1}`),
        question: str(task.question),
        plan: str(task.plan),
        experiment: str(task.experiment),
      })),
    };
  },
  fallback: () => ({ tasks: [] }),
};

export const MetaReviewSpec: StructuredSpec<MetaReview> = {
  name: "MetaReview",
  instruction: '{"decision":"accept|refine","critique":"algorithmic/empirical change and measurements to repeat","score":8.0}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      decision: pick(item.decision, ["accept", "refine"] as const, "refine"),
      critique: str(item.critique),
      score: num(item.score, 0),
      round: Math.max(0, Math.trunc(num(item.round, 0))),
    };
  },
  fallback: () => ({ decision: "refine", critique: "", score: 0, round: 0 }),
};

export const DraftOutput: StructuredSpec<Manuscript> = {
  name: "DraftOutput",
  instruction: '{"id":"...","title":"...","abstract":"...","sections":{"abstract":"...","introduction":"...","related_work":"...","method":"...","experiments":"...","ablation":"...","conclusion":"..."},"claims":[{"text":"...","metric":"auroc","value":0.9,"evidence_ref":"..."}]}',
  parse: (raw) => parseManuscript(raw),
  fallback: () => makeManuscript(),
};

export const SpecAuditResult: StructuredSpec<{ violations: string[]; notes: string }> = {
  name: "SpecAuditResult",
  instruction: '{"violations":["concrete violation"],"notes":""}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return { violations: strArray(item.violations), notes: str(item.notes) };
  },
  fallback: () => ({ violations: [], notes: "" }),
};

export const ReferenceAuditResult = SpecAuditResult;
// Keep the schema name distinct for traces and mock dispatch.
export const ReferenceAuditSpec: StructuredSpec<{ violations: string[]; notes: string }> = {
  ...SpecAuditResult,
  name: "ReferenceAuditResult",
  instruction: '{"violations":["hallucinated or contradictory reference"],"notes":""}',
};

export const MethodCodeAuditResult: StructuredSpec<{
  alignment: number;
  missing: string[];
  notes: string;
}> = {
  name: "MethodCodeAuditResult",
  instruction: '{"alignment":0.0,"missing":["claimed component absent from diff"],"notes":""}',
  parse(raw) {
    const item = asRecord(raw) ?? {};
    return {
      alignment: Math.min(1, Math.max(0, num(item.alignment, 0))),
      missing: strArray(item.missing),
      notes: str(item.notes),
    };
  },
  fallback: () => ({ alignment: 0, missing: [], notes: "" }),
};

export { ReferenceAuditSpec as ReferenceAuditResultSpec };
