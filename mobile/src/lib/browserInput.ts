// Touch → page input for the Browser tab. The screencast frame is letterboxed into the stage; a
// finger on it maps to page CSS pixels (toPagePoint from @harness/shared/state), and gestures become
// the mouse / wheel / key events the service replays through CDP:
//   tap              → move + down + up (clickCount 1; a quick second tap nearby → 2)
//   pan              → wheel events (finger up = scroll down), scaled to page pixels
//   long-press + pan → mouse drag (down at the start, moves, up at the end), for sliders, selection…
// Pure and clock-injected so it can be tested without React Native.

import type { BrowserInput } from "@harness/shared";

export type Point = { x: number; y: number };
type MouseInput = Extract<BrowserInput, { type: "mouse" }>;

export interface GestureOptions {
  /** Local point (stage coordinates) → page CSS pixels, or null outside the drawn frame */
  toPage: (p: Point) => Point | null;
  /** Page CSS pixels per stage point (page width / drawn width) */
  scale: () => number;
  /** Movement below this (stage points) is still a tap */
  slop?: number;
  /** Holding this long before moving turns a pan into a drag */
  longPressMs?: number;
  /** Two taps within this window (and within doubleTapSlop) make a double click */
  doubleTapMs?: number;
  doubleTapSlop?: number;
}

type Mode = "idle" | "pending" | "pan" | "drag";

export class TouchGesture {
  private mode: Mode = "idle";
  private start: Point = { x: 0, y: 0 };
  private startAt = 0;
  private last: Point = { x: 0, y: 0 };
  private lastPage: Point | null = null;
  private lastTap: { at: number; p: Point; count: number } | null = null;
  private readonly slop: number;
  private readonly longPressMs: number;
  private readonly doubleTapMs: number;
  private readonly doubleTapSlop: number;

  constructor(private opts: GestureOptions) {
    this.slop = opts.slop ?? 8;
    this.longPressMs = opts.longPressMs ?? 450;
    this.doubleTapMs = opts.doubleTapMs ?? 320;
    this.doubleTapSlop = opts.doubleTapSlop ?? 24;
  }

  get state(): Mode {
    return this.mode;
  }

  begin(p: Point, at: number): BrowserInput[] {
    this.mode = "pending";
    this.start = this.last = p;
    this.startAt = at;
    this.lastPage = this.opts.toPage(p);
    return [];
  }

  move(p: Point, at: number): BrowserInput[] {
    if (this.mode === "idle") return [];
    const out: BrowserInput[] = [];
    if (this.mode === "pending") {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) < this.slop) return [];
      if (at - this.startAt >= this.longPressMs && this.lastPage) {
        this.mode = "drag";
        const s = this.lastPage;
        out.push(mouse("move", s), { ...mouse("down", s), button: "left", clickCount: 1 });
      } else {
        this.mode = "pan";
      }
    }
    if (this.mode === "pan") {
      const k = this.opts.scale();
      const dx = (this.last.x - p.x) * k;
      const dy = (this.last.y - p.y) * k;
      const at2 = this.opts.toPage(p) ?? this.lastPage;
      if (at2 && (dx || dy)) out.push({ type: "mouse", action: "wheel", x: at2.x, y: at2.y, deltaX: Math.round(dx), deltaY: Math.round(dy) });
      if (at2) this.lastPage = at2;
    } else if (this.mode === "drag") {
      const page = this.opts.toPage(p);
      if (page) {
        this.lastPage = page;
        out.push(mouse("move", page));
      }
    }
    this.last = p;
    return out;
  }

  end(p: Point, at: number): BrowserInput[] {
    const mode = this.mode;
    this.mode = "idle";
    if (mode === "drag") return this.lastPage ? [{ ...mouse("up", this.opts.toPage(p) ?? this.lastPage), button: "left", clickCount: 1 }] : [];
    if (mode !== "pending") return [];
    const page = this.opts.toPage(p);
    if (!page) return [];
    const prev = this.lastTap;
    const count = prev && at - prev.at <= this.doubleTapMs && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) <= this.doubleTapSlop ? Math.min(prev.count + 1, 3) : 1;
    this.lastTap = { at, p, count };
    return [mouse("move", page), { ...mouse("down", page), button: "left", clickCount: count }, { ...mouse("up", page), button: "left", clickCount: count }];
  }

  /** The system took the touch (e.g. a sheet opened): release a held button. */
  cancel(): BrowserInput[] {
    const mode = this.mode;
    this.mode = "idle";
    return mode === "drag" && this.lastPage ? [{ ...mouse("up", this.lastPage), button: "left", clickCount: 1 }] : [];
  }
}

function mouse(action: MouseInput["action"], p: Point): MouseInput {
  return { type: "mouse", action, x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------
// Keyboard: a hidden TextInput's text changes → text inserts and Backspaces
// ---------------------------------------------------------------------------

/** What changed between two values of the hidden input (autocorrect replacements included). */
export function textDelta(prev: string, next: string): { deletes: number; insert: string } {
  let i = 0;
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
  return { deletes: prev.length - i, insert: next.slice(i) };
}

const NAMED_KEYS: Record<string, string> = { Backspace: "Backspace", Enter: "Enter", Tab: "Tab", Escape: "Escape" };

/** Press and release a named key ("Backspace", "Enter", "Tab", "Escape"); [] for anything else. */
export function keyPress(key: string): BrowserInput[] {
  const code = NAMED_KEYS[key];
  if (!code) return [];
  return [
    { type: "key", action: "down", key, code },
    { type: "key", action: "up", key, code },
  ];
}

export function textChangeInputs(prev: string, next: string): BrowserInput[] {
  const { deletes, insert } = textDelta(prev, next);
  const out: BrowserInput[] = [];
  for (let i = 0; i < deletes; i++) out.push(...keyPress("Backspace"));
  if (insert) out.push({ type: "text", text: insert });
  return out;
}

// ---------------------------------------------------------------------------
// Resize: only after the subscription is confirmed, only real size changes
// ---------------------------------------------------------------------------

/**
 * The service restarts the screencast on every real viewport change, and overlapping restarts
 * (or one that races the subscribe) leave the tab without frames. So send nothing until the first
 * browser.state for the session confirms the subscription, then only sizes that differ from the
 * last one sent. Call reset() for a new session or after a reconnect.
 */
export class ResizeGate {
  private subscribed = false;
  private lastSent = "";

  reset() {
    this.subscribed = false;
    this.lastSent = "";
  }

  /** A browser.state arrived; true the first time (schedule a resize now). */
  confirm(): boolean {
    if (this.subscribed) return false;
    this.subscribed = true;
    return true;
  }

  /** The resize to send for this stage size, or null. */
  take(width: number, height: number): Extract<BrowserInput, { type: "resize" }> | null {
    if (!this.subscribed) return null;
    const w = Math.round(width);
    const h = Math.round(height);
    if (w <= 0 || h <= 0) return null;
    const key = `${w}x${h}`;
    if (key === this.lastSent) return null;
    this.lastSent = key;
    return { type: "resize", width: w, height: h };
  }
}
