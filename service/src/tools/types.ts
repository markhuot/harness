// Tool contract. Tools are defined once and exposed two ways:
//  - natively, to drivers that run their own agent loop (dummy, anthropic-api)
//  - over MCP (POST /mcp/:runToken) to drivers that wrap an external agent (claude-code)

import type {
  CompletionAction,
  CreateProjectBody,
  DriverInfo,
  DriverModels,
  PermissionMode,
  PromptEntry,
  PublicSettings,
  RelatedTicket,
  RunKind,
  Session,
  Ticket,
  TicketStatus,
  ToolResultContent,
  TriageStatus,
  TranscriptRole,
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

export type BoardScope = "children" | "project" | "all";

export interface BoardListFilter {
  scope?: BoardScope;
  projectKey?: string;
  statuses?: TicketStatus[];
  limit?: number;
}

/** A ticket plus its project's key (a legacy mirror's key like FOO-123 doesn't name its project). */
export type BoardTicket = Ticket & { projectKey: string };

/** A ticket linked to a remote ID (get_ticket's relatedTickets), with its project's key. */
export type BoardRelatedTicket = RelatedTicket & { projectKey: string };

export interface BoardTicketDetail {
  ticket: BoardTicket;
  /**
   * Other tickets whose remote ID is the requested key or this ticket's remote ID, newest first
   * (drafts left out); [] when there are none.
   */
  relatedTickets: BoardRelatedTicket[];
  /** The old key the lookup went through, when `key` was an alias */
  resolvedFrom: string | null;
  parent: string | null;
  children: string[];
  /** The effective base branch and where it came from (ticket, project, settings, or the checkout's) */
  base: { branch: string; source: string };
  /** attachments[].path: the stored copy, readable with a file tool */
  summaries: { author: string; body: string; createdAt: number; attachments: { name: string; kind: "image" | "video"; path: string }[] }[];
  /** Last N text/status/error entries, oldest first; present only when requested */
  transcript?: { role: TranscriptRole; type: "text" | "status" | "error"; text: string; createdAt: number }[];
}

/**
 * get_ticket for a key no local ticket has (current key or alias) but that tickets carry as their
 * remote ID: not a ticket, a pointer to the local ones.
 */
export interface BoardRemoteMatches {
  ticket: null;
  requested: string;
  relatedTickets: BoardRelatedTicket[];
}

/** One Inbox item (a triage session), for list_inbox. */
export interface InboxItem {
  key: string;
  title: string;
  /** The watcher's name (or the inject source) */
  source: string;
  status: TriageStatus;
  /** What triage did: "Dispatched as SHOP-4", "Declined: …" */
  outcome: string | null;
  /** The watcher's prompt at the time ("" → none) */
  prompt: string;
  /** The watcher output, truncated; only when requested */
  output?: string;
  createdAt: number;
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
  /** Make it a child of the caller's ticket. Default: true for a conductor ticket, false otherwise. */
  child?: boolean;
  projectKey?: string;
  driver?: string;
  model?: string | null;
  /** false → the project checkout, true → its own worktree; omitted → the project's setting. */
  useWorktree?: boolean;
  /** Branch for its worktree (CreateTicketBody.branch); omitted → harness/<key>. */
  branch?: string | null;
  /** Base branch override; null → inherit the project's. */
  baseBranch?: string | null;
  /** Skip the agent review when it's submitted; refused for a project without human review. */
  skipAgentReview?: boolean;
  /** Skip the human review (it lands once the agent review passes); refused alongside skipAgentReview. */
  skipHumanReview?: boolean;
  /** Remote ID to link the new ticket to (e.g. a Jira key), source "manual"; omitted → unlinked. */
  remoteId?: string;
  /** Link to the remote item; needs remoteId. */
  remoteUrl?: string | null;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  driver?: string;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  dependsOn?: string[];
  /** Base branch override; null → inherit the project's. */
  baseBranch?: string | null;
  /** Branch for its worktree: refused once the ticket has a worktree (its agent uses update_branch). */
  branch?: string | null;
  /** Ticket.skipAgentReview; true is refused for a project without human review. */
  skipAgentReview?: boolean;
  /** Ticket.skipHumanReview; true is refused when the ticket skips its agent review. */
  skipHumanReview?: boolean;
  /** Link to a remote ID (PATCH externalRef); null unlinks. Without remoteUrl, re-linking the same ID keeps its link. */
  remoteId?: string | null;
  /** The remote item's link; null clears it. Alone, it changes the link of the remote ID the ticket carries. */
  remoteUrl?: string | null;
}

/**
 * Review skips an agent sets (submit_for_review, create_ticket, update_ticket). Turning one on is
 * refused when the other review is skipped too: one of them has to check the work.
 */
export interface ReviewSkips {
  skipAgentReview?: boolean;
  skipHumanReview?: boolean;
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
  /**
   * Post a short progress/result summary on the ticket (or triage session). `attachments` are
   * image/video paths (relative ones resolve against ctx.cwd); all are validated before any is stored.
   */
  postSummary(ctx: ToolContext, body: string, attachments?: string[]): Promise<void>;

  // --- plan runs ---
  /** Replace the ticket brief/plan (planning agent). */
  updatePlan(ctx: ToolContext, plan: string, title?: string): Promise<void>;

  // --- work, conductor and chat runs ---
  /** Move ticket to blocked with a question for the human. The run should end after this. */
  block(ctx: ToolContext, question: string): Promise<void>;
  /** A human's message resolved the block: blocked → in progress, and the run carries on with the work. */
  unblock(ctx: ToolContext, note?: string): Promise<void>;
  /** Work is finished: move to review with a summary. The run should end after this. */
  /** The skips are stored on the ticket first (turning one on is refused when the other review is skipped too). */
  submitForReview(ctx: ToolContext, summary: string, attachments?: string[], skips?: ReviewSkips): Promise<void>;
  /**
   * Work and conductor runs: re-point the run's own ticket to `branch` (into the worktree that has
   * it checked out, or by switching the ticket's worktree to it) and/or set its base branch
   * (null → inherit). Never deletes branches or worktrees. Returns what changed, for the model.
   */
  updateBranch(ctx: ToolContext, input: { branch?: string; baseBranch?: string | null }): Promise<string>;

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
  /**
   * Local keys only (current key or alias). A key only remote IDs match throws RemoteIdError
   * (tools/util.ts) carrying BoardRemoteMatches; one nothing matches throws a plain Error.
   */
  getTicket(ctx: ToolContext, key: string, opts?: { transcript?: number }): Promise<BoardTicketDetail>;
  /** Full-text search across every status (Orchestrator.searchTickets ranking and cursors). */
  searchTickets(
    ctx: ToolContext,
    input: { query: string; projectKey?: string; limit?: number; cursor?: string },
  ): Promise<{ hits: { ticket: BoardTicket; snippet: string }[]; nextCursor: string | null; total: number }>;
  /** Every project with its settings (null permissionMode → the settings default) */
  listProjects(ctx: ToolContext): Promise<ProjectView[]>;
  /**
   * Inbox items (triage sessions), newest first, capped at `limit` (default 20, max 100);
   * `total` counts every match. `source` is a watcher name; `output` adds its text, truncated.
   */
  listInbox(
    ctx: ToolContext,
    filter: { statuses?: TriageStatus[]; source?: string; limit?: number; output?: boolean },
  ): Promise<{ items: InboxItem[]; total: number }>;

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
  /** `action`, with approve: how the child's work lands once it completes (DESIGN.md "Completion"). */
  reviewTicket(ctx: ToolContext, key: string, decision: "approve" | "request_changes", notes: string, action?: CompletionAction): Promise<Ticket>;
  completeTicket(ctx: ToolContext, key: string, instructions?: string, action?: CompletionAction): Promise<Ticket>;
  /** record_pull_request: store the pull request a "pr" completion opened; refused in any other run. */
  recordPullRequest(ctx: ToolContext, url: string): Promise<string>;

  // --- triage runs ---
  /**
   * `key` is the remote ID: without `ticketKey` a new ticket (native key) is created, linked to
   * it. `ticketKey` names an existing local ticket (current key or alias) that gets the
   * description as a message instead, and is linked to `key` when it has no remote ID yet.
   */
  dispatchTicket(
    ctx: ToolContext,
    input: {
      projectKey: string;
      key?: string;
      ticketKey?: string;
      url?: string;
      title: string;
      description: string;
      start?: boolean;
      conductor?: boolean;
      /** The new ticket's branch (CreateTicketBody.branch); ignored with ticketKey */
      branch?: string;
      /** The new ticket's base branch override (CreateTicketBody.baseBranch); ignored with ticketKey */
      baseBranch?: string;
    },
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
  /**
   * Where a tool that saves an output file (browser_screenshot save_to) may write: the run's
   * harness-owned scratch folder, and the working directory unless the run is read-only (a
   * plan/review/triage/chat run, or read_only as the effective mode).
   */
  fileOutputScope(ctx: ToolContext): Promise<{ scratchDir: string; readOnly: boolean }>;

  // --- config (Settings / Project Settings; DESIGN.md "Config tools") ---
  // Reads work in every ticket run and triage. Mutations are for work and conductor runs only
  // and throw otherwise; their tools ask a human first (defineGatedTool). `dryRun` runs the same
  // validation (and throws the same errors) without changing anything, so a tool can reject a bad
  // call before it puts an approval card in front of the human.
  listWatchers(ctx: ToolContext): Promise<Watcher[]>;
  /** Settings without secrets (anthropicApiKeySet instead of the key) */
  getSettings(ctx: ToolContext): Promise<PublicSettings>;
  /** GET /prompts: every overridable prompt with its built-in text and override */
  listPrompts(ctx: ToolContext): Promise<PromptEntry[]>;
  listDrivers(ctx: ToolContext): Promise<(DriverInfo & { models: DriverModels })[]>;
  createWatcher(ctx: ToolContext, input: WatcherFields & { name: string; command: string }, dryRun?: boolean): Promise<Watcher | null>;
  /** `ref` is a watcher id or its exact name */
  updateWatcher(ctx: ToolContext, ref: string, input: WatcherFields, dryRun?: boolean): Promise<Watcher | null>;
  deleteWatcher(ctx: ToolContext, ref: string, dryRun?: boolean): Promise<Watcher>;
  runWatcher(ctx: ToolContext, ref: string, dryRun?: boolean): Promise<Watcher>;
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
export type WatcherFields = Partial<Pick<Watcher, "name" | "command" | "args" | "prompt" | "cwd" | "env" | "mode" | "intervalSec" | "enabled" | "driver">> & {
  /** Per-driver patch: null clears a driver's entry */
  models?: Record<string, string | null>;
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
  /** null → the settings default */
  permissionMode: PermissionMode | null;
  /** Key badge color: a preset id or "#rrggbb"; null → the theme's accent */
  color: string | null;
  /** Base branch override; null → settings.baseBranch */
  baseBranch: string | null;
  /** What approving a ticket does by default: merge, pr (a GitHub pull request) or custom */
  completionAction: CompletionAction;
  /** The completion actions the project offers (pr needs a remote gh is logged into) */
  completionActions: CompletionAction[];
  /** The host pull requests open on, or null when the project can't open one */
  pullRequestHost: string | null;
}

export interface ApprovalMeta {
  reason?: string;
  source?: "classifier" | "policy";
  summary?: string;
  onceOnly?: boolean;
  /**
   * Asked by Claude Code's --permission-prompt-tool (permission_prompt), not by a harness tool.
   * In an auto-mode ticket the CLI only asks while a run is in ask mode to deliver a grant
   * (planGrants), so the harness classifier judges the call first, as auto mode would.
   */
  viaPromptTool?: boolean;
}
