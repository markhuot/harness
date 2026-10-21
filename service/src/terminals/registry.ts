// The terminal registry: shells the service hosts, shared by every client (DESIGN.md "Terminals").
// A terminal is a PTY with a headless emulator beside it. Clients attach over the WebSocket, get a
// snapshot of the screen plus the byte offset to continue from, then live output. The shell's size
// is the smallest attached, visible client (SizeCoordinator). Terminals live in memory: they end
// when the service restarts.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { MAX_RUNNING_TERMINALS, type CreateTerminalBody, type Presence, type ServerMessage, type TerminalInfo } from "@harness/shared";
import type { EventBus } from "../events";
import { badRequest, conflict, notFound } from "../orchestrator/errors";
import { createEmulator, type CreateEmulator, type Emulator } from "./emulator";
import { pollTerminals, type PollRunners } from "./poller";
import type { PtyProcess, SpawnPty } from "./pty";
import { SizeCoordinator, clampSize, realTimers, watchesTerminal, type Size, type Timers } from "./sizing";

/** A socket attached to terminals. */
export interface TerminalClient {
  /** The socket id. */
  id: string;
  send(msg: ServerMessage): void;
  /** Bytes queued for the socket and not yet sent. */
  buffered(): number;
}

export interface TerminalRegistryOptions {
  bus: EventBus;
  spawn: SpawnPty;
  /** Base environment for shells (default process.env). */
  env?: Record<string, string | undefined>;
  home?: string;
  isDirectory?: (path: string) => boolean;
  now?: () => number;
  timers?: Timers;
  createEmulator?: CreateEmulator;
  poll?: PollRunners;
  /** Running terminals allowed at once (default 24). */
  maxRunning?: number;
  /** An exited terminal stays listed this long (default 10 min). */
  exitedGraceMs?: number;
  /** A terminal nobody is attached to, with only the shell in the foreground, ends after this (default 24 h). */
  idleMs?: number;
  /** Output is coalesced for this long before it goes out (default 4 ms). */
  flushMs?: number;
  /** A client with more than this queued is dropped from live output and resynced from a snapshot (default 1 MiB). */
  highWater?: number;
  log?: (msg: string) => void;
}

export const MAX_WRITE = 1024 * 1024;
/**
 * Input a terminal takes per second. A shell that isn't reading (raw mode, a busy program) leaves
 * what we write queued inside the service, so an unthrottled paste loop would grow its memory.
 */
export const MAX_WRITE_PER_SECOND = 4 * 1024 * 1024;
/** Exited terminals kept for their grace period; the oldest go first past this. */
export const MAX_EXITED_TERMINALS = 8;
/** What an agent reads from a terminal: lines by default, and the most it can ask for. */
export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 1000;
/** A cap on the characters returned, so one enormous line can't overflow a tool result. */
export const MAX_READ_CHARS = 60_000;
const UPDATE_INTERVAL_MS = 1000;
const ENV_DROP = /^(ELECTRON_|HARNESS_|BUN_|npm_|NODE_OPTIONS$)/;

/** The shell's environment: ours minus the service's own switches, plus the terminal's identity. */
export function shellEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || ENV_DROP.test(k)) continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Harness";
  // A service started by launchd has no locale; without one zsh mangles anything non-ASCII.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";
  return env;
}

export function loginShell(env: Record<string, string | undefined>): string {
  const shell = env.SHELL;
  return shell && isAbsolute(shell) ? shell : "/bin/zsh";
}

/** `~` and `~/x` expand to home; a missing, relative or non-directory path is home. */
export function resolveCwd(cwd: string | undefined, home: string, isDirectory: (p: string) => boolean): string {
  let dir = cwd?.trim() ?? "";
  if (dir === "~") dir = home;
  else if (dir.startsWith("~/")) dir = join(home, dir.slice(2));
  return dir && isAbsolute(dir) && isDirectory(dir) ? dir : home;
}

const defaultIsDirectory = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Whether input is the terminal answering a query (cursor position, device attributes, a color,
 * focus, mode report) rather than something typed. Every attached client's emulator answers the
 * shell's queries, so only the primary client's answers are forwarded.
 */
export function isTerminalReply(data: string): boolean {
  return (
    /^\x1b\[[?>=]?[\d;:]*[Rcn]$/.test(data) ||
    /^\x1b\[[IO]$/.test(data) ||
    /^\x1b\[\??[\d;]*\$y$/.test(data) ||
    /^\x1b\](?:4|10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(data) ||
    /^\x1bP[>!01]\$?[^\x1b]*\x1b\\$/.test(data)
  );
}

interface ClientState {
  client: TerminalClient;
  deviceId: string;
  /** Gets live output; false until its snapshot is out, and while it resyncs. */
  ready: boolean;
  resyncing: boolean;
  /** The lowest the socket's queue has been since its snapshot: what's above it is live output. */
  floor: number;
}

interface Term {
  info: TerminalInfo;
  shell: string;
  pty: PtyProcess;
  emu: Emulator;
  decoder: TextDecoder;
  /** Bytes of (decoded) output flushed so far. */
  offset: number;
  pending: string;
  flushTimer: unknown;
  clients: Map<string, ClientState>;
  size: SizeCoordinator;
  primary: string | null;
  /** The last time a client was attached, or the creation time. */
  lastActive: number;
  exitedAt: number | null;
  oscCwd: boolean;
  lastEmit: number;
  lastEmitted: string;
  emitTimer: unknown;
  closed: boolean;
  /** Input accepted since writeWindowAt (a one-second window). */
  writeWindowAt: number;
  writeWindowBytes: number;
  /** The last serialized screen, until output or a resize changes it. */
  snapshot: { offset: number; cols: number; rows: number; data: string; truncated: boolean } | null;
}

export class TerminalRegistry {
  private terms = new Map<string, Term>();
  /** The last presence each socket sent; a socket with none counts for the terminals it attaches. */
  private presences = new Map<string, Presence>();
  private readonly o: Required<Pick<TerminalRegistryOptions, "now" | "timers" | "maxRunning" | "exitedGraceMs" | "idleMs" | "flushMs" | "highWater">>;
  private readonly env: Record<string, string | undefined>;
  private readonly home: string;
  private readonly isDirectory: (p: string) => boolean;
  private readonly makeEmulator: CreateEmulator;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly opts: TerminalRegistryOptions) {
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? homedir();
    this.isDirectory = opts.isDirectory ?? defaultIsDirectory;
    this.makeEmulator = opts.createEmulator ?? createEmulator;
    this.o = {
      now: opts.now ?? Date.now,
      timers: opts.timers ?? realTimers,
      maxRunning: opts.maxRunning ?? MAX_RUNNING_TERMINALS,
      exitedGraceMs: opts.exitedGraceMs ?? 10 * 60_000,
      idleMs: opts.idleMs ?? 24 * 3600_000,
      flushMs: opts.flushMs ?? 4,
      highWater: opts.highWater ?? 1024 * 1024,
    };
  }

  /** Start the 5 s housekeeping tick (size expiry, polling, reaping). */
  start() {
    this.tickTimer ??= setInterval(() => void this.tick().catch((err) => this.logError("terminal housekeeping failed", err)), 5000);
    this.tickTimer.unref?.();
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }));
  }

  get(id: string): TerminalInfo | null {
    const t = this.terms.get(id);
    return t ? { ...t.info } : null;
  }

  /** Who the shell's size is taken from: the size it is at, and each counted client's last viewport with its device. */
  sizeReports(id: string) {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    const clients = term.size.reports().map((r) => ({ ...r, deviceId: term.clients.get(r.clientId)?.deviceId ?? null }));
    return { cols: term.info.cols, rows: term.info.rows, clients };
  }

  create(body: CreateTerminalBody = {}): TerminalInfo {
    const running = [...this.terms.values()].filter((t) => t.info.state === "running").length;
    if (running >= this.o.maxRunning) throw conflict(`There are already ${this.o.maxRunning} terminals running; close one first`);
    if (body.cwd !== undefined && (typeof body.cwd !== "string" || body.cwd.length > 4096)) throw badRequest("cwd must be a path string");
    const initial: Size = clampSize(body.cols ?? 80, body.rows ?? 24) ?? { cols: 80, rows: 24 };
    const cwd = resolveCwd(body.cwd, this.home, this.isDirectory);
    const shell = loginShell(this.env);
    const id = `t-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = this.o.now();
    const info: TerminalInfo = {
      id,
      cwd,
      title: "",
      process: basename(shell),
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      state: "running",
      exitCode: null,
      createdAt: now,
      createdBy: typeof body.deviceId === "string" ? body.deviceId.slice(0, 128) : "",
      cols: initial.cols,
      rows: initial.rows,
    };
    const term: Term = {
      info,
      shell,
      pty: null as never,
      emu: null as never,
      decoder: new TextDecoder("utf-8"),
      offset: 0,
      pending: "",
      flushTimer: null,
      clients: new Map(),
      size: null as never,
      primary: null,
      lastActive: now,
      exitedAt: null,
      oscCwd: false,
      lastEmit: now,
      lastEmitted: JSON.stringify(info),
      emitTimer: null,
      closed: false,
      writeWindowAt: now,
      writeWindowBytes: 0,
      snapshot: null,
    };
    term.emu = this.makeEmulator(initial.cols, initial.rows, {
      title: (title) => {
        term.info.title = title;
        this.changed(term);
      },
      cwd: (path) => {
        term.oscCwd = true;
        term.info.cwd = path;
        this.changed(term);
      },
    });
    term.size = new SizeCoordinator({
      initial,
      now: this.o.now,
      timers: this.o.timers,
      apply: (size) => this.applySize(term, size),
    });
    try {
      this.spawnShell(term, initial);
    } catch (err) {
      term.closed = true;
      term.size.dispose();
      term.emu.dispose();
      throw err;
    }
    this.terms.set(id, term);
    this.opts.bus.emit({ kind: "terminal.created", terminal: { ...info } });
    return { ...info };
  }

  /**
   * Start a new shell in an exited terminal: same id, screen and scrollback, so a shell that
   * crashed or was exited can come back where it was. A running terminal is refused.
   */
  restart(id: string): TerminalInfo {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    if (term.info.state !== "exited") throw conflict(`Terminal ${id} is still running`);
    const running = [...this.terms.values()].filter((t) => t.info.state === "running").length;
    if (running >= this.o.maxRunning) throw conflict(`There are already ${this.o.maxRunning} terminals running; close one first`);
    const size = { cols: term.info.cols, rows: term.info.rows };
    // The same login shell in the terminal's last known directory; a spawn failure leaves it exited.
    term.info.cwd = resolveCwd(term.info.cwd, this.home, this.isDirectory);
    this.spawnShell(term, size);
    term.info.state = "running";
    term.info.exitCode = null;
    term.info.process = basename(term.shell);
    term.exitedAt = null;
    term.lastActive = this.o.now();
    term.decoder = new TextDecoder("utf-8");
    term.snapshot = null;
    term.oscCwd = false;
    this.changed(term, true);
    // Clients attached to the dead shell get the screen again, and read the terminal as live.
    for (const st of term.clients.values()) this.resync(term, st);
    return { ...term.info };
  }

  /** Spawn the shell into a term; its callbacks ignore a shell that isn't the term's current one. */
  private spawnShell(term: Term, size: Size) {
    let pty: PtyProcess | undefined;
    pty = this.opts.spawn(term.shell, ["-l"], {
      cwd: term.info.cwd,
      cols: size.cols,
      rows: size.rows,
      env: shellEnv(this.env),
      onData: (bytes) => {
        if (term.pty === pty || !pty) this.guard(() => this.onData(term, bytes));
      },
      onExit: (exit) => {
        if (term.pty === pty || !pty) this.guard(() => this.onExit(term, exit.exitCode));
      },
    });
    term.pty = pty;
  }

  /** End the terminal now: SIGHUP the shell (SIGKILL if it lingers), forget it. */
  close(id: string): void {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    this.remove(term, true);
  }

  async attach(client: TerminalClient, id: string, deviceId: string, cols: unknown, rows: unknown): Promise<void> {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    const counted = watchesTerminal(this.presences.get(client.id), id);
    const existing = term.clients.get(client.id);
    if (existing) {
      // Attaching again reports a new viewport.
      term.size.report(client.id, cols, rows, counted);
      return;
    }
    // The same device on an older socket (a reconnect, or a second window) doesn't count twice for
    // sizing. The older socket stays attached and keeps its output; its next resize counts it again.
    for (const [sid, st] of term.clients) {
      if (deviceId && st.deviceId === deviceId && sid !== client.id) term.size.remove(sid);
    }
    term.size.report(client.id, cols, rows, counted); // an unusable report leaves the size as it is
    const state: ClientState = { client, deviceId, ready: false, resyncing: false, floor: 0 };
    term.clients.set(client.id, state);
    term.lastActive = this.o.now();
    await this.sendSnapshot(term, state);
  }

  detach(socketId: string, id: string) {
    const term = this.terms.get(id);
    if (!term?.clients.delete(socketId)) return;
    term.size.remove(socketId);
    if (term.primary === socketId) term.primary = null;
    term.lastActive = this.o.now();
  }

  /** A socket closed: detach it everywhere. */
  dropClient(socketId: string) {
    this.presences.delete(socketId);
    for (const term of this.terms.values()) this.detach(socketId, term.info.id);
  }

  /**
   * What a socket shows now (its presence message). A socket that is hidden, away, or showing
   * other terminals stops counting toward the size of the terminals it is attached to, but keeps
   * its output; it counts again when its presence says the terminal is back on screen.
   */
  setPresence(socketId: string, presence: Presence) {
    this.presences.set(socketId, presence);
    for (const term of this.terms.values()) {
      if (term.clients.has(socketId)) term.size.setCounted(socketId, watchesTerminal(presence, term.info.id));
    }
  }

  /** Any message from a socket keeps its attachments alive. */
  touch(socketId: string) {
    for (const term of this.terms.values()) term.size.touch(socketId);
  }

  resize(socketId: string, id: string, cols: unknown, rows: unknown) {
    const term = this.terms.get(id);
    if (!term?.clients.has(socketId)) return;
    // A resize can recreate an entry (unusable attach size, swept), so it carries the presence's verdict.
    term.size.report(socketId, cols, rows, watchesTerminal(this.presences.get(socketId), id));
  }

  write(socketId: string, id: string, data: unknown) {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    if (typeof data !== "string") throw badRequest("data must be a string");
    if (data.length > MAX_WRITE) throw badRequest(`writes are limited to ${MAX_WRITE} characters`);
    if (term.info.state !== "running") return;
    if (isTerminalReply(data)) {
      if (term.primary && term.primary !== socketId) return; // another client answers
      term.primary ??= socketId;
    } else {
      term.primary = socketId;
    }
    this.send(term, id, data);
  }

  /**
   * Typing by an agent (the chief of staff's write_terminal), not a socket: it shares the size and
   * per-second limits with the sockets but has no primary client, and it fails loudly on a shell
   * that has exited, where a socket's write is a silent no-op.
   */
  writeAgent(id: string, data: string) {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    if (data.length > MAX_WRITE) throw badRequest(`writes are limited to ${MAX_WRITE} characters`);
    if (term.info.state !== "running") throw badRequest(`Terminal ${id} has exited`);
    this.send(term, id, data);
  }

  private send(term: Term, id: string, data: string) {
    const now = this.o.now();
    if (now - term.writeWindowAt >= 1000) {
      term.writeWindowAt = now;
      term.writeWindowBytes = 0;
    }
    if (term.writeWindowBytes + data.length > MAX_WRITE_PER_SECOND) throw badRequest("Input is arriving faster than the shell can take it; slow down");
    term.writeWindowBytes += data.length;
    try {
      term.pty.write(data);
    } catch {
      // The shell went away between its master closing and its exit being reported: it ended.
      throw notFound(`Terminal ${id} has ended`);
    }
  }

  /**
   * What the terminal shows as plain text: the last `lines` logical lines (at most MAX_READ_LINES)
   * and at most MAX_READ_CHARS characters, the oldest dropped first. Output still waiting to be
   * parsed is included.
   */
  async text(id: string, lines = DEFAULT_READ_LINES): Promise<{ text: string; lines: number; truncated: boolean }> {
    const term = this.terms.get(id);
    if (!term) throw notFound(`No terminal ${id}`);
    this.flush(term);
    await term.emu.idle();
    const want = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(lines)));
    let out = term.emu.lines(want + 1);
    let truncated = out.length > want;
    out = out.slice(-want);
    let size = 0;
    const kept: string[] = [];
    for (let i = out.length - 1; i >= 0; i--) {
      let line = out[i]!;
      if (size + line.length + 1 > MAX_READ_CHARS) {
        truncated = true;
        const room = MAX_READ_CHARS - size - 1;
        if (kept.length === 0 && room > 0) kept.unshift(line.slice(-room));
        break;
      }
      size += line.length + 1;
      kept.unshift(line);
    }
    return { text: kept.join("\n"), lines: kept.length, truncated };
  }

  /** Housekeeping: expire silent clients, poll attached terminals, drop exited and idle ones. */
  async tick(): Promise<void> {
    const now = this.o.now();
    for (const term of [...this.terms.values()]) {
      // A silent client stops counting for the size but stays attached: it still gets output, and
      // its next resize or attach counts it again. Closing its socket is what detaches it.
      term.size.sweep();
      if (term.info.state === "exited" && term.exitedAt !== null && now - term.exitedAt >= this.o.exitedGraceMs) this.remove(term, false);
      else if (term.info.state === "running" && term.clients.size === 0 && now - term.lastActive >= this.o.idleMs && term.info.process === basename(term.shell)) {
        this.remove(term, true);
      }
    }
    await this.poll(false);
  }

  /** Look up cwd and foreground process now: for attached terminals, or for all of them. */
  async poll(all: boolean): Promise<void> {
    if (this.polling) return;
    const targets = [...this.terms.values()].filter((t) => t.info.state === "running" && (all || t.clients.size > 0));
    if (targets.length === 0) return;
    this.polling = true;
    try {
      const result = await pollTerminals(targets.map((t) => ({ id: t.info.id, pid: t.pty.pid })), this.opts.poll);
      for (const term of targets) {
        const r = result.get(term.info.id);
        if (!r || term.closed) continue;
        if (r.process) term.info.process = r.process;
        if (r.cwd && !term.oscCwd) term.info.cwd = r.cwd;
        this.changed(term);
      }
    } finally {
      this.polling = false;
    }
  }

  /** On service shutdown: hang up every shell. */
  shutdown() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const term of this.terms.values()) {
      term.closed = true;
      term.size.dispose();
      if (term.info.state === "running") this.hangUp(term.pty, false);
      term.emu.dispose();
    }
    this.terms.clear();
  }

  // -- internals ------------------------------------------------------------------------------

  private remove(term: Term, kill: boolean) {
    this.terms.delete(term.info.id);
    term.closed = true;
    term.size.dispose();
    if (term.flushTimer) this.o.timers.clear(term.flushTimer);
    if (term.emitTimer) this.o.timers.clear(term.emitTimer);
    if (kill && term.info.state === "running") this.hangUp(term.pty, true);
    for (const st of term.clients.values()) st.client.send({ type: "terminal.exit", id: term.info.id, exitCode: term.info.exitCode });
    term.clients.clear();
    term.emu.dispose();
    this.opts.bus.emit({ kind: "terminal.removed", id: term.info.id });
  }

  private hangUp(pty: PtyProcess, escalate: boolean) {
    try {
      pty.kill("SIGHUP");
    } catch {}
    if (!escalate) return;
    const timer = setTimeout(() => {
      try {
        pty.kill("SIGKILL");
      } catch {}
    }, 3000);
    timer.unref?.();
  }

  private onData(term: Term, bytes: Uint8Array) {
    if (term.closed) return;
    const text = term.decoder.decode(bytes, { stream: true });
    if (!text) return;
    term.pending += text;
    if (!term.flushTimer) term.flushTimer = this.o.timers.set(() => this.guard(() => this.flush(term)), this.o.flushMs);
  }

  private flush(term: Term) {
    if (term.flushTimer) this.o.timers.clear(term.flushTimer);
    term.flushTimer = null;
    if (term.closed || !term.pending) return;
    const text = term.pending;
    term.pending = "";
    term.offset += Buffer.byteLength(text);
    term.snapshot = null;
    term.emu.write(text);
    for (const st of term.clients.values()) {
      if (!st.ready) continue;
      // Backpressure is what queued since the snapshot went out, not the snapshot itself.
      const queued = st.client.buffered();
      st.floor = Math.min(st.floor, queued);
      if (queued - st.floor > this.o.highWater) {
        // A slow client never stalls the shell or the others: it skips output and resyncs.
        this.resync(term, st);
        continue;
      }
      st.client.send({ type: "terminal.output", id: term.info.id, data: text, offset: term.offset });
    }
  }

  private async sendSnapshot(term: Term, st: ClientState) {
    if (st.resyncing) return;
    st.resyncing = true;
    st.ready = false;
    try {
      this.flush(term);
      await term.emu.idle();
      // Past this point nothing awaits, so the snapshot and the offset describe the same instant.
      while (st.client.buffered() > this.o.highWater / 4) await new Promise((r) => this.o.timers.set(() => r(null), 50));
      if (term.closed || term.clients.get(st.client.id) !== st) return;
      await term.emu.idle();
      // One serialization per size or output change, shared by every client that needs it.
      const { cols, rows } = term.info;
      let shot = term.snapshot;
      if (!shot || shot.offset !== term.offset || shot.cols !== cols || shot.rows !== rows) {
        shot = { offset: term.offset, cols, rows, ...term.emu.serialize() };
        term.snapshot = shot;
      }
      st.client.send({ type: "terminal.snapshot", id: term.info.id, data: shot.data, offset: shot.offset, cols, rows, truncated: shot.truncated });
      st.floor = st.client.buffered();
      if (term.info.state === "exited") st.client.send({ type: "terminal.exit", id: term.info.id, exitCode: term.info.exitCode });
      st.ready = true;
    } finally {
      st.resyncing = false;
    }
  }

  private applySize(term: Term, size: Size) {
    if (term.closed) return;
    this.flush(term); // the emulator parses output queued before the resize at the old size
    try {
      term.pty.resize(size.cols, size.rows);
    } catch {}
    term.emu.resize(size.cols, size.rows);
    term.info.cols = size.cols;
    term.info.rows = size.rows;
    // Clients get the screen again at the new size, from the emulator that reflowed it, rather than
    // reflowing what they drew: two emulators reflow wrapped lines differently.
    for (const st of term.clients.values()) if (st.ready) this.resync(term, st);
    this.changed(term);
  }

  /** Send a client the screen again in the background; a failure is logged, never thrown. */
  private resync(term: Term, st: ClientState) {
    this.sendSnapshot(term, st).catch((err) => this.logError("terminal snapshot failed", err));
  }

  /** Run a callback from the PTY or a timer: whatever it throws ends there, not in the service. */
  private guard(fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.logError("terminal callback failed", err);
    }
  }

  private logError(what: string, err: unknown) {
    try {
      this.opts.log?.(`${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } catch {}
  }

  private onExit(term: Term, exitCode: number | null) {
    if (term.closed) return;
    this.flush(term);
    term.info.state = "exited";
    term.info.exitCode = exitCode;
    term.exitedAt = this.o.now();
    for (const st of term.clients.values()) st.client.send({ type: "terminal.exit", id: term.info.id, exitCode });
    this.changed(term, true);
    // Each exited terminal keeps its scrollback emulator, so only the newest few are kept.
    const exited = [...this.terms.values()].filter((t) => t.info.state === "exited").sort((a, b) => a.exitedAt! - b.exitedAt!);
    for (const old of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_TERMINALS))) this.remove(old, false);
  }

  /** Emit terminal.updated when something changed, at most once a second per terminal. */
  private changed(term: Term, force = false) {
    if (term.closed) return;
    const send = () => {
      term.emitTimer = null;
      if (term.closed) return;
      const json = JSON.stringify(term.info);
      if (json === term.lastEmitted) return;
      term.lastEmitted = json;
      term.lastEmit = this.o.now();
      this.opts.bus.emit({ kind: "terminal.updated", terminal: { ...term.info } });
    };
    if (term.emitTimer) return;
    const wait = UPDATE_INTERVAL_MS - (this.o.now() - term.lastEmit);
    if (force || wait <= 0) return send();
    term.emitTimer = this.o.timers.set(() => this.guard(send), wait);
  }
}
