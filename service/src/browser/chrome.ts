// Locate and launch a Chrome/Chromium process with remote debugging on an ephemeral port.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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
    });
  }

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
          return chrome;
        }
      }
      await Bun.sleep(25);
    }
    await chrome.kill();
    throw new Error(`Timed out waiting for Chrome DevTools port.\n${chrome.stderr()}`);
  }

  /** Last lines of Chrome's stderr, for error messages. */
  stderr(): string {
    return this.stderrTail.join("\n");
  }

  /** SIGTERM, then SIGKILL if it hasn't exited within `graceMs`. */
  async kill(graceMs = 3000): Promise<void> {
    if (this._exited) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
    if (!exited) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      await this.proc.exited;
    }
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
