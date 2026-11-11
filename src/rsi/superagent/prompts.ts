/**
 * Superagent protocol — prompts.
 *
 * The foreground agent reads `orchestrator`, `dispatch` and `replies`; a worker
 * reads the task's own system prompt plus `worker`. `policy` and `environment`
 * are generated from state on every request, so a policy change never rewrites
 * the text above it (the prototype's assembly order, docs/004-prompts.md).
 *
 * Every part lives in `prompts/superagent/<part>.md`; there is no second copy in
 * code. A missing file is a packaging error and throws, because an empty prompt
 * would silently weaken a worker's contract.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PolicySettings, RunSpec, Ticket } from "./model.ts";
import { sopTable } from "./sop.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(HERE, "../../../prompts/superagent");

/** One prompt part; the markdown file is the only source of truth. */
export function promptPart(name: string): string {
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(
      `missing prompt part "${name}": expected ${file}. Every prompt part ships under prompts/superagent/.`,
    );
  }
  if (!text) throw new Error(`empty prompt part "${name}": ${file}`);
  return text;
}

const RULE_LEVELS: Record<string, string> = {
  auto: "the SOP may do it inside an accepted run",
  explicit: "needs a person's explicit request for the run",
  observe: "recorded only unless a person asks for it",
  person: "needs a fresh answer from a person",
};

/** The generated policy section, last in the prompt so a change rewrites only this. */
export function policySection(settings: PolicySettings): string {
  const template = promptPart("policy");
  const rules = settings.rules
    .filter((rule) => rule.enabled)
    .map((rule) => `- ${rule.name} (${rule.id}): ${rule.instruction} [${RULE_LEVELS[rule.level] ?? rule.level}]`)
    .join("\n");
  return template
    .replaceAll("{version}", settings.version)
    .replaceAll("{mode}", settings.acceptMode)
    .replaceAll(
      "{explicit}",
      "A person's explicit request is accepted in every mode; proactive observations never are, outside auto.",
    )
    .replaceAll("{rules}", rules || "No rule is enabled.");
}

export function environmentSection(vars: Record<string, string>): string {
  const template = promptPart("environment");
  const lines = Object.entries(vars)
    .map(([name, value]) => `- ${name}=${value}`)
    .join("\n");
  return template.replaceAll("{variables}", lines || "No variable.");
}

/** A worker's system prompt: the task's own text, plus the report contract. */
export function workerSystem(payload: { task: string; system: string }): string {
  const worker = promptPart("worker");
  return [payload.system.trim(), worker].filter(Boolean).join("\n\n");
}

/** A concise SOP overview for the foreground agent and for run cards. */
export function sopOverview(): string {
  return ["SOP stages (paper section | stage | rule | tasks):", "|---|---|---|---|", sopTable()].join("\n");
}

export function dispatchEnvironment(spec: RunSpec, ticket: Ticket): Record<string, string> {
  return {
    RSI_RUN_ID: ticket.runId ?? "",
    RSI_RUN_DIR: spec.root,
    RSI_TICKET_ID: ticket.id,
    RSI_STAGE: ticket.stage,
    RSI_EXECUTOR: ticket.kind,
    RSI_MODE: spec.mode,
    RSI_AGENTS: spec.agents,
    RSI_RUNNER: spec.runner,
  };
}

/** The foreground agent's standing briefing, used by tool guidance and the skill. */
export function orchestratorBriefing(): string {
  return [promptPart("orchestrator"), promptPart("dispatch"), promptPart("replies")].join("\n\n");
}
