// Thin typed client for the harness service. Used by the desktop app and service tests.
// Works in Bun, Node 22+, Electron renderers and browsers (fetch + WebSocket globals).

import type {
  SubmitTicketBody,
  ClientMessage,
  CompleteBody,
  CreateProjectBody,
  CreateTicketBody,
  DriverInfo,
  DriverModels,
  FileDiff,
  FileSearchOptions,
  FileView,
  HarnessEvent,
  Health,
  HumanReviewBody,
  MessageBody,
  ReopenBody,
  ApprovalBody,
  BranchInfo,
  Project,
  Subagent,
  TaskOutput,
  PromptEntry,
  PublicSettings,
  ServerMessage,
  Session,
  Settings,
  Summary,
  Ticket,
  TicketDetail,
  TicketPage,
  TicketStatus,
  TranscriptEntry,
  UpdateTicketBody,
  Watcher,
  WatcherBody,
  BrowserState,
  PluginInfo,
  PluginTab,
  NetworkStatus,
  PairingInfo,
} from "./protocol";
import type { FileMatch } from "./mentions";
import type { CommandMatch } from "./commands";

/** The /files query: a bare number is the limit (the autocomplete's older call shape). */
function fileSearchQuery(q: string, opts: number | FileSearchOptions = {}): string {
  const o = typeof opts === "number" ? { limit: opts } : opts;
  return query({ q, limit: o.limit, ignored: o.ignored ? 1 : undefined, kind: o.kind });
}

export class HarnessApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The error response's `data`, when the service sent one (e.g. RemoteKeyMatches on a 404) */
    public data?: unknown,
  ) {
    super(message);
  }
}

export interface HarnessClientOptions {
  baseUrl: string; // http://127.0.0.1:7717
  token: string;
}

/** `?a=1&b=2` from the defined, non-empty values (or "" when there are none). */
function query(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export class HarnessClient {
  constructor(private opts: HarnessClientOptions) {}

  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }

  /** The bearer token (hosts hand it to plugin iframes in harness:init). */
  get token() {
    return this.opts.token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new HarnessApiError(res.status, json.error ?? res.statusText, json.data);
    return json.data as T;
  }

  health() {
    return this.request<Health>("GET", "/health");
  }
  /** Restart the service now (it exits and launchd starts it again). Running agents are stopped. */
  restartService() {
    return this.request<{ ok: true }>("POST", "/service/restart");
  }

  // Projects
  listProjects() {
    return this.request<Project[]>("GET", "/projects");
  }
  createProject(body: CreateProjectBody) {
    return this.request<Project>("POST", "/projects", body);
  }
  updateProject(id: string, body: Partial<CreateProjectBody>) {
    return this.request<Project>("PATCH", `/projects/${id}`, body);
  }
  deleteProject(id: string) {
    return this.request<{ ok: true }>("DELETE", `/projects/${id}`);
  }
  /**
   * Files and folders in the project folder matching `q`, for @-mentions in a new session. The file
   * browser passes `{ ignored: true }` to search node_modules too, and `kind: "file"` for files only.
   */
  projectFiles(id: string, q: string, opts?: number | FileSearchOptions) {
    return this.request<FileMatch[]>("GET", `/projects/${id}/files${fileSearchQuery(q, opts)}`);
  }
  /**
   * Slash commands and skills matching `q` that a new session's agent (`driver`, default: the
   * project's) offers in the project folder, for the `/command` autocomplete. [] when it has none.
   */
  projectCommands(id: string, q: string, opts: { driver?: string | null; limit?: number } = {}) {
    return this.request<CommandMatch[]>("GET", `/projects/${id}/commands${query({ q, driver: opts.driver || undefined, limit: opts.limit })}`);
  }
  /** A file in the project folder, read from disk, and where it stands in git. */
  projectFile(id: string, path: string) {
    return this.request<FileView>("GET", `/projects/${id}/file${query({ path })}`);
  }
  /** A project file's uncommitted changes against HEAD (409 outside a git repository). */
  projectFileDiff(id: string, path: string) {
    return this.request<FileDiff>("GET", `/projects/${id}/file/diff${query({ path })}`);
  }
  /** The project's local branches (most recent first) matching `q`, for the new-session branch picker. */
  projectBranches(id: string, q?: string, limit?: number) {
    return this.request<BranchInfo[]>("GET", `/projects/${id}/branches${query({ q: q || undefined, limit })}`);
  }

  // Tickets
  /** Every ticket (optionally one project's), or only those in `opts.status` (e.g. all but done). */
  listTickets(projectId?: string, opts: { status?: TicketStatus[] } = {}) {
    return this.request<Ticket[]>("GET", `/tickets${query({ projectId, status: opts.status?.length ? opts.status.join(",") : undefined })}`);
  }
  /**
   * One page of a single column. done pages newest-completed first; other statuses by position.
   * `q` narrows to tickets matching the search. Pass the previous page's nextCursor as `cursor`.
   */
  ticketPage(opts: { status: TicketStatus; projectId?: string; q?: string; limit?: number; cursor?: string | null }) {
    return this.request<TicketPage>(
      "GET",
      `/tickets/page${query({ status: opts.status, projectId: opts.projectId, q: opts.q, limit: opts.limit, cursor: opts.cursor })}`,
    );
  }
  /**
   * Search every status: key (current or pre-rename, exact/prefix), title, description and the
   * latest summary. Key matches rank first, then title, then the rest; newest first within a rank.
   * An empty/whitespace `q` is a 400.
   */
  searchTickets(opts: { q: string; projectId?: string; limit?: number; cursor?: string | null }) {
    return this.request<TicketPage>("GET", `/tickets/search${query({ q: opts.q, projectId: opts.projectId, limit: opts.limit, cursor: opts.cursor })}`);
  }
  createTicket(body: CreateTicketBody) {
    return this.request<Ticket>("POST", "/tickets", body);
  }
  getTicket(key: string) {
    return this.request<TicketDetail>("GET", `/tickets/${key}`);
  }
  updateTicket(key: string, body: UpdateTicketBody) {
    return this.request<Ticket>("PATCH", `/tickets/${key}`, body);
  }
  deleteTicket(key: string) {
    return this.request<{ ok: true }>("DELETE", `/tickets/${key}`);
  }
  startTicket(key: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/start`);
  }
  /** Launch a draft (Ticket.draft): start work now, or plan first. */
  submitTicket(key: string, body: SubmitTicketBody) {
    return this.request<Ticket>("POST", `/tickets/${key}/submit`, body);
  }
  sendMessage(key: string, text: string, opts: { move?: boolean } = {}) {
    const body: MessageBody = opts.move ? { text, move: true } : { text };
    return this.request<Ticket>("POST", `/tickets/${key}/messages`, body);
  }
  humanReview(key: string, body: HumanReviewBody) {
    return this.request<Ticket>("POST", `/tickets/${key}/review`, body);
  }
  reopenTicket(key: string, body: ReopenBody) {
    return this.request<Ticket>("POST", `/tickets/${key}/reopen`, body);
  }
  completeTicket(key: string, body: CompleteBody = {}) {
    return this.request<Ticket>("POST", `/tickets/${key}/complete`, body);
  }
  answerApproval(key: string, body: ApprovalBody) {
    return this.request<Ticket>("POST", `/tickets/${key}/approval`, body);
  }
  rerunAgentReview(key: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/agent-review`);
  }
  cancelTicket(key: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/cancel`);
  }
  /** Files and folders where the ticket's agent works matching `q`, for @-mentions in a message (options as projectFiles). */
  ticketFiles(key: string, q: string, opts?: number | FileSearchOptions) {
    return this.request<FileMatch[]>("GET", `/tickets/${key}/files${fileSearchQuery(q, opts)}`);
  }
  /** Slash commands and skills matching `q` that the ticket's agent offers where it works, for `/command` in a message. */
  ticketCommands(key: string, q: string, limit?: number) {
    return this.request<CommandMatch[]>("GET", `/tickets/${key}/commands${query({ q, limit })}`);
  }
  /** A file where the ticket's agent works (its worktree, else its cwd, else the project folder). */
  ticketFile(key: string, path: string) {
    return this.request<FileView>("GET", `/tickets/${key}/file${query({ path })}`);
  }
  /** That file's uncommitted changes against HEAD (409 outside a git repository). */
  ticketFileDiff(key: string, path: string) {
    return this.request<FileDiff>("GET", `/tickets/${key}/file/diff${query({ path })}`);
  }
  listSummaries(key: string) {
    return this.request<Summary[]>("GET", `/tickets/${key}/summaries`);
  }
  /** Absolute URL of a summary attachment, token in the query so <img>/<video> can load it. */
  attachmentUrl(id: string): string {
    return `${this.baseUrl}/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(this.opts.token)}`;
  }

  // Sessions (ticket + triage) and transcripts
  listSessions(kind?: "ticket" | "triage") {
    return this.request<Session[]>("GET", `/sessions${kind ? `?kind=${kind}` : ""}`);
  }
  getSession(id: string) {
    return this.request<Session>("GET", `/sessions/${id}`);
  }
  /** The session agent's transcript, or one sub-agent's with `subagentId` */
  transcript(sessionId: string, afterSeq = 0, subagentId?: string | null) {
    const sub = subagentId ? `&subagent=${encodeURIComponent(subagentId)}` : "";
    return this.request<TranscriptEntry[]>("GET", `/sessions/${sessionId}/transcript?after=${afterSeq}${sub}`);
  }
  subagents(sessionId: string) {
    return this.request<Subagent[]>("GET", `/sessions/${sessionId}/subagents`);
  }
  /** A background task's output: the tail, or with `offset` what came after it (TaskOutput) */
  taskOutput(sessionId: string, subagentId: string, offset?: number) {
    const q = offset === undefined ? "" : `?offset=${offset}`;
    return this.request<TaskOutput>("GET", `/sessions/${sessionId}/subagents/${encodeURIComponent(subagentId)}/output${q}`);
  }

  // Watchers
  listWatchers() {
    return this.request<Watcher[]>("GET", "/watchers");
  }
  createWatcher(body: WatcherBody & { name: string; command: string }) {
    return this.request<Watcher>("POST", "/watchers", body);
  }
  updateWatcher(id: string, body: WatcherBody) {
    return this.request<Watcher>("PATCH", `/watchers/${id}`, body);
  }
  deleteWatcher(id: string) {
    return this.request<{ ok: true }>("DELETE", `/watchers/${id}`);
  }
  runWatcher(id: string) {
    return this.request<{ ok: true }>("POST", `/watchers/${id}/run`);
  }
  /**
   * Feed output directly, as if a watcher named `source` printed `text` (objects are sent as JSON
   * text). `prompt` plays the watcher's prompt. Null when the same text was already seen.
   * Useful for testing triage.
   */
  injectOutput(source: string, text: unknown, prompt?: string) {
    return this.request<Session | null>("POST", `/watchers/inject`, { source, text, prompt });
  }

  // Drivers & settings
  listDrivers() {
    return this.request<DriverInfo[]>("GET", "/drivers");
  }
  /** Models the driver offers (cached by the service; refresh re-queries the driver). */
  listModels(driverId: string, opts: { refresh?: boolean } = {}) {
    return this.request<DriverModels>("GET", `/drivers/${encodeURIComponent(driverId)}/models${opts.refresh ? "?refresh=1" : ""}`);
  }
  loginDriver(id: string) {
    return this.request<{ url: string | null; message: string }>("POST", `/drivers/${id}/login`);
  }
  getSettings() {
    return this.request<PublicSettings>("GET", "/settings");
  }
  updateSettings(body: Partial<Settings>) {
    return this.request<PublicSettings>("PATCH", "/settings", body);
  }
  /** Every overridable prompt with its built-in text and the user's override; change them with updateSettings({ prompts }). */
  listPrompts() {
    return this.request<PromptEntry[]>("GET", "/prompts");
  }

  // Network & pairing
  /** Listen mode, bound addresses and Tailscale status. */
  network() {
    return this.request<NetworkStatus>("GET", "/network");
  }
  /** The link a phone scans (409 in localhost mode: nothing off this machine can reach the service). */
  pairing() {
    return this.request<PairingInfo>("GET", "/pairing");
  }
  /**
   * Replace the bearer token. The old one stops working immediately (open sockets on it are closed),
   * so callers must switch to the returned token — this client keeps using the old one.
   */
  rotateToken() {
    return this.request<{ token: string }>("POST", "/token/rotate");
  }

  // Browser
  /** `tabId` omitted: the lowest open tab. */
  browserState(sessionId: string, tabId?: number) {
    return this.request<BrowserState | null>("GET", `/browser/${sessionId}${tabId === undefined ? "" : `?tab=${tabId}`}`);
  }
  browserNavigate(sessionId: string, url: string, tabId?: number) {
    return this.request<BrowserState>("POST", `/browser/${sessionId}/navigate`, tabId === undefined ? { url } : { url, tabId });
  }

  // Plugins
  listPlugins() {
    return this.request<PluginInfo[]>("GET", "/plugins");
  }
  /** Plugin tabs that apply to this ticket (the service evaluates each tab's `when`). */
  ticketTabs(key: string) {
    return this.request<PluginTab[]>("GET", `/tickets/${key}/tabs`);
  }

  /** Open the live event stream. Reconnects automatically until close() is called. */
  connect(handlers: {
    onEvent: (e: HarnessEvent) => void;
    onStatus?: (connected: boolean) => void;
  }): HarnessSocket {
    return new HarnessSocket(this.baseUrl.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(this.opts.token)}`, handlers);
  }
}

const browserSubscribe = (sessionId: string, tabId: number | undefined): ClientMessage =>
  tabId === undefined ? { type: "browser.subscribe", sessionId } : { type: "browser.subscribe", sessionId, tabId };

export class HarnessSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 250;
  private browserSubs = new Map<string, number | undefined>();

  constructor(
    private url: string,
    private handlers: { onEvent: (e: HarnessEvent) => void; onStatus?: (connected: boolean) => void },
  ) {
    this.open();
  }

  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 250;
      this.send({ type: "hello", client: "harness-client" });
      for (const [id, tabId] of this.browserSubs) this.send(browserSubscribe(id, tabId));
      this.handlers.onStatus?.(true);
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer)) as ServerMessage;
      if (msg.type === "event") this.handlers.onEvent(msg.event);
    };
    ws.onclose = () => {
      this.handlers.onStatus?.(false);
      if (this.closed) return;
      setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** Watch a session's browser; again with another `tabId` switches tabs. Remembered across reconnects. */
  subscribeBrowser(sessionId: string, tabId?: number) {
    this.browserSubs.set(sessionId, tabId);
    this.send(browserSubscribe(sessionId, tabId));
  }
  /** Remember the tab a session's subscription is on (the service moved it, e.g. after a newTab), for reconnects. */
  noteBrowserTab(sessionId: string, tabId: number | undefined) {
    if (this.browserSubs.has(sessionId)) this.browserSubs.set(sessionId, tabId);
  }
  unsubscribeBrowser(sessionId: string) {
    this.browserSubs.delete(sessionId);
    this.send({ type: "browser.unsubscribe", sessionId });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
