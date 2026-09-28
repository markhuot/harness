// Composition root: boots store, orchestrator and the HTTP/WS server.

import type { Settings } from "@harness/shared";
import { ensureHome, ensureToken, rotateToken, type HarnessPaths } from "./config";
import { openDb } from "./db";
import { Store } from "./store";
import { EventBus } from "./events";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator/orchestrator";
import { resolveSettings } from "./orchestrator/settings";
import { createHttpHandler, type McpHandler, type TokenStore } from "./api/http";
import { DEFAULT_SETTINGS } from "./orchestrator/settings";
import { NetworkManager, parseHostOverride, type NetworkDeps } from "./api/network";
import type { WsData } from "./api/ws";
import type { Driver } from "./drivers/types";
import type { BrowserService } from "./browser/types";
import { join, resolve } from "node:path";
import { PluginHost, type PluginDir } from "./plugins/host";
import { CodeWatch } from "./code-watch";

/** Built-in plugins shipped with the repo. */
export const BUILTIN_PLUGINS_DIR = resolve(import.meta.dir, "..", "..", "plugins");

export interface CreateHarnessOptions {
  home: string;
  port: number;
  /** HARNESS_HOST: a listen mode keyword or host that overrides settings.listen (tests / dev). */
  hostname?: string | null;
  /** Tailscale lookup (tests inject one); defaults to the tailscale CLI. */
  tailscale?: NetworkDeps["tailscale"];
  /** Address helpers for custom-host validation (tests). */
  localAddresses?: NetworkDeps["localAddresses"];
  resolveHost?: NetworkDeps["resolveHost"];
  /** Retry interval for the configured listen mode after a boot fallback (default 30s). */
  networkRetryMs?: number;
  drivers?: Driver[];
  browser?: BrowserService;
  /** Override tool selection (tests); defaults to tools/index toolsForRun */
  tools?: OrchestratorOptions["tools"];
  /** Watcher supervisor factory; null disables watchers. Defaults to WatcherRunner. */
  watchers?: OrchestratorOptions["watchers"];
  log?: (msg: string) => void;
  /** Plugin search path; defaults to <repo>/plugins (builtin) then $HARNESS_HOME/plugins (user). [] disables plugins. */
  pluginDirs?: PluginDir[];
  /**
   * Track the service's source (daemon): /health reports it stale once the code on disk changes.
   * Omit to not track it (tests).
   */
  codeWatch?: { fingerprint: () => string; intervalMs: number };
  /**
   * Exit so the supervisor (launchd) starts the service again: enables POST /service/restart and,
   * with codeWatch, restarting onto new code once idle.
   */
  restart?: () => void;
}

export interface Harness {
  url: string;
  port: number;
  /** The current bearer token (changes on POST /token/rotate). */
  readonly token: string;
  paths: HarnessPaths;
  store: Store;
  bus: EventBus;
  orchestrator: Orchestrator;
  network: NetworkManager;
  plugins: PluginHost;
  codeWatch: CodeWatch | null;
  stop(): Promise<void>;
}

export async function createHarness(opts: CreateHarnessOptions): Promise<Harness> {
  const paths = ensureHome(opts.home);
  let token = ensureToken(paths);
  const tokens: TokenStore = {
    get: () => token,
    rotate: () => (token = rotateToken(paths)),
  };
  const db = openDb(paths.dbPath);
  const store = new Store(db);
  const bus = new EventBus();
  const settings = (): Settings => resolveSettings(store.settings.all());

  const drivers = opts.drivers ?? (await import("./drivers/index")).createDrivers({ settings });
  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await import("./browser/index")).createBrowserService({ profileDir: paths.chromeProfileDir, headless: true });
  const mcp: McpHandler = (await import("./api/mcp")).handleMcpRequest;

  let baseUrl = "";
  const orchestrator = new Orchestrator({
    store,
    bus,
    drivers,
    browser,
    paths,
    tools: opts.tools,
    baseUrl: () => baseUrl,
    watchers: opts.watchers,
    log: opts.log,
  });
  orchestrator.start();

  const plugins = new PluginHost({
    dirs: opts.pluginDirs ?? [
      { path: BUILTIN_PLUGINS_DIR, source: "builtin" },
      { path: join(paths.home, "plugins"), source: "user" },
    ],
    getTicket: (key) => {
      const ticket = store.tickets.getByKey(key);
      const project = ticket ? store.projects.get(ticket.projectId) : null;
      return ticket && project ? { ticket, project } : null;
    },
    bus,
    log: opts.log ?? ((m) => console.log(m)),
  });
  await plugins.load();

  const log = opts.log ?? ((m: string) => console.log(m));
  const network = new NetworkManager({
    port: opts.port,
    listen: () => settings().listen ?? DEFAULT_SETTINGS.listen!,
    override: parseHostOverride(opts.hostname),
    overrideRaw: opts.hostname ?? null,
    tailscale: opts.tailscale,
    localAddresses: opts.localAddresses,
    resolveHost: opts.resolveHost,
    retryMs: opts.networkRetryMs,
    log,
    serve: (hostname, port) => Bun.serve<WsData>({ hostname, port, idleTimeout: 255, websocket: http.websocket, fetch: http.fetch as never }),
  });
  const codeWatch = opts.codeWatch
    ? new CodeWatch({
        fingerprint: opts.codeWatch.fingerprint,
        isIdle: () => orchestrator.isIdle(),
        onChange: (status) => bus.emit({ kind: "service.status", status }),
        restart: opts.restart,
        log,
      })
    : null;
  const http = createHttpHandler({
    orchestrator,
    bus,
    browser,
    tokens,
    mcp,
    plugins,
    network,
    serviceStatus: codeWatch ? () => codeWatch.status() : undefined,
    restart: opts.restart,
  });
  try {
    await network.boot();
  } catch (err) {
    await orchestrator.stop();
    await plugins.stop();
    if (ownsBrowser) await browser.shutdown().catch(() => {});
    db.close();
    throw err;
  }
  const port = network.boundPort;
  baseUrl = network.loopbackUrl;
  codeWatch?.start(opts.codeWatch!.intervalMs);

  let stopped = false;
  return {
    url: baseUrl,
    port,
    get token() {
      return token;
    },
    paths,
    store,
    bus,
    orchestrator,
    network,
    plugins,
    codeWatch,
    async stop() {
      if (stopped) return;
      stopped = true;
      codeWatch?.stop();
      await orchestrator.stop();
      await plugins.stop();
      network.stop();
      if (ownsBrowser) await browser.shutdown().catch(() => {});
      db.close();
    },
  };
}
