/** Durable request/result envelope for the secret-free check worker. */
import type { RepoRef } from "../types.ts";
import type { CheckReport, LanguageSpec } from "./checks.ts";
import type { LspSpec } from "./lsp.ts";

export interface CheckJobRequest {
  id: string;
  /** Run root; the worker may write only inside it. */
  root: string;
  repo: RepoRef;
  label: string;
  specs: Record<string, LanguageSpec>;
  languages: string[];
  changedFiles: string[];
  lsp: Record<string, LspSpec>;
  /** Hard upper bound for the whole job. */
  timeoutMs: number;
}

export interface CheckJobResult {
  report?: CheckReport;
  error?: string;
}

export interface CheckWorkerReady {
  pid: number;
  host: string;
  started_at: string;
}
