/** Ask a coding agent for a git-applicable diff, retrying prose once. */

import { extractUnifiedDiff } from "../runtime/workspace.ts";
import type { StructuredSpec } from "../providers/base.ts";
import type { AskOptions, BaseAgent } from "./base.ts";

export async function askUnifiedDiff<T extends { patch: string }>(
  agent: BaseAgent,
  spec: StructuredSpec<T>,
  opts: AskOptions,
): Promise<T> {
  const first = await agent.ask(spec, opts);
  if (extractUnifiedDiff(first.patch)) return first;
  const retry = await agent.ask(spec, {
    ...opts,
    system:
      "You are a coding agent. Output ONLY a git-applicable unified diff. " +
      "Use --- a/path, +++ b/path and @@ hunks. No prose, no markdown fences.",
    user:
      `${opts.user ?? ""}\n\nYour previous answer was not a unified diff:\n` +
      `${first.patch.slice(0, 4000)}\n\n` +
      "Convert it into a minimal unified diff against the repository snapshot above. " +
      "Return only the diff.",
  });
  return extractUnifiedDiff(retry.patch) ? retry : first;
}
