/** §3.1 — iterative, guidance-aware extraction and verification of limitations. */

import { stableString } from "../json.ts";
import { LimitationBatch, VerdictSpec } from "../schemas.ts";
import type { DiagnosisFinding, Limitation, Verdict } from "../types.ts";
import { BaseAgent, guidance } from "./base.ts";

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export class LimitationExtractor extends BaseAgent {
  readonly NAME = "limitation_extractor";
  readonly task = "limitations.extract";

  async extract(opts: { round?: number; existing?: Limitation[]; findings?: DiagnosisFinding[] } = {}): Promise<Limitation[]> {
    const round = opts.round ?? 0;
    const findings = [...(opts.findings ?? [])].sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
    const previous = [...(opts.existing ?? [])].sort((a, b) =>
      a.id === b.id ? normalized(a.text).localeCompare(normalized(b.text)) : a.id.localeCompare(b.id),
    );
    const forbidden = [...this.ctx.problem.forbidden].sort();
    const prompt =
      "Extract new, actionable limitations of the source method (§3.1). " +
      "Expand the existing set; never repeat its IDs or normalized text. " +
      "Only suggest limitations whose remedies are in scope. Do not propose " +
      "or depend on any forbidden approach. Ground each limitation in a measured " +
      "finding when one is supplied; label genuinely unmeasured gaps as hypotheses.\n" +
      `Measured findings (primary first): ${stableString(findings)}\n` +
      `Problem: ${this.ctx.problem.statement}\n` +
      `Source: ${this.ctx.problem.source_paper}\n` +
      `Constraints: ${stableString([...this.ctx.problem.constraints].sort())}\n` +
      `Forbidden approaches: ${stableString(forbidden)}\n` +
      `Existing: ${stableString(previous)}\n` +
      `Guidance:\n${guidance(this.ctx)}`;

    const batch = await this.ask(LimitationBatch, {
      user: prompt,
      meta: {
        n: Math.max(1, this.ctx.config.minLimitations - previous.length),
        round,
        existing_ids: previous.map((item) => item.id).sort(),
        finding_ids: findings.map((finding) => finding.id),
      },
    });

    const seenIds = new Set(previous.map((item) => item.id));
    const seenText = new Set(previous.map((item) => normalized(item.text)));
    const banned = forbidden.map(normalized).filter(Boolean);
    const out: Limitation[] = [];
    const ordered = [...batch.limitations].sort((a, b) =>
      a.id === b.id ? normalized(a.text).localeCompare(normalized(b.text)) : a.id.localeCompare(b.id),
    );
    for (const item of ordered) {
      const text = normalized(item.text);
      if (!text || seenIds.has(item.id) || seenText.has(text)) continue;
      if (banned.some((phrase) => text.includes(phrase))) continue;
      seenIds.add(item.id);
      seenText.add(text);
      out.push(item);
    }
    return out;
  }
}

export class LimitationVerifier extends BaseAgent {
  readonly NAME = "limitation_verifier";
  readonly task = "limitations.verify";

  async verify(limitations: Limitation[], opts: { round?: number } = {}): Promise<Verdict> {
    const round = opts.round ?? 0;
    const verdict = await this.ask(VerdictSpec, {
      system:
        "You are the Limitation Verifier (§3.1). Judge whether the set " +
        "is sufficient to guide novel improvements. Return GOOD if " +
        "sufficient, REFINE with missing actionable axes otherwise.",
      user: stableString({
        problem: this.ctx.problem.statement,
        minimum: this.ctx.config.minLimitations,
        limitations: [...limitations].sort((a, b) => a.id.localeCompare(b.id)),
      }),
      meta: { round },
    });
    if (limitations.length < this.ctx.config.minLimitations) {
      return {
        ...verdict,
        decision: "refine",
        feedback: `Need at least ${this.ctx.config.minLimitations} limitations. ${verdict.feedback}`.trim(),
      };
    }
    const accepted = verdict.decision === "good" || verdict.decision === "accept";
    return { ...verdict, decision: accepted ? "good" : "refine" };
  }
}
