// Tool contract. Tools are defined once and exposed two ways:
//  - natively, to drivers that run their own agent loop (dummy, anthropic-api)
//  - over MCP (POST /mcp/:runToken) to drivers that wrap an external agent (claude-code)

import type { PermissionMode, RunKind, Session, Ticket, TicketStatus, ToolResultContent, TranscriptRole } from "@harness/shared";
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

export type BoardScope = "children" | "project" | "all";

export interface BoardListFilter {
  scope?: BoardScope;
  projectKey?: string;
  statuses?: TicketStatus[];
  limit?: number;
}

/** A ticket plus its project's key (mirrored keys like FOO-123 don't name their project). */
export type BoardTicket = Ticket & { projectKey: string };

export interface BoardTicketDetail {
  ticket: BoardTicket;
  /** The old key the lookup went through, when `key` was an alias */
  resolvedFrom: string | null;
  parent: string | null;
  children: string[];
  summaries: { author: string; body: string; createdAt: number }[];
  /** Last N text/status/error entries, oldest first; present only when requested */
  transcript?: { role: TranscriptRole; type: "text" | "status" | "error"; text: string; createdAt: number }[];
}

export interface CreateTicketInput {
  title: string;
  description: string;
  dependsOn?: string[];
  /** Start once every dependency is done. Default: true for a conductor's child, false otherwise. */
  autoStart?: boolean;
  /** Start now (or as soon as dependencies finish). Default false. */
  start?: boolean;
  /** Make the new ticket a conductor. */
  conductor?: boolean;
  projectKey?: string;
  driver?: string;
  model?: string | null;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  driver?: string;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  dependsOn?: string[];
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

  // --- board (read) ---
  // Every run kind (plan, work, review, complete, conductor, triage) may read the whole board.
  // None of these change state. Keys resolve like the HTTP API (current key, then old aliases).
  /**
   * Tickets matching the filter, capped at `limit` (default 50, max 200). `total` counts every
   * match. Scope defaults: conductor → "children"; a project_key or any other ticket run →
   * "project"; no ticket (triage) → "all". Throws for an unknown project key.
   */
  listTickets(ctx: ToolContext, filter: BoardListFilter): Promise<{ tickets: BoardTicket[]; total: number; scope: BoardScope }>;
  /** One ticket in any project, with summaries and optionally the last N text transcript entries. */
  getTicket(ctx: ToolContext, key: string, opts?: { transcript?: number }): Promise<BoardTicketDetail>;
  /** Full-text search across every status (Orchestrator.searchTickets ranking and cursors). */
  searchTickets(
    ctx: ToolContext,
    input: { query: string; projectKey?: string; limit?: number; cursor?: string },
  ): Promise<{ hits: { ticket: BoardTicket; snippet: string }[]; nextCursor: string | null; total: number }>;
  listProjects(ctx: ToolContext): Promise<{ key: string; name: string; path: string }[]>;

  // --- board (write): work and conductor runs ---
  // What a person does to cards on the board, through the same Orchestrator methods as the HTTP
  // API. Every method refuses the caller's own ticket (it has block / submit_for_review) and
  // throws for plan, review, complete and triage runs. See DESIGN.md "Board changes by agents".
  /**
   * Conductor run: a child of the conductor (autoStart default true, its driver/model by default).
   * Work run: a top-level ticket in the run's project or `projectKey` (start default false → planning).
   */
  createTicket(ctx: ToolContext, input: CreateTicketInput): Promise<Ticket>;
  /** Edit a card: PATCH /tickets/:key without status/position. Can't loosen its permission mode. */
  updateTicket(ctx: ToolContext, key: string, patch: UpdateTicketInput): Promise<Ticket>;
  /**
   * Drag a card: change column and/or position, with the same effects as the board. Refuses
   * moves into or out of review, to done from anything but planning, and tickets waiting on a
   * tool approval.
   */
  moveTicket(ctx: ToolContext, key: string, status: TicketStatus, position?: number): Promise<Ticket>;
  startTicket(ctx: ToolContext, key: string): Promise<Ticket>;
  /** As if a human wrote it. Refused while a tool approval is pending, and in review unless the caller is its conductor. */
  messageTicket(ctx: ToolContext, key: string, text: string): Promise<void>;
  /** Abort the ticket's active run and drop its queued runs; status unchanged. */
  cancelTicket(ctx: ToolContext, key: string): Promise<Ticket>;
  /** Send a done ticket back to in progress with notes. */
  reopenTicket(ctx: ToolContext, key: string, notes: string): Promise<Ticket>;

  // --- conductor runs (act on child tickets) ---
  /** Conductor stands in for the human reviewer of its children. */
  reviewTicket(ctx: ToolContext, key: string, decision: "approve" | "request_changes", notes: string): Promise<Ticket>;
  completeTicket(ctx: ToolContext, key: string, instructions?: string): Promise<Ticket>;

  // --- triage runs ---
  /** Create (and optionally start) a local ticket mirroring the external item. */
  dispatchTicket(
    ctx: ToolContext,
    input: { projectKey: string; key?: string; url?: string; title: string; description: string; start?: boolean; conductor?: boolean },
  ): Promise<Ticket>;
  /** `title` replaces the Inbox title derived from the raw output. */
  declineWork(ctx: ToolContext, reason: string, title?: string): Promise<void>;

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
    /** Shown on the approval card: why a human is asked, and by whom (classifier / static policy) */
    meta?: { reason?: string; source?: "classifier" | "policy" },
  ): Promise<{ behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string }>;

  // --- native tool permissions (PermissionGate; DESIGN.md "Permissions") ---
  /**
   * May this native tool call (bash, write_file, edit_file, read_file, list_files) run under the
   * ticket's permission mode? Deny messages are for the model. May block the ticket for a human
   * (soft deny / ask mode), exactly like requestApproval.
   */
  checkPermission(ctx: ToolContext, toolName: string, input: unknown): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
}
