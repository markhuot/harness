// The real service as a child process: port 0, a per-run home, the dummy driver. The port is the
// one it reports; readiness is its "listening" line, not a poll.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientMessage, HarnessEvent, ServerMessage } from "@harness/shared";
import { RunFile, spawnTracked, type Spawned } from "./procs";
import { deferred, withDeadline } from "./wait";

const root = join(import.meta.dir, "..", "..");

export interface Daemon {
  home: string;
  url: string;
  token: string;
  spawned: Spawned;
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** A socket on /ws that keeps every message from the moment it opens. */
  socket(): Promise<Socket>;
  stop(): Promise<void>;
}

/** The env a daemon is started with: the host's own settings must not leak in (a supervisor, launchd, another home). */
export function daemonEnv(base: Record<string, string | undefined>, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("HARNESS_") || k === "XPC_SERVICE_NAME") continue;
    env[k] = v;
  }
  return { ...env, HARNESS_HOME: home, HARNESS_PORT: "0", HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "30", ZDOTDIR: join(home, "zdotdir"), SHELL: "/bin/zsh" };
}

export async function startDaemon(runs: RunFile, home: string): Promise<Daemon> {
  // Terminals start the user's shell: an empty ZDOTDIR keeps their rc files (and whatever those print) out of the run.
  mkdirSync(join(home, "zdotdir"), { recursive: true });
  const spawned = spawnTracked(runs, "daemon", ["bun", join(root, "service/src/daemon.ts")], { env: daemonEnv(process.env, home), cwd: root });
  const [, found] = await spawned.line(/harness listening on (http:\/\/127\.0\.0\.1:\d+)/, "the daemon to listen", 60_000);
  const url = found!;
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const sockets: Socket[] = [];

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { data?: T; error?: string };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ""}`);
    return json.data as T;
  };
  return {
    home,
    url,
    token,
    spawned,
    call,
    async socket() {
      const s = new Socket(`${url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
      sockets.push(s);
      await s.ready;
      return s;
    },
    async stop() {
      for (const s of sockets) s.close();
      spawned.proc.kill("SIGTERM");
      await withDeadline("the daemon to exit", 30_000, spawned.proc.exited);
    },
  };
}

/** A /ws client that keeps every message so an event that arrived before the wait began still counts. */
export class Socket {
  readonly messages: ServerMessage[] = [];
  readonly ready: Promise<void>;
  /** Indices of messages a wait has taken; every wait scans from the start, so one wait never discards what it passed over. */
  private taken = new Set<number>();
  private ws: WebSocket;
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    const welcome = deferred<void>();
    this.ready = withDeadline("/ws welcome", 15_000, welcome.promise);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      this.messages.push(m);
      if (m.type === "welcome") welcome.resolve();
      for (const w of this.waiters.splice(0)) w();
    };
    this.ws.onclose = () => {
      this.closed = true;
      welcome.reject(new Error("socket closed before welcome"));
      for (const w of this.waiters.splice(0)) w();
    };
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }

  /** The first message not yet taken that satisfies `match` (terminal output and the like); fails at `ms`. */
  message(what: string, match: (m: ServerMessage) => boolean, ms = 30_000): Promise<ServerMessage> {
    const found = (async () => {
      for (;;) {
        for (let i = 0; i < this.messages.length; i++) {
          const m = this.messages[i]!;
          if (!this.taken.has(i) && match(m)) {
            this.taken.add(i);
            return m;
          }
        }
        if (this.closed) throw new Error(`socket closed before ${what}`);
        await new Promise<void>((r) => this.waiters.push(r));
      }
    })();
    return withDeadline(what, ms, found, () => this.messages.slice(-5).map((m) => m.type).join(","));
  }

  /** The first event not yet taken that satisfies `match`; fails at `ms` with the kinds seen since. */
  event(what: string, match: (e: HarnessEvent) => boolean, ms = 60_000): Promise<HarnessEvent> {
    const found = (async () => {
      for (;;) {
        for (let i = 0; i < this.messages.length; i++) {
          const m = this.messages[i]!;
          if (!this.taken.has(i) && m.type === "event" && match(m.event)) {
            this.taken.add(i);
            return m.event;
          }
        }
        if (this.closed) throw new Error(`socket closed before ${what}`);
        await new Promise<void>((r) => this.waiters.push(r));
      }
    })();
    return withDeadline(what, ms, found, () => this.messages.slice(-5).map((m) => (m.type === "event" ? m.event.kind : m.type)).join(","));
  }
}
