// Watchers: long-lived or periodic commands that print NDJSON work items on stdout
// (reference implementation: ~/Sites/Jira/watch-jira.js). This module parses their
// output, resolves item keys to project mappings, and supervises the processes.
//
// Exit codes follow watch-jira: 0 = work was emitted, 4 = nothing to report
// (--once / --timeout), anything else = failure.

import type { Mapping, Watcher, WorkItem } from "@harness/shared";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function pickString(obj: Record<string, unknown>, fields: string[], numbers: boolean): string | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (numbers && typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Normalize one NDJSON line into a WorkItem. Returns null for blank lines,
 * non-JSON, non-objects, and objects without a usable key.
 */
export function parseWorkItem(line: string): WorkItem | null {
  const text = line.trim();
  if (!text || text[0] !== "{") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const key = pickString(rec, ["key", "id", "identifier"], true);
  if (!key) return null;
  return {
    key,
    title: pickString(rec, ["summary", "title", "name"], false) ?? key,
    url: pickString(rec, ["url", "link", "html_url", "self"], false),
    // Numeric versions (epoch stamps, revision counters) are accepted too.
    version: pickString(rec, ["updated", "version", "updatedAt", "updated_at"], true),
    raw: obj,
  };
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

const REGEX_PATTERN = /^\/(.+)\/([a-z]*)$/;

/**
 * Resolve an external key to a mapping.
 *  - Prefix patterns ("FOO", or "FOO-") match case-insensitively on a `PREFIX-` boundary:
 *    FOO matches FOO-1 but not FOOBAR-1. The longest matching prefix wins.
 *  - Regex patterns ("/^OPS-\d+$/i") are tried after all prefixes, in list order.
 *    Invalid regexes are ignored.
 */
export function matchMapping(key: string, mappings: Mapping[]): Mapping | null {
  const upperKey = key.trim().toUpperCase();
  let best: { mapping: Mapping; len: number } | null = null;
  const regexes: { mapping: Mapping; body: string; flags: string }[] = [];

  for (const mapping of mappings) {
    const pattern = mapping.pattern.trim();
    const rx = REGEX_PATTERN.exec(pattern);
    if (rx) {
      regexes.push({ mapping, body: rx[1]!, flags: rx[2]! });
      continue;
    }
    const prefix = pattern.replace(/-+$/, "").toUpperCase();
    if (!prefix) continue;
    if (upperKey.startsWith(prefix + "-") && (!best || prefix.length > best.len)) {
      best = { mapping, len: prefix.length };
    }
  }
  if (best) return best.mapping;

  for (const { mapping, body, flags } of regexes) {
    let re: RegExp;
    try {
      // Drop g/y: they make .test() stateful, which is never what a mapping means.
      re = new RegExp(body, flags.replace(/[gy]/g, ""));
    } catch {
      continue;
    }
    if (re.test(key.trim())) return mapping;
  }
  return null;
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
  /** Flush a batch when no new line arrived for this long (default 200ms) */
  batchIdleMs: number;
  /** Flush a batch at the latest this long after its first item (default 1000ms) */
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
  failures: number;
  /** Resolves once the previous entry for this id has fully stopped */
  ready: Promise<void>;
}

function signatureOf(w: Watcher): string {
  const env = Object.keys(w.env ?? {})
    .sort()
    .map((k) => [k, w.env[k]]);
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
  onItems: (watcher: Watcher, items: WorkItem[]) => void | Promise<void>;
  onStatus: (watcherId: string, patch: { lastRunAt?: number; lastError?: string | null }) => void;
  spawn?: SpawnFn;
  timing?: Partial<WatcherTiming>;
}

export class WatcherRunner {
  private readonly onItems: WatcherRunnerOptions["onItems"];
  private readonly onStatus: WatcherRunnerOptions["onStatus"];
  private readonly spawn: SpawnFn;
  private readonly timing: WatcherTiming;
  /** Supervised (enabled) watchers */
  private readonly entries = new Map<string, Entry>();
  /** Every watcher seen by the last sync, so runNow works for disabled ones too */
  private known = new Map<string, Watcher>();
  /** One-off runs (runNow on a watcher that isn't supervised) */
  private readonly oneOffs = new Map<string, Entry>();
  private readonly stopping = new Set<Promise<void>>();

  constructor(opts: WatcherRunnerOptions) {
    this.onItems = opts.onItems;
    this.onStatus = opts.onStatus;
    this.spawn = opts.spawn ?? bunSpawn;
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
  }

  /** Reconcile running processes with the given watcher list. */
  sync(watchers: Watcher[]): void {
    this.known = new Map(watchers.map((w) => [w.id, w]));
    const wanted = new Map(watchers.filter((w) => w.enabled).map((w) => [w.id, w]));

    for (const [id, entry] of this.entries) {
      const next = wanted.get(id);
      if (!next) {
        this.entries.delete(id);
        this.track(this.stopEntry(entry));
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
    await Promise.all([...all.map((e) => this.stopEntry(e)), ...this.stopping]);
  }

  // --- internals -----------------------------------------------------------

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
      ready,
    };
  }

  private startEntry(w: Watcher, after: Promise<void>): void {
    const entry = this.makeEntry(w, after.catch(() => {}));
    this.entries.set(w.id, entry);
    entry.ready.then(() => {
      if (entry.stopped) return;
      if (w.mode === "interval") {
        const every = Math.max((w.intervalSec || 0) * 1000, this.timing.minIntervalMs);
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
    return run.catch(() => false);
  }

  private async executeInner(entry: Entry): Promise<boolean> {
    const w = entry.watcher;
    this.onStatus(w.id, { lastRunAt: Date.now() });

    let proc: SpawnedProcess;
    try {
      proc = this.spawn(w.command, w.args ?? [], { cwd: expandHome(w.cwd), env: w.env ?? {} });
    } catch (err) {
      this.onStatus(w.id, { lastError: `Failed to start ${w.command}: ${errorMessage(err)}` });
      return false;
    }
    entry.proc = proc;
    // A stop/restart may have raced the spawn.
    if (entry.stopped) proc.kill();

    let deliveryError: string | null = null;
    let delivery: Promise<void> = Promise.resolve();
    const deliver = (items: WorkItem[]) => {
      delivery = delivery.then(async () => {
        try {
          await this.onItems(entry.watcher, items);
        } catch (err) {
          deliveryError = `Failed to handle items: ${errorMessage(err)}`;
          this.onStatus(w.id, { lastError: deliveryError });
        }
      });
    };

    const batcher = new Batcher(deliver, this.timing.batchIdleMs, this.timing.batchMaxMs);
    let stderrTail = "";
    const readStderr = proc.stderr
      ? readText(proc.stderr, (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
        })
      : Promise.resolve();

    let buffer = "";
    const readStdout = readText(proc.stdout, (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const item = parseWorkItem(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (item) batcher.push(item);
      }
    });

    let code: number;
    try {
      [code] = await Promise.all([proc.exited, readStdout, readStderr]);
    } finally {
      const tail = parseWorkItem(buffer);
      if (tail) batcher.push(tail);
      batcher.flush();
      entry.proc = null;
      await delivery;
    }

    if (entry.stopped || entry.restarting) return true;
    if (code === 0 || code === 4) {
      if (!deliveryError) this.onStatus(w.id, { lastError: null });
      return true;
    }
    const detail = stderrTail.trim();
    this.onStatus(w.id, { lastError: `${w.command} exited with code ${code}${detail ? `: ${detail}` : ""}` });
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

/** Groups items that arrive close together; flushes on idle, on max age, or explicitly. */
class Batcher {
  private items: WorkItem[] = [];
  private firstAt = 0;
  private timer: Timer | null = null;

  constructor(
    private readonly deliver: (items: WorkItem[]) => void,
    private readonly idleMs: number,
    private readonly maxMs: number,
  ) {}

  push(item: WorkItem): void {
    if (this.items.length === 0) this.firstAt = Date.now();
    this.items.push(item);
    if (this.timer) clearTimeout(this.timer);
    const age = Date.now() - this.firstAt;
    const wait = Math.max(0, Math.min(this.idleMs, this.maxMs - age));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    this.deliver(batch);
  }
}
