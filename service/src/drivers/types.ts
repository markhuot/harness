// Driver contract. A driver turns one "run" (a prompt in the context of a session)
// into a stream of events. Drivers never touch the DB; the orchestrator persists events.

import type { DriverInfo, ModelInfo, PermissionDecisionLog, PermissionMode, RunKind, SubagentStatus } from "@harness/shared";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types";
import type { RunInput } from "./input";

export { RunInput, type SteerMessage } from "./input";

/**
 * What a driver knows about a sub-agent (DESIGN.md "Sub-agents"). The first report for an id
 * creates it (running unless `status` says otherwise); later reports fill in the fields they
 * carry. Once it has finished, later reports don't change its status.
 */
export interface SubagentReport {
  /** Unique within the session: the id of the tool call that started it */
  id: string;
  /** The sub-agent that started this one, for nested agents */
  parentId?: string | null;
  description?: string;
  agentType?: string | null;
  prompt?: string;
  status?: SubagentStatus;
  result?: string | null;
}

/**
 * `subagentId` on a content event: a sub-agent (reported earlier with a "subagent" event)
 * produced it, and it belongs in that sub-agent's transcript rather than the session's.
 */
type FromSubagent = { subagentId?: string };

export type DriverEvent =
  /** Streaming text fragment (not persisted by itself). The session's own agent only. */
  | { type: "text_delta"; text: string }
  /** A completed assistant text block (persisted) */
  | ({ type: "text"; text: string } & FromSubagent)
  | ({ type: "thinking"; text: string } & FromSubagent)
  | ({ type: "tool_call"; callId: string; name: string; input: unknown } & FromSubagent)
  | ({ type: "tool_result"; callId: string; name: string; result: ToolResult } & FromSubagent)
  /** A sub-agent started, changed or finished (drivers that run sub-agents) */
  | { type: "subagent"; subagent: SubagentReport }
  /** Driver-specific state to persist for resuming the conversation next run */
  | { type: "state"; state: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /** A notice for the human, persisted as a transcript status entry (e.g. a mode downgrade) */
  | { type: "status"; text: string }
  /** A permission decision made inside the driver (e.g. Claude Code's auto-mode classifier) */
  | ({ type: "permission"; log: PermissionDecisionLog } & FromSubagent)
  /**
   * A tool call a permission system inside the driver denied without asking the harness
   * (Claude Code's auto-mode classifier). The orchestrator turns the run's last one into a
   * pending approval when the run ends without block/submit (DESIGN.md "Permissions").
   */
  | { type: "permission_denied"; callId: string; toolName: string; input: unknown; reason: string }
  /**
   * A one-time grant from RunRequest.grants the driver handed to its agent up front (claude-code:
   * an exact --allowedTools rule). The grant is used up: the orchestrator consumes it.
   */
  | { type: "grant_applied"; toolName: string; input: unknown }
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
  /**
   * Effective permission mode for the ticket (ticket → project → settings). Drivers with their
   * own permission system map it (claude-code: auto → auto, ask → acceptEdits, read_only →
   * dontAsk; plan runs always use plan). Native tools enforce it through ops.checkPermission.
   * Absent → settings.permissionMode.
   */
  permissionMode?: PermissionMode;
  /**
   * Human grants for this ticket (DESIGN.md "Permissions"): tools always allowed on the ticket
   * and one-time grants for exact calls. Absent for review runs (independent reviewers), plan
   * and triage runs and read-only tickets. Native-tool drivers ignore it (the PermissionGate
   * checks grants itself); claude-code passes them to the CLI as --allowedTools rules.
   */
  grants?: RunGrants;
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
  /**
   * Messages the human sends while the run is going (only for drivers with supportsSteering).
   * The driver takes them into the live conversation, calls delivered() once its agent has seen
   * each, and closes the input when it stops taking more (DESIGN.md "Steering").
   */
  input?: RunInput;
}

export interface RunGrants {
  /** ticket.allowedTools: "Always allow <Tool> on this ticket" */
  tools: string[];
  /**
   * One-time grants (allow_once) for exact calls. `viaPrompt`: an exact CLI rule for this call
   * was already tried and the call was still denied, so the driver must let its agent ask
   * (claude-code: the permission prompt tool) instead of pre-approving it.
   */
  once: { toolName: string; input: unknown; viaPrompt?: boolean }[];
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
  /** True if a running run takes new human messages through RunRequest.input (steering). */
  supportsSteering?: boolean;
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
