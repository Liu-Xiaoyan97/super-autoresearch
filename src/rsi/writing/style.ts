/**
 * STE-RSI: a deterministic subset of ASD-STE100 writing rules for agent output.
 *
 * ASD-STE100's dictionary is aviation-specific; this module adapts the three
 * enforceable writing rules it is known for:
 *
 *   1. one term for one thing    — identifiers and metric names are not reworded
 *   2. one claim per sentence    — descriptive <= 25 words, actions <= 20
 *   3. active, explicit wording  — no vague quantity, no unsupported comparison
 *
 * Only human-readable prose fields are checked. Code patches, ids, paths and
 * machine identifiers are exempt. The manuscript profile lints claims and their
 * evidence, not the academic prose body.
 *
 * Every answer is a JSON object. The rules apply to the string values inside
 * that JSON (hypotheses, feedback, evidence, questions); the keys and structure
 * are fixed by the requested schema and are never rewritten as prose.
 */

import type { Problem } from "../types.ts";

export interface StyleIssue {
  rule:
    | "sentence-length"
    | "multiple-claims"
    | "vague-quantity"
    | "unsupported-comparison"
    | "marketing-term"
    | "identifier-rewritten"
    | "prose-not-structured"
    | "claim-without-evidence";
  path: string;
  detail: string;
}

export type StyleProfile = "strict" | "manuscript";

const DESCRIPTIVE_MAX = 25;
const ACTION_MAX = 20;
const ACTION_FIELDS = /^(feedback|plan|expects?|question|critique|missing)$/i;
const EXEMPT_KEYS = /^(id|.*_id|path|artifact|patch|code|repo|repo_ref|commit|metric|metrics|files|component|variant_of|schema_name|model|provider|novelty_refs|refs|evidence_ref|direction_ids|target_limitations|parent_ids|round|score|value|severity|weight|alignment|domain_fit|novelty_score)$/i;
const VAGUE = /\b(significantly|substantially|somewhat|much|several|various|numerous|many|few)\b/i;
const COMPARATIVE = /\b(better|worse|outperforms?|superior|inferior)\b/i;
const MARKETING = /\b(state[- ]of[- ]the[- ]art|groundbreaking|breakthrough|revolutionary|first[- ]ever|game[- ]changing)\b/i;

/** Code-producing tasks are exempt: their output is a unified diff. */
export function isCodeSpec(name: string): boolean {
  return /Patch$/.test(name) || name === "ImplementationInstruction" || name === "FullSetEngineeringPatch";
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

function metricNames(problem: Problem): string[] {
  return problem.metrics.map((metric) => metric.name).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Restore canonical metric names in prose; a repair must not rename them. */
function restoreMetricNames(problem: Problem, text: string): string {
  let out = text;
  for (const name of metricNames(problem)) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(name).replace(/[_-]/g, "[ _-]")}\\b`,
      "gi",
    );
    out = out.replace(pattern, name);
  }
  return out;
}

/**
 * Deterministic normalization before linting. Limitation evidence often quotes
 * several measured values separated by semicolons; those are data, not
 * separate claims. Split them into sentences and restore metric identifiers so
 * a model repair cannot create a semicolon/identifier deadlock.
 */
export function normalizeStyleOutput(specName: string, problem: Problem, value: unknown): unknown {
  if (specName !== "LimitationBatch" || !value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  const normalize = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    const split = text.replace(/;\s*/g, ". ").replace(/\s+/g, " ").trim();
    return restoreMetricNames(problem, split);
  };
  const limitations = Array.isArray(item.limitations)
    ? item.limitations.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const record = entry as Record<string, unknown>;
        return {
          ...record,
          ...(typeof record.text === "string" ? { text: normalize(record.text) } : {}),
          ...(typeof record.evidence === "string" ? { evidence: normalize(record.evidence) } : {}),
        };
      })
    : item.limitations;
  return {
    ...item,
    ...(limitations !== undefined ? { limitations } : {}),
    ...(typeof item.rationale === "string" ? { rationale: normalize(item.rationale) } : {}),
  };
}

/** Rewritten identifiers: `word ppl` / `word-ppl` instead of the canonical key. */
function identifierIssues(problem: Problem, path: string, sentence: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  for (const name of metricNames(problem)) {
    if (sentence.includes(name)) continue;
    const spaced = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[_-]/g, "[ _-]")}\\b`, "i");
    if (spaced.test(sentence)) {
      issues.push({
        rule: "identifier-rewritten",
        path,
        detail: `write the metric exactly as "${name}", not a spaced or re-cased variant`,
      });
    }
  }
  return issues;
}

function lintText(
  problem: Problem,
  value: string,
  path: string,
  action: boolean,
  allowMarketing: boolean,
): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const trimmed = value.trim();
  if (!trimmed) return issues;
  if (/^[{[`]/.test(trimmed)) {
    issues.push({ rule: "prose-not-structured", path, detail: "prose field contains JSON, code or a fence" });
    return issues;
  }
  for (const sentence of splitSentences(trimmed)) {
    const limit = action ? ACTION_MAX : DESCRIPTIVE_MAX;
    const words = wordCount(sentence);
    if (words > limit) {
      issues.push({ rule: "sentence-length", path, detail: `${words} words > ${limit}: "${sentence.slice(0, 120)}"` });
    }
    if (sentence.includes(";")) {
      issues.push({ rule: "multiple-claims", path, detail: "split the semicolon into separate sentences" });
    }
    // A hypothesis is an unmeasured statement, so it cannot supply a number.
    // The task prompts require the explicit `Hypothesis:` marker; that marker
    // exempts it from the measured-value rules but not from the other rules.
    const hypothesis = /\bhypothes(?:is|es)\b/i.test(sentence);
    const hasNumber = /\d/.test(sentence);
    if (!hasNumber && !hypothesis && VAGUE.test(sentence)) {
      issues.push({
        rule: "vague-quantity",
        path,
        detail: `give a number, or label the statement Hypothesis:, instead of a vague quantity: "${sentence.slice(0, 120)}"`,
      });
    }
    if (!hasNumber && !hypothesis && COMPARATIVE.test(sentence) && !metricNames(problem).some((name) => sentence.includes(name))) {
      issues.push({ rule: "unsupported-comparison", path, detail: `name the metric and the measured value: "${sentence.slice(0, 120)}"` });
    }
    if (!allowMarketing && MARKETING.test(sentence)) {
      issues.push({ rule: "marketing-term", path, detail: `remove the marketing term: "${sentence.slice(0, 120)}"` });
    }
    issues.push(...identifierIssues(problem, path, sentence));
  }
  return issues;
}

function walk(
  problem: Problem,
  value: unknown,
  path: string,
  out: StyleIssue[],
): void {
  if (typeof value === "string") {
    const key = path.split(".").pop() ?? "";
    if (EXEMPT_KEYS.test(key)) return;
    const action = ACTION_FIELDS.test(key);
    out.push(...lintText(problem, value, path, action, false));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(problem, item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (EXEMPT_KEYS.test(key)) continue;
      walk(problem, item, path ? `${path}.${key}` : key, out);
    }
  }
}

/**
 * Manuscript: the academic body keeps its prose; only each claim and its
 * evidence reference is held to the strict operational rules.
 */
function lintManuscriptClaims(problem: Problem, value: unknown): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const claims = (value as { claims?: unknown })?.claims;
  if (!Array.isArray(claims)) return issues;
  claims.forEach((claim, index) => {
    const record = (claim ?? {}) as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    issues.push(...lintText(problem, text, `claims[${index}].text`, false, true));
    if (typeof record.evidence_ref !== "string" || !record.evidence_ref.trim()) {
      issues.push({ rule: "claim-without-evidence", path: `claims[${index}].evidence_ref`, detail: "a claim needs an evidence reference" });
    }
  });
  return issues;
}

export function lintSpec(
  specName: string,
  problem: Problem,
  value: unknown,
  profile: StyleProfile = "strict",
): StyleIssue[] {
  if (isCodeSpec(specName)) return [];
  if (profile === "manuscript") return lintManuscriptClaims(problem, value);
  const issues: StyleIssue[] = [];
  walk(problem, value, "", issues);
  return issues;
}

export function stylePrompt(profile: StyleProfile = "strict"): string {
  const manuscript = profile === "manuscript"
    ? ["- Manuscript body: keep academic prose. Apply these rules only to claims and their evidence_ref."]
    : [];
  return [
    "STE-RSI output rules (mandatory):",
    "- The answer is one JSON object with the keys and structure the task asks for. Apply these rules to its string values, not to the JSON keys or the envelope.",
    "- Use one term for one thing. Copy metric names, ids, paths and component names exactly.",
    "- One claim per sentence. Descriptive sentences: at most 25 words. Actions and feedback: at most 20 words.",
    "- Do not use semicolons in prose values. Split each semicolon into separate sentences.",
    "- Use active voice with an explicit actor and verb.",
    "- Every comparison needs the metric name and a measured value. Never write a vague quantity: significantly, substantially, somewhat, much, several, various, numerous, many, few.",
    "- If a sentence states an unmeasured expectation or comparison, start it with \"Hypothesis:\". Hypotheses are exempt from the number rule, but still use one term per thing and one claim per sentence.",
    "- No marketing terms. Before you answer, check every string value for the banned words above; replace each with a measured number or a Hypothesis-labelled statement.",
    ...manuscript,
  ].join("\n");
}

export function formatIssues(issues: StyleIssue[]): string {
  return issues
    .slice(0, 12)
    .map((issue, index) => `${index + 1}. [${issue.rule}] ${issue.path}: ${issue.detail}`)
    .join("\n");
}

export class StyleViolationError extends Error {
  readonly issues: StyleIssue[];

  constructor(specName: string, issues: StyleIssue[]) {
    super(`${specName} output violates STE-RSI after two repairs:\n${formatIssues(issues)}`);
    this.name = "StyleViolationError";
    this.issues = issues;
  }
}
