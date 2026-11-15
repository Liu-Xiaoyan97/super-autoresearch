/**
 * §4.3 — Integrity audit (paper pp.13-15, Table 7).
 *
 * Evidence checks first, LLM judgement second: a model may add a violation but
 * can never clear a deterministic one.
 */

import { createHash } from "node:crypto";
import { stableString } from "../json.ts";
import { MethodCodeAuditResult, ReferenceAuditSpec, SpecAuditResult } from "../schemas.ts";
import {
  type Evidence,
  type Idea,
  type IntegrityReport,
  type Manuscript,
  type Problem,
  evidenceOk,
  finite,
  makeIntegrity,
} from "../types.ts";
import { BaseAgent } from "./base.ts";
import { reviewChunks } from "./patch.ts";

const TOKEN = /[a-z0-9_]{3,}/g;
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "our", "are", "was",
  "were", "has", "have", "not", "but", "all", "any", "can", "its", "their", "than",
  "then", "use", "used", "using", "via", "per", "each", "over", "under", "between",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    if (!STOP.has(match[0])) out.add(match[0]);
  }
  return out;
}

/** Score verification: the experiment ran and every cited metric is finite. */
export function verifyScores(claimsOk: boolean, evidence: Evidence | null): boolean {
  if (!claimsOk || !evidence || !evidenceOk(evidence)) return false;
  if (!Object.keys(evidence.metrics).length) return false;
  return Object.values(evidence.metrics).every((value) => finite(value));
}

/** Merge partial reports; violations accumulate, alignment takes the minimum. */
export function combine(...reports: Array<IntegrityReport | null | undefined>): IntegrityReport {
  const merged = makeIntegrity({ score_verified: true, method_code_alignment: 1 });
  let seen = false;
  for (const report of reports) {
    if (!report) continue;
    seen = true;
    merged.score_verified = merged.score_verified && report.score_verified;
    merged.spec_violations.push(...report.spec_violations);
    merged.ref_violations.push(...report.ref_violations);
    merged.method_code_alignment = Math.min(merged.method_code_alignment, report.method_code_alignment);
    merged.checked_claims += report.checked_claims;
    merged.notes.push(...report.notes);
  }
  if (!seen) merged.score_verified = false;
  return merged;
}

export class SpecAuditor extends BaseAgent {
  readonly NAME = "spec_auditor";
  readonly task = "integrity.spec";

  hardViolations(problem: Problem, diff: string, evidence: Evidence | null): string[] {
    const violations: string[] = [];
    const haystack = (diff || "").toLowerCase();
    for (const ban of problem.forbidden) {
      const keys = [...tokens(ban)];
      if (keys.length && keys.every((key) => haystack.includes(key))) {
        violations.push(`forbidden approach used: '${ban}'`);
      }
    }
    if (evidence?.result) {
      if (evidence.result.status === "failed") violations.push("experiment crashed: no reproducible result");
      else if (!Object.keys(evidence.metrics).length) violations.push("experiment produced no metrics");
    }
    return violations;
  }

  async audit(idea: Idea, opts: { evidence: Evidence; diff?: string }): Promise<IntegrityReport> {
    const diff = opts.diff ?? "";
    const violations = this.hardViolations(this.ctx.problem, diff, opts.evidence);
    const notes: string[] = [];
    for (const [index, chunk] of reviewChunks(diff).entries()) {
      const key = createHash("sha256").update(stableString({ version: 1, chunk, mechanism: idea.mechanism,
        hypothesis: idea.hypothesis, constraints: this.ctx.problem.constraints, forbidden: this.ctx.problem.forbidden })).digest("hex");
      const file = `checks/spec-cache/${key}.json`;
      let result;
      try { result = SpecAuditResult.parse(this.ctx.store.readJson(file)); }
      catch {
        result = await this.ask(SpecAuditResult, {
          user: this.prompt(idea, chunk),
          meta: { idea_id: idea.id, n: 1, chunk: index + 1 },
        });
        this.ctx.store.writeJson(file, result);
      }
      for (const violation of result.violations) if (!violations.includes(violation)) violations.push(violation);
      if (result.notes) notes.push(result.notes);
    }
    return makeIntegrity({
      score_verified: verifyScores(Boolean(Object.keys(opts.evidence.metrics).length), opts.evidence),
      spec_violations: violations,
      method_code_alignment: 1,
      notes,
    });
  }

  private prompt(idea: Idea, diff: string): string {
    const constraints = this.ctx.problem.constraints.map((c) => `- ${c}`).join("\n") || "- (none)";
    return (
      "Audit whether this experimental solution violates the task specification " +
      "or games the evaluation (reward hacking).\n\n" +
      `HYPOTHESIS: ${idea.hypothesis}\nMECHANISM: ${idea.mechanism}\n` +
      `CONSTRAINTS:\n${constraints}\n` +
      `OUT OF SCOPE: ${this.ctx.problem.forbidden.join(", ") || "(none)"}\n` +
      `DIFF CHUNK (all chunks are reviewed):\n${diff}\n\n` +
      "Report only concrete violations (leaked test data, disabled checks, " +
      "unfair baselines, spec breaches). Empty list = compliant."
    );
  }
}

export class ReferenceAuditor extends BaseAgent {
  readonly NAME = "reference_auditor";
  readonly task = "integrity.refs";

  unknownRefs(refs: string[], corpus: string[]): string[] {
    if (!refs.length) return [];
    const corpusTokens = new Set<string>();
    for (const entry of corpus) for (const token of tokens(entry)) corpusTokens.add(token);
    const bad: string[] = [];
    for (const ref of refs) {
      if (!ref.trim()) continue;
      const refTokens = tokens(ref);
      if (!refTokens.size || ![...refTokens].some((token) => corpusTokens.has(token))) bad.push(ref);
    }
    return bad;
  }

  async audit(manuscript: Manuscript, opts: { corpus?: string[] } = {}): Promise<IntegrityReport> {
    const refs = [...new Set(refsFrom(manuscript))];
    const known = opts.corpus ?? [this.ctx.problem.source_paper];
    const unverified = this.unknownRefs(refs, known.filter(Boolean));
    const result = await this.ask(ReferenceAuditSpec, {
      user:
        "Check these citations for hallucination. Flag only references that cannot " +
        "exist or contradict the cited claim. If a web_search tool is available, " +
        "use it to verify suspected references; otherwise rely on the supplied bibliography.\nCITATIONS:\n" +
        refs.slice(0, 50).map((ref) => `- ${ref}`).join("\n") +
        `\nKNOWN BIBLIOGRAPHY:\n${known.join("\n").slice(0, 3000) || "(empty)"}`,
      meta: { n: 1 },
    });
    const violations = [...unverified];
    for (const violation of result.violations) {
      if (!violations.includes(violation)) violations.push(violation);
    }
    return makeIntegrity({
      score_verified: true,
      ref_violations: violations,
      method_code_alignment: 1,
      checked_claims: refs.length,
      notes: result.notes ? [result.notes] : [],
    });
  }
}

export class MethodCodeAuditor extends BaseAgent {
  readonly NAME = "method_code_auditor";
  readonly task = "integrity.method_code";

  lexicalAlignment(manuscript: Manuscript, diff: string): [number, string[]] {
    const claims = (manuscript.sections.method || manuscript.abstract).split(/(?<=[.!?])\s+|\n+/).filter((text) => text.trim());
    if (!claims.length) return [0, ["manuscript has no claims to align"]];
    const diffTokens = tokens(diff);
    const missing: string[] = [];
    let hit = 0;
    for (const claim of claims) {
      const claimTokens = tokens(claim);
      if (claimTokens.size && [...claimTokens].filter((token) => diffTokens.has(token)).length / claimTokens.size >= 0.25) {
        hit += 1;
      } else {
        missing.push(claim.slice(0, 120));
      }
    }
    return [hit / claims.length, missing];
  }

  async audit(
    manuscript: Manuscript,
    opts: { diff: string; evidence?: Evidence | null },
  ): Promise<IntegrityReport> {
    const [lower, missing] = this.lexicalAlignment(manuscript, opts.diff);
    const claims = (manuscript.sections.method || manuscript.abstract).split(/(?<=[.!?])\s+|\n+/).filter((text) => text.trim());
    if (!claims.length) return makeIntegrity({ score_verified: false, method_code_alignment: 0, notes: ["Manuscript method is missing."] });
    const notes: string[] = [];
    let total = 0;
    for (const claim of claims) {
      let supported = 0;
      for (const [index, chunk] of reviewChunks(opts.diff).entries()) {
        const result = await this.ask(MethodCodeAuditResult, {
          user: "Score code evidence for this single manuscript claim in this chunk. " +
            "Use 0 when unsupported and 1 when fully implemented. All chunks are checked.\n" +
            `CLAIM\n${claim}\nDIFF CHUNK ${index + 1}\n${chunk}`,
          meta: { n: 1, chunk: index + 1 },
        });
        supported = Math.max(supported, Math.min(1, Math.max(0, result.alignment)));
        if (result.notes) notes.push(result.notes);
      }
      total += supported;
    }
    const alignment = lower > 0 ? Math.min(lower, total / claims.length) : 0;
    if (missing.length) notes.push(`${missing.length} claims not lexically supported by the diff`);
    return makeIntegrity({
      score_verified: verifyScores(manuscript.claims.length > 0, opts.evidence ?? null),
      method_code_alignment: Math.round(alignment * 1000) / 1000,
      checked_claims: claims.length,
      notes,
    });
  }
}

function refsFrom(manuscript: Manuscript): string[] {
  const raw = manuscript.sections.references ?? "";
  return raw
    .split("\n")
    .map((line) => line.replace(/^[\s-]+|[\s-]+$/g, ""))
    .filter(Boolean);
}
