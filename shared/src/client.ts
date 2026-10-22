// Thin typed client for the harness service. Used by the desktop app and service tests.
// Works in Bun, Node 22+, Electron renderers and browsers (fetch + WebSocket globals).

import type {
  Group,
  SubmitTicketBody,
  ClientMessage,
  CompleteBody,
  CreateProjectBody,
  CreateTicketBody,
  Attachment,
  AttachmentInput,
  DriverInfo,
  DriverModels,
  FileDiff,
  FileSearchOptions,
  FileView,
  FileWriteResult,
  WriteFileRequest,
  HarnessEvent,
  Health,
  HumanReviewBody,
  MessageBody,
  MessageDraftBody,
  ReopenBody,
  UnblockBody,
  ApprovalBody,
  BranchInfo,
  Project,
  Subagent,
  TaskOutput,
  PromptEntry,
  PublicSettings,
  ServerMessage,
  Session,
  SettingsPatch,
  ActivityEntry,
  SpecConflict,
  SpecDiff,
  SpecRevision,
  SpecRevisionInfo,
  Ticket,
  TicketDetail,
  TicketPage,
  TicketStatus,
  TranscriptEntry,
  UpdateTicketBody,
  Watcher,
  WatcherBody,
  BrowserState,
  BrowserScreenshot,
  BrowserElement,
  BrowserElementQuery,
  CreateTerminalBody,
  TerminalInfo,
  BrowserExtension,
  BrowserExtensionList,
  BrowserExtensionActionResult,
  AddBrowserExtensionBody,
  PluginInfo,
  PluginTab,
  NetworkStatus,
  PairingInfo,
  PlanUsageReport,
  SessionActionBody,
} from "./protocol";
import type { ClientEvent, Cos, CosBadge, CosChatPage, CosEvent, CosEventPage, CosEventStatus, CosMemory, CosScopeKey, MemoryConflict, PutCosMemoryBody } from "./cos";
import type { Device, NotificationStatus, Presence, RegisterDeviceBody, TestNotificationResult } from "./notifications";
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

/** The SpecConflict of a PATCH refused because the spec moved on (409), else null. */
export function specConflict(err: unknown): SpecConflict | null {
  if (!(err instanceof HarnessApiError) || err.status !== 409) return null;
  const d = err.data as Partial<SpecConflict> | undefined;
  return d && typeof d.currentRevision === "number" && typeof d.spec === "string" ? { currentRevision: d.currentRevision, spec: d.spec } : null;
}

/** The MemoryConflict of a PUT …/memory refused because the memory moved on (409), else null. */
export function memoryConflict(err: unknown): MemoryConflict | null {
  if (!(err instanceof HarnessApiError) || err.status !== 409) return null;
  const d = err.data as Partial<MemoryConflict> | undefined;
  return d && typeof d.currentRevision === "string" && typeof d.text === "string" ? { currentRevision: d.currentRevision, text: d.text } : null;
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
  listGroups() {
    return this.request<Group[]>("GET", "/groups");
  }
  /** Rename a group; a name another group has is a 409 (HarnessError). */
  renameGroup(id: string, name: string) {
    return this.request<Group>("PATCH", `/groups/${encodeURIComponent(id)}`, { name });
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
  /** Replace a project file's contents (last write wins). */
  writeProjectFile(id: string, path: string, contents: string) {
    return this.request<FileWriteResult>("PUT", `/projects/${id}/file`, { path, contents } satisfies WriteFileRequest);
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
   * `q` narrows to tickets matching the search, `projectId` to one project and `group` to the
   * projects in that group. Pass the previous page's nextCursor as `cursor`.
   */
  ticketPage(opts: { status: TicketStatus; projectId?: string; groupId?: string; q?: string; limit?: number; cursor?: string | null }) {
    return this.request<TicketPage>(
      "GET",
      `/tickets/page${query({ status: opts.status, projectId: opts.projectId, groupId: opts.groupId, q: opts.q, limit: opts.limit, cursor: opts.cursor })}`,
    );
  }
  /**
   * Search every status: key (current or pre-rename, exact/prefix), title, spec and the
   * latest Activity note. Key matches rank first, then title, then the rest; newest first within a rank.
   * An empty/whitespace `q` is a 400.
   */
  searchTickets(opts: { q: string; projectId?: string; groupId?: string; limit?: number; cursor?: string | null }) {
    return this.request<TicketPage>(
      "GET",
      `/tickets/search${query({ q: opts.q, projectId: opts.projectId, groupId: opts.groupId, limit: opts.limit, cursor: opts.cursor })}`,
    );
  }
  createTicket(body: CreateTicketBody) {
    return this.request<Ticket>("POST", "/tickets", body);
  }
  getTicket(key: string) {
    return this.request<TicketDetail>("GET", `/tickets/${key}`);
  }
  /**
   * A PATCH with `spec` needs `baseRevision` (outside drafts). When the spec moved on since,
   * it rejects with a HarnessApiError of status 409 whose `data` is a SpecConflict; see specConflict().
   */
  /** Fetch every pull request title on the ticket again (Ticket.pullRequests). */
  refreshPullRequests(key: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/pull-requests/refresh`);
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
  /** Cancel a planning ticket's automatic start (plan approval and dependency queue). */
  cancelStart(key: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/cancel-start`);
  }
  /** Take back the human review approval until the complete run starts. */
  withdrawApproval(key: string) {
    return this.request<Ticket>("POST", `/tickets/${key}/withdraw-approval`);
  }
  /** Launch a draft (Ticket.draft): start work now, or plan first. */
  submitTicket(key: string, body: SubmitTicketBody) {
    return this.request<Ticket>("POST", `/tickets/${key}/submit`, body);
  }
  /** The message goes to the agent and the transcript, with any attachments (uploaded first when they aren't on the service's machine). */
  sendMessage(key: string, text: string, opts: { attachments?: AttachmentInput[] } = {}) {
    const body: MessageBody = {
      text,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    };
    return this.request<Ticket>("POST", `/tickets/${key}/messages`, body);
  }
  /** Save the message being written to the ticket (Ticket.messageDraft); empty clears it. */
  saveMessageDraft(key: string, body: MessageDraftBody) {
    return this.request<Ticket>("PUT", `/tickets/${key}/message-draft`, body);
  }
  /** A chief of staff's memory document and its revision. */
  getCosMemory(key: string) {
    return this.request<CosMemory>("GET", `/tickets/${key}/memory`);
  }
  /** Replace the memory. A memory that changed since `baseRevision` rejects with a 409 whose `data` is a MemoryConflict. */
  putCosMemory(key: string, body: PutCosMemoryBody) {
    return this.request<CosMemory>("PUT", `/tickets/${key}/memory`, body);
  }
  // Chiefs of staff
  listCos() {
    return this.request<Cos[]>("GET", "/cos");
  }
  /** The chief of a scope, made on first use. */
  openCos(scope: CosScopeKey) {
    return this.request<Cos>("POST", "/cos", { scope });
  }
  setCosEnabled(id: string, enabled: boolean) {
    return this.request<Cos>("PATCH", `/cos/${id}`, { enabled });
  }
  /** A chief's Inbox, newest first; `before` is the previous page's nextCursor. */
  cosEvents(id: string, opts: { status?: CosEventStatus; before?: string | null; limit?: number } = {}) {
    return this.request<CosEventPage>("GET", `/cos/${id}/events${query({ status: opts.status, before: opts.before, limit: opts.limit })}`);
  }
  cosBadge() {
    return this.request<CosBadge>("GET", "/cos/events/badge");
  }
  /** An ignored event joins the chief's next wake. */
  escalateCosEvent(id: string) {
    return this.request<CosEvent>("POST", `/cos/events/${id}/escalate`);
  }
  /** A chief's chat, newest page first; `before` is the previous page's nextCursor. */
  cosTranscript(id: string, opts: { before?: string | null; limit?: number } = {}) {
    return this.request<CosChatPage>("GET", `/cos/${id}/transcript${query({ before: opts.before, limit: opts.limit })}`);
  }
  /** A message to the chief; it skips triage. */
  sendCosMessage(id: string, text: string) {
    return this.request<{ entryId: string }>("POST", `/cos/${id}/messages`, { text });
  }
  humanReview(key: string, body: HumanReviewBody) {
    return this.request<Ticket>("POST", `/tickets/${key}/review`, body);
  }
  unblockTicket(key: string, body: UnblockBody = {}) {
    return this.request<Ticket>("POST", `/tickets/${key}/unblock`, body);
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
  /** Compact the ticket's saved session, or start a new one (DESIGN.md "Context gauge"); 409 while a run is going. */
  sessionAction(key: string, action: SessionActionBody["action"]) {
    return this.request<Ticket>("POST", `/tickets/${key}/session`, { action } satisfies SessionActionBody);
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
  /** Replace a file where the ticket works (last write wins). */
  writeTicketFile(key: string, path: string, contents: string) {
    return this.request<FileWriteResult>("PUT", `/tickets/${key}/file`, { path, contents } satisfies WriteFileRequest);
  }
  /** That file's uncommitted changes against HEAD (409 outside a git repository). */
  ticketFileDiff(key: string, path: string) {
    return this.request<FileDiff>("GET", `/tickets/${key}/file/diff${query({ path })}`);
  }
  listActivity(key: string) {
    return this.request<ActivityEntry[]>("GET", `/tickets/${key}/activity`);
  }
  /** Every spec revision's metadata, oldest first (no bodies). */
  specRevisions(key: string) {
    return this.request<SpecRevisionInfo[]>("GET", `/tickets/${key}/spec/revisions`);
  }
  /** One spec revision with its body. */
  specRevision(key: string, rev: number) {
    return this.request<SpecRevision>("GET", `/tickets/${key}/spec/revisions/${rev}`);
  }
  /** The unified diff from revision `from` to `to` (parseDiff reads it); "" when they're equal. */
  specDiff(key: string, from: number, to: number) {
    return this.request<SpecDiff>("GET", `/tickets/${key}/spec/revisions/${to}${query({ diff: from })}`);
  }
  /** Absolute URL of any attachment's file (Attachment.id), token in the query so <img>/<video> can load it. 404 once the file is gone. */
  attachmentUrl(id: string): string {
    return `${this.baseUrl}/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(this.opts.token)}`;
  }
  /**
   * Store bytes (a pasted image, a browser screenshot, a file from another device) on the service's
   * machine. Resolves with the registered attachment to add to a draft or a message.
   */
  async uploadAttachment(data: Blob | ArrayBuffer | Uint8Array, name: string, mimeType?: string): Promise<Attachment> {
    const res = await fetch(`${this.baseUrl}/uploads?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": mimeType || (data instanceof Blob && data.type) || "application/octet-stream" },
      body: data as Blob,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new HarnessApiError(res.status, json.error ?? res.statusText, json.data);
    return json.data as Attachment;
  }
  /** Register a file already on the service's machine (a drop or pick on the Mac when the service is local), referenced in place. */
  registerAttachment(path: string, name?: string) {
    return this.request<Attachment>("POST", "/attachments", name ? { path, name } : { path });
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
  /** The plan-usage gauges' readings (DESIGN.md "Plan usage"). */
  getUsage() {
    return this.request<PlanUsageReport>("GET", "/usage");
  }
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
  updateSettings(body: SettingsPatch) {
    return this.request<PublicSettings>("PATCH", "/settings", body);
  }
  /** Every overridable prompt with its built-in text and the user's override; change them with updateSettings({ prompts }). */
  listPrompts() {
    return this.request<PromptEntry[]>("GET", "/prompts");
  }

  // Notifications (DESIGN.md "Notifications")
  /** APNs key status for each environment and the registered devices. */
  notificationStatus() {
    return this.request<NotificationStatus>("GET", "/notifications");
  }
  /** Send a test notification to every registered device. */
  sendTestNotification() {
    return this.request<TestNotificationResult>("POST", "/notifications/test");
  }
  /** Register this device's APNs token, or update it. */
  registerDevice(body: RegisterDeviceBody) {
    return this.request<Device>("POST", "/devices", body);
  }
  removeDevice(id: string) {
    return this.request<{ ok: true }>("DELETE", `/devices/${encodeURIComponent(id)}`);
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

  // Terminals
  /** The service's terminals; `refresh` looks up every terminal's cwd and process first. */
  terminals(refresh = false) {
    return this.request<TerminalInfo[]>("GET", `/terminals${refresh ? "?refresh=1" : ""}`);
  }
  createTerminal(body: CreateTerminalBody = {}) {
    return this.request<TerminalInfo>("POST", "/terminals", body);
  }
  /** A new shell in an exited terminal, keeping its screen and scrollback. */
  restartTerminal(id: string) {
    return this.request<TerminalInfo>("POST", `/terminals/${encodeURIComponent(id)}/restart`);
  }
  closeTerminal(id: string) {
    return this.request<{ ok: true }>("DELETE", `/terminals/${encodeURIComponent(id)}`);
  }

  // Browser
  /** `tabId` omitted: the lowest open tab. */
  browserState(sessionId: string, tabId?: number) {
    return this.request<BrowserState | null>("GET", `/browser/${sessionId}${tabId === undefined ? "" : `?tab=${tabId}`}`);
  }
  /** A PNG of the tab's viewport (`tabId` omitted: the lowest open tab), to annotate. */
  browserScreenshot(sessionId: string, tabId?: number) {
    return this.request<BrowserScreenshot>("GET", `/browser/${sessionId}/screenshot${tabId === undefined ? "" : `?tab=${tabId}`}`);
  }
  /** The element under a point of a captured screenshot (null when the tab has moved on since). */
  browserElementAt(sessionId: string, query: BrowserElementQuery) {
    return this.request<BrowserElement | null>("POST", `/browser/${sessionId}/element`, query);
  }
  browserNavigate(sessionId: string, url: string, tabId?: number) {
    return this.request<BrowserState>("POST", `/browser/${sessionId}/navigate`, tabId === undefined ? { url } : { url, tabId });
  }
  /** Run extension `id`'s toolbar action on a tab (`tabId` omitted: the lowest open tab); its popup opens as the session's next tab. */
  browserExtensionAction(sessionId: string, id: string, tabId?: number) {
    return this.request<BrowserExtensionActionResult>("POST", `/browser/${sessionId}/extension-action`, tabId === undefined ? { id } : { id, tabId });
  }

  // Browser extensions (shared by every session's tabs)
  listBrowserExtensions() {
    return this.request<BrowserExtensionList>("GET", "/browser-extensions");
  }
  /** Restart the service's Chrome, so pending extensions install: every tab's page reloads (watched ones now, the rest when next used). */
  restartBrowser() {
    return this.request<{ ok: true }>("POST", "/browser/restart");
  }
  /** Install from the Chrome Web Store (a link or an ID) or an unpacked folder on the service's machine. */
  addBrowserExtension(body: AddBrowserExtensionBody) {
    return this.request<BrowserExtension>("POST", "/browser-extensions", body);
  }
  setBrowserExtensionEnabled(id: string, enabled: boolean) {
    return this.request<BrowserExtension>("PATCH", `/browser-extensions/${id}`, { enabled });
  }
  removeBrowserExtension(id: string) {
    return this.request<{ ok: true }>("DELETE", `/browser-extensions/${id}`);
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
    onEvent: (e: ClientEvent) => void;
    onStatus?: (connected: boolean) => void;
    onMessage?: (msg: ServerMessage) => void;
  }): HarnessSocket {
    return new HarnessSocket(this.baseUrl.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(this.opts.token)}`, handlers);
  }
}

const browserSubscribe = (sessionId: string, tabId: number | undefined, viewerId: string | undefined): ClientMessage => ({
  type: "browser.subscribe",
  sessionId,
  ...(tabId === undefined ? {} : { tabId }),
  ...(viewerId ? { viewerId } : {}),
});

const subKey = (sessionId: string, viewerId: string | undefined) => `${sessionId}\u0000${viewerId ?? ""}`;

/**
 * Whether a browser.frame/browser.state event is for this viewer of `sessionId`. An event that
 * names a viewer is for that viewer only; one without (an older service, or a viewer that sent no
 * id) is for every viewer of the session.
 */
export function isBrowserEventFor(
  e: ClientEvent,
  sessionId: string,
  viewerId: string | undefined,
): e is Extract<HarnessEvent, { kind: "browser.frame" | "browser.state" }> {
  if (e.kind !== "browser.frame" && e.kind !== "browser.state") return false;
  if (e.sessionId !== sessionId) return false;
  return e.viewerId === undefined || e.viewerId === viewerId;
}

export class HarnessSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 250;
  /** One entry per viewer: `subKey(sessionId, viewerId)` → its session, viewer and tab. */
  private browserSubs = new Map<string, { sessionId: string; viewerId: string | undefined; tabId: number | undefined }>();
  /** The last presence set, sent again after each reconnect. */
  private presence: Presence | null = null;
  /** Terminals attached (id → device and viewport), attached again after each reconnect. */
  private terminalSubs = new Map<string, { deviceId: string; cols: number; rows: number }>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private url: string,
    private handlers: {
      onEvent: (e: ClientEvent) => void;
      onStatus?: (connected: boolean) => void;
      /** Every other message from the service (terminal.snapshot, terminal.output, …). */
      onMessage?: (msg: ServerMessage) => void;
    },
  ) {
    this.open();
  }

  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 250;
      this.send({ type: "hello", client: "harness-client" });
      for (const sub of this.browserSubs.values()) this.send(browserSubscribe(sub.sessionId, sub.tabId, sub.viewerId));
      if (this.presence) this.send({ type: "presence", ...this.presence });
      for (const [id, t] of this.terminalSubs) this.send({ type: "terminal.attach", id, ...t });
      this.handlers.onStatus?.(true);
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer)) as ServerMessage;
      if (msg.type === "event") this.handlers.onEvent(msg.event);
      else this.handlers.onMessage?.(msg);
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

  /**
   * Watch a session's browser; again with another `tabId` switches tabs. Remembered across
   * reconnects. `viewerId` names this view, so several views of one session (torn-off browser
   * tabs) can each watch their own tab over this one socket.
   */
  subscribeBrowser(sessionId: string, tabId?: number, viewerId?: string) {
    this.browserSubs.set(subKey(sessionId, viewerId), { sessionId, viewerId, tabId });
    this.send(browserSubscribe(sessionId, tabId, viewerId));
  }
  /** Remember the tab a viewer's subscription is on (the service moved it, e.g. after a newTab), for reconnects. */
  noteBrowserTab(sessionId: string, tabId: number | undefined, viewerId?: string) {
    const sub = this.browserSubs.get(subKey(sessionId, viewerId));
    if (sub) sub.tabId = tabId;
  }
  unsubscribeBrowser(sessionId: string, viewerId?: string) {
    this.browserSubs.delete(subKey(sessionId, viewerId));
    this.send(viewerId ? { type: "browser.unsubscribe", sessionId, viewerId } : { type: "browser.unsubscribe", sessionId });
  }

  /**
   * Tell the service what this socket shows (Presence), so it holds back notifications for those
   * tickets. Remembered across reconnects; an unchanged presence isn't sent again.
   */
  setPresence(presence: Presence) {
    const next = { ...presence, tickets: [...new Set(presence.tickets)].sort(), ...(presence.terminals ? { terminals: [...new Set(presence.terminals)].sort() } : {}) };
    if (this.presence && JSON.stringify(this.presence) === JSON.stringify(next)) return;
    this.presence = next;
    this.send({ type: "presence", ...next });
  }

  /**
   * Watch a terminal and report this viewport (the service sizes the shell to the smallest visible
   * client). Remembered across reconnects; again with a new size only reports it. While any terminal
   * is attached the socket pings every 5 s, which tells the service this client is still live.
   */
  attachTerminal(id: string, deviceId: string, cols: number, rows: number) {
    const known = this.terminalSubs.has(id);
    this.terminalSubs.set(id, { deviceId, cols, rows });
    this.send({ type: "terminal.attach", id, deviceId, cols, rows });
    if (!known) this.updatePing();
  }
  detachTerminal(id: string) {
    if (!this.terminalSubs.delete(id)) return;
    this.send({ type: "terminal.detach", id });
    this.updatePing();
  }
  resizeTerminal(id: string, cols: number, rows: number) {
    const sub = this.terminalSubs.get(id);
    if (!sub) return;
    sub.cols = cols;
    sub.rows = rows;
    this.send({ type: "terminal.resize", id, cols, rows });
  }
  writeTerminal(id: string, data: string) {
    this.send({ type: "terminal.write", id, data });
  }
  private updatePing() {
    if (this.terminalSubs.size > 0 && !this.pingTimer) this.pingTimer = setInterval(() => this.send({ type: "ping" }), 5000);
    else if (this.terminalSubs.size === 0 && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close();
  }
}
