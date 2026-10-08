// Locate and launch a Chrome/Chromium process with remote debugging on an ephemeral port.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CdpClient } from "./cdp.ts";

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
];

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

/**
 * Resolve the Chrome executable: explicit path, then `HARNESS_CHROME_PATH`, then well-known
 * install locations (Chrome, Chromium, Canary, Beta, Dev). Returns null when nothing exists.
 * An explicit path / env var that doesn't exist is treated as "not found" rather than
 * silently falling back, so misconfiguration is visible.
 */
export function findChrome(explicit?: string): string | null {
  const configured = explicit || process.env.HARNESS_CHROME_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  const candidates = [...MAC_CANDIDATES, ...LINUX_CANDIDATES];
  if (process.env.HOME) {
    candidates.push(...MAC_CANDIDATES.map((p) => join(process.env.HOME!, p)));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

let cloneRootCache: string | null | undefined;

/**
 * Where macOS Chrome puts the ~2 GB copy of its app bundle it makes at every launch
 * (`<DARWIN_USER_TEMP_DIR>/../X/com.google.Chrome.code_sign_clone/code_sign_clone.XXXXXX`).
 * Its helper processes run from the clone for Chrome's whole life, and Chrome deletes it only
 * after a clean exit (Browser.close, quitting the app): SIGTERM, SIGKILL and crashes all leak
 * one. Null when it can't be located (non-macOS, or not created yet).
 */
export function codeSignCloneRoot(): string | null {
  if (cloneRootCache !== undefined) return cloneRootCache;
  if (process.platform !== "darwin") return (cloneRootCache = null);
  let userTemp = "";
  try {
    userTemp = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"]).stdout.toString().trim();
  } catch {}
  if (!userTemp) userTemp = process.env.TMPDIR ?? "";
  if (!userTemp) return (cloneRootCache = null);
  const root = join(dirname(userTemp.replace(/\/+$/, "")), "X", "com.google.Chrome.code_sign_clone");
  // Only cache a hit: the directory appears the first time Chrome ever launches.
  if (!existsSync(root)) return null;
  return (cloneRootCache = root);
}

/** Current clone directory names (not paths). */
export function listCodeSignClones(root = codeSignCloneRoot()): string[] {
  if (!root) return [];
  try {
    return readdirSync(root).filter((n) => n.startsWith("code_sign_clone."));
  } catch {
    return [];
  }
}

/** Parse `ps -o etime=,comm=` output into the start times (ms) of Chrome-ish processes. */
export function parseChromeStartTimes(psOutput: string, now: number): number[] {
  const starts: number[] = [];
  for (const line of psOutput.split("\n")) {
    // etime is [[dd-]hh:]mm:ss.
    const m = line.match(/^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$/);
    if (!m || !/Chrome|Chromium/.test(m[5]!)) continue;
    const secs = Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    starts.push(now - secs * 1000);
  }
  return starts;
}

/** When each running Chrome-ish process started (ms), or null when ps can't say. */
export function chromeStartTimes(): number[] | null {
  try {
    const ps = Bun.spawnSync(["/bin/ps", "-axo", "etime=,comm="]);
    if (ps.exitCode !== 0) return null;
    return parseChromeStartTimes(ps.stdout.toString(), Date.now());
  } catch {
    return null;
  }
}

/** How long after its process starts Chrome may take to make its clone. */
const CLONE_AFTER_START_MS = 2 * 60_000;

/**
 * Delete clones no running Chrome can own: leftovers of Chromes that ended without a clean exit
 * while nothing could remove their clone (the owning daemon or test run died first, or several
 * Chromes launched at once so the clone couldn't be attributed). Every Chrome makes its clone
 * just after it starts, so a clone is kept while any Chrome-ish process started shortly before
 * it. (Which clone a process uses can't be read off it: the clone's executable is a hard link to
 * the installed one, so lsof names whichever clone path the kernel cached.) Also keeps clones
 * younger than `minAgeMs`, and does nothing when the running processes can't be listed.
 * Returns the names it removed.
 */
export async function sweepCodeSignClones(
  opts: { root?: string | null; minAgeMs?: number; chromeStarts?: number[] | null } = {},
): Promise<string[]> {
  const root = opts.root === undefined ? codeSignCloneRoot() : opts.root;
  if (!root) return [];
  const starts = opts.chromeStarts !== undefined ? opts.chromeStarts : chromeStartTimes();
  if (!starts) return [];
  const minAgeMs = opts.minAgeMs ?? CLONE_AFTER_START_MS;
  const removed: string[] = [];
  for (const name of listCodeSignClones(root)) {
    const dir = join(root, name);
    try {
      // The clone's top level never changes after Chrome copies it, so mtime is when it was made
      // (ps start times are whole seconds, hence the slack before a start).
      const made = statSync(dir).mtimeMs;
      if (Date.now() - made < minAgeMs) continue;
      if (starts.some((s) => made >= s - 5_000 && made <= s + CLONE_AFTER_START_MS)) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
}

export interface CloseOptions {
  /** An already-open browser-level CDP client to send Browser.close on. */
  cdp?: CdpClient;
  /** How long to wait for Chrome to exit after Browser.close (ms). */
  graceMs?: number;
  /** How long to wait after SIGTERM before SIGKILL (ms). */
  termMs?: number;
}

export interface LaunchOptions {
  chromePath: string;
  profileDir: string;
  headless?: boolean;
  width?: number;
  height?: number;
  /** How long to wait for DevToolsActivePort (ms). */
  startTimeoutMs?: number;
  extraArgs?: string[];
}

export function chromeArgs(opts: LaunchOptions): string[] {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${width},${height}`,
    // Keep background tabs rendering/timers alive: every session's tab is "background".
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // Avoid macOS keychain prompts when running under launchd.
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--hide-crash-restore-bubble",
    "--mute-audio",
    ...(opts.extraArgs ?? []),
  ];
  if (opts.headless !== false) args.unshift("--headless=new");
  args.push("about:blank");
  return args;
}

export class ChromeProcess {
  private _exited = false;
  private stderrTail: string[] = [];

  private constructor(
    readonly proc: ReturnType<typeof Bun.spawn>,
    readonly profileDir: string,
  ) {
    void proc.exited.then(() => {
      this._exited = true;
      // Crashes and external kills leak the clone too; clean up after ourselves.
      void this.removeLeakedClone();
    });
  }

  /** This process's code-sign clone directory (macOS), when it could be attributed. */
  cloneDir?: string;

  /** The browser-level DevTools WebSocket URL (set once launched). */
  wsUrl = "";
  port = 0;

  get pid(): number {
    return this.proc.pid;
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitedPromise(): Promise<number> {
    return this.proc.exited;
  }

  static async launch(opts: LaunchOptions): Promise<ChromeProcess> {
    mkdirSync(opts.profileDir, { recursive: true });
    const portFile = join(opts.profileDir, "DevToolsActivePort");
    // A stale file from a previous run would point at a dead port.
    try {
      unlinkSync(portFile);
    } catch {}

    // Clear out clones leaked by earlier Chromes nobody was left to clean up after.
    void sweepCodeSignClones().catch(() => {});
    const clonesBefore = new Set(listCodeSignClones());
    const proc = Bun.spawn([opts.chromePath, ...chromeArgs(opts)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const chrome = new ChromeProcess(proc, opts.profileDir);
    chrome.drainStderr(proc.stderr as ReadableStream<Uint8Array>);

    const deadline = Date.now() + (opts.startTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      if (chrome.exited) {
        throw new Error(`Chrome exited during startup (code ${proc.exitCode}).\n${chrome.stderr()}`);
      }
      if (existsSync(portFile)) {
        const lines = readFileSync(portFile, "utf8").split("\n").map((l) => l.trim());
        const port = Number(lines[0]);
        const path = lines[1];
        if (port > 0 && path) {
          chrome.port = port;
          chrome.wsUrl = `ws://127.0.0.1:${port}${path}`;
          // The clone exists before DevTools is up. Only claim it when exactly one new clone
          // appeared, so a concurrent launch elsewhere is never mistaken for ours; a clone left
          // unclaimed that leaks is removed by a later launch's sweep.
          const fresh = listCodeSignClones().filter((n) => !clonesBefore.has(n));
          if (fresh.length === 1) chrome.cloneDir = join(codeSignCloneRoot()!, fresh[0]!);
          return chrome;
        }
      }
      await Bun.sleep(25);
    }
    await chrome.close();
    throw new Error(`Timed out waiting for Chrome DevTools port.\n${chrome.stderr()}`);
  }

  /** Last lines of Chrome's stderr, for error messages. */
  stderr(): string {
    return this.stderrTail.join("\n");
  }

  /**
   * Shut Chrome down, as cleanly as it allows: CDP Browser.close and wait for it to exit
   * (the only path on which Chrome deletes its code-sign clone), then SIGTERM, then SIGKILL.
   * After an unclean exit, removes this process's own clone directory.
   */
  async close(opts: CloseOptions = {}): Promise<void> {
    const graceMs = opts.graceMs ?? 10_000;
    const termMs = opts.termMs ?? 5000;
    if (!this._exited && this.wsUrl) {
      let cdp = opts.cdp && !opts.cdp.closed ? opts.cdp : undefined;
      let own = false;
      try {
        if (!cdp) {
          cdp = await CdpClient.connect(this.wsUrl, { connectTimeoutMs: 2000 });
          own = true;
        }
        // Chrome may drop the socket before answering; that's fine, we wait for exit.
        await cdp.send("Browser.close", {}, undefined, 3000).catch(() => {});
      } catch {
        // Couldn't reach DevTools: fall through to signals.
      } finally {
        if (own) cdp?.close();
      }
      await this.waitForExit(graceMs);
    }
    if (!this._exited) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      await this.waitForExit(termMs);
    }
    if (!this._exited) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      await this.proc.exited;
      this._exited = true;
    }
    await this.removeLeakedClone();
  }

  /** @deprecated use close(); kept as an alias so nothing kills Chrome un-gracefully. */
  kill(): Promise<void> {
    return this.close();
  }

  private async waitForExit(ms: number): Promise<boolean> {
    if (this._exited) return true;
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
    if (exited) this._exited = true;
    return exited;
  }

  /**
   * If Chrome died without deleting its clone (signal, crash), delete it — only the one this
   * process was attributed at launch, never anything else in the clone root.
   */
  async removeLeakedClone(): Promise<void> {
    const dir = this.cloneDir;
    if (!dir || !this._exited) return;
    // Give a clean exit a moment to finish its own cleanup, and helpers time to die.
    for (let attempt = 0; attempt < 10 && existsSync(dir); attempt++) {
      await Bun.sleep(attempt === 0 ? 300 : 500);
      if (!existsSync(dir)) break;
      if (attempt >= 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    if (!existsSync(dir)) this.cloneDir = undefined;
  }

  private drainStderr(stream: ReadableStream<Uint8Array>): void {
    const decoder = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for await (const chunk of stream) {
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            this.stderrTail.push(line);
            if (this.stderrTail.length > 40) this.stderrTail.shift();
          }
        }
      } catch {}
    })();
  }
}
