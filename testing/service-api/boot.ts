import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Project } from "@harness/shared";
import { createHarness, type CreateHarnessOptions, type Harness } from "../../service/src/app";
import type { ApnsTransport } from "../../service/src/notifications/apns";
import type { SpawnPty } from "../../service/src/terminals/pty";
import { QuietBrowser } from "../builders/harness";
import { tempDir } from "../builders/tmp";
import { FakeDriver } from "../service/fake-driver";
import { assertNoTimerLeaks, trackTimers } from "../service/leaks";
import { WsClient } from "./ws-client";

/** What every call returns: the status, and the JSON body (`{data}` on success, `{error}` on failure). */
export interface Reply<T = unknown> {
  status: number;
  body: { data?: T; error?: string };
}

export interface Rig {
  harness: Harness;
  driver: FakeDriver;
  /** A call with the bearer token (or `auth: null` for none, a string for another token). */
  call<T = unknown>(method: string, path: string, body?: unknown, opts?: { auth?: string | null; raw?: string }): Promise<Reply<T>>;
  /** `call`, failing the test unless the status is 2xx; the `data`. */
  ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** A WebSocket as `/ws` expects, with the current token, already past `welcome`. */
  socket(opts?: { token?: string }): Promise<WsClient>;
  /** A project on a fresh directory, made through the API. */
  project(key?: string): Promise<Project>;
  /** Every event the service's bus emitted, in order, as seen by the service itself. */
  busEvents: HarnessEvent[];
  /** Resolves with the first bus event (already emitted, or the next) that satisfies `match`. */
  busEvent(match: (e: HarnessEvent) => boolean): Promise<HarnessEvent>;
}

const rigs: { harness: Harness; sockets: WsClient[] }[] = [];

const apns: ApnsTransport = {
  post: () => Promise.reject(new Error("the L2 rig has no APNs")),
  close() {},
};
const noPty: SpawnPty = () => {
  throw new Error("the L2 rig has no PTY");
};

/**
 * The real service on port 0 with an in-memory database, a per-test home and the scripted driver,
 * and nothing that reaches outside the process: no Tailscale lookup, no APNs, no PTY, no browser,
 * no watchers, no plugins. State is created through the API, never seeded. Pair with
 * `afterEach(stopRigs)`: it stops each service, closes the sockets and fails on a leaked timer.
 */
export async function boot(overrides: Partial<CreateHarnessOptions> = {}): Promise<Rig> {
  trackTimers();
  const driver = new FakeDriver();
  const harness = await createHarness({
    home: tempDir("h-api-"),
    port: 0,
    hostname: "127.0.0.1",
    dbPath: ":memory:",
    drivers: [driver],
    browser: new QuietBrowser(),
    watchers: null,
    pluginDirs: [],
    tailscale: async () => null,
    localAddresses: () => [],
    resolveHost: async () => [],
    apnsTransport: apns,
    spawnPty: noPty,
    log: () => {},
    ...overrides,
  });
  const entry = { harness, sockets: [] as WsClient[] };
  rigs.push(entry);
  // Work goes to the scripted driver in every phase.
  const phase = { driver: driver.id, model: null };
  const phaseModels = { plan: phase, work: phase, review: phase, adviser: phase, complete: phase };
  const busEvents: HarnessEvent[] = [];
  harness.bus.on((e) => busEvents.push(e));

  const rig: Rig = {
    harness,
    driver,
    busEvents,
    busEvent(match) {
      const seen = busEvents.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => {
        const off = harness.bus.on((e) => {
          if (!match(e)) return;
          off();
          resolve(e);
        });
      });
    },
    async call(method, path, body, opts = {}) {
      const headers: Record<string, string> = {};
      const token = opts.auth === undefined ? harness.token : opts.auth;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const text = opts.raw ?? (body === undefined ? undefined : JSON.stringify(body));
      if (text !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${harness.url}${path}`, { method, headers, body: text });
      return { status: res.status, body: (await res.json()) as Reply["body"] } as never;
    },
    async ok(method, path, body) {
      const res = await rig.call(method, path, body);
      if (res.status < 200 || res.status > 299) throw new Error(`${method} ${path} → ${res.status} ${res.body.error ?? ""}`);
      return res.body.data as never;
    },
    async socket(opts = {}) {
      const client = new WsClient(`${harness.url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(opts.token ?? harness.token)}`);
      entry.sockets.push(client);
      await client.ready;
      return client;
    },
    async project(key = "ACME") {
      const dir = join(harness.paths.home, "work", key);
      mkdirSync(dir, { recursive: true });
      return rig.ok<Project>("POST", "/projects", { path: dir, key, name: key, useWorktrees: false });
    },
  };
  await rig.ok("PATCH", "/settings", { phaseModels });
  return rig;
}

export async function stopRigs() {
  for (const { harness, sockets } of rigs.splice(0)) {
    for (const s of sockets) s.close();
    await harness.stop();
  }
  assertNoTimerLeaks();
}
