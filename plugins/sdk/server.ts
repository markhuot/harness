// Server-side plugin API. A plugin's `server` module default-exports definePlugin({...}).
// The harness service loads it with a dynamic import and hands it a PluginContext.
// These are the canonical types: the service imports them from here (see DESIGN.md "Plugins").
//
// Plugins outside this repo ($HARNESS_HOME/plugins/*) can't resolve "@harness/plugin-sdk";
// definePlugin is an identity function, so they can `export default { routes(router, ctx) {…} }`.

import type { Project, Ticket, TicketTabWhen } from "@harness/shared";

/** Parsed plugin.json. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Server module relative to the plugin dir, e.g. "server.ts" */
  server?: string;
  /** Static UI directory relative to the plugin dir, e.g. "dist/" (served at /plugins/<id>/ui/) */
  ui?: string;
  /**
   * Build script relative to the plugin dir, run with the service's bun when the ui dir has no
   * index.html or is older than the plugin's sources (checked at service start). UI requests wait for it.
   */
  build?: string;
  tabs: { id: string; title: string; icon?: string; when?: TicketTabWhen }[];
}

export interface PluginExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the process after this many ms (default 30s). */
  timeoutMs?: number;
  /** Stop reading stdout after this many bytes and set `truncated` (default 16 MiB). */
  maxBytes?: number;
  stdin?: string;
}

export interface PluginExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout hit maxBytes; the process was killed and stdout cut there */
  truncated: boolean;
  timedOut: boolean;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Read-only helpers handed to every plugin. */
export interface PluginContext {
  id: string;
  /** Absolute plugin directory */
  dir: string;
  /** Ticket + its project, or null when the key is unknown */
  getTicket(key: string): { ticket: Ticket; project: Project } | null;
  /** The ticket's workdir when it is set and exists on disk (a worktree or the project path), else null */
  ticketWorkdir(key: string): string | null;
  /** Run a program without a shell. Never throws for a non-zero exit; spawn failures give code -1. */
  exec(cmd: string, args: string[], opts?: PluginExecOptions): Promise<PluginExecResult>;
  log: PluginLogger;
}

export interface PluginRequest {
  request: Request;
  url: URL;
  /** `:name` segments from the route pattern */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (undefined when empty); a 400 is returned for invalid JSON */
  body<T = unknown>(): Promise<T | undefined>;
}

/**
 * Return any JSON-able value (sent as `{ data }`) or a Response (sent as-is).
 * Throw PluginHttpError (or any error with a numeric `status`) for a 4xx/5xx `{ error }`.
 */
export type PluginHandler = (req: PluginRequest, ctx: PluginContext) => unknown | Promise<unknown>;

/** Paths are relative to /plugins/<id>/api, e.g. router.get("/changes", …) → GET /plugins/<id>/api/changes. */
export interface PluginRouter {
  get(path: string, handler: PluginHandler): void;
  post(path: string, handler: PluginHandler): void;
  put(path: string, handler: PluginHandler): void;
  patch(path: string, handler: PluginHandler): void;
  delete(path: string, handler: PluginHandler): void;
}

export interface PluginTabQuery {
  /** The manifest tab id */
  id: string;
  ticket: Ticket;
  project: Project | null;
}

export type PluginTicketEvent = { kind: "ticket.upserted"; ticket: Ticket } | { kind: "ticket.deleted"; id: string };

export interface PluginDefinition {
  /** Register HTTP routes. Called once at load. */
  routes?(router: PluginRouter, ctx: PluginContext): void;
  /**
   * Called for a tab whose manifest `when` doesn't hold for the ticket: return true to offer the tab
   * anyway (the git plugin keeps Changes once the worktree is removed). Errors count as false.
   */
  showTab?(tab: PluginTabQuery, ctx: PluginContext): boolean | Promise<boolean>;
  /** Ticket changes (created, status, busy, workdir…). Errors are logged and swallowed. */
  onTicketEvent?(event: PluginTicketEvent, ctx: PluginContext): void | Promise<void>;
  /** Called when the service stops. */
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export class PluginHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
