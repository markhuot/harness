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
  /** When the project path is a git repo, give each ticket its own worktree + branch */
  useWorktrees: boolean;
  /** When false, the human review step is skipped (agent review alone gates completion) */
  requireHumanReview: boolean;
  createdAt: number;
  updatedAt: number;
}

export const TICKET_STATUSES = ["planning", "in_progress", "blocked", "review", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type ReviewState = "pending" | "approved" | "changes_requested";

export type TicketKind = "task" | "conductor";

export interface Ticket {
  id: string;
  /** Jira-style key: native (NYTIMES-3) or mirrored from an external system (FOO-123) */
  key: string;
  projectId: string;
  kind: TicketKind;
  title: string;
  /** The brief / plan. Humans edit this in planning; the planning agent may update it. */
  description: string;
  status: TicketStatus;
  /** The session holding this ticket's transcript */
  sessionId: string;
  driver: string;
  /** Conductor that owns this ticket, if any */
  parentId: string | null;
  /** Keys of tickets that must be done before this one can start */
  dependsOn: string[];
  /** Start automatically once every dependency is done (used by conductors) */
  autoStart: boolean;
  agentReview: ReviewState;
  humanReview: ReviewState;
  /** Mirrored external ticket, when this came from a watcher */
  externalRef: ExternalRef | null;
  /** Directory the agent runs in (project path or a worktree) */
  workdir: string | null;
  /** Git branch when running in a worktree */
  branch: string | null;
  /** Why the ticket is blocked (question for the human), when status = blocked */
  blockedReason: string | null;
  /** True while any agent run for this ticket is queued or running */
  busy: boolean;
  /** A tool-permission request waiting on a human (claude-code driver). Ticket is blocked meanwhile. */
  pendingApproval: PendingApproval | null;
  /** Tools the human has allowed for every future call on this ticket ("Bash", "WebFetch", ...) */
  allowedTools: string[];
  /** Sort order within a column */
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface PendingApproval {
  id: string;
  runId: string;
  /** Tool the agent wants to use, e.g. "Bash" */
  toolName: string;
  /** The tool input, e.g. { command: "npm install" } */
  input: unknown;
  requestedAt: number;
}

export interface ExternalRef {
  source: string; // watcher name, e.g. "jira"
  key: string; // FOO-123
  url: string | null;
  raw: unknown; // the original item emitted by the watcher
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

export type RunKind = "plan" | "work" | "review" | "complete" | "conductor" | "triage";
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
  | { type: "status"; text: string } // e.g. "Moved to review", "Run started (work)"
  | { type: "error"; text: string };

export interface TranscriptEntry {
  id: string;
  sessionId: string;
  runId: string | null;
  seq: number;
  role: TranscriptRole;
  content: TranscriptContent;
  createdAt: number;
}

export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }; // base64

export type SummaryAuthor = "agent" | "human" | "system";

export interface Summary {
  id: string;
  sessionId: string;
  ticketId: string | null;
  author: SummaryAuthor;
  /** Short markdown update, e.g. "Implemented X; tests pass; next: Y" */
  body: string;
  createdAt: number;
}

export interface Watcher {
  id: string;
  name: string;
  /** Executable + args; spawned with a shell-less exec. Emits NDJSON work items on stdout. */
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  /**
   * "loop": run, read lines until exit, re-run immediately (for blocking watchers like watch-jira).
   * "interval": run every intervalSec seconds.
   */
  mode: "loop" | "interval";
  intervalSec: number;
  enabled: boolean;
  /** Driver used for triage sessions spawned from this watcher (null → settings default) */
  driver: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A normalized work item parsed from one watcher output line. */
export interface WorkItem {
  key: string;
  title: string;
  url: string | null;
  /** Used to dedupe: same key + same version is ignored */
  version: string | null;
  raw: unknown;
}

/** Maps external ticket keys to local projects. pattern is a key prefix ("FOO") or /regex/. */
export interface Mapping {
  id: string;
  pattern: string;
  projectId: string;
  notes: string;
  createdAt: number;
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

export interface Settings {
  defaultDriver: string;
  maxConcurrentRuns: number;
  /** claude-code driver: permission mode passed to the CLI */
  claudePermissionMode: "bypassPermissions" | "acceptEdits" | "auto" | "dontAsk";
  claudeModel: string | null;
  anthropicModel: string;
  /** Stored API key for the anthropic-api driver (never sent back to clients in full) */
  anthropicApiKey: string | null;
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
  /** Ephemeral streaming text; the full block is persisted later as transcript.appended */
  | { kind: "transcript.delta"; sessionId: string; runId: string; text: string }
  | { kind: "summary.added"; summary: Summary }
  | { kind: "watcher.upserted"; watcher: Watcher }
  | { kind: "watcher.deleted"; id: string }
  | { kind: "mapping.upserted"; mapping: Mapping }
  | { kind: "mapping.deleted"; id: string }
  | { kind: "settings.updated"; settings: PublicSettings }
  | { kind: "browser.frame"; sessionId: string; data: string; width: number; height: number }
  | { kind: "browser.state"; sessionId: string; state: BrowserState };

export type PublicSettings = Omit<Settings, "anthropicApiKey"> & { anthropicApiKeySet: boolean };

export interface BrowserState {
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

/** Client → service */
export type ClientMessage =
  | { type: "hello"; client: string }
  | { type: "browser.subscribe"; sessionId: string }
  | { type: "browser.unsubscribe"; sessionId: string }
  | { type: "browser.input"; sessionId: string; input: BrowserInput }
  | { type: "ping" };

export type BrowserInput =
  | { type: "mouse"; action: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number; deltaX?: number; deltaY?: number }
  | { type: "key"; action: "down" | "up"; key: string; code: string; text?: string; modifiers?: number }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "resize"; width: number; height: number };

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
  requireHumanReview?: boolean;
}

export interface CreateTicketBody {
  projectId: string;
  /** First message / brief. Title is derived from it when title is omitted. */
  prompt: string;
  title?: string;
  kind?: TicketKind;
  driver?: string;
  /** Skip planning and start work right away (default true for quick sessions) */
  start?: boolean;
  dependsOn?: string[];
  autoStart?: boolean;
  parentId?: string | null;
  /** Use this key instead of the next native key (external mirrors) */
  key?: string;
  externalRef?: ExternalRef | null;
}

export interface UpdateTicketBody {
  title?: string;
  description?: string;
  status?: TicketStatus; // manual moves from the board
  driver?: string;
  dependsOn?: string[];
  position?: number;
}

export interface MessageBody {
  text: string;
}

export interface HumanReviewBody {
  decision: "approve" | "request_changes";
  notes?: string;
}

export interface ApprovalBody {
  /** allow_once: this exact call; allow_tool: every future call of this tool on this ticket; deny */
  decision: "allow_once" | "allow_tool" | "deny";
  /** Optional note passed to the agent (why denied / what to do instead) */
  message?: string;
}

export interface CompleteBody {
  /** Extra instructions for the completion run, e.g. "merge into main" */
  instructions?: string;
  /** Mark done without running the agent */
  skipAgent?: boolean;
}

export interface TicketDetail {
  ticket: Ticket;
  session: Session;
  summaries: Summary[];
  runs: Run[];
  dependents: string[];
  children: Ticket[];
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
 * - "worktree": ticket.branch is set and ticket.workdir exists on disk (a harness worktree)
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

/** Host (app) → plugin iframe. Sent with targetOrigin = the service origin. */
export type PluginHostMessage =
  | { type: "harness:init"; baseUrl: string; token: string; ticketKey: string; tabId: string; theme: "light" | "dark" }
  | { type: "harness:theme"; theme: "light" | "dark" }
  | { type: "harness:ticket"; ticket: Ticket };

/** Plugin iframe → host (app). The host only accepts these from its own iframe at the service origin. */
export type PluginFrameMessage =
  | { type: "harness:ready" }
  | { type: "harness:openExternal"; url: string }
  | { type: "harness:navigate"; ticketKey: string };
