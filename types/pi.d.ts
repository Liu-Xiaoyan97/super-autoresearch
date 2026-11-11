/**
 * Minimal ambient types for the host-provided Pi modules.
 *
 * The real packages are resolved by Pi's loader at runtime; this shim only
 * exists so `tsc --noEmit` can check our code without installing a second copy
 * of @earendil-works/pi-coding-agent (which Pi explicitly warns against).
 */

declare module "@earendil-works/pi-coding-agent" {
  export interface SessionEntry {
    type: string;
    message?: {
      role: string;
      toolName?: string;
      details?: unknown;
    };
    [key: string]: unknown;
  }

  export interface ExtensionUIContext {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, lines: string[] | undefined): void;
  }

  export interface ExtensionContext {
    cwd: string;
    ui: ExtensionUIContext;
    modelRegistry: any;
    model: any;
    thinkingLevel?: string;
    signal?: AbortSignal;
    sessionManager: {
      getBranch(): SessionEntry[];
      getSessionId(): string;
    };
  }

  export interface ToolResult {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    usage?: unknown;
    isError?: boolean;
    terminate?: boolean;
  }

  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    promptSnippet?: string;
    promptGuidelines?: string[];
    executionMode?: "sequential" | "parallel";
    execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: ((result: ToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<ToolResult>;
  }

  export interface CommandOptions {
    description: string;
    handler(args: string, ctx: ExtensionContext): Promise<void> | void;
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown): () => void;
    registerTool(definition: ToolDefinition): void;
    registerCommand(name: string, options: CommandOptions): void;
    exec(command: string, args?: string[], options?: Record<string, unknown>): Promise<any>;
    sendMessage?(message: unknown, options?: Record<string, unknown>): void;
    getActiveTools?(): string[];
    setActiveTools?(names: string[]): void;
  }
}
