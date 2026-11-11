/**
 * Superagent protocol — policy and gate.
 *
 * The policy is the versioned answer to two questions: who may originate work
 * in a Source (`gate`), and what the SOP may do on its own inside an accepted
 * run (`mayRun`). The prototype's accept modes carry over unchanged:
 *
 *   off      nothing inferred starts work; explicit requests still do
 *   observe  inferred candidates are assessed, a positive one is recorded as
 *            "would accept" and nothing happens (the default)
 *   auto     a positive assessment of an inferred candidate accepts it
 *
 * A rule's level says who must be behind a step:
 *
 *   auto      the SOP, inside any accepted run
 *   explicit  only when a person explicitly asked for this run
 *   observe   recorded as "would do" unless a person explicitly asked
 *   person    never without a fresh human answer; the run opens an Attention
 *
 * The numeric gates of the paper are outside the policy on purpose. A mandate
 * can allow spending or exporting; it can never make a candidate better than
 * the reproduced baseline.
 */

import { canonical, stableString } from "../json.ts";
import type { AcceptMode, Mandate, PolicySettings, Rule, RuleLevel, SourcePolicy, Strength, Thread, Ticket, Trigger } from "./model.ts";
import { SOP_RULES } from "./sop.ts";

export type GateResult =
  | { admissible: false; reason: string }
  | { admissible: true; strength: Strength; basis: "explicit" | "inferred" | "resume" };

/** What a rule lets the SOP do, given the mandate of the work. */
export type RuleVerdict = "run" | "observe" | "attention" | "refused";

const DEFAULT_LIMITS: PolicySettings["limits"] = { evalTimeoutMs: 120_000, maxAttempts: 3, maxWallTimeS: 3600 };

const DEFAULT_SOURCES: Record<string, SourcePolicy> = {
  human: { enabled: true, allowed: ["*"], bots: [], observed: true },
  cli: { enabled: true, allowed: ["*"], bots: [], observed: true },
  schedule: { enabled: true, allowed: [], bots: ["cron"], observed: true },
  experiment: { enabled: true, allowed: [], bots: ["benchmark"], observed: true },
  review: { enabled: true, allowed: [], bots: ["reviewer"], observed: true },
  system: { enabled: true, allowed: [], bots: ["system"], observed: true },
};

/** A stable version for one combination of rules, modes and Source parts. */
export function policyVersion(settings: Omit<PolicySettings, "version"> | PolicySettings): string {
  const material = {
    acceptMode: settings.acceptMode,
    rules: (settings.rules ?? []).map((rule) => ({ id: rule.id, level: rule.level, enabled: rule.enabled })),
    sources: settings.sources ?? {},
    limits: settings.limits ?? DEFAULT_LIMITS,
  };
  let hash = 0x811c9dc5;
  const text = stableString(canonical(material));
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `p${(hash >>> 0).toString(36)}`;
}

export function defaultPolicySettings(over: Partial<PolicySettings> = {}): PolicySettings {
  const base: PolicySettings = {
    version: "",
    paused: false,
    acceptMode: "observe",
    rules: SOP_RULES.map((rule) => ({ ...rule })),
    sources: structuredClone(DEFAULT_SOURCES),
    limits: { ...DEFAULT_LIMITS },
    ...over,
  };
  if (over.rules) base.rules = over.rules.map((rule) => ({ ...rule }));
  if (over.sources) base.sources = structuredClone(over.sources);
  if (over.limits) base.limits = { ...DEFAULT_LIMITS, ...over.limits };
  base.version = over.version || policyVersion(base);
  return base;
}

export interface Policy {
  settings(): PolicySettings;
  version(): string;
  paused(): boolean;
  acceptMode(): AcceptMode;
  rules(): Rule[];
  rule(id: string): Rule | undefined;
  source(id: string): SourcePolicy | undefined;
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult;
  revalidate(mandate: Mandate): boolean;
  admitsInferred(rules: readonly string[]): boolean;
  /** What a stage or step rule allows under `mandate`. */
  mayRun(ruleId: string, mandate: Mandate): RuleVerdict;
  withMode(mode: AcceptMode): PolicySettings;
  withPaused(paused: boolean): PolicySettings;
}

class RsiPolicy implements Policy {
  private readonly data: PolicySettings;

  constructor(data: PolicySettings) {
    this.data = data;
  }

  settings(): PolicySettings {
    return structuredClone(this.data);
  }

  version(): string {
    return this.data.version;
  }

  paused(): boolean {
    return this.data.paused;
  }

  acceptMode(): AcceptMode {
    return this.data.acceptMode;
  }

  rules(): Rule[] {
    return this.data.rules.map((rule) => ({ ...rule }));
  }

  rule(id: string): Rule | undefined {
    return this.data.rules.find((rule) => rule.id === id);
  }

  source(id: string): SourcePolicy | undefined {
    return this.data.sources[id];
  }

  private allowed(source: SourcePolicy | undefined, actor: string | undefined): boolean {
    if (!source) return false;
    if (source.allowed.includes("*")) return true;
    return !!actor && source.allowed.includes(actor);
  }

  private bot(source: SourcePolicy | undefined, actor: string | undefined): boolean {
    return !!source && !!actor && source.bots.includes(actor);
  }

  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult {
    if (this.data.paused) return { admissible: false, reason: "paused" };
    const source = this.source(trigger.source);
    if (!source?.enabled) return { admissible: false, reason: `source ${trigger.source} is off` };
    const live = tickets.filter((ticket) => ticket.ended === undefined);
    const followUp = trigger.human && trigger.threads.some((ref) => thread.key === `${ref.source}:${ref.id}`) && live.length > 0;
    if (trigger.human) {
      if (!this.allowed(source, trigger.actor)) return { admissible: false, reason: `actor ${trigger.actor ?? "?"} is not allowed in ${trigger.source}` };
      if (trigger.addressed) return { admissible: true, strength: "explicit", basis: "explicit" };
      if (followUp) return { admissible: true, strength: "explicit", basis: "resume" };
      if (!source.observed) return { admissible: false, reason: `source ${trigger.source} receives only addressed messages` };
      if (this.data.acceptMode === "off") return { admissible: false, reason: "acceptMode off admits no inferred work" };
      return { admissible: true, strength: "inferred", basis: "inferred" };
    }
    // Automated triggers are observations. They may continue subscribed work,
    // and they may become inferred candidates only from a listed bot.
    if (!this.bot(source, trigger.actor)) return { admissible: false, reason: `actor ${trigger.actor ?? "?"} is not a listed bot` };
    if (this.data.acceptMode === "off") return { admissible: false, reason: "acceptMode off admits no inferred work" };
    return { admissible: true, strength: "inferred", basis: "inferred" };
  }

  revalidate(mandate: Mandate): boolean {
    if (mandate.basis === "explicit" || mandate.basis === "resume" || mandate.basis === "run") return true;
    if (this.data.acceptMode !== "auto") return false;
    return mandate.rules.every((rule) => this.rule(rule)?.enabled === true);
  }

  admitsInferred(rules: readonly string[]): boolean {
    if (this.data.acceptMode !== "auto") return false;
    return rules.every((rule) => this.rule(rule)?.enabled === true);
  }

  mayRun(ruleId: string, mandate: Mandate): RuleVerdict {
    const rule = this.rule(ruleId);
    if (!rule?.enabled) return "refused";
    const level: RuleLevel = rule.level;
    if (level === "auto") return "run";
    if (level === "explicit") return mandate.strength === "explicit" ? "run" : "attention";
    if (level === "observe") return mandate.strength === "explicit" ? "run" : "observe";
    return "attention";
  }

  withMode(mode: AcceptMode): PolicySettings {
    return defaultPolicySettings({ ...this.data, acceptMode: mode });
  }

  withPaused(paused: boolean): PolicySettings {
    return defaultPolicySettings({ ...this.data, paused });
  }
}

/** Highest-permission profile: accept inferred work, every SOP rule auto. */
export function permissivePolicySettings(
  settings: PolicySettings = defaultPolicySettings(),
): PolicySettings {
  return defaultPolicySettings({
    ...settings,
    paused: false,
    acceptMode: "auto",
    rules: settings.rules.map((rule) => ({ ...rule, level: "auto", enabled: true })),
    sources: Object.fromEntries(
      Object.entries(settings.sources).map(([name, source]) => [
        name,
        { ...source, enabled: true, observed: true },
      ]),
    ),
  });
}

export function makePolicy(settings: PolicySettings = defaultPolicySettings()): Policy {
  return new RsiPolicy(settings.version ? settings : defaultPolicySettings(settings));
}
