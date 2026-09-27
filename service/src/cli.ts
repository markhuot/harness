#!/usr/bin/env bun
// harness CLI: manage the launchd agent and do quick ticket operations.
//
//   harness service install|uninstall|start|stop|restart|status|ensure [--json]
//   harness new <dir> "<prompt>" [--driver <id>] [--plan]
//   harness tickets [--json]

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HarnessClient, type Ticket } from "@harness/shared";
import { ensureHome, ensureToken, harnessPaths, readServiceJson, readToken, resolveHome, resolvePort } from "./config";

export const LAUNCHD_LABEL = "com.markhuot.harness";

export interface PlistOptions {
  label?: string;
  bunPath: string;
  daemonPath: string;
  home: string;
  port: number;
  logPath: string;
  userHome: string;
}

export function launchdPath(userHome: string, bunPath: string): string {
  const dirs = [
    join(userHome, ".local/bin"),
    join(userHome, ".bun/bin"),
    dirname(bunPath),
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
    PATH: launchdPath(o.userHome, o.bunPath),
    HOME: o.userHome,
    HARNESS_HOME: o.home,
    HARNESS_PORT: String(o.port),
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
      <string>${esc(o.bunPath)}</string>
      <string>${esc(o.daemonPath)}</string>
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
    <key>StandardOutPath</key>
    <string>${esc(o.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(o.logPath)}</string>
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
  bunPath: string;
  daemonPath: string;
  out: (s: string) => void;
  err: (s: string) => void;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** How long `ensure` polls /health */
  healthTimeoutMs: number;
}

export function defaultDeps(): CliDeps {
  return {
    env: process.env,
    exec: realExec,
    uid: process.getuid?.() ?? 501,
    userHome: homedir(),
    bunPath: process.execPath,
    daemonPath: resolve(import.meta.dir, "daemon.ts"),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    fetch: globalThis.fetch,
    sleep: (ms) => Bun.sleep(ms),
    healthTimeoutMs: 15_000,
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
      bunPath: this.d.bunPath,
      daemonPath: this.d.daemonPath,
      home: this.home,
      port: this.port,
      logPath: paths.logPath,
      userHome: this.d.userHome,
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

  /** Write the plist when missing or different. Returns true when it changed. */
  writePlist(): boolean {
    const next = this.plist();
    const current = existsSync(this.plistPath) ? readFileSync(this.plistPath, "utf8") : null;
    if (current === next) return false;
    mkdirSync(dirname(this.plistPath), { recursive: true });
    ensureHome(this.home);
    writeFileSync(this.plistPath, next);
    return true;
  }

  async install(): Promise<{ changed: boolean }> {
    ensureToken(ensureHome(this.home));
    const changed = this.writePlist();
    const state = await this.loaded();
    if (state.loaded && changed) await this.launchctl("bootout", `${this.domain}/${LAUNCHD_LABEL}`);
    if (!state.loaded || changed) await this.bootstrap();
    return { changed };
  }

  private async bootstrap() {
    const r = await this.launchctl("bootstrap", this.domain, this.plistPath);
    // 5 / 37: already bootstrapped (races with KeepAlive); anything else is an error
    if (r.code !== 0 && !(await this.loaded()).loaded) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || r.code}`);
  }

  async uninstall() {
    await this.launchctl("bootout", `${this.domain}/${LAUNCHD_LABEL}`);
    if (existsSync(this.plistPath)) unlinkSync(this.plistPath);
  }

  async start() {
    if (!existsSync(this.plistPath)) return this.install();
    if (!(await this.loaded()).loaded) await this.bootstrap();
    else await this.launchctl("kickstart", `${this.domain}/${LAUNCHD_LABEL}`);
    return { changed: false };
  }

  async stop() {
    await this.launchctl("bootout", `${this.domain}/${LAUNCHD_LABEL}`);
  }

  async restart() {
    if (!(await this.loaded()).loaded) return this.start();
    await this.launchctl("kickstart", "-k", `${this.domain}/${LAUNCHD_LABEL}`);
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

  /** Install if missing or changed, start, and wait for /health. */
  async ensure(): Promise<{ url: string; tokenPath: string; home: string; pid: number }> {
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
    return client.createTicket({ projectId: project.id, prompt, driver: opts.driver, start: !opts.plan });
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
            const r = await this.ensure();
            print(`harness running at ${r.url} (pid ${r.pid})`, r);
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
        print(`${t.key} ${t.title} [${t.status}]`, t);
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
        print(tickets.map((t) => `${t.key.padEnd(14)} ${t.status.padEnd(12)} ${t.busy ? "●" : " "} ${t.title}`).join("\n") || "(no tickets)", tickets);
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
        "  harness service install|uninstall|start|stop|restart|status|ensure [--json]",
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
