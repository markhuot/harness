// HTTP routes (DESIGN.md "HTTP API"). JSON { data } / { error }, bearer auth except /health.

import type { Server } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { Orchestrator } from "../orchestrator/orchestrator";
import { HarnessError } from "../orchestrator/errors";
import type { BrowserService } from "../browser/types";
import type { EventBus } from "../events";
import { VERSION } from "../config";
import { createWsHandlers, type WsData } from "./ws";
import type { PluginHost } from "../plugins/host";
import { isLoopback, type NetworkManager } from "./network";
import { validateListen, validateSettingsPatch } from "../orchestrator/settings";
import { TICKET_STATUSES, type ServiceStatus, type TicketStatus } from "@harness/shared";

/** The bearer token, rotatable at runtime (POST /token/rotate). */
export interface TokenStore {
  get(): string;
  /** Replace the token (persisted); the old one stops working immediately. */
  rotate(): string;
}

export type McpHandler = (req: Request, run: ReturnType<Orchestrator["mcpRun"]>) => Promise<Response>;

export interface HttpServerOptions {
  orchestrator: Orchestrator;
  bus: EventBus;
  browser: BrowserService;
  tokens: TokenStore;
  mcp: McpHandler;
  plugins?: PluginHost;
  /** Listen addresses; enables /network, /pairing and live rebinds on PATCH /settings { listen }. */
  network?: NetworkManager;
  /** Build tracking for /health; absent → { build: null, stale: false }. */
  serviceStatus?: () => ServiceStatus;
  /** Enables POST /service/restart: exit so launchd starts the service again. */
  restart?: () => void;
}

export interface HttpHandler {
  fetch(req: Request, server: Server<WsData>): Promise<Response | undefined>;
  websocket: ReturnType<typeof createWsHandlers>["websocket"];
  /** Close every open WebSocket (after a token rotation). */
  closeSockets(): void;
}

type Params = Record<string, string>;
type Handler = (ctx: { req: Request; url: URL; params: Params; body: () => Promise<any> }) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${src}/?$`), keys };
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const ok = { ok: true } as const;

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Origins allowed to call the API from a browser context (Electron file:// renderer, local dev servers). */
export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === "null" || origin.startsWith("file://") || LOCAL_ORIGIN.test(origin)) return origin;
  return null;
}

function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  try {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.append("vary", "Origin");
  } catch {
    // immutable headers (e.g. upgrade responses) — leave as-is
  }
  return res;
}

function preflight(origin: string | null): Response {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return new Response(null, { status: 204, headers });
}

export function tokenMatches(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The byte range a `Range: bytes=…` header asks for within `size` bytes, "unsatisfiable" when it
 * falls outside, or null to send the whole file (no header, or one we don't handle, such as
 * several ranges).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix range: the last N bytes
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

const ATTACHMENT_CACHE = "private, max-age=31536000, immutable";

/**
 * A file (or the Range of it asked for) as a response. The body is read into memory rather than
 * handed over as a `Bun.file`: Bun's sendfile path can write the file ahead of the status line and
 * headers on non-loopback sockets (LAN, Tailscale), so the phone got a headerless PNG and showed
 * "Couldn't load". Video players ask for ranges, which keeps what's buffered small.
 */
export async function serveFile(req: Request, path: string, mimeType: string): Promise<Response> {
  const file = Bun.file(path);
  const size = file.size;
  const headers: Record<string, string> = { "content-type": mimeType, "cache-control": ATTACHMENT_CACHE, "accept-ranges": "bytes" };
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  const head = req.method === "HEAD";
  if (!range) return new Response(head ? null : await file.bytes(), { status: 200, headers: { ...headers, "content-length": String(size) } });
  const length = range.end - range.start + 1;
  return new Response(head ? null : await file.slice(range.start, range.end + 1).bytes(), {
    status: 206,
    headers: { ...headers, "content-length": String(length), "content-range": `bytes ${range.start}-${range.end}/${size}` },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1]!.trim() : null;
}

export interface RouteExtras {
  plugins?: PluginHost;
  network?: NetworkManager;
  tokens?: TokenStore;
  /** Called after the token rotates (closes sockets authenticated with the old one). */
  onRotate?: () => void;
  restart?: () => void;
}

/** `?status=planning,review` → validated statuses; absent/empty → undefined (no filter). */
function statusList(raw: string | null): TicketStatus[] | undefined {
  if (raw === null) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return undefined;
  const bad = list.filter((s) => !(TICKET_STATUSES as readonly string[]).includes(s));
  if (bad.length) throw new HarnessError(400, `Unknown status: ${bad.join(", ")} (expected ${TICKET_STATUSES.join(", ")})`);
  return [...new Set(list)] as TicketStatus[];
}

export function buildRoutes(o: Orchestrator, browser: BrowserService, extras: RouteExtras = {}): Route[] {
  const { plugins, network, tokens } = extras;
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => routes.push({ method, ...compile(path), handler });

  // Projects
  add("GET", "/projects", () => o.listProjects());
  add("POST", "/projects", async ({ body }) => o.createProject(await body()));
  add("PATCH", "/projects/:id", async ({ params, body }) => o.updateProject(params.id!, await body()));
  add("DELETE", "/projects/:id", async ({ params }) => (await o.deleteProject(params.id!), ok));
  add("GET", "/projects/:id/files", ({ params, url }) => o.projectFiles(params.id!, url.searchParams.get("q") ?? "", url.searchParams.get("limit")));
  add("GET", "/projects/:id/branches", ({ params, url }) => o.projectBranches(params.id!, url.searchParams.get("q") ?? "", url.searchParams.get("limit")));

  // Tickets
  add("GET", "/tickets", ({ url }) => o.listTickets(url.searchParams.get("projectId") || undefined, statusList(url.searchParams.get("status"))));
  add("POST", "/tickets", async ({ body }) => o.createTicket(await body()));
  // Before /tickets/:key so "page" and "search" aren't taken for keys (keys always contain a dash).
  add("GET", "/tickets/page", ({ url }) => {
    const sp = url.searchParams;
    const [status, ...rest] = statusList(sp.get("status")) ?? [];
    if (!status || rest.length) throw new HarnessError(400, "status must be exactly one ticket status");
    return o.ticketPage({
      status,
      projectId: sp.get("projectId") || undefined,
      q: sp.has("q") ? sp.get("q")! : undefined,
      limit: sp.get("limit"),
      cursor: sp.get("cursor") || null,
    });
  });
  add("GET", "/tickets/search", ({ url }) => {
    const sp = url.searchParams;
    return o.searchTickets({ q: sp.get("q") ?? "", projectId: sp.get("projectId") || undefined, limit: sp.get("limit"), cursor: sp.get("cursor") || null });
  });
  add("GET", "/tickets/:key", ({ params }) => o.ticketDetail(params.key!));
  add("PATCH", "/tickets/:key", async ({ params, body }) => o.updateTicket(params.key!, await body()));
  add("DELETE", "/tickets/:key", async ({ params }) => (await o.deleteTicket(params.key!), ok));
  add("POST", "/tickets/:key/start", ({ params }) => o.startTicket(params.key!));
  add("POST", "/tickets/:key/submit", async ({ params, body }) => o.submitTicket(params.key!, (await body()) ?? {}));
  add("POST", "/tickets/:key/messages", async ({ params, body }) => {
    const b = await body();
    return o.sendMessage(params.key!, b?.text, { chat: b?.chat === true });
  });
  add("POST", "/tickets/:key/review", async ({ params, body }) => {
    const b = await body();
    if (b?.decision !== "approve" && b?.decision !== "request_changes") throw new HarnessError(400, "decision must be approve or request_changes");
    return o.humanReview(params.key!, b);
  });
  add("POST", "/tickets/:key/reopen", async ({ params, body }) => o.reopenTicket(params.key!, (await body()) ?? {}));
  add("POST", "/tickets/:key/complete", async ({ params, body }) => o.completeTicket(params.key!, (await body()) ?? {}));
  add("POST", "/tickets/:key/cancel", ({ params }) => o.cancelTicket(params.key!));
  add("POST", "/tickets/:key/agent-review", ({ params }) => o.rerunAgentReview(params.key!));
  add("POST", "/tickets/:key/approval", async ({ params, body }) => o.answerApproval(params.key!, (await body()) ?? {}));
  add("GET", "/tickets/:key/summaries", ({ params }) => o.summaries(params.key!));
  add("GET", "/tickets/:key/files", ({ params, url }) => o.ticketFiles(params.key!, url.searchParams.get("q") ?? "", url.searchParams.get("limit")));

  // Sessions
  add("GET", "/sessions", ({ url }) => {
    const kind = url.searchParams.get("kind");
    if (kind && kind !== "ticket" && kind !== "triage") throw new HarnessError(400, "kind must be ticket or triage");
    return o.listSessions((kind as "ticket" | "triage" | null) ?? undefined);
  });
  add("GET", "/sessions/:id", ({ params }) => o.getSession(params.id!));
  add("GET", "/sessions/:id/transcript", ({ params, url }) => {
    const after = Number(url.searchParams.get("after") ?? 0);
    return o.transcript(params.id!, Number.isFinite(after) ? after : 0, url.searchParams.get("subagent") || null);
  });
  add("GET", "/sessions/:id/subagents", ({ params }) => o.subagents(params.id!));

  // Watchers (inject before :id so it isn't captured as an id)
  add("GET", "/watchers", () => o.listWatchers());
  add("POST", "/watchers", async ({ body }) => o.createWatcher(await body()));
  add("POST", "/watchers/inject", async ({ body }) => {
    // { source, text, prompt? }; `item` (an object) is the older shape and is sent as JSON text.
    const b = (await body()) ?? {};
    return o.injectOutput(b.source, b.text ?? b.item, b.prompt);
  });
  add("PATCH", "/watchers/:id", async ({ params, body }) => o.updateWatcher(params.id!, await body()));
  add("DELETE", "/watchers/:id", ({ params }) => (o.deleteWatcher(params.id!), ok));
  add("POST", "/watchers/:id/run", async ({ params }) => (await o.runWatcher(params.id!), ok));

  // Drivers & settings
  add("GET", "/drivers", () => o.driverInfos());
  add("POST", "/drivers/:id/login", ({ params }) => o.loginDriver(params.id!));
  add("GET", "/drivers/:id/models", ({ params, url }) => o.listModels(params.id!, { refresh: /^(1|true)$/.test(url.searchParams.get("refresh") ?? "") }));
  add("GET", "/settings", () => o.publicSettings());
  add("GET", "/prompts", () => o.promptCatalog());
  add("PATCH", "/settings", async ({ body }) => {
    const b = await body();
    if (b && typeof b === "object" && !Array.isArray(b) && "listen" in b) {
      // Validate everything first, then rebind (409 keeps the old listeners), then persist.
      validateSettingsPatch(b, o.driverList().map((d) => d.id), o.settings());
      const listen = validateListen(b.listen);
      if (network) await network.apply(listen);
      return o.updateSettings({ ...b, listen });
    }
    return o.updateSettings(b);
  });

  // Network, pairing, token (DESIGN.md "Network")
  add("GET", "/network", async () => {
    if (!network) throw new HarnessError(404, "Network status isn't available");
    return network.status();
  });
  add("GET", "/pairing", async () => {
    if (!network || !tokens) throw new HarnessError(404, "Pairing isn't available");
    return network.pairing(tokens.get());
  });
  add("POST", "/service/restart", () => {
    const restart = extras.restart;
    if (!restart) throw new HarnessError(409, "This service isn't run by launchd, so it can't restart itself; restart it by hand");
    // After the response is on its way: the restart stops the HTTP server.
    setTimeout(restart, 50);
    return ok;
  });
  add("POST", "/token/rotate", () => {
    if (!tokens) throw new HarnessError(404, "Token rotation isn't available");
    const token = tokens.rotate();
    extras.onRotate?.();
    return { token };
  });

  // Browser
  add("GET", "/browser/:sessionId", ({ params }) => browser.state(o.getSession(params.sessionId!).id));
  add("POST", "/browser/:sessionId/navigate", async ({ params, body }) => {
    const b = await body();
    if (typeof b?.url !== "string" || !b.url) throw new HarnessError(400, "url is required");
    return browser.open(o.getSession(params.sessionId!).id, b.url);
  });

  // Plugins (DESIGN.md "Plugins"). /plugins/<id>/api/* and /plugins/<id>/ui/* are handled in createHttpServer.
  add("GET", "/plugins", () => plugins?.list() ?? []);
  add("GET", "/tickets/:key/tabs", async ({ params }) => (plugins ? plugins.ticketTabs(o.ticketDetail(params.key!).ticket) : []));

  return routes;
}

/** Is the request from this machine? (Bun reports the peer; unknown counts as remote.) */
function fromLoopback(req: Request, server: Server<WsData>): boolean {
  try {
    const ip = server.requestIP(req);
    return !!ip && isLoopback(ip.address);
  } catch {
    return false;
  }
}

/** One fetch/websocket pair shared by every listener (loopback, Tailscale, custom, 0.0.0.0). */
export function createHttpHandler(opts: HttpServerOptions): HttpHandler {
  const ws = createWsHandlers({ bus: opts.bus, browser: opts.browser });
  const routes = buildRoutes(opts.orchestrator, opts.browser, {
    plugins: opts.plugins,
    network: opts.network,
    tokens: opts.tokens,
    onRotate: () => ws.closeAll(),
    restart: opts.restart,
  });

  return {
    websocket: ws.websocket,
    closeSockets: () => ws.closeAll(),
    async fetch(req, server) {
      if (opts.network?.isRetired(server)) {
        return new Response(JSON.stringify({ error: "The service no longer listens on this address" }), { status: 503, headers: { "content-type": "application/json", connection: "close" } });
      }
      const origin = allowedOrigin(req.headers.get("origin"));
      if (req.method === "OPTIONS") return preflight(origin);
      const res = await handle(req, server);
      return res ? withCors(res, origin) : undefined;
    },
  };

  async function handle(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // Plugin UI bundles: static, unauthenticated (no data; API calls from the UI carry the token).
      const ui = /^\/plugins\/([^/]+)\/ui(?:\/(.*))?$/.exec(url.pathname);
      if (ui && opts.plugins) {
        if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
        if (ui[2] === undefined) return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}` } });
        return opts.plugins.serveUi(decodeURIComponent(ui[1]!), ui[2]);
      }

      if (req.method === "GET" && path === "/health") return json({ data: { ok: true, version: VERSION, pid: process.pid, ...(opts.serviceStatus?.() ?? { build: null, stale: false }) } });

      // MCP: authenticated by the run-scoped token in the path. Only agents on this machine use it,
      // so it isn't offered to other hosts even when the service listens beyond loopback.
      const mcp = /^\/mcp\/([^/]+)$/.exec(path);
      if (mcp) {
        if (!fromLoopback(req, server)) return json({ error: "MCP is only served to this machine" }, 403);
        try {
          return await opts.mcp(req, opts.orchestrator.mcpRun(decodeURIComponent(mcp[1]!)));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      if (path === "/ws") {
        if (!tokenMatches(url.searchParams.get("token"), opts.tokens.get())) return json({ error: "Unauthorized" }, 401);
        if (server.upgrade(req, { data: ws.newData() })) return undefined;
        return json({ error: "WebSocket upgrade required" }, 400);
      }

      // Summary attachments: the bearer token or ?token=, since <img> and <video> can't set headers.
      // No other route takes the token from the query.
      const attachment = /^\/attachments\/([^/]+)$/.exec(path);
      if (attachment && (req.method === "GET" || req.method === "HEAD")) {
        const token = opts.tokens.get();
        if (!tokenMatches(bearer(req), token) && !tokenMatches(url.searchParams.get("token"), token)) return json({ error: "Unauthorized" }, 401);
        const found = opts.orchestrator.attachmentFile(decodeURIComponent(attachment[1]!));
        if (!found) return json({ error: "Not found" }, 404);
        return serveFile(req, found.path, found.attachment.mimeType);
      }

      // Every other route needs the bearer token, from loopback and remote hosts alike.
      if (!tokenMatches(bearer(req), opts.tokens.get())) return json({ error: "Unauthorized" }, 401);

      const pluginApi = /^\/plugins\/([^/]+)\/api(\/.*)?$/.exec(path);
      if (pluginApi) {
        if (!opts.plugins) return json({ error: "Not found" }, 404);
        return opts.plugins.handleApi(decodeURIComponent(pluginApi[1]!), pluginApi[2] ?? "/", req, url);
      }

      let matchedPath = false;
      for (const route of routes) {
        const m = route.pattern.exec(path);
        if (!m) continue;
        matchedPath = true;
        if (route.method !== req.method) continue;
        const params: Params = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
        const body = async () => {
          const text = await req.text();
          if (!text) return undefined;
          try {
            return JSON.parse(text);
          } catch {
            throw new HarnessError(400, "Invalid JSON body");
          }
        };
        try {
          const data = await route.handler({ req, url, params, body });
          return json({ data: data ?? null });
        } catch (err) {
          if (err instanceof HarnessError) return json({ error: err.message }, err.status);
          console.error(`[http] ${req.method} ${path} failed`, err);
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }
      return json({ error: matchedPath ? "Method not allowed" : "Not found" }, matchedPath ? 405 : 404);
    }
  }
}
