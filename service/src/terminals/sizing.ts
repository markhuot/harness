// Shared sizing, tmux-style: a terminal is as large as the smallest client that is attached,
// watching (its presence says the terminal is on screen, see watchesTerminal) and live. When no
// attached client is watching, the smallest attached one still sets the size. Shrinks apply at
// once, grows wait (a phone that rotates or a window that is resized shouldn't make the shell
// flap), reports are debounced, and a client that stops reporting (a sleeping phone, a dropped
// network) expires, so the size goes back to what the rest fit.

import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS, type Presence } from "@harness/shared";

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Size {
  cols: number;
  rows: number;
}

export interface SizeOptions {
  initial: Size;
  /** Resize the PTY (and the emulator); called only when the size actually changes. */
  apply(size: Size): void;
  now(): number;
  timers: Timers;
  /** Reports inside this window coalesce into one trailing evaluation (default 100 ms). */
  debounceMs?: number;
  /** How long a grow waits before it applies (default 1.5 s). */
  growMs?: number;
  /** A client that hasn't been heard from this long no longer counts (default 15 s). */
  expiryMs?: number;
}

/** A viewport from the wire as a size, or null (NaN, 0×0, fractions of nothing); small ones clamp up to the floor. */
export function clampSize(cols: unknown, rows: unknown): Size | null {
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  const c = Math.floor(cols);
  const r = Math.floor(rows);
  if (c <= 0 || r <= 0) return null;
  return {
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(MIN_TERMINAL_COLS, c)),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(MIN_TERMINAL_ROWS, r)),
  };
}

/**
 * Whether a client with this presence is looking at the terminal. No presence yet (it hasn't sent
 * one) counts, and so does a presence that doesn't list terminals (an older client): only a client
 * that says it is hidden, away, or showing other terminals stops counting.
 */
export function watchesTerminal(presence: Pick<Presence, "visible" | "terminals"> | null | undefined, terminalId: string): boolean {
  if (!presence) return true;
  if (!presence.visible) return false;
  return presence.terminals === undefined || presence.terminals.includes(terminalId);
}

export class SizeCoordinator {
  private clients = new Map<string, Size & { seen: number; counted: boolean }>();
  private current: Size;
  private debounce: unknown = null;
  private dirty = false;
  /** A client attached to a terminal with none: its first evaluation applies in full. */
  private fresh = false;
  private growTimer: unknown = null;
  private readonly debounceMs: number;
  private readonly growMs: number;
  private readonly expiryMs: number;

  constructor(private readonly opts: SizeOptions) {
    this.current = { ...opts.initial };
    this.debounceMs = opts.debounceMs ?? 100;
    this.growMs = opts.growMs ?? 1500;
    this.expiryMs = opts.expiryMs ?? 15_000;
  }

  get size(): Size {
    return { ...this.current };
  }

  get clientCount() {
    return this.clients.size;
  }

  /** Each counted client's last viewport and how long ago its socket was heard from (a debug view of who holds the size). */
  reports(): { clientId: string; cols: number; rows: number; ageMs: number; counted: boolean }[] {
    const now = this.opts.now();
    return [...this.clients].map(([clientId, c]) => ({ clientId, cols: c.cols, rows: c.rows, ageMs: now - c.seen, counted: c.counted }));
  }

  /**
   * A client's viewport (attach or resize). False when the report was unusable. `counted` says
   * whether the client is watching the terminal; left out, a known client keeps what it had and a
   * new one counts.
   */
  report(clientId: string, cols: unknown, rows: unknown, counted?: boolean): boolean {
    const size = clampSize(cols, rows);
    if (!size) return false;
    // The first client to attach to a terminal nobody is watching gets its own size at once.
    if (this.clients.size === 0) this.fresh = true;
    this.clients.set(clientId, { ...size, seen: this.opts.now(), counted: counted ?? this.clients.get(clientId)?.counted ?? true });
    this.schedule();
    return true;
  }

  /** The client started or stopped watching the terminal (its presence changed). */
  setCounted(clientId: string, counted: boolean) {
    const c = this.clients.get(clientId);
    if (!c || c.counted === counted) return;
    c.counted = counted;
    this.schedule();
  }

  /** The client is still there (any message from its socket). */
  touch(clientId: string) {
    const c = this.clients.get(clientId);
    if (c) c.seen = this.opts.now();
  }

  remove(clientId: string) {
    if (this.clients.delete(clientId)) this.schedule();
  }

  /** Drop clients that went quiet; call about every 5 s. Returns their ids. */
  sweep(): string[] {
    const now = this.opts.now();
    const gone = [...this.clients].filter(([, c]) => now - c.seen > this.expiryMs).map(([id]) => id);
    for (const id of gone) this.clients.delete(id);
    if (gone.length) this.schedule();
    return gone;
  }

  dispose() {
    if (this.debounce) this.opts.timers.clear(this.debounce);
    if (this.growTimer) this.opts.timers.clear(this.growTimer);
    this.debounce = this.growTimer = null;
  }

  private target(): Size | null {
    const all = [...this.clients.values()];
    // Nobody watching: the smallest attached client, so a shell nobody looks at doesn't jump around.
    const counted = all.filter((c) => c.counted);
    let t: Size | null = null;
    for (const c of counted.length ? counted : all) t = t ? { cols: Math.min(t.cols, c.cols), rows: Math.min(t.rows, c.rows) } : { cols: c.cols, rows: c.rows };
    return t;
  }

  private schedule() {
    if (this.debounce) {
      this.dirty = true;
      return;
    }
    this.evaluate();
    this.debounce = this.opts.timers.set(() => {
      this.debounce = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.schedule();
    }, this.debounceMs);
  }

  private set(size: Size) {
    if (size.cols === this.current.cols && size.rows === this.current.rows) return;
    this.current = size;
    this.opts.apply({ ...size });
  }

  private evaluate() {
    const target = this.target();
    if (!target) return; // nobody attached: keep the last size
    if (this.fresh && this.clients.size === 1) {
      // Nobody to flap against: a first client gets its own size at once.
      this.fresh = false;
      if (this.growTimer) this.opts.timers.clear(this.growTimer);
      this.growTimer = null;
      this.set(target);
      return;
    }
    this.fresh = false;
    const cur = this.current;
    this.set({ cols: Math.min(cur.cols, target.cols), rows: Math.min(cur.rows, target.rows) });
    const grows = target.cols > this.current.cols || target.rows > this.current.rows;
    if (!grows) {
      if (this.growTimer) this.opts.timers.clear(this.growTimer);
      this.growTimer = null;
      return;
    }
    if (this.growTimer) return;
    this.growTimer = this.opts.timers.set(() => {
      this.growTimer = null;
      const t = this.target();
      if (t) this.set(t);
    }, this.growMs);
  }
}
