/**
 * Superagent protocol — foreground tools.
 *
 * One tool, `rsi_superagent`, with an action. The prototype gives the main
 * Session a handful of narrowly named tools; RSI has one agent and one run, so
 * one action enum is the smaller surface and the easier briefing.
 *
 * Nothing here executes research. The tool reads protocol state, records a
 * person's decision, and dispatches (`rsi_research` does the dispatch).
 */

import type { PolicySettings, Ticket } from "./model.ts";
import { latestAssignment, latestReport, ticketStage } from "./model.ts";
import type { RunStatus, SuperagentRuntime } from "./runtime.ts";
import { ticketCard } from "./runtime.ts";
import { policySection } from "./prompts.ts";
import { permissivePolicySettings } from "./policy.ts";

export interface SuperagentHost {
  runtime(): SuperagentRuntime;
  policy(): PolicySettings;
  /** Applies a policy change and returns the live runs it reached. */
  applyPolicy(settings: PolicySettings): string[];
}

export const SUPERAGENT_ACTIONS = [
  "status",
  "resume",
  "tickets",
  "ticket",
  "events",
  "policy",
  "answer",
  "note",
  "retry",
  "stop",
  "attach",
] as const;

export type SuperagentAction = (typeof SUPERAGENT_ACTIONS)[number];

export const SUPERAGENT_PARAMS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...SUPERAGENT_ACTIONS],
      description:
        "status = runs or one run; resume = start a new attempt from an aborted/failed run; tickets = task tickets of a run; ticket = one ticket with its reports; " +
        "events = domain events; policy = read or set accept mode/pause; answer = answer an open question; " +
        "note = fact for a ticket (no authority); retry = retry a failed or blocked ticket; stop = a person's stop; " +
        "attach = subscribe a ticket to an already recorded trigger.",
    },
    run_id: { type: "string", description: "Run directory name, e.g. ood-frozen-encoder-s7. Required except for status/policy." },
    ticket_id: { type: "string", description: "Ticket id, for ticket/answer/note/retry/stop/attach." },
    trigger_id: { type: "string", description: "Trigger id, for attach." },
    text: { type: "string", description: "The answer or the note." },
    reason: { type: "string", description: "With stop: why the run stops." },
    limit: { type: "number", description: "events: how many events to return (default 40)." },
    mode: {
      type: "string",
      enum: ["off", "observe", "auto"],
      description: "policy: the accept mode. observe records proactive work instead of doing it; auto accepts it.",
    },
    paused: { type: "boolean", description: "policy: pause or resume dispatch, evaluations and replies." },
    show_rules: { type: "boolean", description: "policy: include the generated policy section." },
    allow: {
      type: "boolean",
      description:
        "policy: grant the highest permission profile (accept auto; every SOP rule auto, including experiments).",
    },
  },
  required: ["action"],
};

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function text(value: string, details: Record<string, unknown> = {}, isError = false): ToolResponse {
  return { content: [{ type: "text", text: value }], details, ...(isError ? { isError } : {}) };
}

export function formatStatus(status: RunStatus): string {
  const progress = status.progress ? `\nprogress: ${status.progress.state} — ${status.progress.summary}` : "";
  const attention = status.attention ? `\nNEEDS A PERSON: ${status.attention}` : "";
  const ended = status.ended ? `\nended: ${status.ended.outcome}${status.ended.reason ? ` (${status.ended.reason})` : ""}` : "";
  const stages = status.stages.length
    ? status.stages.map((stage) => `  ${stage.section} ${stage.title}: ${stage.state} (${stage.done}/${stage.tasks} tasks done)`).join("\n")
    : "  no stage has run yet";
  const ticketLines = status.tickets.length
    ? [
        `tickets (${status.tickets.length}):`,
        ...status.tickets.slice(0, 30).map((ticket) => {
          const id = String(ticket.id ?? "?");
          const state = String(ticket.state ?? "?");
          const stage = String(ticket.stage ?? "");
          const task = ticket.task ? ` · ${String(ticket.task)}` : "";
          return `  ${id.padEnd(14)} ${state.padEnd(12)} ${stage}${task}`;
        }),
        ...(status.tickets.length > 30 ? [`  ... ${status.tickets.length - 30} more; /rsi tickets ${status.run_id}`] : []),
      ]
    : [];
  return [
    `run ${status.run_id}: ${status.state}${status.mode ? ` · ${status.mode}` : ""}${status.runner ? `/${status.runner}` : ""}`,
    `root: ${status.root}`,
    ...(status.resumed_from ? [`resumed from: ${status.resumed_from}`] : []),
    ...(status.run_ticket_id ? [`run ticket: ${status.run_ticket_id}`] : []),
    stages,
    ...ticketLines,
    `policy: ${status.policy.mode}${status.policy.paused ? " (paused)" : ""} · ${status.policy.version}`,
  ].join("\n") + progress + attention + ended;
}

export function formatRuns(runs: Array<{ run_id: string; title: string; state: string; root: string }>): string {
  if (!runs.length) return "no RSI runs under runs/";
  return runs.map((run) => `${run.run_id}  ${run.state.padEnd(14)}  ${run.title}`).join("\n");
}

export function formatTicket(ticket: Ticket): string {
  const card = ticketCard(ticket);
  const report = latestReport(ticket);
  const assignment = latestAssignment(ticket);
  const lines = [
    `${ticket.id}  ${ticket.stage}${ticket.task ? ` · ${ticket.task}` : ""}  [${ticketStage(ticket)}]`,
    `title: ${ticket.title}`,
    `mandate: ${ticket.mandate.strength}/${ticket.mandate.basis} · ${ticket.mandate.rules.join(", ")}`,
    `assignment: ${assignment ? `${assignment.state} (attempt ${assignment.attempts})` : "none"}`,
  ];
  if (report) lines.push(`report: ${report.state} — ${report.summary}`);
  if (card.attention) lines.push(`question: ${String(card.attention)}`);
  if (ticket.ended) lines.push(`ended: ${ticket.ended.outcome} by ${ticket.ended.by}${ticket.ended.reason ? ` — ${ticket.ended.reason}` : ""}`);
  return lines.join("\n");
}

export async function superagentAction(host: SuperagentHost, params: Record<string, unknown>): Promise<ToolResponse> {
  const action = String(params.action ?? "");
  const runtime = host.runtime();
  const runId = typeof params.run_id === "string" ? params.run_id : "";
  const ticketId = typeof params.ticket_id === "string" ? params.ticket_id : "";
  const needRun = (): string => {
    if (!runId) throw new Error(`${action} needs run_id`);
    return runId;
  };
  const needTicket = (): [string, string] => {
    if (!ticketId) throw new Error(`${action} needs ticket_id`);
    return [needRun(), ticketId];
  };

  try {
    switch (action) {
      case "status": {
        if (!runId) {
          const runs = runtime.list();
          return text(formatRuns(runs), { runs }, false);
        }
        const status = runtime.status(runId);
        if (!status) return text(`no run ${runId}`, { run_id: runId }, true);
        return text(formatStatus(status), { status });
      }
      case "resume": {
        const parent = needRun();
        const session = runtime.resume(parent);
        return text(
          `resumed ${parent} as ${session.runId} (run ticket ${session.ticketId}, parent ${parent})`,
          { run_id: session.runId, parent_run_id: parent, ticket_id: session.ticketId },
        );
      }
      case "tickets": {
        const status = runtime.status(needRun());
        if (!status) return text(`no run ${runId}`, { run_id: runId }, true);
        const lines = status.tickets.map((ticket) =>
          `${String(ticket.id).padEnd(14)} ${String(ticket.state).padEnd(14)} ${String(ticket.stage).padEnd(10)} ${String(ticket.task ?? "")}  ${String((ticket.report as { summary?: string } | null)?.summary ?? "")}`.slice(0, 240),
        );
        return text(lines.length ? lines.join("\n") : "this run has no task tickets yet", { run_id: runId, tickets: status.tickets });
      }
      case "ticket": {
        const [run, ticket] = needTicket();
        const found = runtime.ticket(run, ticket);
        if (!found) return text(`no ticket ${ticket} in ${run}`, { run_id: run, ticket_id: ticket }, true);
        return text(formatTicket(found), { run_id: run, ticket: ticketCard(found), reports: found.reports.slice(-5) });
      }
      case "events": {
        const events = runtime.events(needRun(), typeof params.limit === "number" ? params.limit : 40);
        const lines = events.map((event) => {
          const record = event as { type?: string; at?: string; data?: Record<string, unknown> };
          return `${record.at ?? ""} ${record.type ?? ""} ${JSON.stringify(record.data ?? {})}`.trim();
        });
        return text(lines.join("\n") || "no events recorded", { run_id: runId, events });
      }
      case "policy": {
        let settings = host.policy();
        if (params.allow === true) {
          settings = permissivePolicySettings(settings);
          const applied = host.applyPolicy(settings);
          settings = host.policy();
          return text(
            `policy ${settings.version}: highest permission (auto, all SOP rules auto) (live runs: ${applied.length})`,
            { policy: settings, applied },
          );
        }
        if (params.mode !== undefined || params.paused !== undefined) {
          settings = {
            ...settings,
            acceptMode: (params.mode as PolicySettings["acceptMode"]) ?? settings.acceptMode,
            paused: typeof params.paused === "boolean" ? params.paused : settings.paused,
          };
          settings.version = "";
          const applied = host.applyPolicy(settings);
          settings = host.policy();
          const mode = params.mode ? `accept mode ${settings.acceptMode}` : "";
          const paused = typeof params.paused === "boolean" ? (settings.paused ? "paused" : "resumed") : "";
          return text(`policy ${settings.version}: ${[mode, paused].filter(Boolean).join(", ") || "unchanged"} (live runs: ${applied.length})`, { policy: settings, applied });
        }
        const body = `policy ${settings.version} · mode ${settings.acceptMode}${settings.paused ? " · paused" : ""}`;
        const section = params.show_rules ? `\n\n${policySection(settings)}` : "";
        return text(body + section, { policy: settings });
      }
      case "answer": {
        const [run, ticket] = needTicket();
        if (typeof params.text !== "string" || !params.text.trim()) throw new Error("answer needs text");
        const updated = runtime.answer(run, ticket, params.text);
        return text(`answered ${ticket}: ${ticketStage(updated)}`, { run_id: run, ticket: ticketCard(updated) });
      }
      case "note": {
        const [run, ticket] = needTicket();
        if (typeof params.text !== "string" || !params.text.trim()) throw new Error("note needs text");
        const updated = runtime.note(run, ticket, params.text);
        return text(`noted for ${ticket}`, { run_id: run, ticket: ticketCard(updated) });
      }
      case "retry": {
        const [run, ticket] = needTicket();
        const updated = runtime.retry(run, ticket);
        return text(`retried ${ticket}: ${ticketStage(updated)}`, { run_id: run, ticket: ticketCard(updated) });
      }
      case "stop": {
        const [run, ticket] = needTicket();
        const updated = runtime.stop(run, ticket, typeof params.reason === "string" ? params.reason : undefined);
        return text(`stopped ${ticket}`, { run_id: run, ticket: ticketCard(updated) });
      }
      case "attach": {
        const [run, ticket] = needTicket();
        const triggerId = String(params.trigger_id ?? "");
        if (!triggerId) throw new Error("attach needs trigger_id");
        const updated = runtime.attach(run, ticket, triggerId, typeof params.text === "string" ? params.text : undefined);
        return text(`attached ${triggerId} to ${ticket}`, { run_id: run, ticket: ticketCard(updated) });
      }
      default:
        return text(`unknown action ${action}; one of ${SUPERAGENT_ACTIONS.join(", ")}`, { action }, true);
    }
  } catch (error) {
    return text((error as Error).message, { action }, true);
  }
}
