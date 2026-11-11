/**
 * §3.5/§3.6 — ScholarPeer-style review, executable rebuttals and meta-review.
 *
 * Rebuttal is experiment-backed, never text-only. A high peer score alone cannot
 * bypass deterministic manuscript structure and evidence checks at meta-review.
 */

import { stableString } from "../json.ts";
import { MetaReviewSpec, RebuttalPlanBatch, ReviewSpec } from "../schemas.ts";
import {
  type Manuscript,
  type MetaReview,
  type RebuttalTask,
  type Review,
  makeReview,
} from "../types.ts";
import { BaseAgent, guidance } from "./base.ts";
import { validateManuscript } from "./writing.ts";

function nonempty(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

function boundedScore(score: number, maximum: number): number {
  if (!Number.isFinite(maximum) || maximum < 1) {
    throw new Error("config.reviewScaleMax must be finite and at least 1");
  }
  return Number.isFinite(score) ? Math.min(maximum, Math.max(1, score)) : 1;
}

export class PeerReviewer extends BaseAgent {
  readonly NAME = "peer_reviewer";
  readonly task = "review.peer";

  async review(manuscript: Manuscript, opts: { round?: number } = {}): Promise<Review> {
    const round = opts.round ?? 0;
    const config = this.ctx.config;
    const output = await this.ask(ReviewSpec, {
      user:
        "Review the current manuscript in ScholarPeer style. Assess methodological novelty, " +
        "baseline fairness, empirical validity, component attribution and reproducibility. " +
        "Return at least one strength, specific weaknesses, targeted experimental questions, " +
        `and an overall score in [1, ${config.reviewScaleMax}]. A score below ` +
        `${config.reviewThreshold} REQUIRES a weakness and targeted question that an ` +
        "engineer can resolve with supplementary experiments. Guidance must not inflate the score.\n" +
        guidance(this.ctx) +
        "\n" +
        stableString({
          manuscript,
          structural_violations: validateManuscript(manuscript, config, this.ctx.problem),
        }),
      meta: { manuscript_id: manuscript.id, round },
    });
    const score = boundedScore(output.score, config.reviewScaleMax);
    const strengths = nonempty(output.strengths).length
      ? nonempty(output.strengths)
      : ["The manuscript presents a concrete method for empirical assessment."];
    let weaknesses = nonempty(output.weaknesses);
    let questions = nonempty(output.questions);
    const metrics = this.ctx.problem.metrics.map((spec) => spec.name).join(", ") || "the reported benchmark metrics";
    const datasets = this.ctx.problem.datasets.join(", ") || "all full-set evaluation datasets";
    if (score < config.reviewThreshold) {
      if (!weaknesses.length) {
        weaknesses = [
          "The core mechanism's contribution and robustness versus the reproduced baseline remain insufficiently established.",
        ];
      }
      if (!questions.length) {
        questions = [
          `Does removing the core mechanism change ${metrics} on ${datasets} under identical splits and repeated seeds versus the reproduced baseline?`,
        ];
      }
    }
    return makeReview({
      manuscript_id: manuscript.id,
      strengths,
      weaknesses,
      questions,
      score,
      scale_max: config.reviewScaleMax,
      summary:
        output.summary.trim() ||
        "Assessment of methodological and empirical support in the current manuscript.",
      round,
    });
  }
}

export class RebuttalPlanner extends BaseAgent {
  readonly NAME = "rebuttal_planner";
  readonly task = "review.rebuttal_plan";
  readonly role = "rebuttal";

  async plan(review: Review, opts: { n: number }): Promise<RebuttalTask[]> {
    if (opts.n < 0) throw new Error("n must be non-negative");
    if (opts.n === 0) return [];
    const config = this.ctx.config;
    const output = await this.ask(RebuttalPlanBatch, {
      user:
        "Turn reviewer questions into exactly n executable supplementary experiments using " +
        "the validated C_best without replacing the core method. For each return an id, original " +
        "question, targeted plan, and a concrete experiment string specifying control, intervention, " +
        "datasets/splits, fixed seeds, measured metrics, and output logs. A prose rebuttal is not " +
        "an experiment. Each task must answer a reviewer query.\n" +
        guidance(this.ctx) +
        "\n" +
        stableString({
          review,
          n: opts.n,
          datasets: this.ctx.problem.datasets,
          metrics: this.ctx.problem.metrics,
          seed: config.seed,
        }),
      meta: { n: opts.n, manuscript_id: review.manuscript_id },
    });
    const questions = nonempty(review.questions).length
      ? nonempty(review.questions)
      : nonempty(review.weaknesses).length
        ? nonempty(review.weaknesses)
        : ["Does the proposed core mechanism improve on the reproduced baseline under matched evaluation?"];
    const metrics = this.ctx.problem.metrics.map((spec) => spec.name).join(", ") || "all manuscript metrics";
    const datasets = this.ctx.problem.datasets.join(", ") || "the full benchmark datasets";
    const tasks: RebuttalTask[] = [];
    for (let index = 0; index < opts.n; index++) {
      const question = questions[index % questions.length];
      const proposed = index < output.tasks.length ? output.tasks[index] : null;
      const identifier = `${review.manuscript_id || "paper"}-rebuttal-${index + 1}`;
      const seed = config.seed + index * 3;
      let experiment =
        `In an isolated copy of validated C_best, implement a controlled test answering: ${question} ` +
        `Evaluate the complete method, the reproduced human baseline and the targeted component ` +
        `intervention on ${datasets} using identical held-out splits and seeds [${seed}, ${seed + 1}, ${seed + 2}]. ` +
        `Hold training/data budgets and all unrelated components fixed; measure ${metrics} for each ` +
        `condition, report per-seed values and mean differences, and save metrics/logs to ` +
        `rebuttal/${identifier}.json. Do not adopt a changed core method.`;
      if (proposed?.experiment.trim()) experiment = `${proposed.experiment.trim()}\n${experiment}`;
      tasks.push({
        id: identifier,
        question,
        plan:
          proposed?.plan.trim() ||
          `Resolve reviewer query through matched measurements: ${question}`,
        experiment,
      });
    }
    return tasks;
  }
}

export class MetaReviewer extends BaseAgent {
  readonly NAME = "meta_reviewer";
  readonly task = "review.meta";

  async decide(manuscript: Manuscript, review: Review, opts: { round?: number } = {}): Promise<MetaReview> {
    const round = opts.round ?? 0;
    const config = this.ctx.config;
    const violations = validateManuscript(manuscript, config, this.ctx.problem);
    const output = await this.ask(MetaReviewSpec, {
      user:
        "Assess this manuscript alongside its current peer review against the venue bar. " +
        "Return decision accept or refine, critique and score. Accept requires peer score >= " +
        `${config.reviewThreshold} AND no structural/evidence violations. Refine must identify ` +
        "an algorithmic or empirical weakness, with a concrete method change and measurements " +
        "to repeat; wording or presentation alone is not a refinement strategy.\n" +
        guidance(this.ctx) +
        "\n" +
        stableString({ manuscript, review, structural_violations: violations }),
      meta: { manuscript_id: manuscript.id, round },
    });
    const validScore =
      Number.isFinite(review.score) &&
      review.score >= 1 &&
      review.score <= config.reviewScaleMax &&
      review.score >= config.reviewThreshold;
    const matchingReview = !review.manuscript_id || review.manuscript_id === manuscript.id;
    const accept = output.decision === "accept" && validScore && matchingReview && !violations.length;
    let critique = output.critique.trim();
    if (!accept) {
      const metrics =
        this.ctx.problem.metrics.map((spec) => spec.name).join(", ") || "the claimed benchmark metrics";
      const weaknesses = nonempty(review.weaknesses).join("; ");
      const reasons = violations.join("; ");
      let instruction =
        "Empirical weakness: the core mechanism's independent contribution and robust advantage " +
        "over the reproduced baseline are not yet established to the venue bar. Simplify or " +
        `replace the unsupported component and re-measure ${metrics} on the full benchmark with ` +
        "matched splits/seeds plus component ablations; adopt only after strict measured improvement.";
      if (weaknesses) instruction += ` Reviewer concerns: ${weaknesses}`;
      if (reasons) instruction += ` Evidence/coverage deficiencies: ${reasons}`;
      if (!matchingReview) {
        instruction += " The supplied review is for a different manuscript; repeat peer evaluation.";
      }
      critique = `${critique}\n${instruction}`.trim();
    }
    return {
      decision: accept ? "accept" : "refine",
      critique: critique || "The manuscript clears the empirical, structural and peer-review gates.",
      score: boundedScore(review.score, config.reviewScaleMax),
      round,
    };
  }
}
