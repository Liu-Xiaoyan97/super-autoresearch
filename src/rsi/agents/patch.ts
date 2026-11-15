/** Ask a coding agent for a git-applicable diff, retrying prose once. */

import { extractUnifiedDiff } from "../runtime/workspace.ts";
import type { StructuredSpec } from "../providers/base.ts";
import type { AskOptions, BaseAgent } from "./base.ts";

/** Preserve every input character across bounded review requests. */
export function reviewChunks(text: string, limit = 16000): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("review chunk limit must be positive");
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += limit) chunks.push(text.slice(offset, offset + limit));
  return chunks.length ? chunks : [""];
}

export async function askUnifiedDiff<T extends { patch: string }>(
  agent: BaseAgent,
  spec: StructuredSpec<T>,
  opts: AskOptions & { allowEmpty?: boolean },
): Promise<T> {
  const first = await agent.ask(spec, opts);
  if (extractUnifiedDiff(first.patch) || opts.allowEmpty && !first.patch.trim()) return first;
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
