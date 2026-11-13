/** §3.2/§3.4 empirical gates: model opinion can never override arithmetic. */

import {
  type Evidence,
  type Trace,
  type Verdict,
  evidenceOk,
  finalEvidence,
  isStrictlyBetter,
  makeVerdict,
  metricDeltas,
} from "../types.ts";
import { BaseAgent } from "./base.ts";

function valid(evidence: Evidence, baseline: Evidence, names: string[]): boolean {
  return (
    evidenceOk(evidence) &&
    evidenceOk(baseline) &&
    samplesOk(evidence) &&
    samplesOk(baseline) &&
    names.length > 0 &&
    names.every(
      (name) =>
        name in evidence.metrics &&
        name in baseline.metrics &&
        Number.isFinite(evidence.metrics[name]) &&
        Number.isFinite(baseline.metrics[name]),
    )
  );
}

/** All screened seeds must finish; a single failed seed is a code repair, not a verdict. */
function samplesOk(evidence: Evidence): boolean {
  return !evidence.samples?.length || evidence.samples.every((sample) => sample.result === null || sample.result?.status === "ok");
}

export class SubsetCritic extends BaseAgent {
  readonly NAME = "subset_critic";
  readonly task = "critic.subset";

  async judge(evidence: Evidence, opts: { baseline: Evidence }): Promise<Verdict> {
    const specs = this.ctx.problem.metrics;
    const deltas = metricDeltas(evidence.metrics, opts.baseline.metrics, specs);
    const primary = specs[0];
    const samples = evidence.samples ?? [];
    // Multi-seed rule: a candidate is bad only when every seed is worse than
    // the subset baseline on the primary metric. One bad seed is a reason to
    // engineer, not to prune the idea.
    const allWorse = !!primary && samples.length > 0 && samples.every((sample) => {
      const delta = metricDeltas(sample.metrics, opts.baseline.metrics, [primary])[primary.name];
      return Number.isFinite(delta) && delta < -primary.tolerance;
    });
    let decision: Verdict["decision"];
    let feedback: string;
    if (!valid(evidence, opts.baseline, specs.map((spec) => spec.name))) {
      // A failed execution is usually an implementation/interface bug, not a
      // scientific refutation. Enter the coding repair loop and do not consume
      // an engineering round; only exhausted repair budget becomes BAD.
      return makeVerdict({
        decision: "engineer",
        invalid: true,
        feedback:
          "Subset run failed or lacks valid paired metrics. Repair the implementation " +
          "(patch, command, output contract) and re-run the identical subset protocol; " +
          "this repair does not consume an engineering round.",
        metrics: deltas,
      });
    } else if (allWorse) {
      decision = "bad";
      feedback = `All ${samples.length} subset seeds are worse than the baseline on ${primary.name}; prune the idea.`;
    } else if (
      isStrictlyBetter(evidence.metrics, opts.baseline.metrics, specs) &&
      (deltas[primary.name] ?? 0) >= this.ctx.config.subsetMargin
    ) {
      decision = "good";
      feedback = "Subset primary gain meets the margin with no material regression.";
    } else {
      decision = "engineer";
      feedback = "Subset gain is below the required margin; inspect and tune the implementation.";
    }
    return makeVerdict({ decision, feedback, metrics: deltas });
  }
}

export class FullSetCritic extends BaseAgent {
  readonly NAME = "full_set_critic";
  readonly task = "critic.full";

  async judge(
    evidence: Evidence,
    opts: { baseline: Evidence; attempts?: number },
  ): Promise<Verdict> {
    const specs = this.ctx.problem.metrics;
    const deltas = metricDeltas(evidence.metrics, opts.baseline.metrics, specs);
    let decision: Verdict["decision"];
    let feedback: string;
    if (!valid(evidence, opts.baseline, specs.map((spec) => spec.name))) {
      return makeVerdict({
        decision: "engineer",
        invalid: true,
        feedback:
          "Full-set run failed or lacks valid paired metrics. Repair the implementation " +
          "(scaling patch, command, output contract) and re-run the identical full protocol; " +
          "this repair does not consume an engineering round.",
        metrics: deltas,
      });
    } else if (isStrictlyBetter(evidence.metrics, opts.baseline.metrics, specs)) {
      decision = "good";
      feedback = "Full benchmark strictly improves on the reproduced baseline.";
    } else if (Math.max(0, opts.attempts ?? 0) < this.ctx.config.maxEngRounds) {
      decision = "engineer";
      feedback = "Full benchmark is not strictly better; refine within the remaining engineering budget.";
    } else {
      decision = "bad";
      feedback = "Full-set engineering budget exhausted without strict improvement.";
    }
    return makeVerdict({ decision, feedback, metrics: deltas });
  }
}

/** The no-LLM strict adoption gate for §3.4/§3.6. */
export class ResultComparison extends BaseAgent {
  readonly NAME = "result_comparison";
  readonly task = "critic.compare";

  async compare(next: Evidence, base: Evidence): Promise<Verdict> {
    const specs = this.ctx.problem.metrics;
    const better =
      valid(next, base, specs.map((spec) => spec.name)) &&
      isStrictlyBetter(next.metrics, base.metrics, specs);
    return makeVerdict({
      decision: better ? "good" : "refine",
      feedback: better
        ? "Strict empirical improvement; candidate may replace incumbent."
        : "No strict empirical improvement; retain the incumbent.",
      metrics: metricDeltas(next.metrics, base.metrics, specs),
    });
  }
}

export class Selector extends BaseAgent {
  readonly NAME = "selector";
  readonly task = "critic.selector";

  async select(traces: Trace[], opts: { baseline: Evidence }): Promise<Trace> {
    const candidates = traces.filter((trace) => trace.decision === "good" && finalEvidence(trace));
    if (!candidates.length) throw new Error("selection requires at least one GOOD trace with evidence");
    const specs = this.ctx.problem.metrics;

    const rank = (trace: Trace): [number, number, number] => {
      const evidence = finalEvidence(trace);
      if (!evidence) return [Number.NEGATIVE_INFINITY, 0, 0];
      const deltas = metricDeltas(evidence.metrics, opts.baseline.metrics, specs);
      // Rank on every declared metric and dataset, not just metrics[0].
      // Deltas are already signed so higher is better for min and max metrics.
      const weighted = specs.reduce((sum, spec) => {
        const delta = deltas[spec.name];
        return sum + (Number.isFinite(delta) ? delta * spec.weight : Number.NEGATIVE_INFINITY);
      }, 0);
      const improved = specs.filter((spec) => (deltas[spec.name] ?? Number.NEGATIVE_INFINITY) > spec.tolerance).length;
      return [weighted, improved, trace.idea.novelty_score];
    };

    let best = candidates[0];
    let bestRank = rank(best);
    for (const trace of candidates.slice(1)) {
      const current = rank(trace);
      if (
        current[0] > bestRank[0] ||
        (current[0] === bestRank[0] && current[1] > bestRank[1]) ||
        (current[0] === bestRank[0] && current[1] === bestRank[1] && current[2] > bestRank[2])
      ) {
        best = trace;
        bestRank = current;
      }
    }
    return best;
  }
}
