import { describe, expect, test } from "bun:test";
import type { HarnessEvent, PlanWindow } from "@harness/shared";
import { EventBus } from "../events";
import { PlanUsageError } from "../drivers/types";
import { FakeDriver } from "../testing/fakes";
import { BACKOFF_MS, MAX_BACKOFF_MS, PlanUsageTracker } from "./plan-usage";

const window = (usedPercent: number, over: Partial<PlanWindow> = {}): PlanWindow => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt: 9_000_000, windowSeconds: 18_000, ...over });

function setup() {
  let now = 1_000_000;
  const bus = new EventBus();
  const events: HarnessEvent[] = [];
  bus.on((e) => events.push(e));
  const driver = new FakeDriver("claude");
  driver.name = "Claude Code";
  let next: PlanWindow[] | null | Error = [window(10)];
  let reads = 0;
  (driver as { planUsage?: () => Promise<PlanWindow[] | null> }).planUsage = async () => {
    reads++;
    if (next instanceof Error) throw next;
    return next;
  };
  const tracker = new PlanUsageTracker(() => [driver, new FakeDriver("no-plan")], bus, () => now);
  return {
    tracker,
    driver,
    events,
    reads: () => reads,
    answer: (v: PlanWindow[] | null | Error) => (next = v),
    advance: (ms: number) => (now += ms),
    updates: () => events.filter((e) => e.kind === "usage.updated").length,
  };
}

describe("PlanUsageTracker", () => {
  test("reads each driver that has a plan, skips the ones that don't, and tells clients", async () => {
    const t = setup();
    expect(t.tracker.report()).toEqual({ drivers: [] });
    await t.tracker.refresh();
    expect(t.tracker.report().drivers).toEqual([{ driver: "claude", name: "Claude Code", windows: [window(10)], status: "ok", error: null, fetchedAt: 1_000_000 }]);
    expect(t.updates()).toBe(1);
    const e = t.events.find((x) => x.kind === "usage.updated") as { usage: { drivers: unknown[] } };
    expect(e.usage.drivers).toHaveLength(1);
  });

  test("status follows the fullest window: near the limit from 90%, limited at 100%", async () => {
    const t = setup();
    t.answer([window(89.9), window(90, { id: "seven_day", label: "Weekly" })]);
    await t.tracker.refresh();
    expect(t.tracker.report().drivers[0]!.status).toBe("near_limit");
    t.answer([window(100)]);
    await t.tracker.refresh(undefined, true);
    expect(t.tracker.report().drivers[0]!.status).toBe("limited");
  });

  test("a driver that turns out to have no plan (null) shows no row", async () => {
    const t = setup();
    await t.tracker.refresh();
    t.answer(null);
    await t.tracker.refresh(undefined, true);
    expect(t.tracker.report().drivers).toEqual([]);
    expect(t.tracker.isFresh("claude", 60_000)).toBe(true); // checked, so GET /usage doesn't ask again
  });

  test("an unreadable plan says why instead of keeping the old bar", async () => {
    const t = setup();
    await t.tracker.refresh();
    t.answer(new PlanUsageError("Sign in to Claude Code to see plan usage"));
    await t.tracker.refresh(undefined, true);
    expect(t.tracker.report().drivers[0]).toMatchObject({ windows: [], error: "Sign in to Claude Code to see plan usage" });
  });

  test("transient failures back off, doubling up to the cap; a poll in that time is skipped, a forced one isn't", async () => {
    const t = setup();
    t.answer(new PlanUsageError("429", true));
    await t.tracker.refresh();
    expect(t.reads()).toBe(1);
    t.advance(BACKOFF_MS - 1);
    await t.tracker.refresh();
    expect(t.reads()).toBe(1); // still backing off
    t.advance(1);
    await t.tracker.refresh();
    expect(t.reads()).toBe(2);
    t.advance(BACKOFF_MS); // the second failure doubled it
    await t.tracker.refresh();
    expect(t.reads()).toBe(2);
    await t.tracker.refresh(undefined, true);
    expect(t.reads()).toBe(3);
    for (let i = 0; i < 8; i++) {
      t.advance(MAX_BACKOFF_MS);
      await t.tracker.refresh();
    }
    t.advance(MAX_BACKOFF_MS - 1);
    const before = t.reads();
    await t.tracker.refresh();
    expect(t.reads()).toBe(before); // capped at an hour, not longer
    t.advance(1);
    await t.tracker.refresh();
    expect(t.reads()).toBe(before + 1);
  });

  test("a success clears the backoff", async () => {
    const t = setup();
    t.answer(new PlanUsageError("503", true));
    await t.tracker.refresh();
    t.answer([window(5)]);
    await t.tracker.refresh(undefined, true);
    t.advance(1);
    await t.tracker.refresh();
    expect(t.reads()).toBe(3);
  });

  test("two refreshes at once make one request", async () => {
    const t = setup();
    await Promise.all([t.tracker.refresh(), t.tracker.refresh()]);
    expect(t.reads()).toBe(1);
  });
});

describe("rate-limit reports as the fallback", () => {
  const report = (status: string, used: number | null = 0.4) => ({
    type: "rate_limit" as const,
    status,
    windows: [{ id: "five_hour" as const, used, resetsAt: 9_000_000 }],
  });

  test("when the endpoint can't be read, the CLI's own window report stands in for the bar", async () => {
    const t = setup();
    t.answer(new PlanUsageError("Sign in to Claude Code to see plan usage"));
    await t.tracker.refresh();
    t.tracker.noteRateLimit(t.driver, report("allowed", 0.4));
    expect(t.tracker.report().drivers[0]).toMatchObject({ windows: [{ id: "five_hour", usedPercent: 40, windowSeconds: 18_000, resetsAt: 9_000_000 }], status: "ok", error: "Sign in to Claude Code to see plan usage" });
  });

  test("with no percentage the status still says how close the account is", async () => {
    const t = setup();
    t.answer(new PlanUsageError("nope"));
    await t.tracker.refresh();
    t.tracker.noteRateLimit(t.driver, report("rejected", null));
    expect(t.tracker.report().drivers[0]).toMatchObject({ windows: [], status: "limited" });
  });

  test("a warning or rejection reads the endpoint again right away; an all-clear doesn't", async () => {
    const t = setup();
    await t.tracker.refresh();
    expect(t.reads()).toBe(1);
    t.tracker.noteRateLimit(t.driver, report("allowed"));
    expect(t.reads()).toBe(1);
    t.answer([window(95)]);
    t.tracker.noteRateLimit(t.driver, report("allowed_warning"));
    await Bun.sleep(5);
    expect(t.reads()).toBe(2);
    expect(t.tracker.report().drivers[0]!.windows[0]!.usedPercent).toBe(95);
  });
});
