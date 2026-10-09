// Tool contract. Tools are defined once and exposed two ways:
//  - natively, to drivers that run their own agent loop (dummy, anthropic-api)
//  - over MCP (POST /mcp/:runToken) to drivers that wrap an external agent (claude-code)

import type {
  AttachmentKind,
  ActivityKind,
  ActivityMeta,
  CompletionAction,
  CreateProjectBody,
  DriverInfo,
  DriverModels,
  PermissionMode,
  PhaseModels,
  PhaseModelsPatch,
  PromptEntry,
  PublicSettings,
  RelatedTicket,
  RunKind,
  Session,
  SubagentKind,
  SubagentStatus,
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
  /** The spec's current revision (ticket.spec is its body) and the approved baseline (null before Start) */
  specRevision: number;
  specBaselineRevision: number | null;
  /** The ticket's Activity, oldest first */
  activity: { kind: ActivityKind; author: string; body: string; meta: ActivityMeta; createdAt: number }[];
  /** The ticket's images and videos (attachment:<id> in the spec): path is the stored copy, readable with a file tool */
  attachments: { id: string; name: string; kind: AttachmentKind; path: string }[];
  /**
   * Files the human attached to the ticket's first message, where they are on disk; missing once
   * moved or deleted. notes: the numbered notes the human drew on an image (Attachment.annotation). id: the
   * registered attachment, which a message can send on by id.
   */
  promptAttachments: { id: string; name: string; path: string; missing: boolean; notes?: string[] }[];
  /** Last N text/status/error entries, oldest first; present only when requested */
  transcript?: BoardTranscriptEntry[];
  /** The sub-agents and background tasks its sessions started, oldest first; present only when requested */
  agents?: BoardAgent[];
}

export type BoardTranscriptEntry = { role: TranscriptRole; type: "text" | "status" | "error"; text: string; createdAt: number };

/** One sub-agent or background task as the board tools show it (a Subagent, its long text clipped). */
export interface BoardAgent {
  id: string;
  kind: SubagentKind;
  description: string;
  agentType: string | null;
  model: string | null;
  status: SubagentStatus;
  /** The sub-agent that started it, when nested */
  parentId: string | null;
  /** A task's command */
  command: string | null;
  /** Its report (an agent) or how it ended (a task), clipped */
  result: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** get_ticket_agent: one sub-agent with its task and transcript tail, or one task with its output tail. */
export interface BoardAgentDetail {
  ticket: string;
  agent: BoardAgent & { prompt: string };
  /** An agent's last N text/status/error entries, oldest first */
  transcript?: BoardTranscriptEntry[];
  /** A task's output: the last part of it, with truncated true when there's more before it */
  output?: { text: string; truncated: boolean; done: boolean; available: boolean };
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
  spec: string;
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
  /** Per-phase driver + model (merged over the driver/model shorthand, which sets Planning, Work and Review) */
  phaseModels?: PhaseModelsPatch;
  /** false → the project checkout, true → its own worktree; omitted → the project's setting. */
  useWorktree?: boolean;
  /** Branch for its worktree (CreateTicketBody.branch); omitted → harness/<key>. */
  branch?: string | null;
  /** Base branch override; null → inherit the project's. */
  baseBranch?: string | null;
  /** Skip the agent review when it's submitted; omitted → the project's default. Refused alongside a skipped human review. */
  skipAgentReview?: boolean;
  /** Skip the human review (it lands once the agent review passes); omitted → the project's default. Refused alongside a skipped agent review. */
  skipHumanReview?: boolean;
  /** Remote ID to link the new ticket to (e.g. a Jira key), source "manual"; omitted → unlinked. */
  remoteId?: string;
  /** Link to the remote item; needs remoteId. */
  remoteUrl?: string | null;
  /** Files to attach to its first message (Ticket.promptAttachments); relative paths resolve against the caller's cwd. */
  attachments?: string[];
}

export interface UpdateTicketInput {
  title?: string;
  /** A new spec revision for the ticket (written as the caller's agent revision) */
  spec?: string;
  /** The specRevision the new spec replaces (from get_ticket); required with spec, a stale one is refused */
  baseRevision?: number;
  driver?: string;
  model?: string | null;
  /** Per-phase driver + model patch; null clears a phase */
  phaseModels?: PhaseModelsPatch;
  permissionMode?: PermissionMode | null;
  dependsOn?: string[];
  /** Base branch override; null → inherit the project's. */
  baseBranch?: string | null;
  /** Branch for its worktree: refused once the ticket has a worktree (its agent uses update_branch). */
  branch?: string | null;
  /** Ticket.skipAgentReview; true is refused when the ticket skips its human review. */
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
  /** A short Activity note on the ticket (post_note). */
  postNote(ctx: ToolContext, note: string): Promise<void>;
  /**
   * Replace the ticket's agent notes (update_notes); returns what was saved, trimmed ("" clears
   * them). Plan, work, chat and conductor runs.
   */
  updateNotes(ctx: ToolContext, notes: string): Promise<string>;
  /** Whether this run has called update_notes: block and submit_for_review remind it when not. */
  wroteNotes(ctx: ToolContext): boolean;
  /**
   * A status line in the ticket's transcript, for the human following along (a browser_run job's
   * log). Not in Activity, and the agent doesn't see it.
   */
  statusLine(ctx: ToolContext, text: string): Promise<void>;
  /** The ticket's spec (a revision, else the current one), with numbered lines (read_spec). */
  readSpec(ctx: ToolContext, revision?: number): Promise<string>;

  // --- plan, work, chat, conductor and complete runs ---
  /**
   * edit_spec: apply `edits` (all or nothing) to revision `baseRevision`, which must be the
   * current one. Local images in the new text are stored and rewritten to attachment:<id>.
   * Returns what happened, for the model.
   */
  editSpec(ctx: ToolContext, input: { baseRevision: number; note: string; edits: unknown }): Promise<string>;
  /** update_spec: replace the whole spec (and maybe the title) as a new revision of `baseRevision`. */
  updateSpec(ctx: ToolContext, input: { spec: string; note: string; baseRevision: number; title?: string }): Promise<string>;

  // --- work, conductor and chat runs ---
  /** Move ticket to blocked with a question for the human. The run should end after this. */
  block(ctx: ToolContext, question: string): Promise<void>;
  /** A human's message resolved the block: blocked → in progress, and the run carries on with the work. */
  unblock(ctx: ToolContext, note?: string): Promise<void>;
  /**
   * The agent is changing reviewed or landed work again: review or done → in progress, and both
   * reviews start over. Returns the ticket's workdir when re-opening moved it away from ctx.cwd
   * (a done ticket's worktree recreated), else "".
   */
  resumeWork(ctx: ToolContext, note?: string): Promise<string>;
  /**
   * Work is finished: move to review with a note on this round. `specIsUpToDate` must be true (the
   * spec was brought up to date in an earlier call), else it throws and the ticket stays put. The
   * skips are stored on the ticket first (turning one on is refused when the other review is
   * skipped too). The run should end after this.
   */
  submitForReview(ctx: ToolContext, note: string, specIsUpToDate: unknown, skips?: ReviewSkips): Promise<void>;
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
  /** One ticket in any project, with its spec, Activity and optionally the last N text transcript entries. */
  /**
   * Local keys only (current key or alias). A key only remote IDs match throws RemoteIdError
   * (tools/util.ts) carrying BoardRemoteMatches; one nothing matches throws a plain Error.
   */
  getTicket(ctx: ToolContext, key: string, opts?: { transcript?: number; agents?: boolean }): Promise<BoardTicketDetail>;
  /** One sub-agent or background task of a ticket's session (an id from get_ticket's agents). Throws for an unknown id. */
  getTicketAgent(ctx: ToolContext, key: string, id: string, opts?: { transcript?: number }): Promise<BoardAgentDetail>;
  /** Full-text search across every status (Orchestrator.searchTickets ranking and cursors). */
  searchTickets(
    ctx: ToolContext,
    input: { query: string; projectKey?: string; limit?: number; cursor?: string },
  ): Promise<{ hits: { ticket: BoardTicket; snippet: string }[]; nextCursor: string | null; total: number }>;
  /** Every project with its settings (null permissionMode → the settings default) */
  listProjects(ctx: ToolContext): Promise<ProjectView[]>;
  /**
   * Inbox items (triage sessions), newest first, capped at `limit` (default 20, max 100);
   * `total` counts every match. `source` is a watcher name; `key` one item (TRIAGE-n); `output` adds its text, truncated.
   */
  listInbox(
    ctx: ToolContext,
    filter: { statuses?: TriageStatus[]; source?: string; key?: string; limit?: number; output?: boolean },
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
   * Change a card's column and/or position. Never starts work (startTicket does). Refuses
   * moves into or out of review, to in_progress, to done from anything but planning, and tickets waiting on a
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
  /**
   * record_pull_request: store the pull request a "pr" completion opened and the commit it pushed
   * (`head`, which becomes the ticket's pinned Changes); refused in any other run.
   */
  recordPullRequest(ctx: ToolContext, url: string, head: string): Promise<string>;

  // --- triage runs ---
  /**
   * `key` is the remote ID: without `ticketKey` a new ticket (native key) is created, linked to
   * it. `ticketKey` names an existing local ticket (current key or alias) that gets the
   * spec as a message instead, and is linked to `key` when it has no remote ID yet.
   */
  dispatchTicket(
    ctx: ToolContext,
    input: {
      projectKey: string;
      key?: string;
      ticketKey?: string;
      url?: string;
      title: string;
      spec: string;
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
  /** Settings without secrets (anthropicApiKeySet, claudeOauthTokenSet and copilotGithubTokenSet instead of the values) */
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
  /** Same validation as PATCH /settings; anthropicApiKey, claudeOauthToken and copilotGithubToken are refused */
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
  /** The project's own per-phase choices; phases it doesn't choose inherit the settings' */
  phaseModels: PhaseModels;
  useWorktrees: boolean;
  /** New tickets skip their agent review by default */
  skipAgentReview: boolean;
  /** New tickets skip their human review by default */
  skipHumanReview: boolean;
  /** null → the settings default */
  permissionMode: PermissionMode | null;
  /** Key badge color: a preset id or "#rrggbb"; null → the theme's accent */
  color: string | null;
  /** The project's group; null → in no group */
  group: string | null;
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
