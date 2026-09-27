// HTTP routes (DESIGN.md "HTTP API"). JSON { data } / { error }, bearer auth except /health.

import type { Server } from "bun";
import { timingSafeEqual } from "node:crypto";
import type { Orchestrator } from "../orchestrator/orchestrator";
import { HarnessError } from "../orchestrator/errors";
import type { BrowserService } from "../browser/types";
import type { EventBus } from "../events";
import { VERSION } from "../config";
import { createWsHandlers, type WsData } from "./ws";

export type McpHandler = (req: Request, run: ReturnType<Orchestrator["mcpRun"]>) => Promise<Response>;

export interface HttpServerOptions {
  orchestrator: Orchestrator;
  bus: EventBus;
  browser: BrowserService;
  token: string;
  port: number;
  hostname?: string;
  mcp: McpHandler;
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

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1]!.trim() : null;
}

export function buildRoutes(o: Orchestrator, browser: BrowserService): Route[] {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => routes.push({ method, ...compile(path), handler });

  // Projects
  add("GET", "/projects", () => o.listProjects());
  add("POST", "/projects", async ({ body }) => o.createProject(await body()));
  add("PATCH", "/projects/:id", async ({ params, body }) => o.updateProject(params.id!, await body()));
  add("DELETE", "/projects/:id", async ({ params }) => (await o.deleteProject(params.id!), ok));

  // Tickets
  add("GET", "/tickets", ({ url }) => o.listTickets(url.searchParams.get("projectId") ?? undefined));
  add("POST", "/tickets", async ({ body }) => o.createTicket(await body()));
  add("GET", "/tickets/:key", ({ params }) => o.ticketDetail(params.key!));
  add("PATCH", "/tickets/:key", async ({ params, body }) => o.updateTicket(params.key!, await body()));
  add("DELETE", "/tickets/:key", async ({ params }) => (await o.deleteTicket(params.key!), ok));
  add("POST", "/tickets/:key/start", ({ params }) => o.startTicket(params.key!));
  add("POST", "/tickets/:key/messages", async ({ params, body }) => o.sendMessage(params.key!, (await body())?.text));
  add("POST", "/tickets/:key/review", async ({ params, body }) => {
    const b = await body();
    if (b?.decision !== "approve" && b?.decision !== "request_changes") throw new HarnessError(400, "decision must be approve or request_changes");
    return o.humanReview(params.key!, b);
  });
  add("POST", "/tickets/:key/complete", async ({ params, body }) => o.completeTicket(params.key!, (await body()) ?? {}));
  add("POST", "/tickets/:key/cancel", ({ params }) => o.cancelTicket(params.key!));
  add("POST", "/tickets/:key/agent-review", ({ params }) => o.rerunAgentReview(params.key!));
  add("POST", "/tickets/:key/approval", async ({ params, body }) => o.answerApproval(params.key!, (await body()) ?? {}));
  add("GET", "/tickets/:key/summaries", ({ params }) => o.summaries(params.key!));

  // Sessions
  add("GET", "/sessions", ({ url }) => {
    const kind = url.searchParams.get("kind");
    if (kind && kind !== "ticket" && kind !== "triage") throw new HarnessError(400, "kind must be ticket or triage");
    return o.listSessions((kind as "ticket" | "triage" | null) ?? undefined);
  });
  add("GET", "/sessions/:id", ({ params }) => o.getSession(params.id!));
  add("GET", "/sessions/:id/transcript", ({ params, url }) => {
    const after = Number(url.searchParams.get("after") ?? 0);
    return o.transcript(params.id!, Number.isFinite(after) ? after : 0);
  });

  // Watchers & mappings (inject before :id so it isn't captured as an id)
  add("GET", "/watchers", () => o.listWatchers());
  add("POST", "/watchers", async ({ body }) => o.createWatcher(await body()));
  add("POST", "/watchers/inject", async ({ body }) => {
    const b = (await body()) ?? {};
    return o.injectWorkItem(b.source, b.item);
  });
  add("PATCH", "/watchers/:id", async ({ params, body }) => o.updateWatcher(params.id!, await body()));
  add("DELETE", "/watchers/:id", ({ params }) => (o.deleteWatcher(params.id!), ok));
  add("POST", "/watchers/:id/run", async ({ params }) => (await o.runWatcher(params.id!), ok));
  add("GET", "/mappings", () => o.listMappings());
  add("POST", "/mappings", async ({ body }) => o.createMapping(await body()));
  add("DELETE", "/mappings/:id", ({ params }) => (o.deleteMapping(params.id!), ok));

  // Drivers & settings
  add("GET", "/drivers", () => o.driverInfos());
  add("POST", "/drivers/:id/login", ({ params }) => o.loginDriver(params.id!));
  add("GET", "/settings", () => o.publicSettings());
  add("PATCH", "/settings", async ({ body }) => o.updateSettings(await body()));

  // Browser
  add("GET", "/browser/:sessionId", ({ params }) => browser.state(o.getSession(params.sessionId!).id));
  add("POST", "/browser/:sessionId/navigate", async ({ params, body }) => {
    const b = await body();
    if (typeof b?.url !== "string" || !b.url) throw new HarnessError(400, "url is required");
    return browser.open(o.getSession(params.sessionId!).id, b.url);
  });

  return routes;
}

export function createHttpServer(opts: HttpServerOptions): Server<WsData> {
  const routes = buildRoutes(opts.orchestrator, opts.browser);
  const ws = createWsHandlers({ bus: opts.bus, browser: opts.browser });

  return Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    websocket: ws.websocket,
    async fetch(req, server) {
      const origin = allowedOrigin(req.headers.get("origin"));
      if (req.method === "OPTIONS") return preflight(origin);
      const res = await handle(req, server);
      return res ? withCors(res, origin) : (undefined as unknown as Response);
    },
  });

  async function handle(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && path === "/health") return json({ data: { ok: true, version: VERSION, pid: process.pid } });

      // MCP: authenticated by the run-scoped token in the path
      const mcp = /^\/mcp\/([^/]+)$/.exec(path);
      if (mcp) {
        try {
          return await opts.mcp(req, opts.orchestrator.mcpRun(decodeURIComponent(mcp[1]!)));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      if (path === "/ws") {
        if (!tokenMatches(url.searchParams.get("token"), opts.token)) return json({ error: "Unauthorized" }, 401);
        if (server.upgrade(req, { data: ws.newData() })) return undefined;
        return json({ error: "WebSocket upgrade required" }, 400);
      }

      if (!tokenMatches(bearer(req), opts.token)) return json({ error: "Unauthorized" }, 401);

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
