// Driver contract. A driver turns one "run" (a prompt in the context of a session)
// into a stream of events. Drivers never touch the DB; the orchestrator persists events.

import type { DriverInfo, ModelInfo, RunKind } from "@harness/shared";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types";

export type DriverEvent =
  /** Streaming text fragment (not persisted by itself) */
  | { type: "text_delta"; text: string }
  /** A completed assistant text block (persisted) */
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; result: ToolResult }
  /** Driver-specific state to persist for resuming the conversation next run */
  | { type: "state"; state: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "error"; message: string };

export interface RunRequest {
  runId: string;
  kind: RunKind;
  /** The user-turn prompt for this run (human message or orchestrator instruction) */
  prompt: string;
  /** Harness system prompt for this run kind (drivers append it to their own, if any) */
  systemPrompt: string;
  cwd: string;
  /**
   * Model for this run, resolved by the orchestrator (ticket → project → settings; review runs
   * may use settings.reviewModels). null → the driver's own default.
   */
  model: string | null;
  /** Previously persisted driver state for this session (null on first run) */
  state: unknown;
  /** Tools available in this run. Native-loop drivers call tool.execute(input, toolContext). */
  tools: ToolDefinition[];
  toolContext: ToolContext;
  /**
   * For drivers wrapping an external agent: an MCP endpoint serving `tools` for this run.
   * { url, headers } — pass to the external agent's MCP config.
   */
  mcp: { url: string; headers: Record<string, string> };
  signal: AbortSignal;
}

export interface Driver {
  id: string;
  name: string;
  description: string;
  /** True if the driver brings its own file/shell tools (so "native" group tools are withheld). */
  hasBuiltinTools: boolean;
  /**
   * True if the driver answers tool-permission prompts through the harness
   * `permission_prompt` tool (claude-code's --permission-prompt-tool). toolsForRun adds it.
   */
  usesPermissionPromptTool?: boolean;
  info(): Promise<DriverInfo>;
  /** Start an interactive login if supported. Returns a URL to open, if any. */
  login?(): Promise<{ url: string | null; message: string }>;
  run(req: RunRequest): AsyncIterable<DriverEvent>;
  /**
   * Models this driver can run with. Throw on failure; a ModelListError can carry a
   * fallback list (shown alongside the error). The orchestrator caches the result.
   */
  listModels(): Promise<ModelInfo[]>;
}

/** A model-list failure that still has something useful to offer (e.g. well-known aliases). */
export class ModelListError extends Error {
  constructor(
    message: string,
    readonly fallback: ModelInfo[] = [],
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

/**
 * Helper used by native-loop drivers: execute a tool by name with error capture.
 * Thrown errors become { isError: true } results, unknown tools too.
 */
export async function executeTool(tools: ToolDefinition[], name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    return await tool.execute(input as any, ctx);
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}
