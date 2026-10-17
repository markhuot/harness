// A service client answered from the world. It is the real HarnessClient with only the transport
// replaced: every method (and its path and query) is the production one, and `request` routes by
// method and path to world data. So a renamed endpoint or a changed method breaks here, and the
// fake can't drift from the client's API surface. The event socket is controlled by the test.

import { HarnessApiError, HarnessClient } from "@harness/shared";
import type { DriverModels, HarnessEvent, HarnessSocket, NetworkStatus, NotificationStatus, PairingInfo, SpecRevisionInfo, Ticket, TicketStatus } from "@harness/shared";
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
  /** Requests no route answered: tests assert this is empty so a missing route is loud. */
  readonly unrouted: string[] = [];
  /** Route overrides for one test (a failing endpoint, an empty list), checked before the world's. */
  readonly overrides = new Map<string, () => unknown>();
  /** Requests answered but whose callers haven't run yet: a test settles until it is 0. */
  inflight = 0;
  readonly socket = new FakeSocket();
  private handlers: Handlers | null = null;
  world: World;

  constructor(world: World = defaultWorld) {
    super({ baseUrl: "http://fake.test", token: "fake" });
    this.world = structuredClone(world);
  }

  override async request<T>(method: string, path: string, _body?: unknown): Promise<T> {
    this.requests.push(`${method} ${path}`);
    this.inflight++;
    try {
      await Promise.resolve();
      return this.answer<T>(method, path);
    } finally {
      this.inflight--;
    }
  }

  private answer<T>(method: string, path: string): T {
    const key = `${method} ${path.split("?")[0]}`;
    const override = this.overrides.get(key);
    if (override) return override() as T;
    const url = new URL(path, "http://fake.test");
    const answer = this.route(method, url);
    if (answer === NO_ROUTE) {
      this.unrouted.push(`${method} ${path}`);
      throw new HarnessApiError(404, `fake service has no route for ${method} ${path}`);
    }
    return structuredClone(answer) as T;
  }

  private route(method: string, url: URL): unknown {
    const w = this.world;
    const p = url.pathname;
    const q = url.searchParams;
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
    let m: RegExpMatchArray | null;
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
  push(event: HarnessEvent) {
    this.handlers?.onEvent(event);
  }
}

const NO_ROUTE = Symbol("no route");
