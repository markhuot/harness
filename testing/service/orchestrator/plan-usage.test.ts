import { afterEach, beforeEach, expect, test } from "bun:test";
import { assertNoTimerLeaks, trackTimers } from "../leaks";
import type { DriverPlanUsage, PlanWindow } from "@harness/shared";
import { PlanUsageError, type Driver } from "../../../service/src/drivers/types";
import { EventBus } from "../../../service/src/events";
import { BACKOFF_MS, MAX_BACKOFF_MS, PlanUsageTracker, POLL_MS } from "../../../service/src/orchestrator/plan-usage";
import { fakeClock } from "../../builders/clock";
import { FakeDriver } from "../fake-driver";

beforeEach(trackTimers);
afterEach(assertNoTimerLeaks);

const win = (usedPercent: number, id: PlanWindow["id"] = "five_hour"): PlanWindow => ({ id, label: "5-hour", usedPercent, resetsAt: 0, windowSeconds: 18000 });

function rig(...reads: (PlanWindow[] | null | Error)[]) {
  const clock = fakeClock(1_000_000);
  const bus = new EventBus();
  const updates: number[] = [];
  bus.onKind("usage.updated", (e) => updates.push(e.usage.drivers.length));
  const driver = new FakeDriver({ id: "claude-code" });
  let calls = 0;
  (driver as Driver).planUsage = async () => {
    const next = reads[Math.min(calls++, reads.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  const tracker = new PlanUsageTracker(() => [driver], bus, clock);
  return { tracker, clock, updates, driver, calls: () => calls };
}

test("a reading is stored with its status by how full the fullest window is, and clients are told", async () => {
  for (const [used, status] of [[10, "ok"], [90, "near_limit"], [100, "limited"]] as const) {
    const r = rig([win(10), win(used, "seven_day")]);
    await r.tracker.refresh();
    expect(r.tracker.report().drivers[0]).toMatchObject({ driver: "claude-code", status, error: null, fetchedAt: 1_000_000 });
    expect(r.updates).toEqual([1]);
  }
});

test("a driver with no plan has no row, and one that stops having a plan loses its row", async () => {
  const r = rig([win(5)], null);
  await r.tracker.refresh();
  expect(r.tracker.report().drivers).toHaveLength(1);
  r.clock.advance(POLL_MS);
  await r.tracker.refresh();
  expect(r.tracker.report().drivers).toEqual([]);
  expect(r.updates).toEqual([1, 0]);
});

test("a failed read after a good one keeps the last windows, dated by when they were read", async () => {
  const r = rig([win(42)], new Error("Claude Code's login token has expired."));
  await r.tracker.refresh();
  r.clock.advance(24 * 3600_000);
  await r.tracker.refresh();
  expect(r.tracker.report().drivers[0]).toMatchObject({ error: "Claude Code's login token has expired.", windows: [win(42)], fetchedAt: 1_000_000 });
});

test("readings are saved and come back after a restart", async () => {
  let saved: DriverPlanUsage[] = [];
  const cache = { load: () => saved, save: (v: DriverPlanUsage[]) => (saved = v) };
  const driver = new FakeDriver({ id: "claude-code" });
  (driver as Driver).planUsage = async () => [win(42)];
  await new PlanUsageTracker(() => [driver], new EventBus(), fakeClock(1_000_000), cache).refresh();
  expect(saved).toHaveLength(1);
  const restarted = new PlanUsageTracker(() => [driver], new EventBus(), fakeClock(9_000_000), cache);
  expect(restarted.report().drivers[0]).toMatchObject({ windows: [win(42)], fetchedAt: 1_000_000 });
});

test("a failed read keeps the row with the error and backs off, so a second refresh inside the window reads nothing", async () => {
  const r = rig(new Error("signed out"), [win(5)]);
  await r.tracker.refresh();
  expect(r.tracker.report().drivers[0]).toMatchObject({ error: "signed out", windows: [] });
  await r.tracker.refresh();
  expect(r.calls()).toBe(1);
  r.clock.advance(BACKOFF_MS);
  await r.tracker.refresh();
  expect(r.calls()).toBe(2);
  expect(r.tracker.report().drivers[0]).toMatchObject({ error: null });
});

test("a forced read gets past a plain failure's backoff but not a rate limit's", async () => {
  const plain = rig(new Error("boom"), [win(1)]);
  await plain.tracker.refresh();
  await plain.tracker.refresh("claude-code", true);
  expect(plain.calls()).toBe(2);
  const limited = rig(new PlanUsageError("429", true), [win(1)]);
  await limited.tracker.refresh();
  await limited.tracker.refresh("claude-code", true);
  expect(limited.calls()).toBe(1);
});

test("consecutive rate limits double the wait up to the cap, and a Retry-After longer than the backoff wins", async () => {
  const r = rig(new PlanUsageError("429", true), new PlanUsageError("429", true), new PlanUsageError("429", true, 45 * 60_000), [win(1)]);
  await r.tracker.refresh();
  r.clock.advance(BACKOFF_MS);
  await r.tracker.refresh();
  r.clock.advance(2 * BACKOFF_MS - 1);
  await r.tracker.refresh();
  expect(r.calls()).toBe(2); // the second failure waits twice as long
  r.clock.advance(1);
  await r.tracker.refresh();
  expect(r.calls()).toBe(3);
  r.clock.advance(4 * BACKOFF_MS - 1);
  await r.tracker.refresh();
  expect(r.calls()).toBe(3); // asked to wait 45 minutes, backoff alone would be 40
  r.clock.advance(MAX_BACKOFF_MS);
  await r.tracker.refresh();
  expect(r.calls()).toBe(4);
});

test("isFresh counts any read, successful or not, within the age given", async () => {
  const r = rig(new Error("x"));
  expect(r.tracker.isFresh("claude-code", 1000)).toBe(false);
  await r.tracker.refresh();
  expect(r.tracker.isFresh("claude-code", 1000)).toBe(true);
  r.clock.advance(1000);
  expect(r.tracker.isFresh("claude-code", 1000)).toBe(false);
});

test("a rate-limit report stands in for the endpoint when it can't be read, with each window's share as a percent", async () => {
  const r = rig(new Error("no creds"));
  await r.tracker.refresh();
  r.tracker.noteRateLimit(r.driver, { type: "rate_limit", status: "allowed", windows: [{ id: "five_hour", used: 0.425, resetsAt: 99 }, { id: "seven_day", used: null, resetsAt: 0 }] });
  const row = r.tracker.report().drivers[0]!;
  expect(row.windows).toEqual([{ id: "five_hour", label: "5-hour", usedPercent: 42.5, resetsAt: 99, windowSeconds: 18000 }]);
  expect(row.status).toBe("ok");
  r.tracker.noteRateLimit(r.driver, { type: "rate_limit", status: "rejected", windows: [] });
  expect(r.tracker.report().drivers[0]!.status).toBe("limited");
});
