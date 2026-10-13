// One way to run the real service for tests, check scripts and dev tools: spawn service/src/daemon.ts
// with the dummy driver in a throwaway HARNESS_HOME, wait until it answers, hand back its API, and
// stop it (and the Chrome it launched) without leaving files behind. sim-check, dev-sim and the app's
// drive scripts all start their daemons here. Not imported by production code.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { seedChromeProfile } from "./chrome-profile";
import { tempDir } from "./tmp";

export const repoRoot = resolve(import.meta.dir, "..", "..", "..");
export const daemonEntry = join(repoRoot, "service", "src", "daemon.ts");

/**
 * Poll `fn` until it returns something truthy. Errors it throws are retried; the last one is
 * reported on timeout. `beforeEach` runs before every attempt and may throw to give up early
 * (sim-check's per-check time cap).
 */
export async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 8000, every = 100, beforeEach?: () => void): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    beforeEach?.();
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(every);
  }
  throw new Error(`timed out waiting for: ${what}${last ? ` (${(last as Error).message})` : ""}`);
}

/**
 * A port nothing is listening on. With `pool` it picks inside that range (a kept sim-check daemon
 * holds its port indefinitely, and a fixed range keeps them findable); otherwise the OS picks.
 */
export function freePort(pool?: { from: number; span: number }): number {
  if (pool) {
    for (let i = 0; i < 200; i++) {
      const p = pool.from + Math.floor(Math.random() * pool.span);
      try {
        Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }).stop(true);
        return p;
      } catch {}
    }
    throw new Error(`no free port in ${pool.from}-${pool.from + pool.span - 1}`);
  }
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  if (!port) throw new Error("couldn't find a free port");
  return port;
}

/**
 * A kept daemon that still runs: its pid is alive, its token file exists in `dir`, /health answers
 * and the home's token is accepted by an authenticated route. The last check matters because a
 * recycled pid plus another daemon on the same port would pass the others while holding another token.
 */
export async function daemonAnswers(s: { daemonPid: number; port: number }, dir: string): Promise<boolean> {
  try {
    process.kill(s.daemonPid, 0);
  } catch {
    return false;
  }
  let token: string;
  try {
    token = readFileSync(join(dir, "token"), "utf8").trim();
  } catch {
    return false;
  }
  const base = `http://127.0.0.1:${s.port}`;
  const healthy = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (!healthy) return false;
  return fetch(`${base}/settings`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}

type Killable = { exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void };

/** SIGTERM, then SIGKILL once `ms` pass. Resolves true when the process left on its own. */
export async function stopProcess(proc: Killable, ms = 5000): Promise<boolean> {
  proc.kill("SIGTERM");
  const graceful = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  if (!graceful) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  return graceful;
}

/** An API client for the service: unwraps `{ data }`, throws on a non-2xx with the service's error text. */
export function apiClient(base: string, token: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ""}`.trim());
    return json.data as T;
  };
}

export type StartDaemonOptions = {
  /** HARNESS_HOME; a tracked temp dir when omitted. A given one is the caller's to remove. */
  home?: string;
  port?: number;
  /** Where to look for a free port when `port` isn't set. */
  portPool?: { from: number; span: number };
  /** HARNESS_DUMMY_DELAY_MS: how long each dummy-driver step takes. Default 1. */
  delayMs?: number;
  /** Extra environment for the daemon (e.g. a fake claude binary). */
  env?: Record<string, string>;
  /** "files": daemon.out and daemon.err in the home (printed on a failed start); "inherit": this terminal. Default "files". */
  logs?: "files" | "inherit";
  /** How long to wait for /health and the token file. Default 20 s. */
  readyMs?: number;
  /**
   * Stop the daemon (and sweep its Chrome) when this process exits or gets SIGINT/SIGTERM/SIGHUP,
   * so a killed check leaves no orphan. Default true; pass false for a daemon meant to outlive
   * the run (sim-check --keep).
   */
  stopOnExit?: boolean;
  /** The script to run instead of the service's daemon (for tests of this module). */
  entry?: string;
};

export type TestDaemon = {
  base: string;
  port: number;
  token: string;
  home: string;
  proc: ReturnType<typeof Bun.spawn>;
  api: ReturnType<typeof apiClient>;
  /** The Chrome profile the daemon launches browsers with; stop() clears out any Chrome left on it. */
  chromeProfile: string;
  /** SIGTERM (the daemon closes its Chrome), SIGKILL plus a Chrome sweep after `termMs`, then remove the home if the daemon made it. */
  stop(opts?: { termMs?: number; keepHome?: boolean }): Promise<void>;
};

/** What a daemon that failed to start wrote to stderr, for the error that reports it. */
function stderrTail(home: string): string {
  try {
    return readFileSync(join(home, "daemon.err"), "utf8").slice(-2000);
  } catch {
    return "";
  }
}

/** Kills a Chrome still running on `profile`: one the daemon didn't get to close. */
function sweepChrome(profile: string) {
  Bun.spawnSync(["pkill", "-f", `user-data-dir=${profile}`]);
}

/** Whether `pid` still exists as a running process: a zombie nobody has reaped yet doesn't count. */
function alive(pid: number): boolean {
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

/** Blocking stop for exit hooks, where no promise can settle: SIGTERM, wait up to `ms`, then SIGKILL. */
function stopProcessSync(pid: number, ms = 5000) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end && alive(pid)) Bun.sleepSync(50);
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** The daemons whose owner process must not leave without stopping them; one handler set serves them all. */
const hooked = new Set<() => void>();
let hooksInstalled = false;

function stopHooked() {
  for (const cleanup of [...hooked]) cleanup();
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // Registered ahead of tmp.ts's own exit hook, so the daemon is gone before its home is removed.
  process.prependListener("exit", stopHooked);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    const onSignal = () => {
      stopHooked();
      // A script with its own handler for this signal finishes its shutdown; otherwise leave now.
      if (process.listenerCount(sig) <= 1) process.exit(code);
    };
    process.on(sig, onSignal);
  }
}

/**
 * Starts the real daemon with the dummy driver and resolves once it answers /health and has
 * written its token. A daemon that doesn't get there (exits, or the readiness timeout passes) is
 * stopped and its home removed before the error, which carries the tail of its stderr, is thrown.
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<TestDaemon> {
  const ownsHome = !opts.home;
  const home = opts.home ?? tempDir("harness-daemon-");
  mkdirSync(home, { recursive: true });
  const port = opts.port ?? freePort(opts.portPool);
  const base = `http://127.0.0.1:${port}`;
  const files = (opts.logs ?? "files") === "files";
  // A test daemon runs by itself: not under the app's launchd plist (which rewrites PATH and sends
  // its output to a log file) and not supervised (which would let it restart through the app's).
  const { HARNESS_LAUNCHD: _launchd, HARNESS_SUPERVISOR_PID: _supervisor, ...inherited } = process.env;
  // The daemon's Chrome starts from a settled profile, so it doesn't rewrite the user's web-app
  // shims (chrome-profile.ts). A home handed in keeps whatever profile it has.
  await seedChromeProfile(join(home, "chrome-profile"), opts.env?.HARNESS_CHROME_PATH || process.env.HARNESS_CHROME_PATH || undefined);
  const proc = Bun.spawn(["bun", opts.entry ?? daemonEntry], {
    env: { ...inherited, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: String(opts.delayMs ?? 1), ...opts.env },
    stdout: files ? Bun.file(join(home, "daemon.out")) : "inherit",
    stderr: files ? Bun.file(join(home, "daemon.err")) : "inherit",
  });
  const chromeProfile = join(home, "chrome-profile");
  let stopping = false;
  let done = false;
  // Blocking cleanup for an exit hook. Also covers a stop() still waiting out its grace period.
  const cleanup = () => {
    if (done) return;
    done = true;
    hooked.delete(cleanup);
    stopProcessSync(proc.pid);
    sweepChrome(chromeProfile);
    if (ownsHome) rmSync(home, { recursive: true, force: true });
  };
  if (opts.stopOnExit ?? true) {
    hooked.add(cleanup);
    installHooks();
  }
  const stop: TestDaemon["stop"] = async ({ termMs = 20000, keepHome = false } = {}) => {
    if (stopping || done) return;
    stopping = true;
    if (!(await stopProcess(proc, termMs))) sweepChrome(chromeProfile);
    if (done) return; // an exit hook took over while we waited
    done = true;
    hooked.delete(cleanup);
    if (ownsHome && !keepHome) rmSync(home, { recursive: true, force: true });
  };
  try {
    const exitedEarly = proc.exited.then((code) => {
      throw new Error(`the daemon exited with code ${code} before it was ready`);
    });
    exitedEarly.catch(() => {}); // surfaced below by the race; not an unhandled rejection if readiness wins
    await Promise.race([
      until("daemon /health", async () => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok && existsSync(join(home, "token")), opts.readyMs ?? 20000, 50),
      exitedEarly,
    ]);
  } catch (e) {
    const tail = files ? stderrTail(home) : "";
    await stop({ termMs: 2000 });
    throw new Error(`${(e as Error).message}${tail ? `\n${tail}` : ""}`);
  }
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return { base, port, token, home, proc, api: apiClient(base, token), chromeProfile, stop };
}
