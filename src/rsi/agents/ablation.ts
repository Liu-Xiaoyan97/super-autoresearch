/** §3.4 — executable component ablations and evidence-based attribution critique. */

import { stableString } from "../json.ts";
import { AblationPlanBatch, VerdictSpec } from "../schemas.ts";
import {
  type AblationPlan,
  type AblationResult,
  type Evidence,
  type Idea,
  type MetricSpec,
  type Verdict,
  evidenceOk,
  evidenceProvenanceError,
  makeVerdict,
} from "../types.ts";
import { BaseAgent, guidance } from "./base.ts";

export class AblationPlanner extends BaseAgent {
  readonly NAME = "ablation_planner";
  readonly task = "ablation.plan";

  async plan(idea: Idea, opts: { best: Evidence; n?: number }): Promise<AblationPlan[]> {
    const count = opts.n ?? this.ctx.config.nAblationPlans;
    if (count <= 0) throw new Error("ablation plan count must be positive");
    const batch = await this.ask(AblationPlanBatch, {
      user:
        "Formulate exactly N_p executable component-level ablations. Each plan must name ONE " +
        "distinct removable or replaceable component actually present in the proposed method, " +
        "not a hyperparameter/threshold/learning-rate sweep. State remove/replace intervention, " +
        "validated code snapshot, fixed datasets/splits/seeds, metrics to re-measure, subset " +
        "control, and output artifacts in description. Set variant_of to the idea id. " +
        "Do not invent components.\n" +
        guidance(this.ctx) +
        "\n" +
        stableString({
          idea,
          best: opts.best,
          N_p: count,
          datasets: this.ctx.problem.datasets,
          seed: this.ctx.config.seed,
        }),
      meta: { n: count, idea_id: idea.id },
    });

    const components = new Set<string>();
    const plans: AblationPlan[] = [];
    const metrics =
      this.ctx.problem.metrics.map((spec) => spec.name).join(", ") ||
      Object.keys(opts.best.metrics).join(", ") ||
      "all benchmark metrics";
    const datasets = this.ctx.problem.datasets.join(", ") || "the full benchmark";
    const snapshot = opts.best.code?.path ?? "the validated incumbent snapshot";

    const appendComponent = (component: string, proposed?: AblationPlan | null) => {
      const key = component.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
      if (
        !key ||
        components.has(key) ||
        plans.length >= count ||
        /\b(sweep|hyperparameter|learning[ -]rate|batch[ -]size)\b/.test(key)
      ) {
        return;
      }
      const index = plans.length + 1;
      let description =
        `Copy ${snapshot}; remove only '${component}' (replace with an identity/no-op if required). ` +
        `Hold all other components, datasets/splits and seed ${this.ctx.config.seed} fixed. ` +
        `Run the same full-set evaluation on ${datasets}, record ${metrics} and logs to ` +
        `ablation/${idea.id}-${index}.json, and compare with complete-method metrics ${stableString(opts.best.metrics)}.`;
      if (proposed?.description.trim()) description = `${proposed.description.trim()}\n${description}`;
      plans.push({
        id: `${idea.id}-ablation-${index}`,
        component: component.trim(),
        description,
        expects:
          proposed?.expects.trim() ||
          `Removing ${component} should worsen ${metrics}; a tie/improvement indicates redundancy.`,
        variant_of: idea.id,
      });
      components.add(key);
    };

    for (const proposed of batch.plans) {
      const fragments = proposed.component.split(/[,;+]|\b(?:and|with|plus)\b/i);
      for (const component of fragments) {
        appendComponent(component, fragments.length === 1 ? proposed : null);
      }
    }
    // Idea exposes mechanism prose, not a component inventory. These deterministic
    // structural probes are labelled as such; the coder must report an absent
    // component rather than invent its implementation.
    for (const text of [idea.mechanism, idea.hypothesis]) {
      for (const fragment of text.split(/[,;+]|\b(?:and|with|plus)\b/i)) {
        const cleaned = fragment.replace(/^[\s.:-]+|[\s.:-]+$/g, "");
        if (cleaned) appendComponent(cleaned);
      }
    }
    const structural = [
      "primary mechanism",
      "auxiliary loss/regularizer",
      "input representation",
      "safety/calibration gate",
      "training-free adaptation",
    ];
    let cycle = 0;
    while (plans.length < count) {
      for (const component of structural) {
        const suffix = cycle ? ` ${cycle + 1}` : "";
        appendComponent(`structural ablation: ${component}${suffix}`);
      }
      cycle += 1;
      if (cycle > count * structural.length + 5) break;
    }
    return plans;
  }
}

export class AblationCritic extends BaseAgent {
  readonly NAME = "ablation_critic";
  readonly task = "ablation.critic";

  async judge(idea: Idea, results: AblationResult[], opts: { best: Evidence }): Promise<Verdict> {
    const verdict = await this.ask(VerdictSpec, {
      user:
        "Judge whether the component breakdown is clean from AblationCoder results. Return " +
        "decision good only if every isolated component contributes; otherwise refine. " +
        "Feedback MUST name a component to remove/merge and specify metrics and benchmark " +
        "to re-measure, not a wording change. Do not execute experiments.\n" +
        guidance(this.ctx) +
        "\n" +
        stableString({ idea, best: opts.best, results }),
      meta: { idea_id: idea.id },
    });

    const concerns: string[] = [];
    if (!results.length || !evidenceOk(opts.best)) concerns.push(idea.mechanism || idea.id);
    for (const result of results) {
      const metrics = result.evidence ? result.evidence.metrics : result.metrics;
      const provenance = result.evidence?.result?.status === "ok"
        ? evidenceProvenanceError(result.evidence)
        : null;
      let valid = result.ok &&
        (!result.evidence || (evidenceOk(result.evidence) && !provenance &&
          (result.evidence.result?.status === "ok" || !!result.evidence.samples?.length)));
      let worse = false;
      let counterproductive = false;
      const specs: MetricSpec[] = this.ctx.problem.metrics;
      if (!specs.length) valid = false;
      for (const spec of specs) {
        const control = opts.best.metrics[spec.name];
        const variant = metrics[spec.name];
        if (
          control === undefined ||
          variant === undefined ||
          !Number.isFinite(control) ||
          !Number.isFinite(variant)
        ) {
          valid = false;
          continue;
        }
        const delta = spec.direction === "max" ? variant - control : control - variant;
        const tolerance = Math.abs(control) * spec.tolerance;
        worse = worse || delta < -tolerance;
        counterproductive = counterproductive || delta > tolerance;
      }
      if (!valid || !worse || counterproductive) concerns.push(result.component || result.plan_id);
    }

    const decision = verdict.decision === "good" && !concerns.length ? "good" : "refine";
    const invalid = results.some((result) => {
      const evidence = result.evidence;
      return !result.ok ||
        !!evidence && evidence.result?.status !== "ok" ||
        !!evidence && !!evidenceProvenanceError(evidence);
    });
    const component =
      concerns[0] ||
      results[0]?.component ||
      results[0]?.plan_id ||
      idea.mechanism ||
      idea.id;
    const metricsText =
      this.ctx.problem.metrics.map((spec) => spec.name).join(", ") || "all benchmark metrics";
    const datasets = this.ctx.problem.datasets.join(", ") || "the full benchmark";
    let instruction =
      `Remove or merge component '${component}' in a candidate copy; re-measure ${metricsText} ` +
      `on ${datasets} with identical splits/seeds against the subset control before adoption.`;
    if (decision === "good") {
      instruction = `Each tested component contributes. As a verification control, ${instruction[0].toLowerCase()}${instruction.slice(1)}`;
    }
    return makeVerdict({
      ...verdict,
      decision,
      invalid: invalid || undefined,
      feedback: `${verdict.feedback.trim()}\n${instruction}`.trim(),
    });
  }
}
