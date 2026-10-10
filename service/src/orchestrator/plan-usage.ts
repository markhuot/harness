// Plan usage (DESIGN.md "Plan usage"): how much of the account's plan limits the agents have used.
// Drivers with a plan (claude-code's 5-hour and weekly windows, github-copilot's monthly quota)
// say so through Driver.planUsage; this keeps the last reading per driver, polls for new ones while
// a client is connected, and tells clients when anything changed.

import type { DriverPlanUsage, PlanUsageReport, PlanWindow } from "@harness/shared";
import type { EventBus } from "../events";
import { PlanUsageError, type Driver, type DriverEvent } from "../drivers/types";

export const POLL_MS = 5 * 60_000;
/** After a failed poll, the next waits this long, doubling per consecutive failure up to the cap. */
export const BACKOFF_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

type RateLimit = Extract<DriverEvent, { type: "rate_limit" }>;

interface Entry extends DriverPlanUsage {
  /** Consecutive failures, for the backoff */
  failures: number;
  /** The windows came from a run's rate-limit report, not from the usage endpoint */
  fromEvents?: boolean;
  /** No poll before this (ms) */
  notBefore: number;
}

export class PlanUsageTracker {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = new Map<string, Promise<void>>();
  /** When each driver was last read, whatever came of it (a driver with no plan has no entry) */
  private checkedAt = new Map<string, number>();

  constructor(
    private readonly drivers: () => Driver[],
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** One entry per driver that has a plan and has been read (or failed) at least once. */
  report(): PlanUsageReport {
    const drivers = this.drivers()
      .filter((d) => this.entries.has(d.id))
      .map((d) => {
        const { failures: _f, notBefore: _n, fromEvents: _e, ...pub } = this.entries.get(d.id)!;
        return pub;
      });
    return { drivers };
  }

  /** Poll every POLL_MS while `hasClients()` (nobody sees the gauges otherwise). */
  start(hasClients: () => boolean) {
    this.stop();
    const tick = () => {
      if (hasClients()) void this.refresh();
    };
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Read the plan usage of every driver that has one (or just `driverId`). A driver in backoff is
   * skipped unless `force`. Resolves once readings are stored and clients told.
   */
  async refresh(driverId?: string, force = false): Promise<void> {
    const targets = this.drivers().filter((d) => d.planUsage && (!driverId || d.id === driverId));
    await Promise.all(targets.map((d) => this.refreshOne(d, force)));
  }

  private refreshOne(driver: Driver, force: boolean): Promise<void> {
    const running = this.inflight.get(driver.id);
    if (running) return running;
    const prev = this.entries.get(driver.id);
    if (!force && prev && prev.notBefore > this.now()) return Promise.resolve();
    const p = this.read(driver, prev).finally(() => this.inflight.delete(driver.id));
    this.inflight.set(driver.id, p);
    return p;
  }

  /** Whether `driverId` was read within `maxAgeMs`. */
  isFresh(driverId: string, maxAgeMs: number): boolean {
    const at = this.checkedAt.get(driverId);
    return at !== undefined && this.now() - at < maxAgeMs;
  }

  private async read(driver: Driver, prev: Entry | undefined): Promise<void> {
    const at = this.now();
    this.checkedAt.set(driver.id, at);
    let next: Entry;
    try {
      const windows = await driver.planUsage!();
      if (windows === null) {
        // The driver has no plan after all: no row.
        if (this.entries.delete(driver.id)) this.emit();
        return;
      }
      next = { driver: driver.id, name: driver.name, windows, status: statusOf(windows), error: null, fetchedAt: at, failures: 0, notBefore: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = err instanceof PlanUsageError && err.transient;
      const failures = (prev?.failures ?? 0) + 1;
      // Keep what the CLI's own rate-limit reports said, so a limit still shows; never a stale bar.
      next = {
        driver: driver.id,
        name: driver.name,
        windows: prev?.fromEvents ? prev.windows : [],
        status: prev?.status ?? null,
        error: message,
        fetchedAt: at,
        failures,
        notBefore: at + Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (transient ? failures - 1 : 0)),
        ...(prev?.fromEvents ? { fromEvents: true } : {}),
      } as Entry;
    }
    this.entries.set(driver.id, next);
    this.emit();
  }

  /**
   * A run's CLI reported its rate-limit state. A warning or a rejection reads the endpoint again
   * right away. When the endpoint can't be read, the report's own windows stand in for it (the
   * CLI gives each one's used share and reset), and its status still says how close the account is.
   */
  noteRateLimit(driver: Driver, ev: RateLimit) {
    const prev = this.entries.get(driver.id);
    const status = ev.status === "rejected" ? "limited" : ev.status === "allowed_warning" ? "near_limit" : "ok";
    if (prev && !prev.error) {
      if (status !== "ok") void this.refresh(driver.id, true);
      return;
    }
    const at = this.now();
    const labels: Record<string, [string, number]> = { five_hour: ["5-hour", 5 * 3600], seven_day: ["Weekly", 7 * 86400] };
    const windows: PlanWindow[] = ev.windows
      .filter((w) => w.used !== null)
      .map((w) => ({ id: w.id, label: labels[w.id]![0], usedPercent: Math.round(w.used! * 1000) / 10, resetsAt: w.resetsAt, windowSeconds: labels[w.id]![1] }));
    const next = {
      driver: driver.id,
      name: driver.name,
      windows: windows.length ? windows : (prev?.windows ?? []),
      status: status === "ok" && windows.length ? "ok" : status,
      error: prev?.error ?? null,
      fetchedAt: at,
      failures: prev?.failures ?? 0,
      notBefore: prev?.notBefore ?? 0,
      fromEvents: true,
    } as Entry;
    this.entries.set(driver.id, next);
    this.emit();
    if (status !== "ok") void this.refresh(driver.id, true);
  }

  private emit() {
    this.bus.emit({ kind: "usage.updated", usage: this.report() });
  }
}

function statusOf(windows: PlanWindow[]): DriverPlanUsage["status"] {
  const top = Math.max(0, ...windows.map((w) => w.usedPercent));
  return top >= 100 ? "limited" : top >= 90 ? "near_limit" : "ok";
}
