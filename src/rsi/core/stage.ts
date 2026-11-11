/**
 * Listing 1 — the single control primitive of the system:
 *
 *   def stage(candidate, critic, refine, max_rounds):
 *       for _ in range(max_rounds):
 *           verdict, feedback = critic(candidate)
 *           if verdict == "accept": return candidate
 *           elif verdict == "refine": candidate = refine(candidate, feedback)
 *           else: return None
 *       return None
 */

import type { Verdict } from "../types.ts";

export interface StageResult<T> {
  value: T | null;
  verdict: Verdict | null;
  rounds: number;
  history: Verdict[];
  accepted: boolean;
}

/**
 * Generic critic/refine loop (paper Listing 1).
 *
 * GOOD/ACCEPT returns the candidate; REFINE/ENGINEER refines and loops; BAD
 * returns an empty result; exhausting max_rounds returns an empty result.
 * Allocation-cheap, side-effect free, logs nothing (callers own tracing).
 */
export async function stage<T>(
  candidate: T,
  critic: (value: T) => Promise<Verdict>,
  refine: (value: T, feedback: string) => Promise<T>,
  maxRounds: number,
): Promise<StageResult<T>> {
  const history: Verdict[] = [];
  for (let i = 0; i < maxRounds; i++) {
    const verdict = await critic(candidate);
    history.push(verdict);
    if (verdict.decision === "good" || verdict.decision === "accept") {
      return { value: candidate, verdict, rounds: history.length, history, accepted: true };
    }
    if (verdict.decision === "refine" || verdict.decision === "engineer") {
      candidate = await refine(candidate, verdict.feedback);
    } else {
      return { value: null, verdict, rounds: history.length, history, accepted: false };
    }
  }
  return {
    value: null,
    verdict: history.length ? history[history.length - 1] : null,
    rounds: history.length,
    history,
    accepted: false,
  };
}
