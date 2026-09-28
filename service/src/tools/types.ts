// Tool contract. Tools are defined once and exposed two ways:
//  - natively, to drivers that run their own agent loop (dummy, anthropic-api)
//  - over MCP (POST /mcp/:runToken) to drivers that wrap an external agent (claude-code)

import type {
  CreateProjectBody,
  DriverInfo,
  DriverModels,
  Mapping,
  PermissionMode,
  PublicSettings,
  RunKind,
  Session,
  Ticket,
  ToolResultContent,
  Watcher,
} from "@harness/shared";
import type { BrowserService } from "../browser/types";

/** JSON Schema object describing the tool input */
export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };

/** Subset of MCP ToolAnnotations (hints to the client, not guarantees). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

export interface ToolDefinition<I = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * "harness" tools are always exposed (ticket ops, browser).
   * "native" tools (bash, files) are only given to drivers without their own tools.
   */
  group: "harness" | "native";
  /** MCP tool annotations. Defaults (see api/mcp.ts): readOnlyHint = group === "harness". */
  annotations?: ToolAnnotations;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/** Everything a tool may need about the run it is executing inside. */
export interface ToolContext {
  runId: string;
  runKind: RunKind;
  session: Session;
  ticket: Ticket | null;
  /** Working directory for file/shell tools */
  cwd: string;
  ops: HarnessOps;
  browser: BrowserService;
  signal: AbortSignal;
}

/**
 * Operations the orchestrator exposes to tools. Implemented by the orchestrator
 * (service/src/orchestrator); tools must go through this facade, never the DB.
 * All methods act on behalf of the run in `ctx` and throw Error(message) on invalid use —
 * the tool layer converts thrown errors into isError tool results.
 */
export interface HarnessOps {
  // --- any ticket run ---
  /** Post a short progress/result summary on the ticket (or triage session). */
  postSummary(ctx: ToolContext, body: string): Promise<void>;

  // --- plan runs ---
  /** Replace the ticket brief/plan (planning agent). */
  updatePlan(ctx: ToolContext, plan: string, title?: string): Promise<void>;

  // --- work runs ---
  /** Move ticket to blocked with a question for the human. The run should end after this. */
  block(ctx: ToolContext, question: string): Promise<void>;
  /** Work is finished: move to review with a summary. The run should end after this. */
  submitForReview(ctx: ToolContext, summary: string): Promise<void>;

  // --- review runs ---
  /** Record the agent review decision. */
  reviewDecision(ctx: ToolContext, decision: "approve" | "request_changes", notes: string): Promise<void>;

  // --- conductor runs (act on child tickets) ---
  createTicket(
    ctx: ToolContext,
    input: { title: string; description: string; dependsOn?: string[]; autoStart?: boolean; projectKey?: string },
  ): Promise<Ticket>;
  listTickets(ctx: ToolContext, scope: "children" | "project"): Promise<Ticket[]>;
  getTicket(ctx: ToolContext, key: string): Promise<{ ticket: Ticket; summaries: { author: string; body: string; createdAt: number }[] }>;
  startTicket(ctx: ToolContext, key: string): Promise<Ticket>;
  messageTicket(ctx: ToolContext, key: string, text: string): Promise<void>;
  /** Conductor stands in for the human reviewer of its children. */
  reviewTicket(ctx: ToolContext, key: string, decision: "approve" | "request_changes", notes: string): Promise<Ticket>;
  completeTicket(ctx: ToolContext, key: string, instructions?: string): Promise<Ticket>;

  // --- triage runs ---
  listProjects(ctx: ToolContext): Promise<ProjectView[]>;
  /** Create (and optionally start) a local ticket mirroring the external item. */
  dispatchTicket(
    ctx: ToolContext,
    input: { projectKey: string; key?: string; title: string; description: string; start?: boolean; conductor?: boolean },
  ): Promise<Ticket>;
  declineWork(ctx: ToolContext, reason: string): Promise<void>;

  // --- permission prompts (claude-code --permission-prompt-tool) ---
  /**
   * The external agent wants to use a tool its permission mode doesn't auto-allow.
   * Allows when the human already granted it (ticket.allowedTools, or a one-time grant for this
   * exact toolName+input, which is consumed). Otherwise records ticket.pendingApproval, moves the
   * ticket to blocked, and denies with a message telling the agent to stop and wait.
   * Review/plan/triage runs are denied outright with guidance (no human in that loop).
   */
  requestApproval(
    ctx: ToolContext,
    toolName: string,
    input: unknown,
    /**
     * Shown on the approval card: why a human is asked, and by whom (classifier / static policy).
     * summary replaces the generic input summary; onceOnly calls are allowed by a one-time grant
     * only (never by ticket.allowedTools), and the card offers no "always allow".
     */
    meta?: ApprovalMeta,
  ): Promise<{ behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string }>;

  // --- native tool permissions (PermissionGate; DESIGN.md "Permissions") ---
  /**
   * May this native tool call (bash, write_file, edit_file, read_file, list_files) run under the
   * ticket's permission mode? Deny messages are for the model. May block the ticket for a human
   * (soft deny / ask mode), exactly like requestApproval.
   */
  checkPermission(ctx: ToolContext, toolName: string, input: unknown): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

  // --- config (Settings / Project Settings; DESIGN.md "Config tools") ---
  // Reads work in every ticket run and triage. Mutations are for work and conductor runs only
  // and throw otherwise; their tools ask a human first (defineGatedTool). `dryRun` runs the same
  // validation (and throws the same errors) without changing anything, so a tool can reject a bad
  // call before it puts an approval card in front of the human.
  listWatchers(ctx: ToolContext): Promise<Watcher[]>;
  /** Mappings with the target project's key */
  listMappings(ctx: ToolContext): Promise<(Mapping & { projectKey: string | null })[]>;
  /** Settings without secrets (anthropicApiKeySet instead of the key) */
  getSettings(ctx: ToolContext): Promise<PublicSettings>;
  listDrivers(ctx: ToolContext): Promise<(DriverInfo & { models: DriverModels })[]>;
  createWatcher(ctx: ToolContext, input: WatcherFields & { name: string; command: string }, dryRun?: boolean): Promise<Watcher | null>;
  /** `ref` is a watcher id or its exact name */
  updateWatcher(ctx: ToolContext, ref: string, input: WatcherFields, dryRun?: boolean): Promise<Watcher | null>;
  deleteWatcher(ctx: ToolContext, ref: string, dryRun?: boolean): Promise<Watcher>;
  runWatcher(ctx: ToolContext, ref: string, dryRun?: boolean): Promise<Watcher>;
  createMapping(ctx: ToolContext, input: { pattern: string; projectKey: string; notes?: string }, dryRun?: boolean): Promise<Mapping | null>;
  deleteMapping(ctx: ToolContext, id: string, dryRun?: boolean): Promise<Mapping>;
  createProject(ctx: ToolContext, input: CreateProjectBody, dryRun?: boolean): Promise<ProjectView | null>;
  /** `key` is the project's current key; input.key renames it */
  updateProject(ctx: ToolContext, key: string, input: Partial<CreateProjectBody>, dryRun?: boolean): Promise<ProjectView | null>;
  /** Refuses the project of the run's own ticket */
  deleteProject(ctx: ToolContext, key: string, dryRun?: boolean): Promise<ProjectView>;
  /** Same validation as PATCH /settings; anthropicApiKey is refused */
  updateSettings(ctx: ToolContext, patch: Record<string, unknown>, dryRun?: boolean): Promise<PublicSettings>;
  /** Refuses the run's own ticket and its ancestors */
  deleteTicket(ctx: ToolContext, key: string, dryRun?: boolean): Promise<Ticket>;
}

/** Watcher fields a tool may set (Watcher without ids, timestamps and run status). */
export type WatcherFields = Partial<Pick<Watcher, "name" | "command" | "args" | "cwd" | "env" | "mode" | "intervalSec" | "enabled" | "driver">> & {
  /** Triage instructions for the watcher's output; passed through to the orchestrator as-is */
  prompt?: string;
};

/** A project as tools see it. */
export interface ProjectView {
  key: string;
  name: string;
  path: string;
  defaultDriver: string | null;
  defaultModels: Record<string, string>;
  useWorktrees: boolean;
  requireHumanReview: boolean;
  autoComplete: boolean;
  /** null → the settings default */
  permissionMode: PermissionMode | null;
}

export interface ApprovalMeta {
  reason?: string;
  source?: "classifier" | "policy";
  summary?: string;
  onceOnly?: boolean;
}
