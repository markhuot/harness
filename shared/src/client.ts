// Thin typed client for the harness service. Used by the desktop app and service tests.
// Works in Bun, Node 22+, Electron renderers and browsers (fetch + WebSocket globals).

import type {
  ClientMessage,
  CompleteBody,
  CreateProjectBody,
  CreateTicketBody,
  DriverInfo,
  DriverModels,
  HarnessEvent,
  HumanReviewBody,
  ReopenBody,
  ApprovalBody,
  Project,
  Subagent,
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
  BrowserState,
  PluginInfo,
  PluginTab,
  NetworkStatus,
  PairingInfo,
} from "./protocol";
import type { FileMatch } from "./mentions";

export class HarnessApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    if (!res.ok) throw new HarnessApiError(res.status, json.error ?? res.statusText);
    return json.data as T;
  }

  health() {
    return this.request<{ ok: true; version: string; pid: number }>("GET", "/health");
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
  /** Files and folders in the project folder matching `q`, for @-mentions in a new session. */
  projectFiles(id: string, q: string, limit?: number) {
    return this.request<FileMatch[]>("GET", `/projects/${id}/files${query({ q, limit })}`);
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
  sendMessage(key: string, text: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/messages`, { text });
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
  /** Files and folders where the ticket's agent works matching `q`, for @-mentions in a message. */
  ticketFiles(key: string, q: string, limit?: number) {
    return this.request<FileMatch[]>("GET", `/tickets/${key}/files${query({ q, limit })}`);
  }
  listSummaries(key: string) {
    return this.request<Summary[]>("GET", `/tickets/${key}/summaries`);
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

  // Watchers
  listWatchers() {
    return this.request<Watcher[]>("GET", "/watchers");
  }
  createWatcher(body: Partial<Watcher> & { name: string; command: string }) {
    return this.request<Watcher>("POST", "/watchers", body);
  }
  updateWatcher(id: string, body: Partial<Watcher>) {
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
  browserState(sessionId: string) {
    return this.request<BrowserState | null>("GET", `/browser/${sessionId}`);
  }
  browserNavigate(sessionId: string, url: string) {
    return this.request<BrowserState>("POST", `/browser/${sessionId}/navigate`, { url });
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

export class HarnessSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 250;
  private browserSubs = new Set<string>();

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
      for (const id of this.browserSubs) this.send({ type: "browser.subscribe", sessionId: id });
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

  subscribeBrowser(sessionId: string) {
    this.browserSubs.add(sessionId);
    this.send({ type: "browser.subscribe", sessionId });
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
