// Locating, starting and connecting to the harness service. The app never hosts agents itself:
// by default it runs the service as a child process (child.ts), and Settings → Service → Start
// at login hands it to launchd instead, which starts it at login and keeps it running after the
// app quits. Either way the app connects to it over HTTP/WS.
//
// Where the service comes from (resources/harness.json):
//   { executable: "harness-service" }   a packaged app: the compiled service in Contents/MacOS
//   { repoRoot, bunPath }               a dev build: bun runs service/src from the checkout

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChildService } from "./child";
import type { Connection, ConnectionError, ConnectionResult, ServiceMode } from "./types";

export type HarnessResources = { executable: string } | { repoRoot: string; bunPath: string };

export type ServiceSource = { kind: "executable"; path: string } | { kind: "checkout"; repoRoot: string; bunPath: string };

export interface EnsureOutput {
  url: string;
  tokenPath: string;
  home?: string;
  pid?: number;
}

/** `harness service status --json` (service/src/cli.ts Cli.status). */
export interface StatusOutput {
  installed: boolean;
  healthy: boolean;
  pid: number | null;
  url: string;
  home: string;
  tokenPath: string;
  logPath: string;
}

/** resources/harness.json is written by scripts/build.ts (and replaced by scripts/package.ts); it lives next to dist/. */
export function readResources(appRoot: string): HarnessResources | null {
  const file = join(appRoot, "resources", "harness.json");
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (typeof json.executable === "string") return { executable: json.executable };
    if (typeof json.repoRoot === "string" && typeof json.bunPath === "string") return { repoRoot: json.repoRoot, bunPath: json.bunPath };
  } catch {}
  return null;
}

/**
 * The service this build runs. `exeDir` is the app executable's directory (Contents/MacOS), where
 * a packaged app keeps the compiled service. HARNESS_REPO_ROOT points a dev build at another checkout.
 */
export function resolveSource(appRoot: string, exeDir: string, env: NodeJS.ProcessEnv): ServiceSource | ConnectionError {
  const res = readResources(appRoot);
  if (!res) {
    return fail(
      "The app wasn't built with a service location.",
      `Missing or invalid ${join(appRoot, "resources", "harness.json")}. Run \`bun run build\` in app/.`,
    );
  }
  if ("executable" in res) {
    const path = resolve(exeDir, res.executable);
    if (!existsSync(path)) return fail("Couldn't find the harness service.", `Expected ${path} inside the app.`);
    return { kind: "executable", path };
  }
  const repoRoot = env.HARNESS_REPO_ROOT || res.repoRoot;
  const cli = join(repoRoot, "service", "src", "cli.ts");
  if (!existsSync(cli)) return fail("Couldn't find the harness service.", `Expected ${cli}`);
  if (!existsSync(res.bunPath)) return fail("Couldn't find bun.", `Expected bun at ${res.bunPath} (from harness.json).`);
  return { kind: "checkout", repoRoot, bunPath: res.bunPath };
}

/** The service CLI, followed by its arguments. */
export function cliCommand(src: ServiceSource): string[] {
  return src.kind === "executable" ? [src.path] : [src.bunPath, join(src.repoRoot, "service", "src", "cli.ts")];
}

/** The daemon, as the app runs it for its child (the CLI writes the same into the launchd plist). */
export function daemonCommand(src: ServiceSource): string[] {
  return src.kind === "executable" ? [src.path, "daemon"] : [src.bunPath, join(src.repoRoot, "service", "src", "daemon.ts")];
}

/** Finder-launched apps get a bare PATH; add the usual places bun, git, claude and node live. */
export function augmentedPath(bunPath: string | null): string {
  const extra = [
    bunPath ? resolve(bunPath, "..") : null,
    join(homedir(), ".bun/bin"),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((p): p is string => !!p);
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...current, ...extra])].join(":");
}

/** Pull the last JSON object out of CLI stdout (tolerates log lines before it). */
export function parseEnsureOutput(stdout: string): EnsureOutput | null {
  const ok = (json: Record<string, unknown>) => typeof json.url === "string" && typeof json.tokenPath === "string";
  return lastJson(stdout, ok) as EnsureOutput | null;
}

export function parseStatusOutput(stdout: string): StatusOutput | null {
  const ok = (j: Record<string, unknown>) =>
    typeof j.installed === "boolean" && typeof j.healthy === "boolean" && typeof j.url === "string" && typeof j.tokenPath === "string" && typeof j.logPath === "string";
  return lastJson(stdout, ok) as StatusOutput | null;
}

function lastJson(stdout: string, ok: (json: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const json = JSON.parse(t);
      if (ok(json)) return json;
    } catch {}
  }
  // Pretty-printed JSON spanning several lines.
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(stdout.slice(start, end + 1));
      if (ok(json)) return json;
    } catch {}
  }
  return null;
}

function expandHome(p: string) {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>((done) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: null, stdout, stderr, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, error: `Timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

export interface ServiceManagerOptions {
  /** The app root (package.json, resources/, dist/) */
  appRoot: string;
  /** The app executable's directory (Contents/MacOS in a packaged app) */
  exeDir: string;
  env?: NodeJS.ProcessEnv;
  child?: ChildService;
  fetch?: typeof fetch;
  /** How long to wait for a service to answer /health after starting (or stopping) it */
  healthTimeoutMs?: number;
  /** The app's pid, which the child service watches (HARNESS_SUPERVISOR_PID) */
  pid?: number;
}

/**
 * The service for this app: connect() starts it if needed and returns the connection; setMode()
 * moves it between the app's child and launchd; restart() restarts whichever runs it.
 */
export class ServiceManager {
  readonly child: ChildService;
  private env: NodeJS.ProcessEnv;
  private fetch: typeof fetch;

  constructor(private o: ServiceManagerOptions) {
    this.env = o.env ?? process.env;
    this.child = o.child ?? new ChildService({ log: (m) => console.log(`[service] ${m}`) });
    this.fetch = o.fetch ?? fetch;
  }

  private source() {
    return resolveSource(this.o.appRoot, this.o.exeDir, this.env);
  }

  private async cli(src: ServiceSource, args: string[]) {
    const [cmd, ...pre] = cliCommand(src);
    const childEnv = { ...this.env, PATH: augmentedPath(src.kind === "checkout" ? src.bunPath : null) };
    // launchctl bootout waits for the service to shut down, which can take ~25s (Chrome).
    const out = await run(cmd!, [...pre, ...args], childEnv, 45_000);
    const transcript = [`$ ${cliCommand(src).join(" ")} ${args.join(" ")}`, out.stdout.trim(), out.stderr.trim(), out.error ?? ""].filter(Boolean).join("\n");
    return { out, transcript };
  }

  private async status(src: ServiceSource): Promise<StatusOutput | ConnectionError> {
    const { out, transcript } = await this.cli(src, ["service", "status", "--json"]);
    // `status` exits 3 when the service isn't healthy, still printing its JSON.
    const parsed = out.error ? null : parseStatusOutput(out.stdout);
    return parsed ?? fail("The harness service returned something unexpected.", transcript);
  }

  /**
   * Resolve a connection to the service:
   *  1. HARNESS_URL + HARNESS_TOKEN env overrides (dev / tests / mock service)
   *  2. A login item (the launchd plist is installed): `service ensure --json`
   *  3. The app's own child, started if it isn't running (and nothing else answers on the port)
   */
  async connect(): Promise<ConnectionResult> {
    const env = this.env;
    if (env.HARNESS_URL && env.HARNESS_TOKEN) {
      return { baseUrl: env.HARNESS_URL, token: env.HARNESS_TOKEN, source: "env" } satisfies Connection;
    }
    const src = this.source();
    if ("error" in src) return src;
    const status = await this.status(src);
    if ("error" in status) return status;
    if (status.installed) return this.ensureLaunchd(src);
    if (status.healthy && !this.child.running) return this.connection(status, "external", status.pid);
    if (!this.child.running) {
      const childEnv = { ...env, PATH: augmentedPath(src.kind === "checkout" ? src.bunPath : null), HARNESS_SUPERVISOR_PID: String(this.o.pid ?? process.pid) };
      this.child.start(daemonCommand(src), childEnv, status.logPath);
    }
    const health = await this.waitHealthy(status.url);
    if (!health) {
      const detail = this.child.lastError ?? `It didn't answer at ${status.url}/health.`;
      return fail("The harness service didn't start.", `${detail}\n\n${logTail(status.logPath)}`.trim());
    }
    return this.connection(status, "app", health.pid);
  }

  private async ensureLaunchd(src: ServiceSource): Promise<ConnectionResult> {
    const { out, transcript } = await this.cli(src, ["service", "ensure", "--json"]);
    if (out.code !== 0) return fail("The harness service didn't start.", transcript);
    const parsed = parseEnsureOutput(out.stdout);
    if (!parsed) return fail("The harness service returned something unexpected.", transcript);
    const token = readTokenFile(parsed.tokenPath);
    if (typeof token !== "string") return token;
    return { baseUrl: parsed.url, token, source: "service", mode: "login", tokenPath: parsed.tokenPath, home: parsed.home, pid: parsed.pid };
  }

  private connection(status: StatusOutput, mode: ServiceMode, pid: number | null | undefined): ConnectionResult {
    const token = readTokenFile(status.tokenPath);
    if (typeof token !== "string") return token;
    return { baseUrl: status.url, token, source: "service", mode, tokenPath: status.tokenPath, home: status.home, pid: pid ?? undefined };
  }

  private async health(url: string): Promise<{ pid: number } | null> {
    try {
      const res = await this.fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return ((await res.json()) as { data: { pid: number } }).data;
    } catch {}
    return null;
  }

  /** Poll /health until it answers; null on timeout, or once a child that gave up can't answer. */
  private async waitHealthy(url: string): Promise<{ pid: number } | null> {
    const deadline = Date.now() + (this.o.healthTimeoutMs ?? 20_000);
    for (;;) {
      const health = await this.health(url);
      if (health) return health;
      if (Date.now() >= deadline || !this.child.running) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Poll /health until nothing answers (the port is free); false on timeout. */
  private async waitStopped(url: string): Promise<boolean> {
    const deadline = Date.now() + (this.o.healthTimeoutMs ?? 20_000);
    while (await this.health(url)) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  /** Move the service to `mode`. It restarts either way, stopping running agents. */
  async setMode(mode: "app" | "login"): Promise<{ connection: ConnectionResult; error?: ConnectionError }> {
    if (this.env.HARNESS_URL && this.env.HARNESS_TOKEN) {
      const connection = await this.connect();
      return { connection, error: fail("This window connects to HARNESS_URL, so the app doesn't run its service.", "") };
    }
    const src = this.source();
    if ("error" in src) return { connection: src, error: src };
    if (mode === "login") {
      await this.child.stop();
      const connection = await this.ensureLaunchd(src);
      if (!("error" in connection)) return { connection };
      // Couldn't hand it to launchd: take it back so the app still has a service.
      await this.cli(src, ["service", "uninstall", "--json"]);
      return { connection: await this.connect(), error: connection };
    }
    const status = await this.status(src);
    if ("error" in status) return { connection: status, error: status };
    if (!status.installed) return { connection: await this.connect() }; // already the app's
    const { out, transcript } = await this.cli(src, ["service", "uninstall", "--json"]);
    if (out.code !== 0) return { connection: await this.connect(), error: fail("Couldn't remove the login item.", transcript) };
    // bootout waits for the job to exit, but let the port go quiet before starting the child on it.
    await this.waitStopped(status.url);
    const connection = await this.connect();
    return "error" in connection ? { connection, error: connection } : { connection };
  }

  /**
   * Restart the service now; running agents are stopped. The app's child restarts in place, and
   * launchd's job through `service restart` (`launchctl kickstart -k`), which works on a service of
   * any age, including one from before POST /service/restart existed. Other connections (HARNESS_URL,
   * a service started by hand) ask the service to restart itself.
   */
  async restart(conn: ConnectionResult | null): Promise<{ ok: true } | ConnectionError> {
    if (!conn || "error" in conn) return fail("Not connected to the service.", "");
    if (conn.source === "service" && conn.mode === "app") {
      await this.child.restart();
      const health = await this.waitHealthy(conn.baseUrl);
      return health ? { ok: true } : fail("The harness service didn't restart.", this.child.lastError ?? "");
    }
    if (conn.source === "service" && conn.mode === "login") {
      const src = this.source();
      if ("error" in src) return src;
      const { out, transcript } = await this.cli(src, ["service", "restart", "--json"]);
      return out.code === 0 ? { ok: true } : fail("The harness service didn't restart.", transcript);
    }
    try {
      const res = await this.fetch(`${conn.baseUrl.replace(/\/$/, "")}/service/restart`, {
        method: "POST",
        headers: { authorization: `Bearer ${conn.token}` },
      });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return fail("The harness service didn't restart.", body.error ?? `HTTP ${res.status}`);
    } catch (e) {
      return fail("The harness service didn't restart.", (e as Error).message);
    }
  }

  /** How many agents are mid-run (for the quit warning); 0 when that can't be told. */
  async busyAgents(conn: ConnectionResult | null): Promise<number> {
    if (!conn || "error" in conn) return 0;
    try {
      const res = await this.fetch(`${conn.baseUrl.replace(/\/$/, "")}/sessions`, {
        headers: { authorization: `Bearer ${conn.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as { data?: { busy?: boolean }[] };
      return (body.data ?? []).filter((s) => s.busy).length;
    } catch {
      return 0;
    }
  }
}

/** The end of the service log, for the error screen when the service doesn't come up. */
function logTail(logPath: string, lines = 15): string {
  try {
    return readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Read the bearer token file (as written by the service, trailing newline trimmed). */
export function readTokenFile(tokenPath: string): string | ConnectionError {
  let token: string;
  try {
    token = readFileSync(expandHome(tokenPath), "utf8").trim();
  } catch (e) {
    return fail("Couldn't read the service token.", `${tokenPath}: ${(e as Error).message}`);
  }
  if (!token) return fail("The service token is empty.", tokenPath);
  return token;
}

/**
 * After the token was rotated (POST /token/rotate): the same connection with the token re-read from
 * its file. Env connections have no file; they take the token the rotate call returned.
 */
export function reloadToken(conn: ConnectionResult | null, rotated?: string): ConnectionResult {
  if (!conn || "error" in conn) return conn ?? fail("Not connected to the service.", "");
  if (!conn.tokenPath) return rotated ? { ...conn, token: rotated } : conn;
  const token = readTokenFile(conn.tokenPath);
  return typeof token === "string" ? { ...conn, token } : token;
}

function fail(error: string, output: string): ConnectionError {
  return { error, output };
}
