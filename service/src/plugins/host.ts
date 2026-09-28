// Plugin host (DESIGN.md "Plugins"): discovers plugin dirs, loads server modules, routes
// /plugins/<id>/api/* to them, serves /plugins/<id>/ui/* and evaluates ticket tabs.
// A plugin that fails to load is listed with `error` and otherwise ignored.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginInfo, PluginTab, Project, Ticket, TicketTabWhen } from "@harness/shared";
import type {
  PluginContext,
  PluginDefinition,
  PluginExecOptions,
  PluginExecResult,
  PluginHandler,
  PluginManifest,
  PluginRouter,
  PluginTicketEvent,
} from "../../../plugins/sdk/server";
import type { EventBus } from "../events";
import { isGitRepo } from "../orchestrator/worktree";

export type PluginSource = "builtin" | "user";

export interface PluginDir {
  path: string;
  source: PluginSource;
}

export interface PluginHostOptions {
  /** Searched in order; a later dir's plugin replaces an earlier one with the same id (user overrides builtin). */
  dirs: PluginDir[];
  getTicket(key: string): { ticket: Ticket; project: Project } | null;
  bus?: EventBus;
  log?: (msg: string) => void;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: PluginHandler;
}

interface LoadedPlugin {
  id: string;
  dir: string;
  source: PluginSource;
  manifest: PluginManifest | null;
  uiRoot: string | null;
  def: PluginDefinition | null;
  ctx: PluginContext | null;
  routes: Route[];
  error: string | null;
  /** In-flight UI build; UI requests wait for it */
  building: Promise<void> | null;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WHENS: TicketTabWhen[] = ["always", "workdir", "worktree"];

/** Validate a parsed plugin.json. Throws with a readable message. */
export function parseManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== "object") throw new Error("plugin.json must be an object");
  const m = raw as Record<string, unknown>;
  const str = (k: string, required = true) => {
    const v = m[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || (required && !v.trim())) throw new Error(`plugin.json: "${k}" must be a${required ? " non-empty" : ""} string`);
    return v;
  };
  const id = str("id")!;
  if (!ID_RE.test(id)) throw new Error(`plugin.json: id "${id}" must match ${ID_RE}`);
  const tabsRaw = m.tabs ?? [];
  if (!Array.isArray(tabsRaw)) throw new Error(`plugin.json: "tabs" must be an array`);
  const seen = new Set<string>();
  const tabs = tabsRaw.map((t, i) => {
    if (!t || typeof t !== "object") throw new Error(`plugin.json: tabs[${i}] must be an object`);
    const tab = t as Record<string, unknown>;
    if (typeof tab.id !== "string" || !ID_RE.test(tab.id)) throw new Error(`plugin.json: tabs[${i}].id must match ${ID_RE}`);
    if (seen.has(tab.id)) throw new Error(`plugin.json: duplicate tab id "${tab.id}"`);
    seen.add(tab.id);
    if (typeof tab.title !== "string" || !tab.title.trim()) throw new Error(`plugin.json: tabs[${i}].title must be a non-empty string`);
    const when = (tab.when ?? "always") as TicketTabWhen;
    if (!WHENS.includes(when)) throw new Error(`plugin.json: tabs[${i}].when must be one of ${WHENS.join(", ")}`);
    if (tab.icon !== undefined && typeof tab.icon !== "string") throw new Error(`plugin.json: tabs[${i}].icon must be a string`);
    return { id: tab.id, title: tab.title, icon: tab.icon as string | undefined, when };
  });
  const manifest: PluginManifest = {
    id,
    name: str("name", false) ?? id,
    version: str("version", false) ?? "0.0.0",
    description: str("description", false) ?? "",
    server: str("server", false),
    ui: str("ui", false),
    build: str("build", false),
    tabs,
  };
  if (tabs.length && !manifest.ui) throw new Error(`plugin.json: tabs need a "ui" directory`);
  if (manifest.build && !manifest.ui) throw new Error(`plugin.json: "build" needs a "ui" directory to build into`);
  return manifest;
}

/** Resolve `rel` inside `root`, refusing anything that escapes it (.., absolute paths, symlinks out). */
export function safeJoin(root: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s === "..")) return null;
  const target = resolve(root, ...segments);
  const inside = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
  if (!inside(target, root)) return null;
  if (!existsSync(target)) return target; // caller 404s; nothing to follow
  try {
    const realRoot = realpathSync(root);
    if (!inside(realpathSync(target), realRoot)) return null;
  } catch {
    return null;
  }
  return target;
}

/** True when <uiRoot>/index.html is missing or older than any source file in the plugin dir. */
export function needsBuild(dir: string, uiRoot: string): boolean {
  let built: number;
  try {
    built = statSync(join(uiRoot, "index.html")).mtimeMs;
  } catch {
    return true;
  }
  const skip = new Set(["node_modules", ".git"]);
  const walk = (d: string, depth: number): boolean => {
    if (depth > 6) return false;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith(".") || full === uiRoot) continue;
        if (walk(full, depth + 1)) return true;
      } else if (!/\.test\.[cm]?[jt]sx?$/.test(e.name)) {
        try {
          if (statSync(full).mtimeMs > built) return true;
        } catch {}
      }
    }
    return false;
  };
  return walk(dir, 0);
}

function compile(path: string) {
  const keys: string[] = [];
  const clean = path.replace(/^\/+|\/+$/g, "");
  const src = (clean ? "/" + clean : "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:([a-zA-Z_]+)/g, (_, k) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${src}/?$`), keys };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function execFile(cmd: string, args: string[], opts: PluginExecOptions = {}): Promise<PluginExecResult> {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err), truncated: false, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 30_000);
  let truncated = false;
  const readStdout = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        proc.kill();
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.length;
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const [stdout, stderr, code] = await Promise.all([readStdout(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  clearTimeout(timer);
  return { code: truncated ? 0 : code, stdout, stderr, truncated, timedOut };
}

export class PluginHost {
  private plugins = new Map<string, LoadedPlugin>();
  private unsub: (() => void) | null = null;
  private log: (msg: string) => void;

  constructor(private opts: PluginHostOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** Discover and load every plugin. Never throws. */
  async load(): Promise<void> {
    const found = new Map<string, { dir: string; source: PluginSource; manifest: PluginManifest | null; error: string | null }>();
    for (const { path: root, source } of this.opts.dirs) {
      let entries: string[] = [];
      try {
        entries = readdirSync(root).sort();
      } catch {
        continue; // missing plugin dir is fine
      }
      for (const name of entries) {
        const dir = join(root, name);
        const manifestPath = join(dir, "plugin.json");
        try {
          if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) continue;
        } catch {
          continue;
        }
        try {
          const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
          found.set(manifest.id, { dir, source, manifest, error: null });
        } catch (err) {
          // Key by dir name so a broken manifest is still visible (and still overrides a builtin of that name).
          found.set(name, { dir, source, manifest: null, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    for (const [id, f] of found) {
      const p: LoadedPlugin = { id, dir: f.dir, source: f.source, manifest: f.manifest, uiRoot: null, def: null, ctx: null, routes: [], error: f.error, building: null };
      this.plugins.set(id, p);
      if (!f.manifest) {
        this.log(`[plugins] ${id}: ${f.error}`);
        continue;
      }
      try {
        await this.init(p, f.manifest);
        this.log(`[plugins] loaded ${id}@${f.manifest.version} (${f.source})`);
      } catch (err) {
        p.error = err instanceof Error ? err.message : String(err);
        p.def = null;
        p.routes = [];
        this.log(`[plugins] ${id} failed to load: ${p.error}`);
      }
    }

    this.unsub?.();
    this.unsub =
      this.opts.bus?.on((e) => {
        if (e.kind === "ticket.upserted" || e.kind === "ticket.deleted") this.dispatchTicketEvent(e);
      }) ?? null;
  }

  private async init(p: LoadedPlugin, manifest: PluginManifest) {
    if (manifest.ui) {
      const ui = resolve(p.dir, manifest.ui);
      if (relative(p.dir, ui).startsWith("..") || isAbsolute(relative(p.dir, ui))) throw new Error(`ui "${manifest.ui}" is outside the plugin directory`);
      p.uiRoot = ui;
      if (manifest.build && needsBuild(p.dir, ui)) p.building = this.build(p, manifest.build);
    }
    const ctx = this.context(p);
    p.ctx = ctx;
    if (!manifest.server) return;
    const file = resolve(p.dir, manifest.server);
    if (!existsSync(file)) throw new Error(`server module ${manifest.server} not found`);
    const mod = await import(pathToFileURL(file).href);
    const def = (mod.default ?? mod.plugin) as PluginDefinition | undefined;
    if (!def || typeof def !== "object") throw new Error(`${manifest.server} must default-export definePlugin({...})`);
    const router: PluginRouter = {
      get: (path, h) => this.addRoute(p, "GET", path, h),
      post: (path, h) => this.addRoute(p, "POST", path, h),
      put: (path, h) => this.addRoute(p, "PUT", path, h),
      patch: (path, h) => this.addRoute(p, "PATCH", path, h),
      delete: (path, h) => this.addRoute(p, "DELETE", path, h),
    };
    await def.routes?.(router, ctx);
    p.def = def;
  }

  private build(p: LoadedPlugin, script: string): Promise<void> {
    const started = Date.now();
    this.log(`[plugins] building ${p.id} UI (${script})`);
    return execFile(process.execPath, [resolve(p.dir, script)], { cwd: p.dir, timeoutMs: 180_000 }).then((r) => {
      p.building = null;
      if (r.code === 0 && !r.timedOut && existsSync(join(p.uiRoot!, "index.html"))) {
        this.log(`[plugins] built ${p.id} UI in ${Date.now() - started}ms`);
        return;
      }
      const why = r.timedOut ? "timed out" : (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n") || `exit ${r.code}`;
      this.log(`[plugins] ${p.id} UI build failed: ${why}`);
      // A stale bundle is still better than nothing; only a missing one is an error.
      if (!existsSync(join(p.uiRoot!, "index.html"))) p.error ??= `UI build failed: ${why}`;
    });
  }

  /** Resolves once every in-flight UI build has finished (tests, scripts). */
  async ready(): Promise<void> {
    await Promise.all([...this.plugins.values()].map((p) => p.building));
  }

  private addRoute(p: LoadedPlugin, method: string, path: string, handler: PluginHandler) {
    if (typeof handler !== "function") throw new Error(`route ${method} ${path} has no handler`);
    p.routes.push({ method, ...compile(path), handler });
  }

  private context(p: LoadedPlugin): PluginContext {
    const prefix = `[plugin:${p.id}]`;
    return {
      id: p.id,
      dir: p.dir,
      getTicket: (key) => this.opts.getTicket(key),
      ticketWorkdir: (key) => {
        const t = this.opts.getTicket(key)?.ticket;
        return t?.workdir && existsSync(t.workdir) ? t.workdir : null;
      },
      exec: execFile,
      log: {
        info: (m) => this.log(`${prefix} ${m}`),
        warn: (m) => this.log(`${prefix} warn: ${m}`),
        error: (m) => this.log(`${prefix} error: ${m}`),
      },
    };
  }

  private dispatchTicketEvent(e: PluginTicketEvent) {
    for (const p of this.plugins.values()) {
      if (!p.def?.onTicketEvent || !p.ctx) continue;
      try {
        const r = p.def.onTicketEvent(e, p.ctx);
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((err) => this.log(`[plugin:${p.id}] onTicketEvent failed: ${err}`));
      } catch (err) {
        this.log(`[plugin:${p.id}] onTicketEvent failed: ${err}`);
      }
    }
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        name: p.manifest?.name ?? p.id,
        version: p.manifest?.version ?? "0.0.0",
        description: p.manifest?.description ?? "",
        source: p.source,
        hasServer: !!p.manifest?.server,
        hasUi: !!p.uiRoot,
        tabs: this.tabsOf(p),
        error: p.error,
      }));
  }

  private tabsOf(p: LoadedPlugin): PluginTab[] {
    return (p.manifest?.tabs ?? []).map((t) => ({ pluginId: p.id, id: t.id, title: t.title, icon: t.icon ?? null, when: t.when ?? "always" }));
  }

  /**
   * Tabs of healthy plugins whose `when` holds for this ticket (or whose plugin's `showTab` keeps
   * them anyway), in plugin-id order.
   */
  async ticketTabs(ticket: Ticket): Promise<PluginTab[]> {
    const plugins = [...this.plugins.values()].filter((p) => !p.error).sort((a, b) => a.id.localeCompare(b.id));
    let gitRepo: boolean | null = null;
    const out: PluginTab[] = [];
    for (const p of plugins) {
      for (const tab of this.tabsOf(p)) {
        let show = tab.when === "always";
        if (tab.when === "worktree") show = !!ticket.branch && !!ticket.workdir && existsSync(ticket.workdir);
        else if (tab.when === "workdir") show = gitRepo ??= !!ticket.workdir && (await isGitRepo(ticket.workdir));
        if (!show && p.def?.showTab && p.ctx) {
          try {
            show = (await p.def.showTab({ id: tab.id, ticket, project: this.opts.getTicket(ticket.key)?.project ?? null }, p.ctx)) === true;
          } catch (err) {
            this.log(`[plugin:${p.id}] showTab failed: ${err}`);
          }
        }
        if (show) out.push(tab);
      }
    }
    return out;
  }

  /** GET /plugins/<id>/ui/<rest>. Unauthenticated: UI bundles carry no data. */
  async serveUi(id: string, rest: string): Promise<Response> {
    const p = this.plugins.get(id);
    if (!p?.uiRoot) return json({ error: "Not found" }, 404);
    if (p.building) await p.building;
    let rel: string;
    try {
      rel = decodeURIComponent(rest);
    } catch {
      return json({ error: "Bad path" }, 400);
    }
    if (!rel || rel.endsWith("/")) rel += "index.html";
    const file = safeJoin(p.uiRoot, rel);
    if (!file) return json({ error: "Forbidden" }, 403);
    try {
      if (!statSync(file).isFile()) return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Not found" }, 404);
    }
    // Buffered, not `new Response(Bun.file(...))`: Bun's sendfile path drops the status line and
    // headers on non-loopback sockets (LAN, Tailscale), which iOS reports as NSURLErrorDomain -1017.
    const f = Bun.file(file);
    return new Response(await f.bytes(), {
      headers: {
        "content-type": f.type || "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }

  /** /plugins/<id>/api/<rest>, already authenticated by the caller. */
  async handleApi(id: string, rest: string, req: Request, url: URL): Promise<Response> {
    const p = this.plugins.get(id);
    if (!p) return json({ error: `No plugin ${id}` }, 404);
    if (p.error) return json({ error: `Plugin ${id} failed to load: ${p.error}` }, 503);
    const path = "/" + rest.replace(/^\/+|\/+$/g, "");
    let matched = false;
    for (const route of p.routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      matched = true;
      if (route.method !== req.method && !(route.method === "GET" && req.method === "HEAD")) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      let bodyErr = false;
      const body = async <T,>() => {
        const text = await req.text();
        if (!text) return undefined;
        try {
          return JSON.parse(text) as T;
        } catch {
          bodyErr = true;
          throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
        }
      };
      try {
        const out = await route.handler({ request: req, url, params, query: url.searchParams, body }, p.ctx!);
        if (out instanceof Response) return out;
        return json({ data: out ?? null });
      } catch (err) {
        const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
        if (status >= 500 && !bodyErr) this.log(`[plugin:${id}] ${req.method} ${path} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        return json({ error: err instanceof Error ? err.message : String(err) }, status >= 400 && status < 600 ? status : 500);
      }
    }
    return json({ error: matched ? "Method not allowed" : "Not found" }, matched ? 405 : 404);
  }

  async stop() {
    this.unsub?.();
    this.unsub = null;
    for (const p of this.plugins.values()) {
      try {
        await p.def?.dispose?.();
      } catch (err) {
        this.log(`[plugin:${p.id}] dispose failed: ${err}`);
      }
    }
  }
}
