/**
 * The RSI standard operating procedure, as the protocol sees it.
 *
 * The paper's sections (§3.1–§3.6, §4.3) are the SOP's stages. Each stage maps
 * to the RSI agents that implement it; each agent task maps to exactly one
 * stage, and therefore to one rule of the policy. The mapping is total: an
 * unknown task is a programming error, not a silently allowed call.
 */

import type { Rule, Stage } from "./model.ts";

export interface StageSpec {
  stage: Stage;
  /** Paper section, or `run` for the whole loop. */
  section: string;
  title: string;
  summary: string;
  /** RSI task keys executed in this stage. */
  tasks: string[];
  /** The policy rule that governs this stage. */
  rule: string;
  /** What the stage must leave behind before the SOP may advance. */
  deliverables: string[];
}

export const SOP_STAGES: readonly StageSpec[] = [
  {
    stage: "run",
    section: "SOP",
    title: "Run",
    summary: "One accepted research request, from §3.1 to the exported artifact tree.",
    tasks: [],
    rule: "sop.run",
    deliverables: ["runs/<run_id>/state.json", "runs/<run_id>/final.json", "runs/<run_id>/superagent/state.json"],
  },
  {
    stage: "limits",
    section: "§3.1",
    title: "Limitations",
    summary: "Extract limitations from the literature and problem constraints; verify sufficiency before seeds.",
    tasks: ["limitations.extract", "limitations.verify"],
    rule: "sop.limits",
    deliverables: ["state.limitations", "limits.ok transition"],
  },
  {
    stage: "seeds",
    section: "§3.1",
    title: "Seed ideas",
    summary: "Generate, expand and novelty-score seed ideas against retrieved references.",
    tasks: ["ideas.initial", "ideas.novelty", "ideas.expand"],
    rule: "sop.seeds",
    deliverables: ["state.seeds", "seeds:<n> transition"],
  },
  {
    stage: "baseline",
    section: "§3.2",
    title: "Baseline reproduction",
    summary: "Reproduce the baseline on subset and full scopes; no candidate may be compared against an unreproduced number.",
    tasks: ["code.baseline"],
    rule: "sop.baseline",
    deliverables: ["state.baseline", "baseline.ok transition"],
  },
  {
    stage: "search",
    section: "§3.2–§3.3",
    title: "Idea search",
    summary: "Implement candidates, gate subset and full-set evidence with critics and engineers, evolve ideas from traces.",
    tasks: [
      "code.implement",
      "code.subset",
      "critic.subset",
      "engineer.subset",
      "code.full",
      "critic.full",
      "critic.compare",
      "ideas.evolve",
    ],
    rule: "sop.search",
    deliverables: ["state.traces", "full-set evidence for candidates"],
  },
  {
    stage: "select",
    section: "§3.3",
    title: "Incumbent selection",
    summary: "Rank validated traces and adopt an incumbent only on a strict measured improvement over the reproduced baseline.",
    tasks: ["critic.selector"],
    rule: "sop.select",
    deliverables: ["state.best_idea", "state.best_evidence", "adopt.select transition"],
  },
  {
    stage: "ablations",
    section: "§3.4",
    title: "Ablations and attribution",
    summary: "Plan and run ablations, judge attribution, refine the incumbent when the critic demands it.",
    tasks: ["ablation.plan", "code.ablation", "ablation.critic"],
    rule: "sop.ablations",
    deliverables: ["state.ablations", "ablation.<decision> transition"],
  },
  {
    stage: "draft",
    section: "§3.5",
    title: "Drafting",
    summary: "Draft the manuscript from the incumbent evidence and ablations.",
    tasks: ["write.draft"],
    rule: "sop.draft",
    deliverables: ["state.manuscript"],
  },
  {
    stage: "review",
    section: "§3.5",
    title: "Peer review and rebuttal",
    summary: "Score the draft, plan rebuttal experiments, enhance the draft until the threshold or the budget stops it.",
    tasks: ["review.peer", "review.rebuttal_plan", "code.rebuttal", "write.enhance"],
    rule: "sop.review",
    deliverables: ["state.review", "state.rebuttals", "peer.r<k>:<score> transitions"],
  },
  {
    stage: "meta",
    section: "§3.6",
    title: "Meta-review",
    summary: "Decide accept or refine with the meta-reviewer; a refine round re-enters ablation and drafting.",
    tasks: ["review.meta", "engineer.full"],
    rule: "sop.meta",
    deliverables: ["state.meta_review", "meta.<decision> transition"],
  },
  {
    stage: "integrity",
    section: "§4.3",
    title: "Integrity audit",
    summary: "Audit scores, specification, references and method-code alignment; a model may not repair a failed audit.",
    tasks: ["integrity.spec", "integrity.refs", "integrity.method_code"],
    rule: "sop.integrity",
    deliverables: ["final.integrity", "final.extra.accepted"],
  },
  {
    stage: "export",
    section: "SOP",
    title: "Export",
    summary: "Write state.json, final.json, artifacts and the manuscript; record why an incumbent was exported instead of accepted.",
    tasks: [],
    rule: "sop.export",
    deliverables: ["runs/<run_id>/final.json", "runs/<run_id>/artifacts/"],
  },
] as const;

/**
 * The policy's rules. `level` says who may make the step happen:
 *   auto     the SOP may do it on its own, inside an accepted run
 *   observe  only recorded as "would do" until a person asks for it
 *   person   a person must act; the SOP opens an Attention and waits
 * The numeric gates of the paper are not rules: a model can never cause a
 * promotion, whatever the policy says (see `agents/critics.ts`).
 */
export const SOP_RULES: Rule[] = [
  { id: "sop.run", name: "Research run", level: "auto", enabled: true, instruction: "Accept and execute one research run: the closed loop from §3.1 to the exported artifacts." },
  { id: "sop.limits", name: "Limitations", level: "auto", enabled: true, instruction: "Extract limitations and verify them before generating seeds." },
  { id: "sop.seeds", name: "Seed ideas", level: "auto", enabled: true, instruction: "Generate, expand and novelty-score seed ideas against retrieved references." },
  { id: "sop.baseline", name: "Baseline reproduction", level: "auto", enabled: true, instruction: "Reproduce the baseline before comparing any candidate against it." },
  { id: "sop.search", name: "Idea search", level: "auto", enabled: true, instruction: "Implement candidates and gate them on subset and full-set evidence." },
  { id: "sop.select", name: "Incumbent selection", level: "auto", enabled: true, instruction: "Rank validated traces; adopt only a strict measured improvement over the reproduced baseline." },
  { id: "sop.ablations", name: "Ablations", level: "auto", enabled: true, instruction: "Plan, run and judge ablations; refine the incumbent when attribution demands it." },
  { id: "sop.draft", name: "Drafting", level: "auto", enabled: true, instruction: "Draft the manuscript from the incumbent evidence." },
  { id: "sop.review", name: "Peer review", level: "auto", enabled: true, instruction: "Score the draft, run rebuttal experiments and enhance the draft." },
  { id: "sop.meta", name: "Meta-review", level: "auto", enabled: true, instruction: "Decide accept or refine with the meta-reviewer." },
  { id: "sop.integrity", name: "Integrity audit", level: "auto", enabled: true, instruction: "Audit scores, specification, references and method-code alignment." },
  {
    id: "sop.spend",
    name: "Real model calls",
    level: "explicit",
    enabled: true,
    instruction: "Spending real provider calls on a run: allowed when a person asked for a provider run, never on a schedule's own initiative.",
  },
  {
    id: "sop.experiment",
    name: "Target-repository experiments",
    level: "person",
    enabled: true,
    instruction: "Executing the problem repository's experiment command: needs a prepared environment a person vouched for.",
  },
  {
    id: "sop.export",
    name: "Publishing artifacts",
    level: "observe",
    enabled: true,
    instruction: "Writing final.json and the manuscript is part of the run; announcing acceptance outside the run directory is not.",
  },
];

const BY_STAGE = new Map<Stage, StageSpec>(SOP_STAGES.map((spec) => [spec.stage, spec]));
const BY_TASK = new Map<string, StageSpec>();
for (const spec of SOP_STAGES) for (const task of spec.tasks) BY_TASK.set(task, spec);

export function stageSpec(stage: Stage): StageSpec {
  const spec = BY_STAGE.get(stage);
  if (!spec) throw new Error(`unknown SOP stage: ${stage}`);
  return spec;
}

/** The stage that owns an RSI task key. Unknown tasks fail loudly. */
export function stageOfTask(task: string): Stage {
  const spec = BY_TASK.get(task);
  if (!spec) throw new Error(`task '${task}' is not part of the RSI SOP`);
  return spec.stage;
}

export function ruleOfTask(task: string): string {
  return stageSpec(stageOfTask(task)).rule;
}

export function stageOfRule(rule: string): Stage | undefined {
  return SOP_STAGES.find((spec) => spec.rule === rule)?.stage;
}

/** The model role a task runs under (`config.modelRoutes`), for tracing and routing. */
export function roleOfTask(task: string): string {
  if (task === "code.ablation") return "ablation";
  if (task === "code.rebuttal" || task === "review.rebuttal_plan") return "rebuttal";
  if (task === "write.enhance") return "draft_enhancer";
  if (task.startsWith("code.") || task === "engineer.subset" || task === "engineer.full") return "coding";
  return "default";
}

export function taskTitle(task: string): string {
  const spec = BY_TASK.get(task);
  return spec ? `${spec.title}: ${task}` : task;
}

/** Markdown table of the SOP, for prompts and `rsi_superagent` cards. */
export function sopTable(): string {
  return SOP_STAGES.filter((spec) => spec.stage !== "run")
    .map((spec) => `| ${spec.section} | ${spec.title} | ${spec.rule} | ${spec.tasks.join(", ") || "—"} |`)
    .join("\n");
}

export function sopSummary(): string {
  return SOP_STAGES.filter((spec) => spec.stage !== "run")
    .map((spec) => `${spec.section} ${spec.title} [${spec.rule}]: ${spec.summary}`)
    .join("\n");
}
