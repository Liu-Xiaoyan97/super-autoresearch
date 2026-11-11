/**
 * Tunable knobs of the RSI loop.
 *
 * Values marked [PAPER] are taken from the ScientistTwo paper (section noted);
 * [CHOICE] values are documented defaults of this port. The Python reference
 * config is the source of truth (legacy/python/src/scientisttwo/config.py).
 */

export interface ModelRoute {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export type RunnerKind = "simulated" | "subprocess";
export type EngineeringBudgetScope = "per_idea" | "per_stage";

export interface Config {
  runId: string;
  outDir: string;
  seed: number;
  runner: RunnerKind;
  failFast: boolean;

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
  engineeringBudgetScope: EngineeringBudgetScope;
  subsetFraction: number;
  subsetMargin: number; // [CHOICE] 2% relative

  // §3.3 idea refinement
  maxRefineRounds: number; // [PAPER] up to four rounds k>=1
  successTarget: number; // [PAPER]
  nEvolved: number;
  nExplore: number;

  // §3.4 ablations
  nAblationPlans: number; // [INFERENCE]
  maxAblationRounds: number; // [PAPER]

  // §3.5 drafting & review
  reviewThreshold: number; // [PAPER]
  reviewScaleMax: number; // [PAPER]
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
  return {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    temperature: 0.2,
    maxTokens: 8192,
    ...over,
  };
}

/** Appendix A.2: Flash for everything except the coding-heavy roles. */
export function defaultModelRoutes(): Record<string, ModelRoute> {
  const model = process.env.RSI_MODEL || "deepseek-v4.1-flash";
  const coding = process.env.RSI_CODING_MODEL || model;
  return {
    default: modelRoute({ model }),
    coding: modelRoute({ model: coding }),
    ablation: modelRoute({ model: coding }),
    rebuttal: modelRoute({ model: coding }),
    draft_enhancer: modelRoute({ model: coding }),
  };
}

export function defaultConfig(over: Partial<Config> = {}): Config {
  const base: Config = {
    runId: "run",
    outDir: "runs",
    seed: 7,
    runner: "simulated",
    failFast: false,

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
    engineeringBudgetScope: "per_idea",
    subsetFraction: 0.25,
    subsetMargin: 0.02,

    maxRefineRounds: 4,
    successTarget: 4,
    nEvolved: 1,
    nExplore: 1,

    nAblationPlans: 5,
    maxAblationRounds: 1,

    reviewThreshold: 8,
    reviewScaleMax: 10,
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
