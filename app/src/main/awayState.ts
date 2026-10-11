// Whether the person is away from the Mac: screen locked, system asleep, or idle past a threshold.
// Chromium keeps `document.visibilityState` at "visible" while the display sleeps (it only reports
// "hidden" for a minimized or covered window), so a window can't tell on its own. The renderers
// report `visible: false` while this says away, so the service doesn't hold pushes back for a
// screen nobody is looking at. powerMonitor has no display-sleep event; a sleeping display only
// happens after the idle timeout, so idle plus lock plus suspend covers it.

export type IdleState = "active" | "idle" | "locked" | "unknown";

/** The slice of Electron's powerMonitor this uses. */
export interface PowerMonitorLike {
  on(event: "lock-screen" | "unlock-screen" | "suspend" | "resume", listener: () => void): unknown;
  removeListener(event: "lock-screen" | "unlock-screen" | "suspend" | "resume", listener: () => void): unknown;
  getSystemIdleState(idleThresholdSeconds: number): IdleState;
}

export interface AwayStateOptions {
  monitor: PowerMonitorLike;
  /** Seconds without input before the person counts as away */
  idleSeconds?: number;
  pollMs?: number;
  onChange: (away: boolean) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export const AWAY_IDLE_SECONDS = 60;
export const AWAY_POLL_MS = 5000;

export class AwayState {
  private locked = false;
  private suspended = false;
  private idle = false;
  private last = false;
  private timer: unknown = null;
  private readonly listeners: [Parameters<PowerMonitorLike["on"]>[0], () => void][];

  constructor(private opts: AwayStateOptions) {
    this.listeners = [
      ["lock-screen", () => this.set({ locked: true })],
      // The person just came back, so the idle reading is stale until the next poll says otherwise.
      ["unlock-screen", () => this.set({ locked: false, idle: false })],
      ["suspend", () => this.set({ suspended: true })],
      ["resume", () => this.set({ suspended: false, idle: false })],
    ];
  }

  get away(): boolean {
    return this.locked || this.suspended || this.idle;
  }

  start() {
    if (this.timer) return;
    for (const [event, fn] of this.listeners) this.opts.monitor.on(event, fn);
    this.poll();
    this.timer = (this.opts.setInterval ?? setInterval)(() => this.poll(), this.opts.pollMs ?? AWAY_POLL_MS);
  }

  stop() {
    if (!this.timer) return;
    for (const [event, fn] of this.listeners) this.opts.monitor.removeListener(event, fn);
    (this.opts.clearInterval ?? clearInterval as (h: unknown) => void)(this.timer);
    this.timer = null;
  }

  /** Read the system's idle state; an unreadable or unknown answer changes nothing. */
  poll() {
    let state: IdleState;
    try {
      state = this.opts.monitor.getSystemIdleState(this.opts.idleSeconds ?? AWAY_IDLE_SECONDS);
    } catch {
      return;
    }
    if (state === "unknown") return;
    this.set({ idle: state !== "active", locked: state === "locked" ? true : this.locked });
  }

  private set(patch: { locked?: boolean; suspended?: boolean; idle?: boolean }) {
    if (patch.locked !== undefined) this.locked = patch.locked;
    if (patch.suspended !== undefined) this.suspended = patch.suspended;
    if (patch.idle !== undefined) this.idle = patch.idle;
    const away = this.away;
    if (away === this.last) return;
    this.last = away;
    this.opts.onChange(away);
  }
}
