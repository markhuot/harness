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
  /** When false, the human review step is skipped (agent review alone gates completion) */
  requireHumanReview: boolean;
  /**
   * When true, a top-level ticket starts its complete run (merge + clean up) as soon as both
   * reviews approve, instead of waiting for a human to press Complete. Conductor children are
   * left to their conductor.
   */
  autoComplete: boolean;
  /** Permission mode for this project's tickets (null → settings.permissionMode) */
  permissionMode: PermissionMode | null;
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
  /** e.g. "Moved to review", "Run started (work)"; `permission` marks a permission decision (auto-approved, sent to a human, denied) */
  | { type: "status"; text: string; permission?: PermissionDecisionLog }
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
  /** Driver used for triage sessions spawned from this watcher (null → settings default) */
  driver: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
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
  /** Stored API key for the anthropic-api driver (never sent back to clients in full) */
  anthropicApiKey: string | null;
  /**
   * Which addresses the service listens on (DESIGN.md "Network"). The service always sends it
   * (default { mode: "localhost" }); optional so clients tolerate an older service without it.
   */
  listen?: ListenSetting;
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
  /** Ephemeral streaming text; the full block is persisted later as transcript.appended */
  | { kind: "transcript.delta"; sessionId: string; runId: string; text: string }
  | { kind: "summary.added"; summary: Summary }
  | { kind: "watcher.upserted"; watcher: Watcher }
  | { kind: "watcher.deleted"; id: string }
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
  autoComplete?: boolean;
  /** null → settings.permissionMode */
  permissionMode?: PermissionMode | null;
  /** Per-driver default models; PATCH merges per driver, null clears one */
  defaultModels?: Record<string, string | null>;
}

export interface CreateTicketBody {
  projectId: string;
  /** First message / brief. Title is derived from it when title is omitted. */
  prompt: string;
  title?: string;
  kind?: TicketKind;
  driver?: string;
  /** Model for this ticket's runs (null / omitted → defaults) */
  model?: string | null;
  /** Permission mode override (null / omitted → project → settings) */
  permissionMode?: PermissionMode | null;
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
  /** Changing the driver clears the model unless `model` is given too */
  driver?: string;
  /** Applies from the next run (claude-code resumes the conversation with the new --model) */
  model?: string | null;
  /** Applies from the next tool call / run; null → inherit from the project / settings */
  permissionMode?: PermissionMode | null;
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
  /** Extra instructions for the completion run, e.g. "merge into main" */
  instructions?: string;
  /** Mark done without running the agent */
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
  summaries: Summary[];
  runs: Run[];
  dependents: string[];
  children: Ticket[];
  /** The conductor this ticket belongs to (when parentId is set), so clients can show the
   *  "Part of …" breadcrumb even when the parent isn't loaded (e.g. a done conductor off-page). */
  parent?: Ticket | null;
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
