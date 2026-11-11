/** Hard budget accounting: every agent call and every experiment is charged. */

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

export interface BudgetSnapshot {
  llm_calls: number;
  experiments: number;
  elapsed_s: number;
  limits: {
    max_llm_calls: number;
    max_experiments: number;
    max_wall_time_s: number;
  };
}

export class Budget {
  maxLlmCalls: number;
  maxExperiments: number;
  maxWallTimeS: number;
  llmCalls = 0;
  experiments = 0;
  started = Date.now();

  constructor(opts: { maxLlmCalls?: number; maxExperiments?: number; maxWallTimeS?: number } = {}) {
    this.maxLlmCalls = opts.maxLlmCalls ?? 10_000;
    this.maxExperiments = opts.maxExperiments ?? 10_000;
    this.maxWallTimeS = opts.maxWallTimeS ?? 86_400;
  }

  chargeLlm(n = 1): void {
    this.llmCalls += n;
    this.check();
  }

  chargeExperiment(n = 1): void {
    this.experiments += n;
    this.check();
  }

  get elapsed(): number {
    return (Date.now() - this.started) / 1000;
  }

  exhausted(): string | null {
    if (this.llmCalls >= this.maxLlmCalls) return `max_llm_calls=${this.maxLlmCalls}`;
    if (this.experiments >= this.maxExperiments) return `max_experiments=${this.maxExperiments}`;
    if (this.elapsed >= this.maxWallTimeS) return `max_wall_time_s=${this.maxWallTimeS}`;
    return null;
  }

  check(): void {
    const reason = this.exhausted();
    if (reason) throw new BudgetExceeded(reason);
  }

  snapshot(): BudgetSnapshot {
    return {
      llm_calls: this.llmCalls,
      experiments: this.experiments,
      elapsed_s: Math.round(this.elapsed * 1000) / 1000,
      limits: {
        max_llm_calls: this.maxLlmCalls,
        max_experiments: this.maxExperiments,
        max_wall_time_s: this.maxWallTimeS,
      },
    };
  }
}
