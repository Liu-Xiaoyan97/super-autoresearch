/** §3.2/§3.4/§3.6 bounded engineering: patches and actual execution only. */

import { crc32 } from "../crc32.ts";
import { stableString } from "../json.ts";
import { FullSetEngineeringPatch, SubsetEngineeringPatch } from "../schemas.ts";
import { type Evidence, type Idea, makeEvidence } from "../types.ts";
import { BaseAgent } from "./base.ts";
import { askUnifiedDiff } from "./patch.ts";
import { codeOf } from "./coding.ts";

export class SubsetEngineer extends BaseAgent {
  readonly NAME = "subset_engineer";
  readonly task = "engineer.subset";
  readonly role = "coding";

  async refine(idea: Idea, opts: { evidence: Evidence; feedback: string }): Promise<Evidence> {
    const brief = this.ctx.workspace.brief?.(codeOf(opts.evidence), `${idea.mechanism} ${opts.feedback}`) ?? "";
    const out = await askUnifiedDiff(this, SubsetEngineeringPatch, {
      user:
        `${stableString(idea)}\nCritique: ${opts.feedback}\n${stableString(opts.evidence)}\n\n` +
        `Return a unified diff that fixes/tunes the implementation. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id },
    });
    const repo = await this.ctx.workspace.writePatch(
      codeOf(opts.evidence),
      `${out.patch}\nCritique: ${opts.feedback}\n`,
      `${idea.id}-subset-engineered`,
    );
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, "subset", idea);
    return makeEvidence({
      idea_id: idea.id,
      scope: "subset",
      metrics: result.metrics,
      baseline_metrics: { ...opts.evidence.baseline_metrics },
      code: repo,
      result,
      label: repo.label,
    });
  }
}

export class FullSetEngineer extends BaseAgent {
  readonly NAME = "full_set_engineer";
  readonly task = "engineer.full";
  readonly role = "coding";

  async refine(
    idea: Idea,
    opts: { evidence: Evidence; feedback: string; reason?: string },
  ): Promise<{ idea: Idea; evidence: Evidence }> {
    const reason = opts.reason ?? "ablation";
    const brief = this.ctx.workspace.brief?.(codeOf(opts.evidence), `${idea.mechanism} ${opts.feedback}`) ?? "";
    const out = await askUnifiedDiff(this, FullSetEngineeringPatch, {
      user:
        `${stableString(idea)}\nReason: ${reason}\nCritique: ${opts.feedback}\n` +
        `${stableString(opts.evidence)}\n` +
        `${this.ctx.problem.domain ? stableString({ domain: this.ctx.problem.domain, directions: this.ctx.problem.directions }) : ""}` +
        `\n\nReturn a unified diff against the snapshot. Do not modify run_experiment.py or tests.\n\n${brief}`,
      meta: { idea_id: idea.id, reason },
    });
    const token = crc32(
      `${codeOf(opts.evidence).label}|${reason}|${opts.feedback}|${out.patch}`,
    )
      .toString(16)
      .padStart(8, "0");
    const refined: Idea = {
      ...idea,
      id: `${idea.id}-eng-${token}`,
      hypothesis: out.hypothesis || idea.hypothesis,
      mechanism: out.mechanism || `${idea.mechanism}|${reason}:${token}`,
      parent_ids: [idea.id],
      notes: opts.feedback,
    };
    const repo = await this.ctx.workspace.writePatch(
      codeOf(opts.evidence),
      `${out.patch}\nCritique: ${opts.feedback}\nMechanism: ${refined.mechanism}\n`,
      `${refined.id}-full`,
    );
    this.ctx.budget.chargeExperiment();
    const result = await this.ctx.workspace.run(repo, "full", refined);
    const measured = makeEvidence({
      idea_id: refined.id,
      scope: "full",
      metrics: result.metrics,
      baseline_metrics: { ...opts.evidence.baseline_metrics },
      code: repo,
      result,
      label: repo.label,
    });
    return { idea: refined, evidence: measured };
  }
}
