// The one delivery path for ticket events (DESIGN.md "Events"): rows that are ready for a target ticket
// (status "escalated") wait out a short debounce, pass the target's wake cap, and go in one wake (a push into
// the target's live run, or a queued run: the caller's `deliver` decides). When the run ends the rows settle
// (a run that failed, was cancelled or was lost puts them back, a few tries, then closes them with a reason),
// and a restart sweep settles what a crash left mid-flight. The chief of staff's triage and the subscription
// feed differ only in what they hand this engine: who is ready, how a wake reads and which cap applies.
//
// It owns scheduling and state only. One timer serves everything due: debounce, cap, the caller's own
// due time (`extraDue`, the chief's triage batch) and the retention prune.

import type { WakeCap } from "@harness/shared";
import { EVENT_WAKE_CAP, collapseMoves, nextWakeAllowedAt } from "@harness/shared";
import type { Store } from "../store";
import type { StoredTicketEvent } from "../store/ticket-events";
import { renderEventsPrompt } from "./render";

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Events in one wake; the rest wait for a later wake and are counted in this one. */
export const WAKE_MAX_EVENTS = 40;
/** A wake whose run fails or is cancelled is sent again this many times in all. */
export const WAKE_MAX_ATTEMPTS = 3;
/** Ready rows wait this long, so a burst of live pushes goes out as one. */
export const DELIVERY_DEBOUNCE_MS = 1000;
/** The prune runs this often (and once at start), so an idle service still applies the retention. */
export const PRUNE_EVERY_MS = 60 * 60_000;

export interface DeliveryResult {
  /** The run that will read the wake, null when none (the caller handled it some other way) */
  runId: string | null;
  /** The wake was pushed into a run that was already going, rather than starting one */
  live?: boolean;
}

export interface OpenWake {
  id: string;
  targetId: string;
  runId: string | null;
  startedAt: number;
  eventCount: number;
  digest: string;
}

export interface EventDeliveryDeps {
  store: Store;
  now(): number;
  log(message: string): void;
  /** The status of a run, or null when it no longer exists */
  runStatus(runId: string): string | null;
  /** How long settled events are kept */
  retentionMs(): number;
  /** Hand the target the wake text; resolves to the run that will see it. A throw leaves the rows waiting and charges no wake. */
  deliver(targetId: string, text: string, events: StoredTicketEvent[]): Promise<DeliveryResult>;
  /** How a wake reads, with the digest the wake log keeps; the default fences every event's text. */
  render?(targetId: string, events: StoredTicketEvent[], more: number): { text: string; digest?: string };
  timers?: Timers;
  /** Whether the target still exists. A ready row whose target is gone goes to `onTargetGone`. */
  targetExists?(targetId: string): boolean;
  onTargetGone?(e: StoredTicketEvent): void;
  /** The gate: false holds the target's rows (a chief that is switched off) */
  open?(targetId: string): boolean;
  /** Which cap a row counts against, and what it is. A mixed batch carries each class under its own cap. */
  classOf?(e: StoredTicketEvent): string;
  capOf?(eventClass: string): WakeCap;
  /** Debounce before a ready row goes out (default DELIVERY_DEBOUNCE_MS) */
  debounceMs?: number;
  /** Whether a push into a live run settles its rows at once (default true). The chief's rows wait for its outcomes and the run's end. */
  settleOnPush?(targetId: string): boolean;
  /** Names the target's run in the reason a row is closed with ("the chief's run") */
  describeRun?(targetId: string): string;
  /** A row changed (so the caller can tell its clients) */
  patched?(e: StoredTicketEvent): void;
  /** Rows were settled or swept (the caller's counts and ownership may have moved) */
  changed?(): void;
  /** A wake's run is over; the default records spoke or failed in the wake log */
  settleWake?(w: OpenWake, runStatus: string): void;
  /** Work the caller does at the start of a tick (the chief reads activity and triages) */
  beforeTick?(): Promise<unknown> | void;
  /** When the caller next needs a tick, or null */
  extraDue?(): number | null;
  /** Housekeeping after the retention prune */
  afterPrune?(): void;
}

export class EventDelivery {
  private timer: unknown = null;
  private stopped = true;
  /** Targets with a wake being handed over now: a second deliver would send the same events again */
  private delivering = new Set<string>();
  /** Targets whose run failed in this tick: they don't get their events again in the same pass */
  private failedThisTick = new Set<string>();
  private lastPrune = 0;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  private readonly timers: Timers;

  constructor(private readonly d: EventDeliveryDeps) {
    this.timers = d.timers ?? realTimers;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Prune, then settle what a crash left mid-flight. The caller arms the timer once its own start-up is done. */
  start() {
    this.stopped = false;
    this.prune();
    this.sweep();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  get isStopped() {
    return this.stopped;
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  private capOf(eventClass: string): WakeCap {
    return this.d.capOf?.(eventClass) ?? EVENT_WAKE_CAP;
  }

  private classOf(e: StoredTicketEvent): string {
    return this.d.classOf?.(e) ?? "";
  }

  private patch(id: string, patch: Parameters<Store["ticketEvents"]["update"]>[1]): StoredTicketEvent | null {
    const e = this.d.store.ticketEvents.update(id, patch);
    if (e) this.d.patched?.(e);
    return e;
  }

  /** When a class of a target's wakes is next allowed: now, or when the oldest wake in the window ages out. */
  private allowedAt(targetId: string, eventClass: string, now: number): number {
    const cap = this.capOf(eventClass);
    return nextWakeAllowedAt(this.d.store.ticketEvents.wakeTimes(targetId, "wake", now - cap.windowMs, eventClass), now, cap);
  }

  /** Net state per ticket: five moves waiting for one wake are one move, or none. Returns the rows that remain, fresh. */
  private collapse(rows: StoredTicketEvent[]): StoredTicketEvent[] {
    const { dropped, net } = collapseMoves(rows.map((e) => ({ id: e.id, ticketId: e.ticketId, kind: e.kind, from: e.payload.from as string | null, to: e.payload.to as string | null, createdAt: e.createdAt })));
    if (!dropped.length && !net.size) return rows;
    const gone = new Set(dropped.map((x) => x.id));
    for (const { id, into } of dropped) this.patch(id, { status: "ignored", verdict: "filtered", reason: into ? "merged into a later move of the same ticket" : "moves cancelled out: the ticket ended where it started" });
    for (const [id, move] of net) {
      const e = rows.find((r) => r.id === id)!;
      const first = e.summary.trim().split("\n")[0] ?? "";
      this.patch(id, { summary: `${first.length > 100 ? `${first.slice(0, 100)}…` : first} (net: ${move.from} → ${move.to})`, payload: { ...e.payload, from: move.from, to: move.to } });
    }
    return rows.filter((e) => !gone.has(e.id)).map((e) => this.d.store.ticketEvents.get(e.id)!);
  }

  /** Wake `targetId` with its ready rows, unless it is gated, debouncing or over its cap; what is held goes in one later wake. */
  async deliver(targetId: string) {
    if (this.stopped || this.delivering.has(targetId) || this.failedThisTick.has(targetId)) return;
    this.delivering.add(targetId);
    try {
      await this.deliverNow(targetId);
    } finally {
      this.delivering.delete(targetId);
    }
  }

  private async deliverNow(targetId: string) {
    const { store } = this.d;
    if (this.d.open && !this.d.open(targetId)) return;
    const waiting = store.ticketEvents.byTarget("escalated", targetId);
    if (!waiting.length) return;
    const now = this.d.now();
    const debounce = this.d.debounceMs ?? DELIVERY_DEBOUNCE_MS;
    const ripe = this.collapse(waiting.filter((e) => now - e.updatedAt >= debounce));
    const capped = new Map<string, boolean>();
    const allowed = ripe.filter((e) => {
      const cls = this.classOf(e);
      if (!capped.has(cls)) capped.set(cls, this.allowedAt(targetId, cls, now) <= now);
      return capped.get(cls);
    });
    const events = allowed.slice(0, WAKE_MAX_EVENTS);
    if (!events.length) return;
    const more = waiting.length - events.length;
    const { text, digest } = this.d.render ? this.d.render(targetId, events, more) : { text: renderEventsPrompt(events, more), digest: undefined };
    let result: DeliveryResult;
    try {
      result = await this.d.deliver(targetId, text, events);
    } catch (err) {
      // Nothing was handed over: no wake is charged to the cap.
      this.d.log(`events: couldn't wake ${targetId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const settleNow = !!result.live && (this.d.settleOnPush?.(targetId) ?? true);
    // One wake-log row per class, so each class's cap counts only its own events.
    const byClass = new Map<string, StoredTicketEvent[]>();
    for (const e of events) byClass.set(this.classOf(e), [...(byClass.get(this.classOf(e)) ?? []), e]);
    for (const [eventClass, rows] of byClass) {
      const wakeId = store.ticketEvents.addWake({ targetId, eventClass, kind: "wake", eventCount: rows.length, digest, runId: result.runId });
      // A conductor's run can live for hours: a later cancel mustn't redeliver what the agent already read.
      for (const e of rows) this.patch(e.id, { status: settleNow ? "handled" : "handling", wakeId, consumingRunId: result.runId });
    }
    this.d.changed?.();
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /** A run ended: a run that finished handled its events; one that failed or was cancelled didn't, so they go back to waiting. */
  runEnded(runId: string, status: string): number {
    const events = this.d.store.ticketEvents.byRun(runId, "handling");
    for (const e of events) this.settle(e, status);
    for (const w of this.d.store.ticketEvents.openWakes()) if (w.runId === runId) this.settleWake(w, status);
    if (events.length) this.d.changed?.();
    this.arm();
    return events.length;
  }

  private settleWake(w: OpenWake, status: string) {
    if (this.d.settleWake) this.d.settleWake(w, status);
    else this.d.store.ticketEvents.setWakeOutcome(w.id, status === "succeeded" ? "spoke" : "failed");
  }

  private settle(e: StoredTicketEvent, runStatus: string) {
    // An outcome belongs to the run that recorded it: a run that failed or was cancelled leaves none for the next one to inherit.
    if (runStatus !== "succeeded" && e.payload.outcome !== undefined) {
      const { outcome: _o, ...rest } = e.payload;
      e = { ...e, payload: rest };
    }
    if (runStatus === "succeeded") {
      this.patch(e.id, { status: "handled" });
      return;
    }
    // A target whose runs keep failing isn't woken forever: after a few tries the event is closed with the reason.
    if (e.targetId) this.failedThisTick.add(e.targetId);
    const attempts = (typeof e.payload.wakeAttempts === "number" ? e.payload.wakeAttempts : 0) + 1;
    if (attempts >= WAKE_MAX_ATTEMPTS) {
      const run = (e.targetId && this.d.describeRun?.(e.targetId)) || "The run for this ticket";
      this.patch(e.id, { status: "ignored", reason: `${run} ${runStatus === "cancelled" ? "was cancelled" : "failed"} ${attempts} times, so it isn't woken for this again`, wakeId: null, consumingRunId: null, payload: { ...e.payload, wakeAttempts: attempts } });
    } else this.patch(e.id, { status: "escalated", wakeId: null, consumingRunId: null, payload: { ...e.payload, wakeAttempts: attempts } });
  }

  /**
   * Rows "handling" whose run is gone or over (a crash, a pruned run, a run that ended while its rows were being
   * recorded) are settled. One whose run is still queued or running stays: the wake survived, and sending it again
   * would wake the target twice.
   */
  sweep() {
    const { store } = this.d;
    let changed = false;
    for (const e of store.ticketEvents.byStatus("handling")) {
      const status = e.consumingRunId ? this.d.runStatus(e.consumingRunId) : null;
      if (status === "queued" || status === "running") continue;
      if (e.targetId && this.d.targetExists && !this.d.targetExists(e.targetId)) {
        if (this.d.onTargetGone) this.d.onTargetGone(e);
        else this.patch(e.id, { status: "ignored", reason: "its ticket no longer exists", wakeId: null, consumingRunId: null });
      } else this.settle(e, status ?? "missing");
      changed = true;
    }
    for (const w of store.ticketEvents.openWakes()) {
      const status = w.runId ? this.d.runStatus(w.runId) : null;
      if (status === "queued" || status === "running") continue;
      this.settleWake(w, status ?? "missing");
    }
    if (changed) this.d.changed?.();
  }

  // -------------------------------------------------------------------------
  // Timer
  // -------------------------------------------------------------------------

  /** Process what is due now. One tick at a time; a tick requested during one runs after it. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.runDue();
        } while (this.tickAgain && !this.stopped);
      } finally {
        this.ticking = null;
        this.arm();
      }
    })();
    return this.ticking;
  }

  private async runDue() {
    this.failedThisTick.clear();
    this.sweep();
    if (this.d.now() - this.lastPrune >= PRUNE_EVERY_MS) this.prune();
    const before = this.d.beforeTick?.();
    if (before) await before;
    for (const targetId of this.readyTargets()) await this.deliver(targetId);
  }

  private readyTargets(): string[] {
    return [...new Set(this.d.store.ticketEvents.byStatus("escalated").flatMap((e) => (e.targetId ? [e.targetId] : [])))];
  }

  /** The next moment something is due: a ready row's debounce and cap, the caller's own time, the prune. */
  private nextDue(): number | null {
    const now = this.d.now();
    const debounce = this.d.debounceMs ?? DELIVERY_DEBOUNCE_MS;
    const times: number[] = [];
    const by = new Map<string, Map<string, number>>();
    for (const e of this.d.store.ticketEvents.byStatus("escalated")) {
      if (!e.targetId || (this.d.open && !this.d.open(e.targetId))) continue;
      const classes = by.get(e.targetId) ?? new Map<string, number>();
      const cls = this.classOf(e);
      classes.set(cls, Math.min(classes.get(cls) ?? Infinity, e.updatedAt + debounce));
      by.set(e.targetId, classes);
    }
    for (const [targetId, classes] of by) {
      for (const [cls, ripeAt] of classes) times.push(Math.max(ripeAt, this.allowedAt(targetId, cls, now)));
    }
    const extra = this.d.extraDue?.();
    if (extra !== null && extra !== undefined) times.push(extra);
    times.push(this.lastPrune + PRUNE_EVERY_MS);
    return Math.min(...times);
  }

  arm() {
    if (this.stopped) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    const at = this.nextDue();
    if (at === null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.tick().catch((err) => this.d.log(`events: tick failed: ${err instanceof Error ? err.message : String(err)}`));
    }, Math.max(0, at - this.d.now()));
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /** Delete settled events (and the wake log) older than the retention setting. */
  prune() {
    this.lastPrune = this.d.now();
    const n = this.d.store.ticketEvents.prune(this.d.now() - this.d.retentionMs());
    if (n) this.d.log(`events: pruned ${n} old event(s)`);
    this.d.afterPrune?.();
  }
}
