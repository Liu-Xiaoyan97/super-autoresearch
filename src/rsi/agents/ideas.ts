/** §3.1/§3.3 — guided seed generation, novelty ranking, and trace evolution. */

import { stableString } from "../json.ts";
import { IdeaBatch, IdeaLibrary } from "../schemas.ts";
import {
  type DiagnosisFinding,
  type Idea,
  type Limitation,
  type Problem,
  type Trace,
  hardDirections,
  makeIdea,
} from "../types.ts";
import { BaseAgent, guidance } from "./base.ts";
import type { Config } from "../config.ts";

export function rankKey(idea: Idea, guidanceWeight: number): number {
  return idea.novelty_score + guidanceWeight * idea.domain_fit;
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function filterByGuidance(ideas: Idea[], problem: Problem, config: Config): Idea[] {
  const hardIds = new Set(hardDirections(problem).map((direction) => direction.id));
  return ideas
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter(
      (idea) =>
        (!problem.directions.length || idea.domain_fit >= config.minDomainFit) &&
        (!config.strictDirections ||
          hardIds.size === 0 ||
          idea.direction_ids.some((id) => hardIds.has(id))),
    );
}

function distinct(ideas: Idea[], existing: Idea[], n: number): Idea[] {
  const ids = new Set(existing.map((idea) => idea.id));
  const hypotheses = new Set(existing.map((idea) => normalizeText(idea.hypothesis)));
  const out: Idea[] = [];
  const ordered = ideas
    .slice()
    .sort((a, b) =>
      a.id === b.id
        ? normalizeText(a.hypothesis).localeCompare(normalizeText(b.hypothesis))
        : a.id.localeCompare(b.id),
    );
  for (const idea of ordered) {
    if (out.length >= Math.max(0, n)) break;
    const key = normalizeText(idea.hypothesis);
    if (!key || ids.has(idea.id) || hypotheses.has(key)) continue;
    out.push(idea);
    ids.add(idea.id);
    hypotheses.add(key);
  }
  return out;
}

function isSynthetic(ctx: { llm: { name: string } }, id: string): boolean {
  if (ctx.llm.name !== "mock") return false;
  return id.startsWith("ideas-") || id.startsWith("idea-") || id.includes("-ideas-");
}

function normalizeIds(
  ctx: { llm: { name: string }; scratch: Record<string, unknown> },
  ideas: Idea[],
  prefix: string,
  base: number,
): Idea[] {
  let counter = Math.trunc(Number(ctx.scratch.idea_id_seq ?? Math.max(base - 1, 0))) || 0;
  const out = ideas.map((idea) => {
    if (!isSynthetic(ctx, idea.id)) return idea;
    counter += 1;
    return { ...idea, id: `${prefix}${counter}` };
  });
  ctx.scratch.idea_id_seq = counter;
  return out;
}

export class InitialIdeaGenerator extends BaseAgent {
  readonly NAME = "initial_idea_generator";
  readonly task = "ideas.initial";

  async generate(limitations: Limitation[], opts: { findings?: DiagnosisFinding[] } = {}): Promise<Idea> {
    const findings = [...(opts.findings ?? [])].sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
    const batch = await this.ask(IdeaBatch, {
      user:
        "Generate exactly one initial idea h0, with a testable hypothesis " +
        "and concrete mechanism addressing the limitations. When measured findings " +
        "are supplied, target the highest-severity measured defect; a mechanism that " +
        "cannot be justified from those findings is a hypothesis, not a measured claim. " +
        "Record target_limitations and direction_ids. Never use a forbidden approach.\n" +
        `Measured findings (primary first): ${stableString(findings)}\n` +
        `Problem: ${this.ctx.problem.statement}\n` +
        `Limitations: ${stableString([...limitations].sort((a, b) => a.id.localeCompare(b.id)))}\n` +
        `Forbidden: ${stableString([...this.ctx.problem.forbidden].sort())}\n` +
        `Guidance:\n${guidance(this.ctx)}`,
      meta: { n: 1, prefix: "h", round: 0 },
    });
    const ideas = batch.ideas.slice().sort((a, b) => a.id.localeCompare(b.id));
    const initial = ideas[0] ?? makeIdea({ id: "h0", hypothesis: "" });
    return { ...initial, id: "h0", origin: "seed", round: 0 };
  }
}

export class NoveltyChecker extends BaseAgent {
  readonly NAME = "novelty_checker";
  readonly task = "ideas.novelty";

  async score(idea: Idea, opts: { round?: number; findings?: DiagnosisFinding[] } = {}): Promise<Idea> {
    const round = opts.round ?? 0;
    const findings = [...(opts.findings ?? [])].sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
    const count = this.ctx.config.noveltyRefs;
    const library = await this.ask(IdeaLibrary, {
      user:
        "Evaluate novelty against prior literature and domain alignment, " +
        "both in [0,1]. Return the scored idea and top-level novelty_score, " +
        "domain_fit, direction_ids and novelty_refs. " +
        `Measured defect to address: ${stableString(findings.slice(0, 1))}. ` +
        `Retrieve exactly ${count} relevant reference papers for that defect; never invent citations. ` +
        "The references must evaluate the idea's mechanism (for example kernel decay, state mixing or the training objective), " +
        "not generic data-curation or benchmark papers. If no relevant literature is found, say so and do not inflate novelty. " +
        "If a web_search tool is available, use it to find real papers and cite their titles/URLs; " +
        "if search fails, mark the slot as 'Reference unavailable' instead of guessing.\n" +
        `Idea: ${stableString(idea)}\nGuidance:\n${guidance(this.ctx)}`,
      meta: { n: count, novelty_refs: count, idea_id: idea.id, round },
    });

    const scored = library.idea;
    // Top-level fields win when provided; otherwise use the nested scored idea.
    const novelty = library.novelty_score || scored?.novelty_score || 0;
    const fit = library.domain_fit || scored?.domain_fit || 0;
    const directions = library.direction_ids.length ? library.direction_ids : (scored?.direction_ids ?? []);
    const refs = [...new Set((library.novelty_refs.length ? library.novelty_refs : (scored?.novelty_refs ?? []))
      .map((ref) => ref.trim())
      .filter(Boolean))]
      .slice(0, count);
    for (let i = refs.length; i < count; i++) refs.push(`Reference unavailable (slot ${i + 1})`);
    const validDirections = new Set(this.ctx.problem.directions.map((direction) => direction.id));
    return {
      ...idea,
      novelty_score: clamp01(novelty),
      domain_fit: clamp01(fit),
      novelty_refs: refs,
      direction_ids: [...new Set(directions.filter((id) => validDirections.has(id)))].sort(),
    };
  }
}

export class IdeaGenerator extends BaseAgent {
  readonly NAME = "idea_generator";
  readonly task = "ideas.expand";

  async generate(opts: { limitations: Limitation[]; existing: Idea[]; n: number; findings?: DiagnosisFinding[] }): Promise<Idea[]> {
    const { limitations, existing, n } = opts;
    const findings = [...(opts.findings ?? [])].sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
    if (n <= 0) return [];
    const batch = await this.ask(IdeaBatch, {
      user:
        `Propose ${n} distinct, higher-novelty testable ideas with unique IDs. ` +
        "Do not repeat existing hypotheses or IDs. Address limitations, " +
        "supply direction_ids, and avoid all forbidden approaches.\n" +
        `Problem: ${this.ctx.problem.statement}\n` +
        `Measured findings (primary first): ${stableString(findings)}\n` +
        `Limitations: ${stableString([...limitations].sort((a, b) => a.id.localeCompare(b.id)))}\n` +
        `Existing: ${stableString([...existing].sort((a, b) => a.id.localeCompare(b.id)))}\n` +
        `Forbidden: ${stableString([...this.ctx.problem.forbidden].sort())}\n` +
        `Guidance:\n${guidance(this.ctx)}`,
      meta: {
        n,
        prefix: "h",
        offset: existing.length,
        existing_ids: existing.map((idea) => idea.id).sort(),
      },
    });
    const clean = distinct(batch.ideas, existing, n);
    return normalizeIds(this.ctx, clean, "h", existing.length).map((idea) => ({
      ...idea,
      origin: "seed",
      round: 0,
    }));
  }
}

export class IdeaEvolver extends BaseAgent {
  readonly NAME = "idea_evolver";
  readonly task = "ideas.evolve";

  async evolve(opts: { traces: Trace[]; n: number; round: number }): Promise<Idea[]> {
    const { traces, n, round } = opts;
    if (n <= 0) return [];
    const ordered = traces
      .slice()
      .sort((a, b) => (a.round === b.round ? a.idea.id.localeCompare(b.idea.id) : a.round - b.round));
    const successful = ordered.filter((trace) => trace.decision === "good");
    const failed = ordered.filter((trace) => trace.decision !== "good");
    let prompt =
      `Evolve ${n} new hypotheses in round ${round} from ALL historical traces. ` +
      "Amalgamate successful mechanisms and diagnose failures using measured " +
      "metrics and feedback. Supply unique IDs, parent_ids and direction_ids.\n" +
      `Problem: ${this.ctx.problem.statement}\n` +
      `Successful traces (metrics + feedback): ${stableString(successful)}\n` +
      `Failed traces (metrics + feedback): ${stableString(failed)}\n` +
      `Forbidden approaches: ${stableString([...this.ctx.problem.forbidden].sort())}`;
    if (this.ctx.config.guidanceInEvolution && (this.ctx.problem.directions.length || this.ctx.problem.domain)) {
      prompt += `\nGuidance:\n${guidance(this.ctx)}`;
    }
    const batch = await this.ask(IdeaBatch, {
      system: "You are the Idea Evolver (§3.3). Propose empirical improvements from execution traces.",
      user: prompt,
      meta: {
        n,
        prefix: `e${round}`,
        round,
        existing_ids: ordered.map((trace) => trace.idea.id).sort(),
      },
    });
    const clean = distinct(batch.ideas, ordered.map((trace) => trace.idea), n);
    return normalizeIds(this.ctx, clean, `e${round}-`, 0).map((idea) => ({
      ...idea,
      origin: "evolved",
      round,
    }));
  }
}

export { rankKey as ideaRankKey };
