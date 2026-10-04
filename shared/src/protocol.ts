// Shared wire protocol between the harness service and its clients (desktop app, future iOS app).
// Everything here is plain JSON-serializable data. Timestamps are epoch milliseconds.

export const DEFAULT_PORT = 7717;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  /** Upper-case key prefix used for ticket ids, e.g. "NYTIMES" → NYTIMES-1 */
  key: string;
  name: string;
  /** Absolute path of the working directory agents start in */
  path: string;
  /** Next sequence number handed out for a native ticket key */
  nextSeq: number;
  /** Default driver id for new tickets in this project (falls back to settings.defaultDriver) */
  defaultDriver: string | null;
  /**
   * Default model per driver id for new runs of this project's tickets (overrides
   * settings.defaultModels; a ticket's own model overrides this). Absent → settings default.
   */
  defaultModels: Record<string, string>;
  /** When the project path is a git repo, give each ticket its own worktree + branch */
  useWorktrees: boolean;
  /**
   * Whether the project path is inside a git checkout (checked each time the project is read).
   * Clients hide worktree choices when it's false. Optional only so older payloads type-check.
   */
  isGit?: boolean;
  /**
   * New tickets skip their agent review (Ticket.skipAgentReview) unless they say otherwise: the
   * default the New session's switch starts from and a create without the field gets. Existing
   * tickets keep their own. Optional only so older payloads type-check.
   */
  skipAgentReview?: boolean;
  /** Same, for the human review (Ticket.skipHumanReview). Optional only so older payloads type-check. */
  skipHumanReview?: boolean;
  /**
   * @deprecated `!skipHumanReview`, sent only for apps from before the two defaults (which
   * require it). Nothing reads it; CreateProjectBody still accepts it from those apps.
   */
  requireHumanReview?: boolean;
  /** Permission mode for this project's tickets (null → settings.permissionMode) */
  permissionMode: PermissionMode | null;
  /**
   * Branch this project's tickets merge into when they complete, and new ticket branches start
   * from (DESIGN.md "Branches"). null → settings.baseBranch. Resolve with `resolveBaseBranch`.
   * The service always sends it; optional only so older payloads type-check.
   */
  baseBranch?: string | null;
  /**
   * What approving one of this project's tickets does by default (DESIGN.md "Completion"): the
   * choice preselected on the Approve button, and the action used when nobody picks one (no human
   * review, a conductor completing a child, auto-complete). When the project stops offering it
   * (see `completionActions`), the effective default falls back to merge, then custom; resolve with
   * `completionOptions`. Optional only so older payloads type-check.
   */
  completionAction?: CompletionAction;
  /**
   * The completion actions this project offers, worked out on each read (never stored): custom
   * only outside git, merge and custom in a git repo, plus pr when `pullRequestHost` is set.
   * Optional only so older payloads type-check.
   */
  completionActions?: CompletionAction[];
  /**
   * The host a pull request would open on, e.g. "github.com" or an Enterprise host: set when `gh`
   * is installed, the repo has a remote, and gh is logged into that remote's host. null otherwise
   * (no pr action). Worked out on each read. Optional only so older payloads type-check.
   */
  pullRequestHost?: string | null;
  /**
   * Color of the project's key badge: a preset id from PROJECT_COLORS ("blue") or a custom
   * "#rrggbb". null → the theme's accent.
   */
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * How much an agent may do without asking (DESIGN.md "Permissions"):
 * - "auto":      a classifier judges each unapproved action (Claude Code's auto mode for
 *                claude-code; the harness PermissionGate + classifier for native-tool drivers)
 * - "ask":       edits inside the workdir are allowed, everything else asks a human
 * - "read_only": reads only; writes and non-read-only commands are denied
 */
export const PERMISSION_MODES = ["auto", "ask", "read_only"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Who judges actions in auto mode for native-tool drivers ("off": ask a human instead). */
export const CLASSIFIER_BACKENDS = ["claude-cli", "anthropic-api", "off"] as const;
export type ClassifierBackend = (typeof CLASSIFIER_BACKENDS)[number];

/** One permission decision, logged on the transcript as a status entry (content.permission). */
export interface PermissionDecisionLog {
  /** Tool as the driver names it: "bash", "write_file", "Bash", ... */
  tool: string;
  /** One-line summary of the input (command / path) */
  summary: string;
  /** allow: ran without asking · ask: sent to a human · deny: refused (the agent sees the reason) */
  decision: "allow" | "ask" | "deny";
  reason: string;
  /** classifier: a model judged it · policy: a static rule (allowlist, mode, hard-deny, grant) */
  source: "classifier" | "policy";
  /** Classifier backend ("claude-cli", "anthropic-api", "claude-code" for the CLI's own auto mode) */
  backend?: string;
  latencyMs?: number;
  mode: PermissionMode;
}

export const TICKET_STATUSES = ["planning", "in_progress", "blocked", "review", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * "skipped" is only ever an agent review: the ticket has `skipAgentReview`, so submitting didn't
 * start a review run (DESIGN.md "Skipping the agent review"). It counts as passed (`reviewPassed`).
 */
export type ReviewState = "pending" | "approved" | "changes_requested" | "skipped";

/** An approved or skipped review: nothing left to wait for on that side. */
export function reviewPassed(state: ReviewState): boolean {
  return state === "approved" || state === "skipped";
}

export type TicketKind = "task" | "conductor";

/**
 * How an approved ticket's work lands (DESIGN.md "Completion"), each with its own completion
 * prompts: "merge" merges the branch into its base branch locally, "pr" pushes it and opens a
 * GitHub pull request with gh, "cleanup" only removes the ticket's worktree and branch (the work
 * already landed, e.g. pushed to an existing pull request's branch), "custom" follows the
 * approver's own instructions.
 */
export const COMPLETION_ACTIONS = ["merge", "pr", "cleanup", "custom"] as const;
export type CompletionAction = (typeof COMPLETION_ACTIONS)[number];

export interface Ticket {
  id: string;
  /** Jira-style key: native (NYTIMES-3) or mirrored from an external system (FOO-123) */
  key: string;
  projectId: string;
  kind: TicketKind;
  title: string;
  /**
   * The spec (DESIGN.md "Spec revisions and attachments"): a living markdown document with the
   * goal, plan, status and open questions. Agents keep it current with edit_spec / update_spec;
   * every write is a revision. This is the current revision's body.
   */
  spec: string;
  /** The current spec revision (1 for a new ticket). Optional so older fixtures type-check. */
  specRevision?: number;
  /**
   * The revision that was current when the human pressed Start (planning → work): the approved
   * baseline the agent review diffs against. null until the ticket first starts.
   */
  specBaselineRevision?: number | null;
  status: TicketStatus;
  /** The session holding this ticket's transcript */
  sessionId: string;
  driver: string;
  /** Conductor that owns this ticket, if any */
  parentId: string | null;
  /**
   * How many tickets have this one as their parent. Any ticket with children acts as a conductor
   * (see `isConductor`), whatever its kind. Optional only so older services and fixtures type-check.
   */
  childCount?: number;
  /** Keys of tickets that must be done before this one can start */
  dependsOn: string[];
  /** Start automatically once every dependency is done (used by conductors) */
  autoStart: boolean;
  agentReview: ReviewState;
  humanReview: ReviewState;
  /**
   * The remote item this ticket is linked to (a Jira issue, a PR), from a watcher's triage or set
   * by hand. Its `key` is the remote ID the board shows in place of `key` (`displayKey`). Many
   * tickets can link the same remote ID; `key` stays the ticket's only identity (DESIGN.md
   * "Remote IDs").
   */
  externalRef: ExternalRef | null;
  /** Directory the agent runs in (project path or a worktree) */
  workdir: string | null;
  /**
   * The git branch checked out in the ticket's worktree, set once the worktree exists. The
   * invariant: branch set ⇔ the ticket works in a git worktree of its own at `workdir` (a harness
   * worktree or, after `update_branch`, another worktree that has the branch checked out). null
   * while the ticket hasn't started, or when it runs in the project checkout itself.
   * The branch a ticket will use or uses: `plannedBranch(ticket)` (DESIGN.md "Branches").
   */
  branch: string | null;
  /**
   * The branch chosen for the ticket (CreateTicketBody.branch, update_branch). When work starts
   * the worktree checks it out: an existing local branch as is, a new name created from the base
   * branch. null → harness/<key> (`harnessBranch`). Kept after the worktree exists, so a re-opened
   * ticket whose worktree was removed gets the same branch back. Optional so older payloads type-check.
   */
  requestedBranch?: string | null;
  /**
   * Base branch override: what this ticket's work merges into when it completes (and where a new
   * branch starts). null → project → settings; resolve with `resolveBaseBranch`. Optional so
   * older payloads type-check.
   */
  baseBranch?: string | null;
  /**
   * Per-ticket worktree choice, applied when work starts: true → its own worktree, false → the
   * project checkout, null → the project's useWorktrees. Optional only so older payloads type-check.
   */
  useWorktree?: boolean | null;
  /**
   * Submitting skips the agent review: agentReview becomes "skipped" and the ticket waits only on
   * the human (or its conductor). Set when the ticket is created (default: Project.skipAgentReview), from the ticket card, or by the
   * ticket's own agent (`submit_for_review` skip_agent_review). Optional so older payloads type-check.
   */
  skipAgentReview?: boolean;
  /**
   * Submitting counts the human review as approved: the ticket lands as soon as its agent review
   * passes, or right away when that's skipped too. Set when the ticket is created (default:
   * Project.skipHumanReview), from the ticket card, or by an agent (`submit_for_review` / `create_ticket` / `update_ticket`
   * skip_human_review). Optional so older payloads type-check.
   */
  skipHumanReview?: boolean;
  /**
   * The completion action picked when the ticket was approved (or completed), kept until the
   * completion runs: a human approval can come before the agent review finishes. null → the
   * project's default. Optional so older payloads type-check.
   */
  completionAction?: CompletionAction | null;
  /** The approver's instructions for the completion run, kept with `completionAction`. */
  completionInstructions?: string | null;
  /**
   * The pull request a "pr" completion opened (the agent records it with record_pull_request).
   * Later approvals of the ticket default to "pr", so they update the same pull request.
   */
  pullRequestUrl?: string | null;
  /**
   * Whether the ticket's worktree has anything to land: uncommitted changes, or commits its base
   * branch doesn't have. The service checks with git when the ticket moves to review and when it's
   * opened. false drops "merge" and "pr" from its completion choices (`completionOptions`); null
   * (not checked, no worktree, or git couldn't say) changes nothing. Optional so older payloads
   * type-check.
   */
  hasChanges?: boolean | null;
  /**
   * A draft (DESIGN.md "Drafts"): a New session saved before it was launched. It stays in planning
   * and never runs or reaches agents until POST /tickets/:key/submit clears the flag. While it's set,
   * `kind`, `useWorktree` and `projectId` can still change (UpdateTicketBody). Optional so fixtures
   * type-check; the service always sends it.
   */
  draft?: boolean;
  /**
   * Files the human attached to the New session (DESIGN.md "Prompt attachments"): referenced where
   * they are on the service's machine, never copied. The first run gets their paths and the images
   * inline. One can go missing later (moved or deleted); GET /tickets/:key/prompt-attachments/:index
   * answers 404 for it then. Optional so fixtures type-check; the service always sends it.
   */
  promptAttachments?: PromptAttachment[];
  /** Why the ticket is blocked (question for the human), when status = blocked */
  blockedReason: string | null;
  /** True while any agent run for this ticket is queued or running */
  busy: boolean;
  /** A tool-permission request waiting on a human (claude-code driver). Ticket is blocked meanwhile. */
  pendingApproval: PendingApproval | null;
  /** Tools the human has allowed for every future call on this ticket ("Bash", "WebFetch", ...) */
  allowedTools: string[];
  /** Permission mode override for this ticket (null → project → settings) */
  permissionMode: PermissionMode | null;
  /** Model for this ticket's runs (driver-specific id). null → project / settings / driver default. */
  model: string | null;
  /** Sort order within a column */
  position: number;
  /**
   * When the ticket last entered done (ms). Set on the move into done, cleared (null) when it
   * leaves. The service always sends it; it's optional here only so older fixtures and payloads
   * still type-check. The Done column sorts by this, newest first (fall back to updatedAt).
   */
  completedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A ticket acts as a conductor (steers child tickets, shows their rollup and Tickets tab) when it
 * was created as one or once it has children. `kind` only picks the ticket's first prompt.
 */
export function isConductor(t: Pick<Ticket, "kind" | "childCount">): boolean {
  return t.kind === "conductor" || (t.childCount ?? 0) > 0;
}

/**
 * One page of tickets from GET /tickets/page or GET /tickets/search. `nextCursor` is opaque:
 * pass it back as `cursor` for the next page; null means this was the last page. `total` counts
 * every ticket matching the filter (not just this page).
 */
export interface TicketPage {
  tickets: Ticket[];
  nextCursor: string | null;
  total: number;
}

export interface PendingApproval {
  id: string;
  runId: string;
  /** Tool the agent wants to use, e.g. "Bash" */
  toolName: string;
  /** The tool input, e.g. { command: "npm install" } */
  input: unknown;
  requestedAt: number;
  /** Why a human is being asked (e.g. the classifier's judgement) */
  reason?: string;
  /** What sent it to the human: the auto-mode classifier or a static policy (ask mode, ...) */
  source?: "classifier" | "policy";
  /** One-line description of the call for the card and the blocked reason (harness config tools) */
  summary?: string;
  /**
   * Only "allow once" or "deny" may answer it: harness config tools (watchers, settings,
   * deletes) are never allowed for the rest of a ticket.
   */
  onceOnly?: boolean;
}

export interface ExternalRef {
  source: string; // watcher name, e.g. "jira", or "manual" for a link set by hand
  key: string; // the remote ID, e.g. FOO-123
  url: string | null;
  raw: unknown; // the original item emitted by the watcher (null for a manual link)
}

/**
 * A ticket that carries a remote ID (TicketDetail.relatedTickets): another ticket linked to the
 * same remote item, or the tickets a remote ID points to when no local key matches.
 */
export interface RelatedTicket {
  key: string;
  title: string;
  status: TicketStatus;
  projectId: string;
  /** The remote ID it carries */
  externalKey: string;
}

/**
 * A remote ID set by hand (UpdateTicketBody.externalRef). The key is upper-cased and must look
 * like FOO-123; the link's source is "manual".
 */
export interface ExternalRefInput {
  key: string;
  url?: string | null;
}

export type SessionKind = "ticket" | "triage";

export interface Session {
  id: string;
  /** Display key: the ticket key, or TRIAGE-n for ephemeral triage sessions */
  key: string;
  kind: SessionKind;
  ticketId: string | null;
  driver: string;
  cwd: string;
  /** Title for triage sessions (the external item summary) */
  title: string;
  /** Triage lifecycle; ticket sessions mirror their ticket instead */
  triageStatus: TriageStatus | null;
  /** Outcome text for triage sessions (dispatched to X / declined because Y) */
  outcome: string | null;
  busy: boolean;
  createdAt: number;
  updatedAt: number;
}

export type TriageStatus = "triaging" | "dispatched" | "declined" | "failed";

/** chat: a human message to a blocked, review or done ticket, answered by its agent with the work tools (the agent moves the ticket itself). */
export type RunKind = "plan" | "work" | "review" | "complete" | "conductor" | "triage" | "chat";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Run {
  id: string;
  sessionId: string;
  kind: RunKind;
  status: RunStatus;
  driver: string;
  prompt: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export type TranscriptRole = "user" | "assistant" | "tool" | "system";

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; output: ToolResultContent[]; isError: boolean }
  /** e.g. "Moved to review", "Run started (work)"; `permission` marks a permission decision (auto-approved, sent to a human, denied) */
  | { type: "status"; text: string; permission?: PermissionDecisionLog }
  | { type: "error"; text: string };

export interface TranscriptEntry {
  id: string;
  sessionId: string;
  runId: string | null;
  /**
   * The sub-agent that produced this entry (Subagent.id), or null for the session's own agent.
   * GET /sessions/:id/transcript leaves sub-agent entries out unless `?subagent=<id>` asks for
   * them. Optional so clients tolerate an older service without sub-agents.
   */
  subagentId?: string | null;
  seq: number;
  role: TranscriptRole;
  content: TranscriptContent;
  createdAt: number;
}

/**
 * A sub-agent an agent started inside its own session (Claude Code's Agent / Task tool), not a
 * ticket. Drivers report them with the "subagent" driver event; its conversation is the session's
 * transcript entries carrying its id as `subagentId` (DESIGN.md "Sub-agents").
 *
 * A background task (a Bash command or Monitor the agent left running, `kind` "bash" or
 * "monitor") is reported the same way. It has no conversation: its output is read with
 * GET /sessions/:id/subagents/:subagentId/output (TaskOutput).
 */
export interface Subagent {
  /** The id of the tool call that started it (unique within the session) */
  id: string;
  sessionId: string;
  /** The run it was started in */
  runId: string | null;
  /** The sub-agent that started this one (nested agents), else null */
  parentId: string | null;
  /** Short description of its task, e.g. "Find the auth middleware" */
  description: string;
  /** The kind of agent, e.g. "general-purpose", "Explore" (null when the driver doesn't say) */
  agentType: string | null;
  /** The instructions it was given */
  prompt: string;
  status: SubagentStatus;
  /** Its final report when it finished (or why it failed) */
  result: string | null;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
  /** "agent" (absent from older services), or the kind of background task */
  kind?: SubagentKind;
  /** A background task's command (null for agents) */
  command?: string | null;
  /** A background task has output to read (GET …/output) */
  hasOutput?: boolean;
}

/** stopped: its run ended (cancelled, failed, or the driver never reported an outcome) */
export type SubagentStatus = "running" | "succeeded" | "failed" | "stopped";

/** agent: a sub-agent; bash / monitor: a background task (a Bash command, a Monitor) */
export type SubagentKind = "agent" | "bash" | "monitor";

/**
 * A slice of a background task's output (GET /sessions/:id/subagents/:subagentId/output). Offsets
 * count bytes of the output. Without `offset` the route sends the tail (up to 256 KB); with one, the
 * output after it, skipping ahead to the tail when more than that came in since (`start` > the
 * offset asked for: a gap). Text is UTF-8 with terminal escapes removed.
 */
export interface TaskOutput {
  text: string;
  /** Where `text` starts in the output */
  start: number;
  /** Where it ends: pass it back as `offset` to read on */
  end: number;
  /** The output's size so far */
  size: number;
  /** The task finished: the output won't grow */
  done: boolean;
  /** false when there's no output to read (the file is gone, or the driver never said where it is) */
  available: boolean;
}

export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }; // base64

export type ActivityAuthor = "agent" | "human" | "system";

export type AttachmentKind = "image" | "video";

/**
 * A ticket's image or video (DESIGN.md "Spec revisions and attachments"), referenced from its spec
 * as `![alt](attachment:<id>)` and served at GET /attachments/:id. It lives until the ticket is
 * deleted.
 */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** e.g. "image/png", "video/mp4" */
  mimeType: string;
  /** The original file name, e.g. "after.png" */
  name: string;
  /** Bytes */
  size: number;
  /** Pixels, when known from the file header (images only) */
  width?: number;
  height?: number;
}

/**
 * A file attached to a New session's prompt (Ticket.promptAttachments). Unlike an Attachment it
 * isn't copied: `path` is where the file is on the service's machine, so it can go missing.
 */
export interface PromptAttachment {
  /** Absolute path on the service's machine */
  path: string;
  /** Display name: the file name when it was attached ("Pasted image.png" for a paste) */
  name: string;
  /**
   * "file": a file that was already on disk (dropped or picked on the Mac), referenced in place.
   * "upload": bytes the service stored with POST /uploads (a paste, or anything from the
   * iPhone/iPad), deleted with the ticket.
   */
  source: PromptAttachmentSource;
}

export type PromptAttachmentSource = "file" | "upload";

/**
 * A prompt attachment as clients send it: the name defaults to the file's. `source` is ignored by
 * the service, which decides it from where the file is; clients keep it in their local copy.
 */
export interface PromptAttachmentInput {
  path: string;
  name?: string;
  source?: PromptAttachmentSource;
}

/** Most prompt attachments one ticket takes. */
export const MAX_PROMPT_ATTACHMENTS = 20;

/**
 * What an Activity entry records (DESIGN.md "Activity"):
 * - note: an agent's short progress note (post_note)
 * - submitted: the work went to review (the submit note)
 * - spec_revised: a new spec revision (revision 1, written with the ticket, adds none); the body is
 *   the revision's note, meta.specRevision its number, the author who wrote it
 * - blocked: the agent (or a failure) asked the human something; meta.question
 * - unblocked: the agent picked a blocked ticket back up; meta.note when it gave one
 * - review_approved / changes_requested: an agent or conductor review decision; meta.round,
 *   meta.commit (the HEAD it reviewed), meta.by
 * - approved: a human (or conductor) approved the ticket
 * - message, answer: legacy. Older services logged a human's message from the Spec or Activity
 *   tab and the agent's reply; messages now go to the transcript only, and these are never written
 * - reopened: a done ticket went back to work; the notes
 * - moved: the ticket changed columns and no other entry records it (a drag, Start, Completed);
 *   meta.from / meta.to. Every column change is in Activity: an entry that records one itself
 *   (submitted, blocked, unblocked, changes_requested, reopened, …) carries meta.from / meta.to too
 * - failed: a run failed
 * - permission: a tool approval was asked for or answered
 * - system: anything else the service records (a worktree that couldn't be made, …)
 */
export const ACTIVITY_KINDS = [
  "note",
  "submitted",
  "spec_revised",
  "blocked",
  "unblocked",
  "review_approved",
  "changes_requested",
  "approved",
  "message",
  "answer",
  "reopened",
  "moved",
  "failed",
  "permission",
  "system",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** ActivityEntry.meta: typed extras per kind. Every field is optional. */
export interface ActivityMeta {
  /** blocked: the question (same as the ticket's blockedReason when it was posted) */
  question?: string;
  /** review_approved / changes_requested: the agent review round, 1 for the first review */
  round?: number;
  /** review_approved / changes_requested: the commit the reviewer looked at (git rev-parse HEAD) */
  commit?: string | null;
  /** review_approved / changes_requested / approved: who decided */
  by?: "agent" | "human" | "conductor";
  /** unblocked: what resolved it */
  note?: string;
  /** submitted: the spec revision the work was submitted at; spec_revised: the revision it records */
  specRevision?: number;
  /**
   * The full text when the body is its one-line summary: a review's request-changes notes, the
   * calls the classifier denied during a run
   */
  detail?: string;
  /** The column move this entry records: where the ticket was, and where it went */
  from?: TicketStatus;
  to?: TicketStatus;
}

export interface ActivityEntry {
  id: string;
  sessionId: string;
  ticketId: string | null;
  kind: ActivityKind;
  author: ActivityAuthor;
  /** One short line of markdown, e.g. "Fixed the button color; tests pass" (older entries can be longer) */
  body: string;
  meta: ActivityMeta;
  createdAt: number;
}

export type SpecRevisionAuthor = "agent" | "human" | "system";

/** GET /tickets/:key/spec/revisions: one revision's metadata, oldest first. */
export interface SpecRevisionInfo {
  rev: number;
  author: SpecRevisionAuthor;
  /** The run that wrote it (agent revisions), else null */
  runId: string | null;
  runKind: RunKind | null;
  /** What changed, in a few words (the edit_spec / update_spec note, "Created", "Edited by hand") */
  note: string;
  /** True on the revision the human approved by pressing Start */
  approvedBaseline: boolean;
  createdAt: number;
}

/** GET /tickets/:key/spec/revisions/:rev: a revision with its body. */
export interface SpecRevision extends SpecRevisionInfo {
  body: string;
}

/**
 * GET /tickets/:key/spec/revisions/:rev?diff=<otherRev>: a unified diff (parseDiff in
 * shared/src/diff.ts reads it) from revision `from` to `to`. `diff` is "" when they're the same.
 */
export interface SpecDiff {
  from: number;
  to: number;
  diff: string;
}

export interface Watcher {
  id: string;
  name: string;
  /**
   * What to run. With no args (the normal case) this is one shell command line, run through the
   * user's login shell (`$SHELL -lc <command>`), so PATH, pipes and `while true; do …; done`
   * loops work. With args (watchers created before prompts existed) it is an executable that is
   * spawned directly with those args and no shell. Whatever it prints on stdout becomes Inbox items.
   */
  command: string;
  /** Legacy direct-exec arguments; empty for shell command lines. See `command`. */
  args: string[];
  /** What the triage agent should do with this watcher's output, in the user's words ("" → none). */
  prompt: string;
  cwd: string | null;
  env: Record<string, string>;
  /**
   * "loop": run, read output until exit, re-run immediately (for blocking or long-running
   * commands). Each burst of output becomes one Inbox item.
   * "interval": run every intervalSec seconds. Each run's output becomes one Inbox item.
   */
  mode: "loop" | "interval";
  intervalSec: number;
  enabled: boolean;
  /** Driver used for triage sessions spawned from this watcher (null → settings.watcherDriver, then settings.defaultDriver) */
  driver: string | null;
  /**
   * Model per driver id for this watcher's triage sessions. Missing → settings.watcherModels, then
   * settings.defaultModels, then the driver's own default. PATCH merges per driver; null clears.
   * Optional so clients tolerate an older service without it.
   */
  models?: Record<string, string>;
  lastRunAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * What the watcher's process is doing right now. Not stored: the service fills it in from its
   * supervisor. Absent from services that don't report it (older builds, watchers switched off).
   */
  live?: WatcherLive;
}

/**
 * POST /watchers and PATCH /watchers/:id bodies: Watcher fields, with `models` as a per-driver
 * patch (merged over the stored map; null clears a driver's entry).
 */
export type WatcherBody = Partial<Omit<Watcher, "models">> & { models?: Record<string, string | null> };

/**
 * A watcher's process state. `running`: a process is alive (since `since`). `waiting`: between
 * runs; `nextRunAt` is the next interval tick or the loop's restart after its delay or failure
 * backoff (null while it waits on a previous process to stop). `stopped`: not supervised (disabled,
 * deleted, or the service is shutting down). Whether the last run failed is `Watcher.lastError`.
 */
export interface WatcherLive {
  state: "running" | "waiting" | "stopped";
  /** When this state began (ms) */
  since: number;
  nextRunAt: number | null;
  /** Consecutive failed runs; 0 after a clean exit */
  failures: number;
}

export interface DriverInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  authenticated: boolean;
  /** e.g. "mark@happycog.com · Happy Cog (team)" */
  detail: string;
  /** Whether POST /drivers/:id/login is supported */
  supportsLogin: boolean;
}

/** A model a driver can run with (GET /drivers/:id/models). */
export interface ModelInfo {
  /** Value passed to the driver (claude-code: --model alias or id; anthropic-api: model id) */
  id: string;
  name: string;
  description?: string;
  /** The model the driver uses when no model is chosen */
  default?: boolean;
}

/** GET /drivers/:id/models. Failures give models: [] (or a fallback list) plus error. */
export interface DriverModels {
  driverId: string;
  models: ModelInfo[];
  error: string | null;
  /** When the list was fetched (cached per driver) */
  fetchedAt: number;
}

/** Settings.browserIdleTabMinutes when unset, and its upper bound (a day). */
export const DEFAULT_BROWSER_IDLE_TAB_MINUTES = 5;
export const MAX_BROWSER_IDLE_TAB_MINUTES = 1440;

export interface Settings {
  defaultDriver: string;
  maxConcurrentRuns: number;
  /** Default permission mode (projects and tickets may override it). Default "auto". */
  permissionMode: PermissionMode;
  /** Who judges actions in auto mode for drivers without their own permission system */
  classifier: ClassifierBackend;
  /**
   * Model per driver id used when neither the ticket nor its project picks one.
   * Missing / null → the driver's own default. PATCH merges per driver; null clears.
   */
  defaultModels: Record<string, string | null>;
  /** Model per driver id for agent review runs. Missing / null → the same model as the work runs. */
  reviewModels: Record<string, string | null>;
  /**
   * Driver for triage sessions of watchers that don't pick one (null → defaultDriver). Optional so
   * clients tolerate an older service without it.
   */
  watcherDriver?: string | null;
  /**
   * Model per driver id for triage sessions of watchers that don't pick one. Missing / null →
   * defaultModels. PATCH merges per driver; null clears. Optional like watcherDriver.
   */
  watcherModels?: Record<string, string | null>;
  /** Stored API key for the anthropic-api driver (never sent back to clients in full) */
  anthropicApiKey: string | null;
  /**
   * Long-lived Claude token (from `claude setup-token`) the claude-code driver passes to the CLI as
   * CLAUDE_CODE_OAUTH_TOKEN, so runs don't depend on the login the CLI keeps in the Keychain, which
   * a service started by launchd may not be able to read. null → the CLI's own login. Never sent
   * back to clients (claudeOauthTokenSet instead); optional so clients tolerate an older service.
   */
  claudeOauthToken?: string | null;
  /**
   * Default base branch (projects and tickets may override it): what completed tickets merge into
   * and new ticket branches start from. A valid git branch name; default "main". The service
   * always sends it; optional so clients tolerate an older service without it.
   */
  baseBranch?: string;
  /**
   * Which addresses the service listens on (DESIGN.md "Network"). The service always sends it
   * (default { mode: "localhost" }); optional so clients tolerate an older service without it.
   */
  listen?: ListenSetting;
  /**
   * Minutes a session browser tab may go unused (no agent call, no viewer input) while nobody has
   * it open in the app before the service suspends it (closes its page; it reloads when used). 0 = never. Integer 0–1440, default 5. The
   * service always sends it; optional so clients tolerate an older service without it.
   */
  browserIdleTabMinutes?: number;
  /**
   * The user's prompt overrides (DESIGN.md "Prompt overrides"): prompt id → template text, or null
   * for the built-in prompt that ships with the service. The service sends every id; unset ones
   * are null, so they pick up the built-in text as it improves. PATCH merges per id; null or ""
   * resets one. Unknown ids and templates that don't parse or name variables the prompt doesn't
   * have are refused with a 400. Optional so clients tolerate an older service without it.
   */
  prompts?: Partial<Record<PromptId, string | null>>;
}

// ---------------------------------------------------------------------------
// Prompts (DESIGN.md "Prompt overrides")
// ---------------------------------------------------------------------------

/**
 * Every prompt the user can override. `system.*` are sections of a run's system prompt (the
 * service decides which sections a run gets and their order); `run.*` are the message that
 * starts a run. GET /prompts describes each one.
 */
export const PROMPT_IDS = [
  "system.intro",
  "system.context",
  "system.lifecycle",
  "system.plan",
  "system.work",
  "system.review",
  "system.complete_merge",
  "system.complete_pr",
  "system.complete_cleanup",
  "system.complete_custom",
  "system.conductor",
  "system.chat",
  "system.triage",
  "system.children",
  "system.branches",
  "system.files",
  "system.spec",
  "system.file_links",
  "system.board",
  "system.board_changes",
  "system.config",
  "system.approvals",
  "system.browser",
  "run.work_start",
  "run.conductor_start",
  "run.review",
  "run.complete_merge",
  "run.complete_pr",
  "run.complete_cleanup",
  "run.complete_custom",
  "run.conductor_update",
  "run.changes_requested",
  "run.reopen",
  "run.triage",
] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

/**
 * Prompt ids that were renamed, old → new. Overrides saved under an old id still apply (the
 * service migrates stored ones and maps any it's sent).
 */
export const RENAMED_PROMPT_IDS: Record<string, PromptId> = {
  "system.complete": "system.complete_merge",
  "run.complete": "run.complete_merge",
};
export type PromptGroup = "system" | "run";

export interface PromptVariable {
  name: string;
  description: string;
}

/**
 * GET /prompts: one entry per PromptId, in PROMPT_IDS order. Templates use `{{name}}` and
 * `{{#if name}} … {{else if other}} … {{else}} … {{/if}}` (shared/src/templates.ts); text outside
 * tags is kept exactly.
 */
export interface PromptEntry {
  id: PromptId;
  group: PromptGroup;
  /** Short name for a settings list, e.g. "Work run instructions" */
  label: string;
  /** One line: where the prompt is used */
  description: string;
  /** The variables the template may use; anything else is refused on save */
  variables: PromptVariable[];
  /** The built-in template (the starting point for an edit) */
  builtin: string;
  /** The user's template, or null when the built-in is used */
  override: string | null;
  /**
   * Why a stored override is no longer used (it names a variable this version of the prompt
   * doesn't have, for example), or null. Runs fall back to the built-in while it's set.
   */
  overrideError: string | null;
}

// ---------------------------------------------------------------------------
// Network (listen addresses, pairing)
// ---------------------------------------------------------------------------

/**
 * localhost → 127.0.0.1 · tailscale → the Tailscale IPv4 + 127.0.0.1 · any → 0.0.0.0 ·
 * custom → `host` (must be a local interface address) + 127.0.0.1.
 */
export const LISTEN_MODES = ["localhost", "tailscale", "any", "custom"] as const;
export type ListenMode = (typeof LISTEN_MODES)[number];

export interface ListenSetting {
  mode: ListenMode;
  /** Hostname or IP for mode "custom" */
  host?: string;
}

export interface BoundAddress {
  /** The address a listener is bound to, e.g. "127.0.0.1", "100.107.188.66", "0.0.0.0" */
  address: string;
  /** http://<address>:<port> (IPv6 in brackets) */
  url: string;
}

/** GET /network */
export interface NetworkStatus {
  /** The configured mode (settings.listen.mode, or HARNESS_HOST's) */
  mode: ListenMode;
  /** The configured custom host (mode "custom"), else null */
  host: string | null;
  port: number;
  /** Listeners that are up right now. Always includes loopback (127.0.0.1 or 0.0.0.0). */
  bound: BoundAddress[];
  /** The mode the bound listeners serve; differs from `mode` while falling back to localhost */
  active: ListenMode;
  /** Tailscale on this machine, when it is running */
  tailscale: { ip: string; dnsName: string | null } | null;
  /** Why the configured mode isn't bound (boot fallback, failed rebind), else null */
  error: string | null;
  /** HARNESS_HOST when it overrides the setting (the setting can't be changed then) */
  override: string | null;
}

/** GET /pairing: what a phone needs to connect. `pairUrl` is what the QR code encodes. */
export interface PairingInfo {
  /** Base URL on the best reachable non-loopback address, e.g. http://100.107.188.66:7717 */
  url: string;
  token: string;
  /** harness://pair?url=<encodeURIComponent(url)>&token=<encodeURIComponent(token)> */
  pairUrl: string;
}

// ---------------------------------------------------------------------------
// Events (service → client over WebSocket)
// ---------------------------------------------------------------------------

export type HarnessEvent =
  | { kind: "project.upserted"; project: Project }
  | { kind: "project.deleted"; id: string }
  | { kind: "ticket.upserted"; ticket: Ticket }
  | { kind: "ticket.deleted"; id: string }
  | { kind: "session.upserted"; session: Session }
  | { kind: "session.deleted"; id: string }
  | { kind: "run.upserted"; run: Run }
  | { kind: "transcript.appended"; entry: TranscriptEntry }
  | { kind: "subagent.upserted"; subagent: Subagent }
  /** Ephemeral streaming text; the full block is persisted later as transcript.appended */
  | { kind: "transcript.delta"; sessionId: string; runId: string; text: string }
  | { kind: "activity.added"; entry: ActivityEntry }
  /**
   * A new spec revision; the ticket.upserted that follows carries the new body. Services from
   * before runId / runKind / createdAt omit them.
   */
  | { kind: "spec.revised"; ticketId: string; rev: number; author: SpecRevisionAuthor; note: string; runId?: string | null; runKind?: RunKind | null; createdAt?: number }
  | { kind: "watcher.upserted"; watcher: Watcher }
  | { kind: "watcher.deleted"; id: string }
  | { kind: "settings.updated"; settings: PublicSettings }
  /** `tabId`: the tab the frame is from (services before browser tabs omit it) */
  | { kind: "browser.frame"; sessionId: string; tabId?: number; data: string; width: number; height: number }
  | { kind: "browser.state"; sessionId: string; state: BrowserState }
  /** The service's code on disk changed since it started (or changed back) */
  | { kind: "service.status"; status: ServiceStatus };

/**
 * Whether the service runs the code on disk. `stale`: the checkout changed since it started; it
 * restarts onto the new code by itself once no runs are active. `build` is null when the service
 * doesn't track its source (tests, embedded services).
 */
export interface ServiceStatus {
  build: string | null;
  stale: boolean;
}

/**
 * GET /health (unauthenticated). Services from before build tracking omit `build` and `stale`.
 * `release`: the newest app-* release tag the service's code includes (null when it can't tell);
 * services from before it omit it.
 */
export interface Health extends Partial<ServiceStatus> {
  ok: true;
  version: string;
  pid: number;
  release?: string | null;
}

export type PublicSettings = Omit<Settings, "anthropicApiKey" | "claudeOauthToken"> & {
  anthropicApiKeySet: boolean;
  /** Whether a claudeOauthToken is stored. Services from before it omit it. */
  claudeOauthTokenSet?: boolean;
};

/**
 * A session's browser as one viewer (or tool call) sees it: the tab it is on (`tabId`, with that
 * tab's url, title and loading) and every open tab. Services from before browser tabs omit
 * `tabId` and `tabs`.
 */
export interface BrowserState {
  sessionId: string;
  tabId?: number;
  url: string;
  title: string;
  loading: boolean;
  /** The tab's page is closed to save memory (unused for a while, or the ticket is done); it reloads its URL when opened. Absent: false. */
  suspended?: boolean;
  tabs?: BrowserTab[];
}

/** One tab of a session's browser. Ids count up from 1 per session and are never reused. */
export interface BrowserTab {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  /** Its page is closed to save memory; watching it or an agent using it reloads its URL. Absent: false. */
  suspended?: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

/** Client → service */
export type ClientMessage =
  | { type: "hello"; client: string }
  /**
   * Watch a session's browser. `tabId` picks the tab (omitted, or a tab that has closed: the
   * lowest open one); subscribing again with another `tabId` switches this socket to that tab.
   */
  | { type: "browser.subscribe"; sessionId: string; tabId?: number }
  | { type: "browser.unsubscribe"; sessionId: string }
  /** `tabId`: the tab the input is for (omitted: the tab this socket watches). */
  | { type: "browser.input"; sessionId: string; tabId?: number; input: BrowserInput }
  | { type: "ping" };

export type BrowserInput =
  | { type: "mouse"; action: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number; deltaX?: number; deltaY?: number }
  | { type: "key"; action: "down" | "up"; key: string; code: string; text?: string; modifiers?: number }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  /** The size of every tab in the session */
  | { type: "resize"; width: number; height: number }
  /** Open a tab (at `url`, else about:blank) and switch this socket to it */
  | { type: "newTab"; url?: string }
  /** Close the input's tab; closing the last one leaves a blank tab in its place */
  | { type: "closeTab" };

/** Service → client */
export type ServerMessage =
  | { type: "welcome"; version: string }
  | { type: "event"; event: HarnessEvent }
  | { type: "pong" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// REST API request bodies (responses are the entities above, wrapped as { data })
// ---------------------------------------------------------------------------

export interface CreateProjectBody {
  path: string;
  name?: string;
  key?: string;
  defaultDriver?: string | null;
  useWorktrees?: boolean;
  /** Project.skipAgentReview: new tickets skip their agent review by default. Default false. */
  skipAgentReview?: boolean;
  /** Project.skipHumanReview: new tickets skip their human review by default. Default false. */
  skipHumanReview?: boolean;
  /** @deprecated From older apps: false means skipHumanReview true. Ignored with skipHumanReview. */
  requireHumanReview?: boolean;
  /** Preset id from PROJECT_COLORS or "#rrggbb"; null or "" → the theme's accent */
  color?: string | null;
  /** null → settings.permissionMode */
  permissionMode?: PermissionMode | null;
  /** Per-driver default models; PATCH merges per driver, null clears one */
  defaultModels?: Record<string, string | null>;
  /** A valid branch name; null or "" → inherit settings.baseBranch */
  baseBranch?: string | null;
  /** The default completion action; must be one the project offers. Default "merge". */
  completionAction?: CompletionAction;
}

export interface CreateTicketBody {
  projectId: string;
  /**
   * The ticket's spec: revision 1, and the first run's message. Title is derived from it when
   * title is omitted.
   */
  spec: string;
  title?: string;
  kind?: TicketKind;
  driver?: string;
  /** Model for this ticket's runs (null / omitted → defaults) */
  model?: string | null;
  /** Permission mode override (null / omitted → project → settings) */
  permissionMode?: PermissionMode | null;
  /** Skip planning and start work right away (default true for quick sessions) */
  start?: boolean;
  /** Worktree for this ticket: false → the project checkout (null / omitted → project.useWorktrees) */
  useWorktree?: boolean | null;
  /**
   * The branch the ticket's worktree checks out (Ticket.requestedBranch). null / omitted / "" →
   * harness/<key>. An existing local branch is checked out as is (the ticket blocks if another
   * worktree has it checked out); a new name is created from the base branch. Needs a worktree:
   * refused with useWorktree false. Pick names from GET /projects/:id/branches.
   */
  branch?: string | null;
  /** Base branch override (Ticket.baseBranch); null / "" → inherit the project's */
  baseBranch?: string | null;
  /** Skip the agent review when the ticket is submitted (Ticket.skipAgentReview). Default: the project's. */
  skipAgentReview?: boolean;
  /** Skip the human review: the ticket lands once its agent review passes (Ticket.skipHumanReview). Default: the project's. */
  skipHumanReview?: boolean;
  dependsOn?: string[];
  autoStart?: boolean;
  parentId?: string | null;
  /**
   * Use this key instead of the next native key. Only for imports and tests: watcher tickets get
   * native keys and carry the remote ID in externalRef.
   */
  key?: string;
  externalRef?: ExternalRef | null;
  /**
   * Save it as a draft (Ticket.draft): created in planning with no run, whatever `start` says.
   * POST /tickets/:key/submit launches it later. The prompt may be empty for a draft.
   */
  draft?: boolean;
  /**
   * Files to attach to the prompt (Ticket.promptAttachments): absolute paths on the service's
   * machine, each existing now (400 otherwise), at most MAX_PROMPT_ATTACHMENTS. Pastes and files
   * from another device go through POST /uploads first.
   */
  promptAttachments?: PromptAttachmentInput[];
}

export interface UpdateTicketBody {
  title?: string;
  /** A new spec revision, written by the human. Needs baseRevision unless the ticket is a draft. */
  spec?: string;
  /**
   * The spec revision the edit started from (Ticket.specRevision when the editor opened). A spec
   * that moved on since answers 409 with the current revision in `data` (SpecConflict), so a
   * human's edit never overwrites an agent's without them seeing it.
   */
  baseRevision?: number;
  /** A few words on what the edit changed, kept with the revision (default "Edited by hand") */
  specNote?: string;
  status?: TicketStatus; // manual moves from the board
  /** Changing the driver clears the model unless `model` is given too */
  driver?: string;
  /** Applies from the next run (claude-code resumes the conversation with the new --model) */
  model?: string | null;
  /** Applies from the next tool call / run; null → inherit from the project / settings */
  permissionMode?: PermissionMode | null;
  /** Base branch override; null / "" → inherit the project's. Applies from the next run. */
  baseBranch?: string | null;
  /**
   * The branch for the ticket's worktree (see CreateTicketBody.branch). Only while the ticket has
   * no worktree (409 once it has one: its agent re-points it with the update_branch tool).
   */
  branch?: string | null;
  /**
   * Ticket.skipAgentReview. Turning it on while the ticket waits on its agent review skips that
   * review (a queued review run is dropped); turning it off while the review is "skipped" starts one.
   */
  skipAgentReview?: boolean;
  /**
   * Ticket.skipHumanReview. Turning it on while the ticket waits on its human review approves it
   * (the ticket lands once its agent review passes); turning it off while a review it approved
   * hasn't started landing puts the human review back to pending.
   */
  skipHumanReview?: boolean;
  dependsOn?: string[];
  position?: number;
  /** Link the ticket to a remote ID by hand (source "manual"), or null to unlink it */
  externalRef?: ExternalRefInput | null;
  /** Drafts only (409 otherwise): what the ticket is, fixed once it launches */
  kind?: TicketKind;
  /** Drafts only (409 otherwise): Ticket.useWorktree, fixed once it launches */
  useWorktree?: boolean | null;
  /**
   * Drafts only (409 otherwise): move the draft to another project. It takes that project's next
   * key; the old key is kept as an alias (like a project rename), so open panes follow it.
   */
  projectId?: string;
  /**
   * Drafts only (409 otherwise): the whole new list of prompt attachments. New paths must exist;
   * ones the draft already had are kept as they are, even when their file has gone missing.
   */
  promptAttachments?: PromptAttachmentInput[];
}

/** POST /tickets/:key/submit: launch a draft, starting work now (start) or planning first. */
export interface SubmitTicketBody {
  start: boolean;
}

/**
 * One local branch of a project's repository, from GET /projects/:id/branches?q=&limit=
 * (ApiClient.projectBranches), for the new-session branch picker. Most recent commit first; `q`
 * filters case-insensitively (substring matches first, then names containing q's characters in
 * order); `limit` defaults to 50 (max 200). A project that isn't a git repo gives [].
 */
export interface BranchInfo {
  /** Short name, e.g. "main", "medl-1223-ai-app", "harness/web-3" */
  name: string;
  /** Committer date of the branch tip (ms) */
  lastCommitAt: number;
  /**
   * Path of a worktree that has the branch checked out (the main checkout included), else null.
   * A new ticket can't take a branch that is checked out elsewhere: it would block.
   */
  checkedOutAt: string | null;
}

/**
 * Where a file stands in git (GET /…/file). All false when the root isn't in a repository.
 * `dirty` is any difference from HEAD (staged, unstaged, or untracked); an ignored file is
 * neither tracked nor untracked, and never dirty.
 */
export interface FileGitState {
  repo: boolean;
  tracked: boolean;
  dirty: boolean;
  untracked: boolean;
  ignored: boolean;
}

/**
 * A project or ticket file for the file viewer (GET /projects/:id/file, /tickets/:key/file), read
 * from disk, gitignored files included. `contents` is null for binary files (a NUL in the first
 * 8 KB) and files over 2 MiB (`tooLarge`). `truncated` means `contents` is only the start of the
 * file: it grew past the cap while being read.
 */
export interface FileView {
  /** Relative to `root`, "/"-separated */
  path: string;
  /** The folder the path is resolved in: the ticket's worktree, else its session's cwd, else the project folder */
  root: string;
  size: number;
  contents: string | null;
  binary: boolean;
  truncated: boolean;
  tooLarge: boolean;
  git: FileGitState;
}

/**
 * One file's uncommitted changes (GET /…/file/diff): the working tree against HEAD, staged and
 * unstaged together; an untracked file shows as added. `patch` is a unified git diff ("" when the
 * file is clean or ignored). Either side's contents is null when it doesn't exist there, is binary,
 * or is over 2 MiB. A root outside any git repository is a 409.
 */
export interface FileDiff {
  path: string;
  patch: string;
  oldContents: string | null;
  newContents: string | null;
  /** The patch is over 4 MiB, so `patch` is "" even though the file changed */
  tooLarge: boolean;
}

/** Options for the /files search. `ignored` also indexes node_modules; `kind` keeps one kind. */
export interface FileSearchOptions {
  limit?: number;
  ignored?: boolean;
  kind?: "file" | "dir";
}

export interface HumanReviewBody {
  decision: "approve" | "request_changes";
  notes?: string;
  /**
   * With "approve": how the work lands once the ticket is ready (kept on the ticket until then).
   * Omitted → the ticket's earlier choice, else the project default. Must be one the ticket offers.
   */
  action?: CompletionAction;
  /** With "approve": instructions for the completion run (required in spirit for custom). */
  instructions?: string;
}

/** POST /tickets/:key/messages */
export interface MessageBody {
  text: string;
  /**
   * true: move the ticket before its agent gets the message: a review ticket back to in
   * progress, a done one re-opened. Default: the ticket stays where it is and its agent moves it
   * (planning → the plan run; blocked, review, done → a chat run with the work tools).
   */
  move?: boolean;
}

/** The `data` of PATCH /tickets/:key's 409 when baseRevision isn't the current spec revision. */
export interface SpecConflict {
  currentRevision: number;
  spec: string;
}

/** Re-open a done ticket: back to in progress, with notes for the agent */
export interface ReopenBody {
  notes: string;
}

export interface ApprovalBody {
  /** allow_once: this exact call; allow_tool: every future call of this tool on this ticket; deny */
  decision: "allow_once" | "allow_tool" | "deny";
  /** Optional note passed to the agent (why denied / what to do instead) */
  message?: string;
}

export interface CompleteBody {
  /** How the work lands; omitted → the choice made at approval, else the project default. */
  action?: CompletionAction;
  /** Extra instructions for the completion run, e.g. "merge into main" */
  instructions?: string;
  /**
   * Mark done without running the agent ("Approve and take no action"): on a ticket in review this
   * also records the human approval.
   */
  skipAgent?: boolean;
}

export interface TicketDetail {
  /**
   * Set when the requested key is an old key of this ticket (from before a project rename):
   * the key that was asked for. `ticket.key` is the current key; clients should show and
   * link that one instead (e.g. replace the URL).
   */
  resolvedFrom?: string;
  ticket: Ticket;
  session: Session;
  /** The ticket's Activity, oldest first */
  activity: ActivityEntry[];
  runs: Run[];
  dependents: string[];
  children: Ticket[];
  /** The conductor this ticket belongs to (when parentId is set), so clients can show the
   *  "Part of …" breadcrumb even when the parent isn't loaded (e.g. a done conductor off-page). */
  parent?: Ticket | null;
  /** Sub-agents started in the ticket's session, oldest first (absent from older services) */
  subagents?: Subagent[];
  /**
   * Other tickets carrying a remote ID equal to the requested key or to this ticket's own remote
   * ID, newest first. Absent from older services.
   */
  relatedTickets?: RelatedTicket[];
}

/**
 * The `data` of GET /tickets/:key's 404 when no local key matches but tickets carry the requested
 * key as their remote ID: a remote ID never opens a ticket, it points to the local ones.
 */
export interface RemoteKeyMatches {
  requested: string;
  relatedTickets: RelatedTicket[];
}

export interface ApiOk<T> {
  data: T;
}
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// Plugins (DESIGN.md "Plugins")
// ---------------------------------------------------------------------------

/**
 * When a plugin tab shows on a ticket (evaluated by the service in GET /tickets/:key/tabs):
 * - "always":   every ticket
 * - "workdir":  ticket.workdir is set, exists on disk, and is inside a git work tree
 * - "worktree": ticket.branch is set and ticket.workdir exists on disk (the ticket's own git
 *               worktree: a harness worktree, or the one update_branch re-pointed it to)
 */
export type TicketTabWhen = "always" | "workdir" | "worktree";

export interface PluginTab {
  pluginId: string;
  id: string;
  title: string;
  /** Icon name from the app's icon set (hosts fall back to a generic icon) */
  icon: string | null;
  when: TicketTabWhen;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** "builtin" (<repo>/plugins) or "user" ($HARNESS_HOME/plugins) */
  source: "builtin" | "user";
  hasServer: boolean;
  hasUi: boolean;
  tabs: PluginTab[];
  /** Set when the manifest or server module failed to load; the plugin's routes and tabs are disabled */
  error: string | null;
}

/**
 * The app's color theme as sent to plugins, next to the resolved `theme: "light" | "dark"` every
 * plugin already reads. Additive: hosts older than themes omit these fields.
 */
export interface PluginThemeFields {
  /** Same as `theme` (the resolved appearance) */
  appearance?: "light" | "dark";
  /** Theme id, e.g. "catppuccin-mocha" (see @harness/shared/themes) */
  themeId?: string;
  themeName?: string;
  /** Shiki theme matching the app theme, or null when none ships */
  syntaxTheme?: string | null;
  /** Semantic color tokens (ThemeTokens): bg, text, accent, status colors, diff colors, … */
  tokens?: Record<string, string>;
}

/** Host (app) → plugin iframe. Sent with targetOrigin = the service origin. */
export type PluginHostMessage =
  | ({ type: "harness:init"; baseUrl: string; token: string; ticketKey: string; tabId: string; theme: "light" | "dark" } & PluginThemeFields)
  | ({ type: "harness:theme"; theme: "light" | "dark" } & PluginThemeFields)
  | { type: "harness:ticket"; ticket: Ticket };

/** Plugin iframe → host (app). The host only accepts these from its own iframe at the service origin. */
export type PluginFrameMessage =
  | { type: "harness:ready" }
  | { type: "harness:openExternal"; url: string }
  | { type: "harness:navigate"; ticketKey: string };
