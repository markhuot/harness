// Watchers: long-lived or periodic commands whose text output becomes Inbox items. Any
// command works; nothing about the output's shape is required. This module turns stdout into
// output chunks, finds the external keys they mention, and supervises the processes.
//
// Chunking: interval mode delivers one chunk per run (everything it printed); loop mode
// delivers one chunk per burst of output (lines that arrive close together, see batchIdleMs /
// batchMaxMs). Chunks are trimmed, whitespace-only output is dropped, and a chunk is cut at
// maxOutputChars and marked truncated.
//
// Exit codes follow watch-jira: 0 = ok, 4 = nothing to report (--once / --timeout), anything
// else = failure.

import type { Watcher, WatcherLive } from "@harness/shared";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One Inbox-bound piece of watcher output. */
export interface WatcherOutput {
  /** Trimmed, never empty */
  text: string;
  /** True when the output was cut at the character limit */
  truncated: boolean;
}

/** Default cap on one chunk of watcher output, in characters */
export const MAX_OUTPUT_CHARS = 16_000;

/** Trim and cap raw output. Null when there is nothing but whitespace. */
export function toOutput(raw: string, limit = MAX_OUTPUT_CHARS, truncated = false): WatcherOutput | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.length > limit) {
    text = text.slice(0, limit).trimEnd();
    truncated = true;
  }
  return { text, truncated };
}

/** Upper-case external keys (FOO-123) mentioned in text, in order of first appearance. */
export function findKeys(text: string, max = 20): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*-\d+\b/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  /** Optional: when present, its tail is used for error messages. */
  stderr?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

/**
 * Spawns a watcher process. `env` holds only the watcher's own variables; the
 * default implementation merges them over process.env.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
) => SpawnedProcess;

/** The user's login shell for command-line watchers: $SHELL when it is absolute, else zsh/sh. */
export function loginShell(env: Record<string, string | undefined> = process.env): string {
  const shell = env.SHELL;
  if (shell && shell.startsWith("/")) return shell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/**
 * What to spawn for a watcher. No args: `command` is a shell command line, run as
 * `<shell> -lc <command>` so PATH, pipes and loops behave as in the user's terminal. With args:
 * a legacy watcher, spawned directly as `command args…` without a shell, exactly as before.
 */
export function watcherArgv(w: Pick<Watcher, "command" | "args">, shell: string): [string, string[]] {
  if (w.args?.length) return [w.command, w.args];
  return [shell, ["-lc", w.command]];
}

export const bunSpawn: SpawnFn = (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

export interface WatcherTiming {
  /** Loop mode: end an output burst when nothing new arrived for this long (default 200ms) */
  batchIdleMs: number;
  /** Loop mode: end an output burst at the latest this long after it started (default 1000ms) */
  batchMaxMs: number;
  /** Loop mode: delay before re-running after exit 0/4 (default 1000ms) */
  restartDelayMs: number;
  /** Loop mode: first backoff after a failure, doubled per consecutive failure (default 2000ms) */
  backoffBaseMs: number;
  /** Loop mode: backoff cap (default 5 minutes) */
  backoffMaxMs: number;
  /** Interval mode: floor for intervalSec (default 10s) */
  minIntervalMs: number;
}

const DEFAULT_TIMING: WatcherTiming = {
  batchIdleMs: 200,
  batchMaxMs: 1000,
  restartDelayMs: 1000,
  backoffBaseMs: 2000,
  backoffMaxMs: 5 * 60 * 1000,
  minIntervalMs: 10_000,
};

const STDERR_TAIL = 2048;

type Timer = ReturnType<typeof setTimeout>;

interface Entry {
  watcher: Watcher;
  signature: string;
  stopped: boolean;
  /** Settles when the current run (spawn → exit → delivery) is fully finished */
  running: Promise<void> | null;
  proc: SpawnedProcess | null;
  /** Set when a kill is intentional (restart via runNow), so the exit isn't a failure */
  restarting: boolean;
  timer: Timer | null;
  interval: ReturnType<typeof setInterval> | null;
  /** Consecutive failed runs */
  failures: number;
  /** Interval mode: when the schedule started and its period, for the next tick's time */
  schedule: { startedAt: number; everyMs: number } | null;
  /** Resolves once the previous entry for this id has fully stopped */
  ready: Promise<void>;
}

function signatureOf(w: Watcher): string {
  const env = Object.keys(w.env ?? {})
    .sort()
    .map((k) => [k, w.env[k]]);
  // The prompt is read at delivery time, so editing it doesn't restart the process.
  return JSON.stringify([w.command, w.args, w.cwd, env, w.mode, w.mode === "interval" ? w.intervalSec : null]);
}

function expandHome(p: string | null): string | undefined {
  if (!p) return undefined;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface WatcherRunnerOptions {
  /** Called once per chunk of output, in order, with the latest watcher object */
  onOutput: (watcher: Watcher, output: WatcherOutput) => void | Promise<void>;
  onStatus: (watcherId: string, patch: { lastRunAt?: number; lastError?: string | null }) => void;
  /** Called whenever a watcher's process state changes (see WatcherLive) */
  onLive?: (watcherId: string, live: WatcherLive) => void;
  spawn?: SpawnFn;
  timing?: Partial<WatcherTiming>;
  /** Shell for command-line watchers (default loginShell()) */
  shell?: string;
  /** Cap on one chunk of output (default MAX_OUTPUT_CHARS) */
  maxOutputChars?: number;
}

export class WatcherRunner {
  private readonly onOutput: WatcherRunnerOptions["onOutput"];
  private readonly onStatus: WatcherRunnerOptions["onStatus"];
  private readonly onLive: NonNullable<WatcherRunnerOptions["onLive"]>;
  private readonly spawn: SpawnFn;
  private readonly timing: WatcherTiming;
  private readonly shell: string;
  private readonly maxOutputChars: number;
  /** Supervised (enabled) watchers */
  private readonly entries = new Map<string, Entry>();
  /** Every watcher seen by the last sync, so runNow works for disabled ones too */
  private known = new Map<string, Watcher>();
  /** One-off runs (runNow on a watcher that isn't supervised) */
  private readonly oneOffs = new Map<string, Entry>();
  private readonly stopping = new Set<Promise<void>>();
  /** Latest process state per known watcher id */
  private readonly lives = new Map<string, WatcherLive>();

  constructor(opts: WatcherRunnerOptions) {
    this.onOutput = opts.onOutput;
    this.onStatus = opts.onStatus;
    this.onLive = opts.onLive ?? (() => {});
    this.spawn = opts.spawn ?? bunSpawn;
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
    this.shell = opts.shell ?? loginShell();
    this.maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  }

  /** What a watcher's process is doing now; undefined for ids the last sync didn't include. */
  live(id: string): WatcherLive | undefined {
    return this.lives.get(id);
  }

  /** Reconcile running processes with the given watcher list. */
  sync(watchers: Watcher[]): void {
    this.known = new Map(watchers.map((w) => [w.id, w]));
    const wanted = new Map(watchers.filter((w) => w.enabled).map((w) => [w.id, w]));
    for (const id of this.lives.keys()) if (!this.known.has(id)) this.lives.delete(id);

    for (const [id, entry] of this.entries) {
      const next = wanted.get(id);
      if (!next) {
        this.entries.delete(id);
        this.track(this.stopEntry(entry));
        // A one-off run of the now-disabled watcher reports its own state.
        if (this.known.has(id) && !this.oneOffs.get(id)?.running) this.report(id, "stopped", null, 0);
      } else if (signatureOf(next) !== entry.signature) {
        this.entries.delete(id);
        const stopped = this.track(this.stopEntry(entry));
        this.startEntry(next, stopped);
      } else {
        // Name/driver changes don't need a restart; later deliveries see the new object.
        entry.watcher = next;
      }
    }
    for (const [id, w] of wanted) {
      if (!this.entries.has(id)) this.startEntry(w, this.oneOffs.get(id)?.running ?? Promise.resolve());
    }
    for (const w of watchers) if (!this.lives.has(w.id)) this.report(w.id, "stopped", null, 0);
  }

  /**
   * Trigger an immediate run. Interval mode: runs now unless a run is in flight.
   * Loop mode: kills a blocking child (or cancels a pending backoff) and re-runs at once.
   * Unsupervised (disabled) watchers get a one-off run. Resolves once the run is triggered.
   */
  async runNow(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      await entry.ready;
      if (entry.stopped) return;
      if (entry.watcher.mode === "loop") {
        if (entry.proc) {
          entry.restarting = true;
          entry.failures = 0;
          entry.proc.kill();
        } else if (!entry.running) {
          this.clearTimer(entry);
          entry.failures = 0;
          this.loopRun(entry);
        }
        return;
      }
      if (!entry.running) this.execute(entry);
      return;
    }

    const w = this.known.get(id);
    if (!w) throw new Error(`Unknown watcher: ${id}`);
    const existing = this.oneOffs.get(id);
    if (existing?.running) return;
    const oneOff = this.makeEntry(w, Promise.resolve());
    this.oneOffs.set(id, oneOff);
    this.execute(oneOff).finally(() => {
      if (this.oneOffs.get(id) === oneOff) this.oneOffs.delete(id);
    });
  }

  async stopAll(): Promise<void> {
    const all = [...this.entries.values(), ...this.oneOffs.values()];
    this.entries.clear();
    this.oneOffs.clear();
    for (const [id, live] of this.lives) if (live.state !== "stopped") this.report(id, "stopped", null, live.failures);
    await Promise.all([...all.map((e) => this.stopEntry(e)), ...this.stopping]);
  }

  // --- internals -----------------------------------------------------------

  private report(id: string, state: WatcherLive["state"], nextRunAt: number | null, failures: number): void {
    const live: WatcherLive = { state, since: Date.now(), nextRunAt, failures };
    this.lives.set(id, live);
    this.onLive(id, live);
  }

  /** Report an entry's state, unless it has been replaced (a restart) or stopped. */
  private setLive(entry: Entry, state: WatcherLive["state"], nextRunAt: number | null = null): void {
    const id = entry.watcher.id;
    const supervised = this.entries.get(id);
    const current = supervised ? supervised === entry : this.oneOffs.get(id) === entry;
    if (current && !entry.stopped) this.report(id, state, nextRunAt, entry.failures);
  }

  /** Interval mode: the next scheduled tick after now. */
  private nextTick(entry: Entry): number | null {
    const s = entry.schedule;
    if (!s) return null;
    const now = Date.now();
    return s.startedAt + (Math.floor((now - s.startedAt) / s.everyMs) + 1) * s.everyMs;
  }

  private track(p: Promise<void>): Promise<void> {
    this.stopping.add(p);
    p.finally(() => this.stopping.delete(p));
    return p;
  }

  private makeEntry(w: Watcher, ready: Promise<void>): Entry {
    return {
      watcher: w,
      signature: signatureOf(w),
      stopped: false,
      running: null,
      proc: null,
      restarting: false,
      timer: null,
      interval: null,
      failures: 0,
      schedule: null,
      ready,
    };
  }

  private startEntry(w: Watcher, after: Promise<void>): void {
    const entry = this.makeEntry(w, after.catch(() => {}));
    this.entries.set(w.id, entry);
    // Starting, possibly after the previous process for this id has stopped.
    this.setLive(entry, "waiting");
    entry.ready.then(() => {
      if (entry.stopped) return;
      if (w.mode === "interval") {
        const every = Math.max((w.intervalSec || 0) * 1000, this.timing.minIntervalMs);
        entry.schedule = { startedAt: Date.now(), everyMs: every };
        this.execute(entry);
        entry.interval = setInterval(() => {
          if (!entry.stopped && !entry.running) this.execute(entry);
        }, every);
      } else {
        this.loopRun(entry);
      }
    });
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private async stopEntry(entry: Entry): Promise<void> {
    entry.stopped = true;
    this.clearTimer(entry);
    if (entry.interval) clearInterval(entry.interval);
    entry.interval = null;
    entry.proc?.kill();
    await entry.running;
  }

  private loopRun(entry: Entry): void {
    this.execute(entry).then((ok) => {
      if (entry.stopped) return;
      let delay: number;
      if (entry.restarting) {
        entry.restarting = false;
        delay = 0;
      } else if (ok) {
        entry.failures = 0;
        delay = this.timing.restartDelayMs;
      } else {
        entry.failures++;
        delay = Math.min(this.timing.backoffBaseMs * 2 ** (entry.failures - 1), this.timing.backoffMaxMs);
      }
      this.clearTimer(entry);
      this.setLive(entry, "waiting", Date.now() + delay);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!entry.stopped) this.loopRun(entry);
      }, delay);
    });
  }

  /** One spawn → read → exit cycle. Resolves true on exit 0/4 (or an intentional kill). */
  private execute(entry: Entry): Promise<boolean> {
    const run = this.executeInner(entry);
    const settled = run.then(() => {}, () => {});
    entry.running = settled;
    settled.then(() => {
      if (entry.running === settled) entry.running = null;
    });
    return run
      .catch(() => false)
      .then((ok) => {
        const id = entry.watcher.id;
        if (this.oneOffs.get(id) === entry) {
          // A one-off run (the watcher isn't supervised) leaves it stopped.
          if (!this.entries.has(id)) this.report(id, "stopped", null, ok ? 0 : entry.failures + 1);
        } else if (entry.watcher.mode === "interval") {
          // Loop mode reports its own restart delay (loopRun).
          entry.failures = ok ? 0 : entry.failures + 1;
          this.setLive(entry, "waiting", this.nextTick(entry));
        }
        return ok;
      });
  }

  private async executeInner(entry: Entry): Promise<boolean> {
    const w = entry.watcher;
    const startedAt = Date.now();

    let proc: SpawnedProcess;
    const [cmd, args] = watcherArgv(w, this.shell);
    try {
      proc = this.spawn(cmd, args, { cwd: expandHome(w.cwd), env: w.env ?? {} });
    } catch (err) {
      this.onStatus(w.id, { lastRunAt: startedAt, lastError: `Failed to start ${w.command}: ${errorMessage(err)}` });
      return false;
    }
    // A loop process that is up has recovered from whatever stopped the last one; an interval
    // run's error stands until the next run finishes.
    this.onStatus(w.id, w.mode === "loop" ? { lastRunAt: startedAt, lastError: null } : { lastRunAt: startedAt });
    entry.proc = proc;
    this.setLive(entry, "running");
    // A stop/restart may have raced the spawn.
    if (entry.stopped) proc.kill();

    let deliveryError: string | null = null;
    let delivery: Promise<void> = Promise.resolve();
    const deliver = (output: WatcherOutput) => {
      delivery = delivery.then(async () => {
        try {
          await this.onOutput(entry.watcher, output);
        } catch (err) {
          deliveryError = `Failed to handle output: ${errorMessage(err)}`;
          this.onStatus(w.id, { lastError: deliveryError });
        }
      });
    };

    // Interval runs are one chunk each; loop runs split into bursts.
    const chunker =
      w.mode === "interval"
        ? new Chunker(deliver, this.maxOutputChars, null)
        : new Chunker(deliver, this.maxOutputChars, { idleMs: this.timing.batchIdleMs, maxMs: this.timing.batchMaxMs });
    let stderrTail = "";
    const readStderr = proc.stderr
      ? readText(proc.stderr, (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
        })
      : Promise.resolve();
    const readStdout = readText(proc.stdout, (chunk) => chunker.push(chunk));

    let code: number;
    try {
      [code] = await Promise.all([proc.exited, readStdout, readStderr]);
    } finally {
      chunker.flush(true);
      entry.proc = null;
      await delivery;
    }

    if (entry.stopped || entry.restarting) return true;
    if (code === 0 || code === 4) {
      if (!deliveryError) this.onStatus(w.id, { lastError: null });
      return true;
    }
    const detail = stderrTail.trim();
    // A command line can be a whole loop, so shell watchers don't repeat it in the error.
    const label = w.args?.length ? w.command : "Command";
    this.onStatus(w.id, { lastError: `${label} exited with code ${code}${detail ? `: ${detail}` : ""}` });
    return false;
  }
}

/** Reads a byte stream as UTF-8 text, calling onChunk as data arrives. Never rejects. */
async function readText(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value, { stream: true }));
    }
    const rest = decoder.decode();
    if (rest) onChunk(rest);
  } catch {
    // A killed process can error its pipe; whatever was read is kept.
  } finally {
    reader.releaseLock();
  }
}

/**
 * Collects stdout text into chunks. Untimed (interval mode): one chunk, flushed at exit. Timed
 * (loop mode): a chunk ends when output goes quiet for idleMs, which delivers everything (a
 * response without a trailing newline is still finished), or when it is maxMs old while output
 * is still streaming, which stops at the last complete line and keeps the partial line for the
 * next chunk. Text past `limit` is dropped and the chunk marked truncated.
 */
class Chunker {
  private text = "";
  private truncated = false;
  private firstAt = 0;
  private timer: Timer | null = null;

  constructor(
    private readonly deliver: (output: WatcherOutput) => void,
    private readonly limit: number,
    private readonly timed: { idleMs: number; maxMs: number } | null,
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    if (this.text === "" && !this.truncated) this.firstAt = Date.now();
    const room = this.limit - this.text.length;
    if (chunk.length > room) {
      this.text += chunk.slice(0, Math.max(0, room));
      this.truncated = true;
    } else {
      this.text += chunk;
    }
    if (!this.timed) return;
    if (this.timer) clearTimeout(this.timer);
    const age = Date.now() - this.firstAt;
    const untilMax = this.timed.maxMs - age;
    // Whichever comes first: quiet for idleMs (the burst is over) or the max age (still streaming).
    const idle = this.timed.idleMs <= untilMax;
    this.timer = setTimeout(() => this.flush(idle), Math.max(0, idle ? this.timed.idleMs : untilMax));
  }

  /** Deliver what's collected. `all` false (a max-age flush) keeps a trailing partial line, unless truncated. */
  flush(all: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let take = this.text;
    let rest = "";
    if (!all && !this.truncated) {
      const nl = this.text.lastIndexOf("\n");
      if (nl >= 0) {
        take = this.text.slice(0, nl + 1);
        rest = this.text.slice(nl + 1);
      }
    }
    const output = toOutput(take, this.limit, this.truncated);
    this.text = rest;
    this.truncated = false;
    if (rest) {
      this.firstAt = Date.now();
      // Nothing more within idleMs means the partial line was the end of the output.
      if (this.timed) this.timer = setTimeout(() => this.flush(true), this.timed.idleMs);
    }
    if (output) this.deliver(output);
  }
}
