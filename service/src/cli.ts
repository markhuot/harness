#!/usr/bin/env bun
// harness CLI: manage the launchd agent and do quick ticket operations.
//
//   harness service install|uninstall|start|stop|restart|status|ensure [--force] [--json]
//   harness new <dir> "<prompt>" [--driver <id>] [--plan]
//   harness tickets [--json]

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HarnessClient, keyLabel, type Ticket } from "@harness/shared";
import { ensureHome, ensureToken, harnessPaths, readServiceJson, readToken, resolveHome, resolvePort } from "./config";
import { COMPILED, daemonProgram } from "./runtime";

export const LAUNCHD_LABEL = "com.markhuot.harness";
/** The plist's ExitTimeOut: launchd SIGKILLs the daemon this long after SIGTERM. */
export const EXIT_TIMEOUT_S = 30;

export interface PlistOptions {
  label?: string;
  /** The command that runs the daemon (runtime.ts daemonProgram) */
  program: string[];
  /** Extra PATH entries ahead of the defaults: bun's directory when the daemon runs under bun */
  pathDirs?: string[];
  home: string;
  port: number;
  logPath: string;
  userHome: string;
  /** Add the dummy driver to the service (HARNESS_DUMMY_DRIVER=1); only acceptance runs ask for it. */
  dummyDriver?: boolean;
}

export function launchdPath(userHome: string, extra: string[] = []): string {
  const dirs = [
    join(userHome, ".local/bin"),
    join(userHome, ".bun/bin"),
    ...extra,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pure: the launchd agent plist for the service. */
export function buildPlist(o: PlistOptions): string {
  const env: Record<string, string> = {
    PATH: launchdPath(o.userHome, o.pathDirs),
    HOME: o.userHome,
    HARNESS_HOME: o.home,
    HARNESS_PORT: String(o.port),
    ...(o.dummyDriver ? { HARNESS_DUMMY_DRIVER: "1" } : {}),
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${esc(o.label ?? LAUNCHD_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${o.program.map((a) => `      <string>${esc(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>WorkingDirectory</key>
    <string>${esc(o.home)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ExitTimeOut</key>
    <integer>${EXIT_TIMEOUT_S}</integer>
    <key>StandardOutPath</key>
    <string>${esc(o.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(o.logPath)}</string>
  </dict>
</plist>
`;
}

/** The bundled plist's file name in Harness.app/Contents/Library/LaunchAgents (SMAppService's serviceName). */
export const BUNDLED_PLIST = `${LAUNCHD_LABEL}.plist`;
/** EnvironmentVariables marker: launchd started the daemon from the app's bundled plist. */
export const BUNDLED_ENV = "HARNESS_LAUNCHD";

/**
 * Pure: the plist a packaged Harness.app ships in Contents/Library/LaunchAgents, which the app
 * registers through SMAppService (Start at login). launchd then attributes the job to the app the
 * user approved, so Gatekeeper doesn't evaluate the quarantined service binary on its own (a
 * prompt nobody sees, and the service hangs before its first instruction). It's the same for
 * every user, so it holds no paths: the daemon works out PATH, its working directory and its log
 * file itself (daemon.ts, BUNDLED_ENV).
 */
export function buildBundledPlist(o: { appBundleId: string; executable: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${esc(LAUNCHD_LABEL)}</string>
    <key>BundleProgram</key>
    <string>Contents/MacOS/${esc(o.executable)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(o.executable)}</string>
      <string>daemon</string>
    </array>
    <key>AssociatedBundleIdentifiers</key>
    <array>
      <string>${esc(o.appBundleId)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>${BUNDLED_ENV}</key>
      <string>bundle</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ExitTimeOut</key>
    <integer>${EXIT_TIMEOUT_S}</integer>
  </dict>
</plist>
`;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string[]) => Promise<ExecResult>;

export const realExec: Exec = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

export interface CliDeps {
  env: Record<string, string | undefined>;
  exec: Exec;
  uid: number;
  userHome: string;
  /** The command that runs the daemon (runtime.ts daemonProgram) */
  program: string[];
  /** Extra PATH entries for the daemon (bun's directory in a checkout) */
  pathDirs: string[];
  out: (s: string) => void;
  err: (s: string) => void;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** How long `ensure` polls /health */
  healthTimeoutMs: number;
  /**
   * The compiled service inside Harness.app, whose login item the app registers through
   * SMAppService from the bundled plist. This CLI then never writes a plist of its own for the
   * label (install, ensure and start refuse), and restart only kickstarts the job launchd has.
   */
  appManaged: boolean;
}

const APP_MANAGED =
  "Harness.app runs this service: turn on Settings → Service → Start at login in the app to keep it running after you quit.";

export function defaultDeps(): CliDeps {
  return {
    env: process.env,
    exec: realExec,
    uid: process.getuid?.() ?? 501,
    userHome: homedir(),
    program: daemonProgram(),
    // The executable's directory is Harness.app/Contents/MacOS, whose Harness would shadow a
    // `harness` command on a case-insensitive disk; only a checkout's bun goes on PATH.
    pathDirs: COMPILED ? [] : [dirname(process.execPath)],
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    fetch: globalThis.fetch,
    sleep: (ms) => Bun.sleep(ms),
    healthTimeoutMs: 15_000,
    appManaged: COMPILED,
  };
}

export class Cli {
  constructor(private d: CliDeps) {}

  get home() {
    return resolveHome(this.d.env);
  }
  get port() {
    return resolvePort(this.d.env);
  }
  get plistPath() {
    return join(this.d.userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }
  get domain() {
    return `gui/${this.d.uid}`;
  }
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  plist(): string {
    const paths = harnessPaths(this.home);
    return buildPlist({
      program: this.d.program,
      pathDirs: this.d.pathDirs,
      home: this.home,
      port: this.port,
      logPath: paths.logPath,
      userHome: this.d.userHome,
      dummyDriver: this.d.env.HARNESS_DUMMY_DRIVER === "1",
    });
  }

  private async launchctl(...args: string[]) {
    return this.d.exec(["launchctl", ...args]);
  }

  async loaded(): Promise<{ loaded: boolean; pid: number | null }> {
    const r = await this.launchctl("print", `${this.domain}/${LAUNCHD_LABEL}`);
    if (r.code !== 0) return { loaded: false, pid: null };
    const m = /^\s*pid = (\d+)/m.exec(r.stdout);
    return { loaded: true, pid: m ? Number(m[1]) : null };
  }

  /** The plist on disk differs from the one this build writes (or there is none). */
  plistChanged(): boolean {
    return (existsSync(this.plistPath) ? readFileSync(this.plistPath, "utf8") : null) !== this.plist();
  }

  /** Write the plist when missing or different. Returns true when it changed. */
  writePlist(): boolean {
    if (!this.plistChanged()) return false;
    const next = this.plist();
    mkdirSync(dirname(this.plistPath), { recursive: true });
    ensureHome(this.home);
    writeFileSync(this.plistPath, next);
    return true;
  }

  async install(): Promise<{ changed: boolean }> {
    if (this.d.appManaged) throw new Error(APP_MANAGED);
    ensureToken(ensureHome(this.home));
    const changed = this.writePlist();
    const state = await this.loaded();
    if (state.loaded && changed) await this.bootout();
    if (!state.loaded || changed) await this.bootstrap();
    return { changed };
  }

  /**
   * `launchctl bootout` returns as soon as it has sent SIGTERM, but launchd keeps the job until the
   * daemon exits (up to ExitTimeOut, closing Chrome), and a bootstrap before then fails with 5
   * while `print` still finds the dying job. So wait for the job to be gone.
   */
  private async bootout() {
    await this.launchctl("bootout", `${this.domain}/${LAUNCHD_LABEL}`);
    const deadline = Date.now() + (EXIT_TIMEOUT_S + 5) * 1000;
    while ((await this.loaded()).loaded) {
      if (Date.now() >= deadline) throw new Error(`launchd still has ${LAUNCHD_LABEL} ${EXIT_TIMEOUT_S + 5}s after bootout`);
      await this.d.sleep(250);
    }
  }

  private async bootstrap() {
    const r = await this.launchctl("bootstrap", this.domain, this.plistPath);
    // 5 / 37: already bootstrapped (races with KeepAlive); anything else is an error
    if (r.code !== 0 && !(await this.loaded()).loaded) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || r.code}`);
  }

  /**
   * Remove the plist this CLI wrote. App-managed, that's only a plist from before the app
   * registered its login item through SMAppService (the app migrates it); the app's own job is
   * left to the app.
   */
  async uninstall() {
    if (this.d.appManaged && !existsSync(this.plistPath)) return;
    await this.bootout();
    if (existsSync(this.plistPath)) unlinkSync(this.plistPath);
  }

  async start() {
    if (this.d.appManaged) {
      if (!(await this.loaded()).loaded) throw new Error(APP_MANAGED);
      await this.launchctl("kickstart", `${this.domain}/${LAUNCHD_LABEL}`);
      return { changed: false };
    }
    if (this.plistChanged()) return this.install();
    if (!(await this.loaded()).loaded) await this.bootstrap();
    else await this.launchctl("kickstart", `${this.domain}/${LAUNCHD_LABEL}`);
    return { changed: false };
  }

  async stop() {
    await this.bootout();
  }

  async restart() {
    if (!(await this.loaded()).loaded) return this.start();
    if (this.d.appManaged) return void (await this.launchctl("kickstart", "-k", `${this.domain}/${LAUNCHD_LABEL}`));
    // launchd relaunches the definition it loaded, so a plist that changed since (an ensure that
    // was deferred) is reloaded instead.
    if (this.plistChanged()) return this.install();
    await this.launchctl("kickstart", "-k", `${this.domain}/${LAUNCHD_LABEL}`);
  }

  /** Agents mid-run on the service; 0 when it can't be asked. */
  async busyAgents(): Promise<number> {
    const token = readToken(harnessPaths(this.home));
    if (!token) return 0;
    try {
      const res = await this.d.fetch(`${this.url}/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return 0;
      const body = (await res.json()) as { data?: { busy?: boolean }[] };
      return (body.data ?? []).filter((s) => s.busy).length;
    } catch {
      return 0;
    }
  }

  async health(): Promise<{ ok: true; version: string; pid: number } | null> {
    try {
      const res = await this.d.fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return null;
      return ((await res.json()) as { data: { ok: true; version: string; pid: number } }).data;
    } catch {
      return null;
    }
  }

  async waitHealthy(): Promise<{ ok: true; version: string; pid: number } | null> {
    const deadline = Date.now() + this.d.healthTimeoutMs;
    for (;;) {
      const h = await this.health();
      if (h) return h;
      if (Date.now() >= deadline) return null;
      await this.d.sleep(250);
    }
  }

  async status() {
    const state = await this.loaded();
    const health = await this.health();
    const paths = harnessPaths(this.home);
    return {
      installed: existsSync(this.plistPath),
      loaded: state.loaded,
      pid: health?.pid ?? state.pid,
      healthy: !!health,
      version: health?.version ?? null,
      url: this.url,
      home: this.home,
      tokenPath: paths.tokenPath,
      plistPath: this.plistPath,
      logPath: paths.logPath,
    };
  }

  /**
   * Install if missing or changed, start, and wait for /health. A changed plist (another build of
   * the app, say) restarts the service, so while agents are running that waits: the running
   * service is left alone and `deferred` says why, until an ensure with `force` or a `restart`.
   */
  async ensure(opts: { force?: boolean } = {}): Promise<{ url: string; tokenPath: string; home: string; pid: number; deferred?: { busy: number } }> {
    if (this.d.appManaged) throw new Error(APP_MANAGED);
    if (!opts.force && existsSync(this.plistPath) && this.plistChanged() && (await this.loaded()).loaded) {
      const running = await this.health();
      const busy = running ? await this.busyAgents() : 0;
      if (running && busy > 0) return { url: this.url, tokenPath: harnessPaths(this.home).tokenPath, home: this.home, pid: running.pid, deferred: { busy } };
    }
    const { changed } = await this.install();
    let health = changed ? null : await this.health();
    if (!health) {
      if ((await this.loaded()).loaded && !changed) await this.launchctl("kickstart", `${this.domain}/${LAUNCHD_LABEL}`);
      health = await this.waitHealthy();
    }
    if (!health) throw new Error(`harness service did not become healthy at ${this.url} (see ${harnessPaths(this.home).logPath})`);
    return { url: this.url, tokenPath: harnessPaths(this.home).tokenPath, home: this.home, pid: health.pid };
  }

  client(): HarnessClient {
    const paths = harnessPaths(this.home);
    const token = readToken(paths);
    if (!token) throw new Error(`No token at ${paths.tokenPath}; run \`harness service ensure\``);
    const port = this.d.env.HARNESS_PORT ? this.port : (readServiceJson(paths)?.port ?? this.port);
    return new HarnessClient({ baseUrl: `http://127.0.0.1:${port}`, token });
  }

  async newTicket(dir: string, prompt: string, opts: { driver?: string; plan?: boolean }): Promise<Ticket> {
    const client = this.client();
    try {
      await client.health();
    } catch {
      throw new Error("harness service is not running; run `harness service ensure`");
    }
    const path = resolve(dir);
    const project = (await client.listProjects()).find((p) => p.path === path) ?? (await client.createProject({ path }));
    return client.createTicket({ projectId: project.id, spec: prompt, driver: opts.driver, start: !opts.plan });
  }

  async run(argv: string[]): Promise<number> {
    const json = argv.includes("--json");
    const args = argv.filter((a) => a !== "--json");
    const flag = (name: string) => {
      const i = args.indexOf(name);
      if (i < 0) return undefined;
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    };
    const print = (human: string, data: unknown) => this.d.out(json ? JSON.stringify(data) : human);
    const [cmd, sub, ...rest] = args;
    try {
      if (cmd === "service") {
        switch (sub) {
          case "install": {
            const r = await this.install();
            print(r.changed ? `Installed ${this.plistPath}` : "Already installed", { ...r, plistPath: this.plistPath });
            return 0;
          }
          case "uninstall":
            await this.uninstall();
            print("Uninstalled", { ok: true });
            return 0;
          case "start":
            await this.start();
            print("Started", { ok: true });
            return 0;
          case "stop":
            await this.stop();
            print("Stopped", { ok: true });
            return 0;
          case "restart":
            await this.restart();
            print("Restarted", { ok: true });
            return 0;
          case "status": {
            const s = await this.status();
            print(
              `${s.healthy ? "running" : s.loaded ? "loaded (not responding)" : s.installed ? "installed (not loaded)" : "not installed"}` +
                `${s.pid ? ` pid ${s.pid}` : ""} · ${s.url} · home ${s.home}`,
              s,
            );
            return s.healthy ? 0 : 3;
          }
          case "ensure": {
            const r = await this.ensure({ force: args.includes("--force") });
            const deferred = r.deferred ? ` · not reloaded: ${r.deferred.busy} agent(s) running (--force restarts it)` : "";
            print(`harness running at ${r.url} (pid ${r.pid})${deferred}`, r);
            return 0;
          }
        }
      } else if (cmd === "new") {
        const driver = flag("--driver");
        const plan = args.includes("--plan");
        const pos = args.filter((a) => a !== "--plan").slice(1);
        const [dir, ...words] = pos;
        if (!dir || !words.length) return this.usage();
        const t = await this.newTicket(dir, words.join(" "), { driver, plan });
        print(`${keyLabel(t)} ${t.title} [${t.status}]`, t);
        return 0;
      } else if (cmd === "network") {
        const n = await this.client().network();
        const ts = n.tailscale ? `tailscale ${n.tailscale.ip}${n.tailscale.dnsName ? ` (${n.tailscale.dnsName})` : ""}` : "tailscale not running";
        print(
          [`mode ${n.mode}${n.host ? ` ${n.host}` : ""}${n.active !== n.mode ? ` (serving ${n.active})` : ""}${n.override ? ` · HARNESS_HOST=${n.override}` : ""}`, ...n.bound.map((b) => `  ${b.url}`), ts, ...(n.error ? [`error: ${n.error}`] : [])].join("\n"),
          n,
        );
        return 0;
      } else if (cmd === "listen") {
        if (!sub || (sub === "custom" && !rest[0])) return this.usage();
        const s = await this.client().updateSettings({ listen: sub === "custom" ? { mode: "custom", host: rest[0] } : { mode: sub as never } });
        const n = await this.client().network();
        print(`listen ${s.listen?.mode}: ${n.bound.map((b) => b.url).join(", ")}`, n);
        return 0;
      } else if (cmd === "pair") {
        const p = await this.client().pairing();
        print(`${p.url}\n${p.pairUrl}`, p);
        return 0;
      } else if (cmd === "token" && sub === "rotate") {
        await this.client().rotateToken();
        print(`Rotated the token (${harnessPaths(this.home).tokenPath}); the old one no longer works`, { ok: true, tokenPath: harnessPaths(this.home).tokenPath });
        return 0;
      } else if (cmd === "tickets") {
        const tickets = await this.client().listTickets();
        // A linked ticket shows its remote ID with its local key: "MH-62 · MH-124".
        const width = Math.max(14, ...tickets.map((t) => keyLabel(t).length));
        print(tickets.map((t) => `${keyLabel(t).padEnd(width)} ${(t.draft ? "draft" : t.status).padEnd(12)} ${t.busy ? "●" : " "} ${t.title}`).join("\n") || "(no tickets)", tickets);
        return 0;
      }
      return this.usage();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) this.d.out(JSON.stringify({ error: msg }));
      else this.d.err(msg);
      return 1;
    }
  }

  private usage(): number {
    this.d.err(
      [
        "usage:",
        "  harness service install|uninstall|start|stop|restart|status|ensure [--force] [--json]",
        '  harness new <dir> "<prompt>" [--driver <id>] [--plan] [--json]',
        "  harness tickets [--json]",
        "  harness network [--json]",
        "  harness listen localhost|tailscale|any|custom <host> [--json]",
        "  harness pair [--json]",
        "  harness token rotate [--json]",
      ].join("\n"),
    );
    return 2;
  }
}

if (import.meta.main) {
  const code = await new Cli(defaultDeps()).run(process.argv.slice(2));
  process.exit(code);
}
