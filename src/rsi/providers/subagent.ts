/**
 * Compatibility shim.
 *
 * The bare subagent provider has been replaced by the superagent protocol: a
 * subagent is now a task Ticket executed by a `PiWorker`, and it reports a
 * structured envelope instead of free text. New code uses
 * `SuperagentLLMProvider` with `PiWorker` (see `./superagent.ts`); this module
 * keeps the old import path and option names working for one release.
 *
 * @deprecated Use `SuperagentLLMProvider` + `PiWorker` and pass the run engine.
 */

import { PiWorker, type PiWorkerOptions } from "./superagent.ts";
import type { TaskWorker } from "../superagent/executor.ts";
import type { Ticket } from "../superagent/model.ts";

export type SubagentProviderOptions = PiWorkerOptions;

/**
 * The old class shape, kept as a worker. It cannot answer a `complete()` call
 * without an engine anymore, so it throws with the migration instruction.
 */
export class PiSubagentProvider extends PiWorker {
  constructor(opts: SubagentProviderOptions) {
    super(opts);
  }

  run(_ticket: Ticket, _signal: AbortSignal): Promise<never> {
    return Promise.reject(
      new Error(
        "PiSubagentProvider is now PiWorker: construct SuperagentLLMProvider with { engine, runTicketId, worker: new PiWorker(...) }.",
      ),
    );
  }
}

export type { PiWorkerOptions, TaskWorker };
