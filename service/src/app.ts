// Composition root: boots store, orchestrator and the HTTP/WS server.

import type { Server } from "bun";
import type { Settings } from "@harness/shared";
import { ensureHome, ensureToken, type HarnessPaths } from "./config";
import { openDb } from "./db";
import { Store } from "./store";
import { EventBus } from "./events";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator/orchestrator";
import { resolveSettings } from "./orchestrator/settings";
import { createHttpServer, type McpHandler } from "./api/http";
import type { WsData } from "./api/ws";
import type { Driver } from "./drivers/types";
import type { BrowserService } from "./browser/types";
import { join, resolve } from "node:path";
import { PluginHost, type PluginDir } from "./plugins/host";

/** Built-in plugins shipped with the repo. */
export const BUILTIN_PLUGINS_DIR = resolve(import.meta.dir, "..", "..", "plugins");

export interface CreateHarnessOptions {
  home: string;
  port: number;
  hostname?: string;
  drivers?: Driver[];
  browser?: BrowserService;
  /** Override tool selection (tests); defaults to tools/index toolsForRun */
  tools?: OrchestratorOptions["tools"];
  /** Watcher supervisor factory; null disables watchers. Defaults to WatcherRunner. */
  watchers?: OrchestratorOptions["watchers"];
  log?: (msg: string) => void;
  /** Plugin search path; defaults to <repo>/plugins (builtin) then $HARNESS_HOME/plugins (user). [] disables plugins. */
  pluginDirs?: PluginDir[];
}

export interface Harness {
  url: string;
  port: number;
  token: string;
  paths: HarnessPaths;
  store: Store;
  bus: EventBus;
  orchestrator: Orchestrator;
  server: Server<WsData>;
  plugins: PluginHost;
  stop(): Promise<void>;
}

export async function createHarness(opts: CreateHarnessOptions): Promise<Harness> {
  const paths = ensureHome(opts.home);
  const token = ensureToken(paths);
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

  const server = createHttpServer({ orchestrator, bus, browser, token, port: opts.port, hostname: opts.hostname, mcp, plugins });
  const port = server.port!;
  baseUrl = `http://127.0.0.1:${port}`;

  let stopped = false;
  return {
    url: baseUrl,
    port,
    token,
    paths,
    store,
    bus,
    orchestrator,
    server,
    plugins,
    async stop() {
      if (stopped) return;
      stopped = true;
      await orchestrator.stop();
      await plugins.stop();
      server.stop(true);
      if (ownsBrowser) await browser.shutdown().catch(() => {});
      db.close();
    },
  };
}
