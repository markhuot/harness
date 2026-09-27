// Listen addresses (DESIGN.md "Network"). The service always answers on loopback so the desktop
// app keeps working; the listen setting adds a Tailscale / custom address or widens to 0.0.0.0.
// Several Bun.serve listeners share one fetch/websocket handler. Rebinding starts the new
// listeners before stopping the old ones, and a failed rebind leaves the old ones in place.

import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { BoundAddress, ListenMode, ListenSetting, NetworkStatus, PairingInfo } from "@harness/shared";
import { buildPairUrl } from "@harness/shared";
import { HarnessError, badRequest, conflict } from "../orchestrator/errors";

export const LOOPBACK = "127.0.0.1";
export const WILDCARD = "0.0.0.0";

export interface TailscaleInfo {
  ip: string;
  dnsName: string | null;
}

/** A listener the manager can stop. Bun's Server fits. */
export interface Listener {
  port?: number;
  stop(closeActiveConnections?: boolean): unknown;
}

export interface NetworkDeps {
  /** Start one listener; throws when the address can't be bound. port 0 → any free port. */
  serve: (hostname: string, port: number) => Listener;
  /** The machine's Tailscale IPv4 + MagicDNS name, or null when Tailscale isn't running. */
  tailscale?: () => Promise<TailscaleInfo | null>;
  /** Resolve a hostname to IP addresses (default: DNS / hosts lookup). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Addresses of this machine's interfaces (default: os.networkInterfaces()). */
  localAddresses?: () => string[];
}

export class NetworkError extends HarnessError {
  constructor(message: string) {
    super(409, message);
  }
}

export const isLoopback = (addr: string) => /^127\./.test(addr) || addr === "::1" || /^::ffff:127\./i.test(addr);
const isWildcard = (addr: string) => addr === WILDCARD || addr === "::";

export function formatUrl(address: string, port: number): string {
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

/** HARNESS_HOST: a mode keyword (localhost / tailscale / any) or a host for custom mode. */
export function parseHostOverride(raw: string | undefined | null): ListenSetting | null {
  const v = raw?.trim();
  if (!v) return null;
  if (v === "localhost" || v === LOOPBACK) return { mode: "localhost" };
  if (v === "tailscale") return { mode: "tailscale" };
  if (v === "any" || v === WILDCARD) return { mode: "any" };
  return { mode: "custom", host: v.replace(/^\[(.*)\]$/, "$1") };
}

export function defaultLocalAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((i) => i.address);
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true });
  return found.map((f) => f.address);
}

const TAILSCALE_BINS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

async function run(cmd: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

/** Parse `tailscale status --json`: null unless the backend is Running with an IPv4. */
export function parseTailscaleStatus(json: string): TailscaleInfo | null {
  try {
    const s = JSON.parse(json);
    if (s?.BackendState !== "Running") return null;
    const ips: unknown[] = s.Self?.TailscaleIPs ?? s.TailscaleIPs ?? [];
    const ip = ips.find((x): x is string => typeof x === "string" && isIP(x) === 4);
    if (!ip) return null;
    const dns = typeof s.Self?.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
    return { ip, dnsName: dns || null };
  } catch {
    return null;
  }
}

/** Ask the tailscale CLI (PATH, then the usual install locations). */
export async function lookupTailscale(): Promise<TailscaleInfo | null> {
  const bins = [Bun.which("tailscale"), ...TAILSCALE_BINS].filter((b, i, all): b is string => !!b && all.indexOf(b) === i && existsSync(b));
  for (const bin of bins) {
    const status = await run([bin, "status", "--json"], 3000);
    if (status !== null) {
      const info = parseTailscaleStatus(status);
      if (info) return info;
    }
    const ip = (await run([bin, "ip", "-4"], 3000))?.trim().split("\n")[0]?.trim();
    if (ip && isIP(ip) === 4) return { ip, dnsName: null };
  }
  return null;
}

/**
 * The addresses a listen setting binds. Loopback is always covered (127.0.0.1, or 0.0.0.0 which
 * includes it). Throws NetworkError (409) when the mode can't be bound on this machine right now.
 */
export async function resolveBindAddresses(
  listen: ListenSetting,
  deps: Pick<NetworkDeps, "tailscale" | "resolveHost" | "localAddresses"> = {},
): Promise<string[]> {
  const local = (deps.localAddresses ?? defaultLocalAddresses)();
  switch (listen.mode) {
    case "localhost":
      return [LOOPBACK];
    case "any":
      return [WILDCARD];
    case "tailscale": {
      const ts = await (deps.tailscale ?? lookupTailscale)();
      if (!ts) throw new NetworkError("Tailscale isn't running on this machine (no Tailscale IPv4 address). Start Tailscale and try again.");
      if (!local.includes(ts.ip)) throw new NetworkError(`Tailscale reports ${ts.ip}, but no interface on this machine has that address yet.`);
      return [ts.ip, LOOPBACK];
    }
    case "custom": {
      const host = listen.host?.trim();
      if (!host) throw badRequest("listen.host is required for custom mode");
      let candidates: string[];
      if (isIP(host)) candidates = [host];
      else {
        try {
          candidates = await (deps.resolveHost ?? defaultResolveHost)(host);
        } catch (err) {
          throw new NetworkError(`Couldn't resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const addr = candidates.find((a) => isWildcard(a) || isLoopback(a) || local.includes(a));
      if (!addr) {
        const seen = candidates.length && candidates[0] !== host ? ` (resolves to ${candidates.join(", ")})` : "";
        throw new NetworkError(`${host}${seen} isn't an address of this machine, so the service can't listen on it.`);
      }
      return isLoopback(addr) ? [LOOPBACK] : [addr, LOOPBACK];
    }
  }
}

export interface NetworkManagerOptions extends NetworkDeps {
  port: number;
  /** The configured listen setting (settings.listen). */
  listen: () => ListenSetting;
  /** HARNESS_HOST: overrides the setting; changing the setting is refused while it's set. */
  override?: ListenSetting | null;
  overrideRaw?: string | null;
  /** How often to retry the configured mode after a boot fallback. Default 30s. */
  retryMs?: number;
  /** After a rebind, removed listeners stop accepting at once and drop open connections after this. Default 1s. */
  drainMs?: number;
  log?: (msg: string) => void;
}

export class NetworkManager {
  private listeners = new Map<string, Listener>();
  /** Removed listeners waiting out the drain window; the fetch handler turns their requests away. */
  private retired = new WeakMap<object, string>();
  private port: number;
  private active: ListenMode = "localhost";
  private activeHost: string | null = null;
  private error: string | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private lastTailscale: { at: number; info: TailscaleInfo | null } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private opts: NetworkManagerOptions) {
    this.port = opts.port;
  }

  private log(msg: string) {
    (this.opts.log ?? ((m) => console.log(m)))(`[network] ${msg}`);
  }

  /** The listen setting in force: HARNESS_HOST, else the stored setting. */
  configured(): ListenSetting {
    return this.opts.override ?? this.opts.listen();
  }

  get boundPort(): number {
    return this.port;
  }

  /** Loopback base URL (the desktop app, agents' MCP URLs, `harness` CLI). */
  get loopbackUrl(): string {
    return formatUrl(LOOPBACK, this.port);
  }

  /**
   * A listener removed by a rebind that hasn't closed yet, whose address the current listeners no
   * longer serve. (127.0.0.1 retired in favour of 0.0.0.0 is still served: the kernel keeps routing
   * loopback to the more specific socket until it closes.)
   */
  isRetired(listener: object): boolean {
    const address = this.retired.get(listener);
    if (address === undefined) return false;
    return !this.listeners.has(address) && !this.listeners.has(WILDCARD) && !this.listeners.has("::");
  }

  bound(): BoundAddress[] {
    return [...this.listeners.keys()].map((address) => ({ address, url: formatUrl(address, this.port) }));
  }

  private tailscale = async (): Promise<TailscaleInfo | null> => {
    const info = await (this.opts.tailscale ?? lookupTailscale)();
    this.lastTailscale = { at: Date.now(), info };
    return info;
  };

  private async cachedTailscale(): Promise<TailscaleInfo | null> {
    if (this.lastTailscale && Date.now() - this.lastTailscale.at < 10_000) return this.lastTailscale.info;
    return this.tailscale();
  }

  /** Serialize binds so two PATCHes can't interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Bind exactly `addresses`: start what's new first; on any failure stop those and keep the old set. */
  private async bindSet(addresses: string[]) {
    const started: [string, Listener][] = [];
    for (const address of addresses) {
      if (this.listeners.has(address)) continue;
      try {
        const listener = this.opts.serve(address, this.port);
        if (this.port === 0 && listener.port) this.port = listener.port;
        started.push([address, listener]);
      } catch (err) {
        for (const [, l] of started) l.stop(true);
        if (started.length && this.listeners.size === 0) this.port = this.opts.port;
        throw new NetworkError(`Couldn't listen on ${formatUrl(address, this.port)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const removed = [...this.listeners].filter(([address]) => !addresses.includes(address));
    for (const [address, l] of started) this.listeners.set(address, l);
    for (const [address, l] of removed) {
      this.listeners.delete(address);
      // In-flight requests (e.g. the PATCH that asked for this) finish; new ones are refused
      // (isRetired) until the listener and its keep-alive connections close after the drain window.
      // (Bun ignores stop(true) after a stop(false), so there is only the one forced stop.)
      this.retired.set(l, address);
      setTimeout(() => l.stop(true), this.opts.drainMs ?? 1000).unref?.();
    }
  }

  private async bindListen(listen: ListenSetting) {
    const addresses = await resolveBindAddresses(listen, {
      tailscale: this.tailscale,
      resolveHost: this.opts.resolveHost,
      localAddresses: this.opts.localAddresses,
    });
    await this.bindSet(addresses);
    this.active = listen.mode;
    this.activeHost = listen.mode === "custom" ? (listen.host ?? null) : null;
  }

  /**
   * Boot: bind the configured mode; when that fails (Tailscale not up yet, custom host gone), serve
   * loopback only and retry the configured mode every retryMs. Throws only if loopback can't bind.
   */
  async boot(): Promise<void> {
    return this.exclusive(async () => {
      const want = this.configured();
      try {
        await this.bindListen(want);
        this.error = null;
        this.log(`listening on ${this.bound().map((b) => b.url).join(", ")} (${want.mode})`);
      } catch (err) {
        if (!(err instanceof HarnessError)) throw err;
        await this.bindListen({ mode: "localhost" });
        this.error = err.message;
        this.log(`can't bind ${want.mode} (${err.message}); serving ${this.loopbackUrl} only, retrying every ${Math.round((this.opts.retryMs ?? 30_000) / 1000)}s`);
        this.startRetry();
      }
    });
  }

  private startRetry() {
    this.stopRetry();
    this.retryTimer = setInterval(() => void this.retry(), this.opts.retryMs ?? 30_000);
    this.retryTimer.unref?.();
  }

  private stopRetry() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /** One retry of the configured mode (the timer calls this; exposed for tests). */
  async retry(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.stopped) return false;
      const want = this.configured();
      try {
        await this.bindListen(want);
        this.error = null;
        this.stopRetry();
        this.log(`now listening on ${this.bound().map((b) => b.url).join(", ")} (${want.mode})`);
        return true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        return false;
      }
    });
  }

  /**
   * Rebind for a new listen setting (PATCH /settings { listen }). On failure the previous listeners
   * stay up and the error is thrown (409) and kept as `error`.
   */
  async apply(listen: ListenSetting): Promise<void> {
    if (this.opts.override) throw conflict(`HARNESS_HOST=${this.opts.overrideRaw ?? ""} overrides the listen setting; unset it to change this here.`);
    return this.exclusive(async () => {
      try {
        await this.bindListen(listen);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        throw err;
      }
      this.error = null;
      this.stopRetry();
      this.log(`listening on ${this.bound().map((b) => b.url).join(", ")} (${listen.mode})`);
    });
  }

  async status(): Promise<NetworkStatus> {
    const want = this.configured();
    return {
      mode: want.mode,
      host: want.mode === "custom" ? (want.host ?? null) : null,
      port: this.port,
      bound: this.bound(),
      active: this.active,
      tailscale: await this.cachedTailscale(),
      error: this.error,
      override: this.opts.override ? (this.opts.overrideRaw ?? null) : null,
    };
  }

  /** Best address a phone can reach: Tailscale > custom host > first LAN IPv4 (any). */
  async pairingUrl(): Promise<string> {
    const bound = [...this.listeners.keys()];
    const why = this.error ? ` (${this.error})` : "";
    if (this.active === "localhost") throw conflict(`The service only listens on localhost${why}. Pick Tailscale, Any or Custom under Settings → Network to pair a phone.`);
    const ts = await this.cachedTailscale();
    const wildcard = bound.some(isWildcard);
    if (ts && (bound.includes(ts.ip) || wildcard)) return formatUrl(ts.ip, this.port);
    if (this.active === "custom" && this.activeHost && !isLoopback(this.activeHost) && !isWildcard(this.activeHost)) {
      return formatUrl(this.activeHost, this.port);
    }
    const reachable = bound.find((a) => !isLoopback(a) && !isWildcard(a));
    if (reachable) return formatUrl(reachable, this.port);
    if (wildcard) {
      const lan = lanAddress((this.opts.localAddresses ?? defaultLocalAddresses)());
      if (lan) return formatUrl(lan, this.port);
    }
    throw conflict("No address off this machine reaches the service right now.");
  }

  async pairing(token: string): Promise<PairingInfo> {
    const url = await this.pairingUrl();
    return { url, token, pairUrl: buildPairUrl(url, token) };
  }

  stop() {
    this.stopped = true;
    this.stopRetry();
    for (const l of this.listeners.values()) l.stop(true);
    this.listeners.clear();
    // Retired listeners still in their drain window close on their timers.
  }
}

/** First non-loopback, non-link-local IPv4 (the LAN address for mode "any"). */
export function lanAddress(addresses: string[]): string | null {
  return addresses.find((a) => isIP(a) === 4 && !isLoopback(a) && !a.startsWith("169.254.")) ?? null;
}
