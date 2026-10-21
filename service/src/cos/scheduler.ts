// The scheduler (DESIGN.md "Schedules"): fires a chief of staff's reminders and wake-ups. One interval
// tick looks for due rows; there is no per-schedule timer, so a Mac that slept or a service that
// restarted catches up on its next tick. A schedule that was due more than once fires ONCE and moves
// on from now (an interval keeps its phase). Each fire has an id, '<schedule id>:<scheduled time>':
// a wake's cos_events row is written with it as the dedupe key in the same transaction that moves
// the schedule on, so a wake happens exactly once; a reminder's push goes out after that commit, so
// it happens at most once.

import {
  SCHEDULE_STALE_MS,
  type CosEvent,
  type Schedule,
  type ScheduleOutcome,
  type ScheduleStatus,
} from "@harness/shared";
import type { Clock } from "../clock";
import type { Store } from "../store";
import type { FireResult } from "../store/schedules";
import { advance, describeTime } from "./schedule-time";

/** Where a fire becomes an event (CosEngine.addExternal). */
export interface CosEventSink {
  addExternal(input: {
    sourceKind: "schedule";
    sourceRef: string;
    actor: string;
    title: string;
    body: string;
    projectId?: string | null;
    cosId?: string | null;
    /** Record the event as handled without a wake, with this reason (a reminder) */
    filtered?: string;
  }): CosEvent | null;
}

/** How a reminder reaches the human (NotificationService.remind). */
export interface ReminderNotifier {
  remind(reminder: { title: string; body: string }): void;
}

export interface SchedulerDeps {
  store: Store;
  now: Clock;
  sink: CosEventSink;
  notifier: ReminderNotifier;
  log?: (message: string) => void;
  /** Tick every this many ms (default 30 s); 0 never ticks on its own, for tests that call tick() */
  intervalMs?: number;
}

export const SCHEDULER_TICK_MS = 30_000;

export const fireId = (scheduleId: string, scheduledFor: number) =>
  `${scheduleId}:${scheduledFor}`;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: SchedulerDeps) {}

  /** Catch up once, then tick on an interval (a setInterval, not a long timeout: timers stand still while the Mac sleeps). */
  start() {
    this.tick();
    const every = this.d.intervalMs ?? SCHEDULER_TICK_MS;
    if (every > 0 && !this.timer) {
      this.timer = setInterval(() => this.tick(), every);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire what is due now; returns how many fired (not counting skipped or missed ones). */
  tick(): number {
    const now = this.d.now();
    let fired = 0;
    for (const s of this.d.store.schedules.due(now)) {
      try {
        if (this.fire(s, now)) fired++;
      } catch (err) {
        // The row didn't move (the transaction rolled back): the next tick tries again.
        this.d.log?.(
          `schedule ${s.id}: fire failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return fired;
  }

  private fire(s: Schedule, now: number): boolean {
    const { store, sink } = this.d;
    const scheduledFor = s.nextFireAt!;
    const next = advance(s.spec, scheduledFor, now);
    const status: ScheduleStatus = next === null ? "done" : "active";
    const move = (
      outcome: ScheduleOutcome,
      finalStatus: ScheduleStatus = status,
    ): FireResult => ({
      status: finalStatus,
      nextFireAt: next,
      lastFireAt: now,
      outcome,
    });

    // A one-shot found long after its time (the Mac was off) is stale, not late: say so, don't fire.
    if (s.spec.type === "at" && now - scheduledFor > SCHEDULE_STALE_MS) {
      store.schedules.fired(s.id, scheduledFor, move("missed", "missed"));
      this.d.log?.(
        `schedule ${s.id}: "${s.title}" was due ${describeTime(scheduledFor)} and is long past: marked missed`,
      );
      return false;
    }

    const cos = store.cos.get(s.cosId);
    const id = fireId(s.id, scheduledFor);
    const late =
      now - scheduledFor > 2 * (this.d.intervalMs ?? SCHEDULER_TICK_MS) + 1000;
    const when = late
      ? `${describeTime(scheduledFor)} (late: fired ${describeTime(now)})`
      : describeTime(scheduledFor);
    const projectId = s.projectKey
      ? (store.projects.getByKey(s.projectKey)?.id ?? null)
      : null;

    if (s.kind === "wake" && cos && !cos.enabled) {
      // A switched-off chief doesn't wake, and nothing queues for when it is switched back on.
      store.schedules.fired(s.id, scheduledFor, move("skipped"));
      this.d.log?.(
        `schedule ${s.id}: "${s.title}" skipped, chief ${cos.key} is off`,
      );
      return false;
    }

    const body = s.message
      ? `${s.message}\n\nScheduled for ${when}.`
      : `Scheduled for ${when}.`;
    let event: CosEvent | null = null;
    const cancelled = new Error("cancelled");
    try {
      store.transaction(() => {
        event = sink.addExternal({
          sourceKind: "schedule",
          sourceRef: id,
          actor: `schedule:${s.id}`,
          title: s.kind === "reminder" ? `Reminder: ${s.title}` : s.title,
          body,
          projectId,
          cosId: s.cosId,
          ...(s.kind === "reminder"
            ? { filtered: "reminder: posted to the human, no run" }
            : {}),
        });
        // Cancelled since the due list was read: roll the event back so the cancel stands.
        if (!store.schedules.fired(s.id, scheduledFor, move("fired")))
          throw cancelled;
      });
    } catch (err) {
      if (err === cancelled) return false;
      throw err;
    }
    // A null event is a fire id the Inbox already has: the push went out with it.
    if (s.kind === "reminder" && event)
      this.d.notifier.remind({
        title: s.title,
        body: s.message || `Scheduled for ${when}.`,
      });
    return true;
  }
}
