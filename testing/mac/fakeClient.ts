// A service client answered from the world. It is the real HarnessClient with only the transport
// replaced: every method (and its path and query) is the production one, and `request` routes by
// method and path to world data. So a renamed endpoint or a changed method breaks here, and the
// fake can't drift from the client's API surface. The event socket is controlled by the test.

import { HarnessApiError, HarnessClient } from "@harness/shared";
import { COS_OPEN_STATUSES, type ClientEvent, type Cos, type CosBadge, type CosChatEntry, type CosChatPage, type CosEventPage, type MemoryConflict, type PutCosMemoryBody } from "@harness/shared";
import { chiefs, cosChat, cosEvents } from "../world/cos";
import type { CreateTicketBody, DriverModels, FileWriteResult, SubmitTicketBody, UpdateTicketBody, HarnessSocket, WriteFileRequest, NetworkStatus, NotificationStatus, PairingInfo, SpecRevisionInfo, Ticket, TicketStatus } from "@harness/shared";
import { world as defaultWorld, type World } from "../world";

type Handlers = Parameters<HarnessClient["connect"]>[0];

/** The public surface of HarnessSocket; the fake must keep all of it so a view can't reach a method the fake lacks. */
type SocketSurface = Pick<HarnessSocket, keyof HarnessSocket>;

class FakeSocket implements SocketSurface {
  closed = false;
  sent: unknown[] = [];
  send(msg: unknown) { this.sent.push(msg); }
  subscribeBrowser() {}
  noteBrowserTab() {}
  unsubscribeBrowser() {}
  setPresence() {}
  attachTerminal() {}
  detachTerminal() {}
  resizeTerminal() {}
  writeTerminal() {}
  close() { this.closed = true; }
}

const ok = <T>(v: T) => v;

export class FakeClient extends HarnessClient {
  /** `${method} ${path}` of every request, in order. */
  readonly requests: string[] = [];
  /** The body of every request that sent one, with its `${method} ${path}`. */
  readonly bodies: { request: string; body: unknown }[] = [];
  /** Requests no route answered: tests assert this is empty so a missing route is loud. */
  readonly unrouted: string[] = [];
  /** Route overrides for one test (a failing endpoint, an empty list), checked before the world's. */
  readonly overrides = new Map<string, () => unknown>();
  /** Requests answered but whose callers haven't run yet: a test settles until it is 0. */
  inflight = 0;
  readonly socket = new FakeSocket();
  private handlers: Handlers | null = null;
  world: World;
  /** The chiefs of staff, their Inbox, chat and memory: the writes the views make change these. */
  readonly cos = { chiefs: structuredClone(chiefs), events: structuredClone(cosEvents), chat: structuredClone(cosChat), memory: { text: "# Memory\n\n## Triage guidance\n\nIgnore routine ticket moves.\n", revision: "rev-1" } };

  constructor(world: World = defaultWorld) {
    super({ baseUrl: "http://fake.test", token: "fake" });
    this.world = structuredClone(world);
  }

  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.requests.push(`${method} ${path}`);
    if (body !== undefined) this.bodies.push({ request: `${method} ${path}`, body });
    this.inflight++;
    try {
      await Promise.resolve();
      return this.answer<T>(method, path, body);
    } finally {
      this.inflight--;
    }
  }

  private answer<T>(method: string, path: string, body?: unknown): T {
    const key = `${method} ${path.split("?")[0]}`;
    const override = this.overrides.get(key);
    if (override) return override() as T;
    const url = new URL(path, "http://fake.test");
    const answer = this.route(method, url, body);
    if (answer === NO_ROUTE) {
      this.unrouted.push(`${method} ${path}`);
      throw new HarnessApiError(404, `fake service has no route for ${method} ${path}`);
    }
    return structuredClone(answer) as T;
  }

  private route(method: string, url: URL, body?: unknown): unknown {
    const w = this.world;
    const p = url.pathname;
    const q = url.searchParams;
    const cos = this.cosRoute(method, p, q, body);
    if (cos !== NO_ROUTE) return cos;
    let m: RegExpMatchArray | null = p.match(/^\/tickets\/([^/]+)\/file$/);
    if (method === "PUT" && m) {
      // A save: the world's file takes the new contents, so a reload shows what was written.
      const b = body as WriteFileRequest;
      const f = w.files.views.find((v) => v.path === b.path);
      if (!f) return NO_ROUTE;
      f.contents = b.contents;
      f.size = b.contents.length;
      return { path: b.path, size: f.size } satisfies FileWriteResult;
    }
    // Drafts (the New Ticket form): the first save creates one, edits patch it, Plan first / Start submit it.
    if (method === "POST" && p === "/tickets") {
      const b = body as CreateTicketBody;
      const project = w.projects.find((x) => x.id === b.projectId);
      if (!project) return NO_ROUTE;
      const t: Ticket = { ...w.tickets[0]!, id: `ticket-new-${w.tickets.length}`, key: `${project.key}-${project.nextSeq}`, projectId: project.id, spec: b.spec, title: b.title ?? b.spec, status: "planning", draft: !!b.draft };
      project.nextSeq++;
      w.tickets.push(t);
      return t;
    }
    m = p.match(/^\/tickets\/([^/]+)(\/submit)?$/);
    const draft = m && w.tickets.find((t) => t.key === m![1] && t.draft);
    if (draft && method === "PATCH" && !m![2]) return Object.assign(draft, body as UpdateTicketBody);
    if (draft && method === "POST" && m![2]) return Object.assign(draft, { draft: false, status: (body as SubmitTicketBody).start ? "in_progress" : "planning" });
    if (method !== "GET") return NO_ROUTE;
    if (p === "/health") return ok({ ok: true });
    if (p === "/projects") return w.projects;
    if (p === "/tickets") {
      const statuses = q.get("status")?.split(",");
      return w.tickets.filter((t) => (!statuses || statuses.includes(t.status)) && (!q.get("projectId") || t.projectId === q.get("projectId")));
    }
    if (p === "/tickets/page") {
      const status = q.get("status") as TicketStatus;
      const all = this.page(w.tickets.filter((t) => t.status === status), q);
      return { tickets: all, nextCursor: null, total: all.length };
    }
    if (p === "/tickets/search") {
      const needle = (q.get("q") ?? "").toLowerCase();
      const hits = w.tickets.filter((t) => t.key.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle));
      return { tickets: hits, nextCursor: null, total: hits.length };
    }
    if (p === "/sessions") return w.sessions.filter((s) => !q.get("kind") || s.kind === q.get("kind"));
    if (p === "/watchers") return w.watchers;
    if (p === "/settings") return w.settings;
    if (p === "/drivers") return w.drivers;
    if (p === "/terminals" || p === "/prompts" || p === "/plugins") return [];
    if (p === "/pairing") return { url: "http://127.0.0.1:7717", token: "fake", pairUrl: "harness://pair" } satisfies PairingInfo;
    if (p === "/browser-extensions") return { extensions: [], running: false };
    if (p === "/network") return { mode: "localhost", host: null, port: 7717, bound: [], active: "localhost", tailscale: null, error: null, override: null } satisfies NetworkStatus;
    if (p === "/notifications") return { keyDir: "/Users/dev/.appstoreconnect/private_keys", keys: [], devices: [], presence: [] } satisfies NotificationStatus;
    m = p.match(/^\/drivers\/([^/]+)\/models$/);
    if (m) return { driverId: m[1]!, models: [{ id: "claude-opus-5-5", name: "Opus 5.5", default: true }], error: null, fetchedAt: w.now } satisfies DriverModels;
    m = p.match(/^\/tickets\/([^/]+)\/tabs$/);
    if (m) return [];
    if (p === "/plugins/git/api/changes") return w.changes[q.get("ticket") ?? ""]?.changes ?? NO_ROUTE;
    if (p === "/plugins/git/api/log") return w.changes[q.get("ticket") ?? ""]?.log ?? NO_ROUTE;
    m = p.match(/^\/tickets\/([^/]+)$/);
    if (m) return w.details[decodeURIComponent(m[1]!)] ?? NO_ROUTE;
    m = p.match(/^\/tickets\/([^/]+)\/activity$/);
    if (m) {
      const t = w.tickets.find((x) => x.key === m![1]);
      return t ? w.activity.filter((a) => a.ticketId === t.id) : NO_ROUTE;
    }
    m = p.match(/^\/sessions\/([^/]+)\/transcript$/);
    if (m) return w.transcript.filter((e) => e.sessionId === m![1] && e.seq > Number(q.get("after") ?? 0));
    m = p.match(/^\/tickets\/([^/]+)\/spec\/revisions$/);
    if (m) {
      const t = w.tickets.find((x) => x.key === m![1]);
      return t ? [{ rev: t.specRevision ?? 1, author: "agent", runId: null, runKind: null, note: "Plan drafted", approvedBaseline: false, createdAt: t.createdAt }] satisfies SpecRevisionInfo[] : NO_ROUTE;
    }
    m = p.match(/^\/tickets\/([^/]+)\/spec\/revisions$/);
    if (m) {
      const t = w.tickets.find((x) => x.key === m![1]);
      const info: SpecRevisionInfo[] = t ? [{ rev: t.specRevision ?? 1, author: "agent", runId: null, runKind: null, note: "Plan drafted", approvedBaseline: false, createdAt: t.createdAt }] : [];
      return t ? info : NO_ROUTE;
    }
    m = p.match(/^\/sessions\/([^/]+)\/subagents$/);
    if (m) return [];
    m = p.match(/^\/tickets\/([^/]+)\/file$/);
    if (m) return w.files.views.find((f) => f.path === q.get("path")) ?? NO_ROUTE;
    m = p.match(/^\/tickets\/([^/]+)\/file\/diff$/);
    if (m) return w.files.diffs.find((f) => f.path === q.get("path")) ?? NO_ROUTE;
    return NO_ROUTE;
  }

  /** The chiefs of staff: lists, pages (newest first, a cursor of `<createdAt>:<id>`), and the writes the views make. */
  private cosRoute(method: string, p: string, q: URLSearchParams, body: unknown): unknown {
    const c = this.cos;
    let m: RegExpMatchArray | null;
    if (method === "GET" && p === "/cos") return c.chiefs;
    if (method === "POST" && p === "/cos") {
      const scope = (body as { scope: Cos["scope"] }).scope;
      let chief = c.chiefs.find((x) => x.scope === scope);
      if (!chief) {
        chief = { ticketId: `cos-${scope}`, key: `COS-${c.chiefs.length + 1}`, scope, groupId: scope === "all" ? null : scope.slice("group:".length), enabled: true, createdAt: this.world.now };
        c.chiefs.push(chief);
      }
      return chief;
    }
    if (method === "GET" && p === "/cos/events/badge") {
      const byCos: Record<string, number> = {};
      for (const e of c.events) if (e.cosId && COS_OPEN_STATUSES.includes(e.status)) byCos[e.cosId] = (byCos[e.cosId] ?? 0) + 1;
      return { total: Object.values(byCos).reduce((n, v) => n + v, 0), byCos } satisfies CosBadge;
    }
    m = p.match(/^\/cos\/events\/([^/]+)\/escalate$/);
    if (method === "POST" && m) {
      const e = c.events.find((x) => x.id === m![1]);
      if (!e) return NO_ROUTE;
      e.status = "escalated";
      e.verdict = "escalate";
      return e;
    }
    m = p.match(/^\/cos\/([^/]+)$/);
    if (method === "PATCH" && m) {
      const chief = c.chiefs.find((x) => x.ticketId === m![1]);
      if (!chief) return NO_ROUTE;
      chief.enabled = (body as { enabled: boolean }).enabled;
      return chief;
    }
    m = p.match(/^\/cos\/([^/]+)\/events$/);
    if (method === "GET" && m) {
      const rows = c.events.filter((e) => e.cosId === m![1] || e.cosId === null).filter((e) => !q.get("status") || e.status === q.get("status"));
      return paged(rows, q) satisfies CosEventPage;
    }
    m = p.match(/^\/cos\/([^/]+)\/transcript$/);
    if (method === "GET" && m) {
      const { items, nextCursor } = paged(c.chat.filter((e) => e.cosId === m![1]), q);
      return { entries: items, nextCursor } satisfies CosChatPage;
    }
    m = p.match(/^\/cos\/([^/]+)\/messages$/);
    if (method === "POST" && m) {
      const entry: CosChatEntry = { id: `chat-sent-${c.chat.length + 1}`, cosId: m[1]!, createdAt: this.world.now, kind: "message", role: "user", text: (body as { text: string }).text };
      c.chat.push(entry);
      return { entryId: entry.id };
    }
    m = p.match(/^\/tickets\/([^/]+)\/memory$/);
    if (m && method === "GET") return c.memory;
    if (m && method === "PUT") {
      const b = body as PutCosMemoryBody;
      if (b.baseRevision !== c.memory.revision) throw new HarnessApiError(409, "memory changed", { currentRevision: c.memory.revision, text: c.memory.text } satisfies MemoryConflict);
      c.memory = { text: b.text, revision: `rev-${b.text.length}` };
      return c.memory;
    }
    return NO_ROUTE;
  }

  private page(tickets: Ticket[], q: URLSearchParams): Ticket[] {
    const limit = Number(q.get("limit") ?? tickets.length);
    return [...tickets].sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)).slice(0, limit);
  }

  override connect(handlers: Handlers): HarnessSocket {
    this.handlers = handlers;
    return this.socket as unknown as HarnessSocket;
  }

  // --- The test's side of the event stream ---------------------------------------------------

  /** The service accepts the socket: the app loads its snapshot. */
  open() {
    this.handlers?.onStatus?.(true);
  }
  drop() {
    this.handlers?.onStatus?.(false);
  }
  /** The service pushes an event. */
  push(event: ClientEvent) {
    this.handlers?.onEvent(event);
  }
}

const NO_ROUTE = Symbol("no route");

/** A page of rows, newest first: those older than the cursor (`<createdAt>:<id>`), at most `limit`. */
function paged<T extends { id: string; createdAt: number }>(rows: T[], q: URLSearchParams): { items: T[]; nextCursor: string | null } {
  const limit = Number(q.get("limit") ?? 50);
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const before = q.get("before");
  const [bt, ...bid] = before ? before.split(":") : [];
  const older = before ? sorted.filter((r) => r.createdAt < Number(bt) || (r.createdAt === Number(bt) && r.id < bid.join(":"))) : sorted;
  const items = older.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: older.length > limit && last ? `${last.createdAt}:${last.id}` : null };
}
