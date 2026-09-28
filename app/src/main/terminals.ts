// Built-in terminals, process side: one PTY per caller-supplied id (the renderer's pane leaf id).
// Sessions outlive the pane that shows them, so a remounted pane re-attaches with ensure() and
// replays the scrollback. The PTY itself is injected (node-pty in the app, fakes in tests).

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { TerminalExit, TerminalSession } from "./types";

/** The slice of node-pty's IPty the manager uses. */
export interface Pty {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type SpawnPty = (file: string, args: string[], opts: SpawnOptions) => Pty;

export interface TerminalEvents {
  /** Output, coalesced; `end` is the session's output offset just past it (see TerminalSession.end). */
  data(id: string, data: string, end: number): void;
  exit(id: string, exit: TerminalExit): void;
}

export interface TerminalManagerOptions {
  spawn: SpawnPty;
  events: TerminalEvents;
  /** Base environment for shells (default process.env) */
  env?: Record<string, string | undefined>;
  home?: string;
  isDirectory?: (path: string) => boolean;
  /** Scrollback kept per session, in UTF-16 code units (default 1 MiB) */
  scrollbackLimit?: number;
  /** How output is coalesced before it's sent: schedule `flush` once (default a 4 ms timer) */
  schedule?: (flush: () => void) => void;
  /** Delay before a killed PTY that ignored SIGHUP gets SIGKILL (default 3 s) */
  killGraceMs?: number;
}

export const SCROLLBACK_LIMIT = 1024 * 1024;
export const MAX_WRITE = 1024 * 1024;
export const MAX_DIMENSION = 1000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Bounded output history: whole chunks, trimmed from the front once over `limit`. */
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}

  push(data: string) {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit && this.chunks.length) {
      const over = this.size - this.limit;
      const first = this.chunks[0]!;
      if (first.length <= over) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        // Cut the oldest chunk, and start the replay on a fresh line where one is near, so it
        // doesn't open halfway through an escape sequence or a wide character.
        let cut = over;
        const nl = first.indexOf("\n", cut);
        if (nl !== -1 && nl - cut < 4096) cut = nl + 1;
        this.chunks[0] = first.slice(cut);
        this.size -= cut;
        if (!this.chunks[0]) this.chunks.shift();
      }
    }
  }

  get length() {
    return this.size;
  }

  toString() {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join("")];
    return this.chunks[0] ?? "";
  }
}

interface Session {
  id: string;
  pty: Pty;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: Scrollback;
  pending: string;
  /** How much output there's been, in UTF-16 code units (never trimmed, unlike the scrollback). */
  written: number;
  exit: TerminalExit | null;
}

export class TerminalError extends Error {}

export function validId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function dimension(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_DIMENSION) {
    throw new TerminalError(`${name} must be an integer from 1 to ${MAX_DIMENSION}`);
  }
  return v;
}

function checkId(id: unknown): string {
  if (!validId(id)) throw new TerminalError("terminal id must be 1-128 of A-Z a-z 0-9 . _ : -");
  return id;
}

/** Parse ensure()'s options from the renderer (IPC input is untrusted). */
export function parseEnsureOptions(raw: unknown): { cwd?: string; cols: number; rows: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (o.cwd !== undefined && (typeof o.cwd !== "string" || o.cwd.length > 4096)) throw new TerminalError("cwd must be a path string");
  return { cwd: o.cwd as string | undefined, cols: dimension(o.cols ?? 80, "cols"), rows: dimension(o.rows ?? 24, "rows") };
}

/** Resolve the shell's working directory: `~` expands to home; missing or relative → home. */
export function resolveCwd(cwd: string | undefined, home: string, isDirectory: (p: string) => boolean): string {
  let dir = cwd?.trim() ?? "";
  if (dir === "~") dir = home;
  else if (dir.startsWith("~/")) dir = join(home, dir.slice(2));
  return dir && isAbsolute(dir) && isDirectory(dir) ? dir : home;
}

/** The user's login shell: $SHELL when it's an absolute path, else /bin/zsh. */
export function loginShell(env: Record<string, string | undefined>): string {
  const shell = env.SHELL;
  return shell && isAbsolute(shell) ? shell : "/bin/zsh";
}

/** The shell's environment: ours minus Electron's own switches, plus the terminal's identity. */
export function shellEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ELECTRON_") || k === "NODE_OPTIONS") continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Harness";
  // Apps opened from Finder get no locale; without one zsh mangles anything non-ASCII.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";
  return env;
}

const isDirectory = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private dirty = new Set<Session>();
  private flushScheduled = false;
  private readonly env: Record<string, string | undefined>;
  private readonly home: string;
  private readonly isDirectory: (p: string) => boolean;
  private readonly scrollbackLimit: number;
  private readonly schedule: (flush: () => void) => void;
  private readonly killGraceMs: number;

  constructor(private readonly opts: TerminalManagerOptions) {
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? homedir();
    this.isDirectory = opts.isDirectory ?? isDirectory;
    this.scrollbackLimit = opts.scrollbackLimit ?? SCROLLBACK_LIMIT;
    this.schedule = opts.schedule ?? ((flush) => void setTimeout(flush, 4));
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  /**
   * Attach to the session `id`, spawning a login shell first if there isn't one. An existing
   * session (running or exited) is returned as is, with its scrollback for the pane to replay.
   */
  ensure(rawId: unknown, rawOpts?: unknown): TerminalSession {
    const id = checkId(rawId);
    const existing = this.sessions.get(id);
    // An existing session re-attaches. Its unsent output still goes out (other windows may show
    // it); the snapshot says where its scrollback ends, so this pane skips what it just replayed.
    if (existing) return this.snapshot(existing, false);
    const { cwd: wanted, cols, rows } = parseEnsureOptions(rawOpts);
    const cwd = resolveCwd(wanted, this.home, this.isDirectory);
    const shell = loginShell(this.env);
    const pty = this.opts.spawn(shell, ["-l"], { cwd, cols, rows, env: shellEnv(this.env) });
    const session: Session = { id, pty, shell, cwd, cols, rows, scrollback: new Scrollback(this.scrollbackLimit), pending: "", written: 0, exit: null };
    this.sessions.set(id, session);
    pty.onData((data) => {
      if (this.sessions.get(id) !== session) return;
      session.scrollback.push(data);
      session.pending += data;
      session.written += data.length;
      this.dirty.add(session);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        this.schedule(() => this.flush());
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(id) !== session) return;
      this.flushSession(session);
      session.exit = { exitCode, signal: signal || null };
      this.opts.events.exit(id, session.exit);
    });
    return this.snapshot(session, true);
  }

  write(rawId: unknown, data: unknown): boolean {
    const session = this.sessions.get(checkId(rawId));
    if (typeof data !== "string") throw new TerminalError("data must be a string");
    if (data.length > MAX_WRITE) throw new TerminalError(`writes are limited to ${MAX_WRITE} characters`);
    if (!session || session.exit) return false;
    session.pty.write(data);
    return true;
  }

  resize(rawId: unknown, rawCols: unknown, rawRows: unknown): boolean {
    const session = this.sessions.get(checkId(rawId));
    const cols = dimension(rawCols, "cols");
    const rows = dimension(rawRows, "rows");
    if (!session || session.exit) return false;
    if (cols === session.cols && rows === session.rows) return true;
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    return true;
  }

  /** End the session: SIGHUP the shell (SIGKILL if it's still around after the grace period) and forget it. */
  kill(rawId: unknown): boolean {
    const id = checkId(rawId);
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.dirty.delete(session);
    if (!session.exit) this.terminate(session.pty, true);
    return true;
  }

  /** Every session id, running or exited, so the renderer can kill the ones it no longer shows. */
  list(): string[] {
    return [...this.sessions.keys()];
  }

  /** On quit. No SIGKILL follow-up: the process is exiting, and closing the PTYs hangs up what's left. */
  killAll() {
    for (const session of this.sessions.values()) if (!session.exit) this.terminate(session.pty, false);
    this.sessions.clear();
    this.dirty.clear();
  }

  private terminate(pty: Pty, escalate: boolean) {
    let exited = false;
    pty.onExit(() => {
      exited = true;
    });
    try {
      pty.kill("SIGHUP");
    } catch {}
    if (!escalate) return;
    const timer = setTimeout(() => {
      if (exited) return;
      try {
        pty.kill("SIGKILL");
      } catch {}
    }, this.killGraceMs);
    timer.unref?.();
  }

  private flush() {
    this.flushScheduled = false;
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const session of dirty) this.flushSession(session);
  }

  private flushSession(session: Session) {
    this.dirty.delete(session);
    if (!session.pending) return;
    const data = session.pending;
    session.pending = "";
    // pending is everything since the last flush, so it ends where the output does.
    this.opts.events.data(session.id, data, session.written);
  }

  private snapshot(s: Session, created: boolean): TerminalSession {
    return { id: s.id, pid: s.pty.pid, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, created, scrollback: s.scrollback.toString(), end: s.written, exit: s.exit };
  }
}
