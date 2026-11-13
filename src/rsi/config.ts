/**
 * Tunable knobs of the RSI loop.
 *
 * Values marked [PAPER] are taken from the ScientistTwo paper (section noted);
 * [CHOICE] values are documented defaults of this port. These values are the
 * source of truth; every one is mirrored into `final.json` provenance.
 */

export interface ModelRoute {
  /** Unset fields inherit the injected provider's native/session configuration. */
  provider?: string;
  model?: string;
  temperature?: number;
  /** Explicit output limit; unset delegates to the provider's native policy. */
  maxTokens?: number;
}

export type RunnerKind = "simulated" | "subprocess";
export type EngineeringBudgetScope = "per_idea" | "per_stage";

export interface Config {
  runId: string;
  outDir: string;
  seed: number;
  runner: RunnerKind;
  /** Fresh-evidence flows (adapter smoke, dry runs) must never replay a measurement. */
  disableMeasurementCache?: boolean;
  failFast: boolean;
  /** depth = one measured defect at a time; breadth = the original seed search. */
  searchPolicy: "depth" | "breadth";

  // §3.1 idea generation
  nSeed: number; // [CHOICE] N_seed
  maxLimitationRounds: number; // [PAPER] A.2
  noveltyRefs: number; // [PAPER] A.2
  minNovelty: number; // [PAPER] gate exists; threshold [CHOICE]
  minLimitations: number; // [CHOICE]

  // exploration guidance [EXTENSION]
  guidanceWeight: number;
  minDomainFit: number;
  strictDirections: boolean;
  guidanceInEvolution: boolean;

  // §3.2 idea evaluation
  n0: number; // [CHOICE] top-N0 seeds
  maxEngRounds: number; // [PAPER] at most two rounds
  /** Code/interface repairs after an invalid run; these do not consume an engineering round. */
  maxRepairs: number; // [CHOICE] bounded repair budget
  engineeringBudgetScope: EngineeringBudgetScope;
  subsetFraction: number;
  /** Hard cap on subset training steps; the screen uses min(fraction*full, this). */
  subsetMaxSteps: number;
  /** Independent seeds per subset screen; a candidate is bad only if all are worse. */
  subsetSeeds: number;
  subsetMargin: number; // [CHOICE] 2% relative

  // §3.3 idea refinement
  maxIdeaRetries: number; // an exhausted idea pool seeds a new round up to this count
  maxPaperRetries: number; // an unaccepted paper loop re-drafts up to this count
  maxRefineRounds: number; // [PAPER] up to four rounds k>=1
  successTarget: number; // [PAPER]
  /** Minimum independent full-set winners, across at least two rounds, before writing starts. */
  minGoodTraces: number; // [CHOICE] multi-round data gate
  nEvolved: number;
  nExplore: number;

  // §3.4 ablations
  nAblationPlans: number; // [INFERENCE]
  maxAblationRounds: number; // [PAPER]

  // §3.5 drafting & review
  reviewThreshold: number; // [PAPER]
  reviewScaleMax: number; // [PAPER]
  /** Independent reviewers per paper round; every score must reach the threshold. */
  reviewPanelSize: number; // [CHOICE] all-reviewer gate
  maxPeerRounds: number; // [PAPER]
  maxReviewRefinements: number; // [PAPER]
  venueFormat: string;
  requiredSections: string[];

  // §3.6 meta-review
  maxMetaRounds: number; // [CHOICE] N_meta

  // models & budget
  modelRoutes: Record<string, ModelRoute>;
  maxLlmCalls: number;
  maxExperiments: number;
  maxWallTimeS: number;
}

export function modelRoute(over: Partial<ModelRoute> = {}): ModelRoute {
  if (over.maxTokens !== undefined && (!Number.isSafeInteger(over.maxTokens) || over.maxTokens <= 0)) {
    throw new RangeError("maxTokens must be a positive safe integer when specified");
  }
  return { ...over };
}

/** Inherit Pi's selected model unless the user explicitly configures an RSI route. */
export function defaultModelRoutes(): Record<string, ModelRoute> {
  const model = process.env.RSI_MODEL || undefined;
  const coding = process.env.RSI_CODING_MODEL || model;
  return {
    default: modelRoute(model ? { model } : {}),
    coding: modelRoute(coding ? { model: coding } : {}),
    ablation: modelRoute(coding ? { model: coding } : {}),
    rebuttal: modelRoute(coding ? { model: coding } : {}),
    draft_enhancer: modelRoute(coding ? { model: coding } : {}),
  };
}

export function defaultConfig(over: Partial<Config> = {}): Config {
  const base: Config = {
    runId: "run",
    outDir: "runs",
    seed: 7,
    runner: "simulated",
    failFast: false,
    searchPolicy: "depth",

    nSeed: 8,
    maxLimitationRounds: 16,
    noveltyRefs: 2,
    minNovelty: 0.35,
    minLimitations: 3,

    guidanceWeight: 0.5,
    minDomainFit: 0.3,
    strictDirections: false,
    guidanceInEvolution: true,

    n0: 2,
    maxEngRounds: 2,
    maxRepairs: 2,
    engineeringBudgetScope: "per_idea",
    subsetFraction: 0.1,
    subsetMaxSteps: 200,
    subsetSeeds: 3,
    subsetMargin: 0.02,

    maxIdeaRetries: 2,
    maxPaperRetries: 1,
    maxRefineRounds: 4,
    successTarget: 4,
    minGoodTraces: 2,
    nEvolved: 1,
    nExplore: 1,

    nAblationPlans: 5,
    maxAblationRounds: 1,

    reviewThreshold: 8,
    reviewScaleMax: 10,
    reviewPanelSize: 3,
    maxPeerRounds: 2,
    maxReviewRefinements: 1,
    venueFormat: "iclr2025",
    requiredSections: [
      "abstract",
      "introduction",
      "related_work",
      "method",
      "experiments",
      "ablation",
      "conclusion",
    ],

    maxMetaRounds: 2,

    modelRoutes: defaultModelRoutes(),
    maxLlmCalls: 2000,
    maxExperiments: 200,
    maxWallTimeS: 3600,
  };
  return { ...base, ...over, modelRoutes: over.modelRoutes ?? base.modelRoutes };
}

export function routeFor(config: Config, role: string): ModelRoute {
  return config.modelRoutes[role] || config.modelRoutes.default;
}
