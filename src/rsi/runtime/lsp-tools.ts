/**
 * Model-facing read-only LSP tools.
 *
 * These tools are bound to one worker directory. They resolve every path
 * inside that directory, never edit files, and never send write-capable LSP
 * requests. Coding output still travels through the patch/check pipeline.
 */
import type { LanguageSpec } from "./checks.ts";
import { LspClient, formatLspValue, type LspSpec } from "./lsp.ts";

export const LSP_TOOL_NAMES = [
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
] as const;

export type LspToolName = typeof LSP_TOOL_NAMES[number];

export interface LspToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export interface LspToolOptions {
  root: string;
  specs: Record<string, LanguageSpec>;
  timeoutMs?: number;
  maxChars?: number;
}

const PATH_PROPERTY = {
  type: "string",
  description: "Path relative to the target repository.",
};

const POSITION_PROPERTIES = {
  path: PATH_PROPERTY,
  line: { type: "number", description: "1-based line number." },
  character: { type: "number", description: "1-based character column." },
};

function positionSchema(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...POSITION_PROPERTIES, ...extra },
    required: ["path", "line", "character"],
  };
}

function normalizeParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? params as Record<string, unknown> : {};
}

function readString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing '${name}'`);
  return value;
}

function readPositive(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error(`'${name}' must be a positive number`);
  }
  return Math.trunc(value);
}

function clientForLanguage(opts: LspToolOptions, clients: Map<string, LspClient>, language: string): LspClient {
  const existing = clients.get(language);
  if (existing) return existing;
  const spec: LspSpec | undefined = opts.specs[language]?.lsp;
  if (!spec?.command.length) throw new Error(`no LSP server is configured for ${language}`);
  const client = new LspClient(opts.root, spec, { timeoutMs: opts.timeoutMs ?? 8000 });
  clients.set(language, client);
  return client;
}

function languageForFile(opts: LspToolOptions, file: string): string {
  for (const [id, spec] of Object.entries(opts.specs)) {
    if (spec.extensions.some((extension) => file.endsWith(extension))) return id;
  }
  throw new Error(`no LSP language is configured for ${file}`);
}

export interface LspToolSet {
  tools: LspToolDefinition[];
  close: () => Promise<void>;
}

/** Build one tool set for one worker session; servers start lazily. */
export function lspTools(opts: LspToolOptions): LspToolSet {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxChars = opts.maxChars ?? 20000;
  const clients = new Map<string, LspClient>();

  const run = async (
    name: LspToolName,
    file: string | null,
    query: () => Promise<unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }> => {
    try {
      const value = await query();
      const text = formatLspValue(opts.root, value, maxChars);
      return {
        content: [{ type: "text", text: text === "null" ? "No result." : text }],
        details: { tool: name, ...(file ? { file } : {}) },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `${name} failed: ${(error as Error).message}` }],
        details: { tool: name, ...(file ? { file } : {}) },
        isError: true,
      };
    }
  };

  const tools: LspToolDefinition[] = [
    {
      name: "lsp_diagnostics",
      label: "LSP Diagnostics",
      description:
        "Read-only: return compiler/linter diagnostics for one file in the target repository. " +
        "The file must be inside the worker's target directory.",
      parameters: { type: "object", properties: { path: PATH_PROPERTY }, required: ["path"] },
      execute: async (_toolCallId, raw) => {
        const params = normalizeParams(raw);
        const path = typeof params.path === "string" ? params.path : null;
        return run("lsp_diagnostics", path, async () => {
          const file = readString(params, "path");
          const client = clientForLanguage(opts, clients, languageForFile(opts, file));
          await client.start();
          return client.diagnostic(file, timeoutMs);
        });
      },
    },
    {
      name: "lsp_definition",
      label: "LSP Definition",
      description:
        "Read-only: find the definition at a 1-based file position in the target repository.",
      parameters: positionSchema(),
      execute: async (_toolCallId, raw) => {
        const params = normalizeParams(raw);
        const path = typeof params.path === "string" ? params.path : null;
        return run("lsp_definition", path, async () => {
          const file = readString(params, "path");
          const line = readPositive(params, "line");
          const character = readPositive(params, "character");
          const client = clientForLanguage(opts, clients, languageForFile(opts, file));
          return client.definition(file, line, character, timeoutMs);
        });
      },
    },
    {
      name: "lsp_references",
      label: "LSP References",
      description:
        "Read-only: find references at a 1-based file position in the target repository.",
      parameters: positionSchema({
        include_declaration: {
          type: "boolean",
          description: "Include the declaration itself; default true.",
        },
      }),
      execute: async (_toolCallId, raw) => {
        const params = normalizeParams(raw);
        const path = typeof params.path === "string" ? params.path : null;
        return run("lsp_references", path, async () => {
          const file = readString(params, "path");
          const line = readPositive(params, "line");
          const character = readPositive(params, "character");
          const client = clientForLanguage(opts, clients, languageForFile(opts, file));
          return client.references(file, line, character, params.include_declaration !== false, timeoutMs);
        });
      },
    },
    {
      name: "lsp_hover",
      label: "LSP Hover",
      description:
        "Read-only: return the type/documentation hover at a 1-based file position.",
      parameters: positionSchema(),
      execute: async (_toolCallId, raw) => {
        const params = normalizeParams(raw);
        const path = typeof params.path === "string" ? params.path : null;
        return run("lsp_hover", path, async () => {
          const file = readString(params, "path");
          const line = readPositive(params, "line");
          const character = readPositive(params, "character");
          const client = clientForLanguage(opts, clients, languageForFile(opts, file));
          return client.hover(file, line, character, timeoutMs);
        });
      },
    },
    {
      name: "lsp_document_symbols",
      label: "LSP Document Symbols",
      description: "Read-only: list symbols declared in one file.",
      parameters: { type: "object", properties: { path: PATH_PROPERTY }, required: ["path"] },
      execute: async (_toolCallId, raw) => {
        const params = normalizeParams(raw);
        const path = typeof params.path === "string" ? params.path : null;
        return run("lsp_document_symbols", path, async () => {
          const file = readString(params, "path");
          const client = clientForLanguage(opts, clients, languageForFile(opts, file));
          return client.documentSymbols(file, timeoutMs);
        });
      },
    },
    {
      name: "lsp_workspace_symbols",
      label: "LSP Workspace Symbols",
      description: "Read-only: search symbols in the target repository by name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name or fragment." },
          language: {
            type: "string",
            description: "Optional language id when the target has more than one LSP server.",
          },
        },
        required: ["query"],
      },
      execute: async (_toolCallId, raw) => {
        const params = normalizeParams(raw);
        return run("lsp_workspace_symbols", null, async () => {
          const query = readString(params, "query");
          const requested = typeof params.language === "string" ? params.language : "";
          const language = requested || Object.entries(opts.specs)
            .find(([, spec]) => spec.lsp?.command.length)?.[0];
          if (!language) throw new Error("no LSP server is configured");
          const client = clientForLanguage(opts, clients, language);
          return client.workspaceSymbols(query, timeoutMs);
        });
      },
    },
  ];

  return {
    tools,
    close: async () => {
      await Promise.all([...clients.values()].map((client) => client.stop()));
      clients.clear();
    },
  };
}
