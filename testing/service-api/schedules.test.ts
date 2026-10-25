import { afterEach, expect, test } from "bun:test";
import type { Cos, TicketEventPage, Schedule } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

const MIN = 60_000;

/** A service with a chief and one repeating wake. Only a chief's tools make schedules, so this one is written to the store. */
async function withSchedule() {
  const rig = await boot({ schedulerIntervalMs: 0 });
  const cos = await rig.ok<Cos>("POST", "/cos", { scope: "all" });
  const now = rig.harness.store.schedules.insert({ cosId: cos.ticketId, kind: "wake", title: "Weekday check", message: "Look", spec: { type: "every", everyMs: 10 * MIN }, projectId: null, nextFireAt: Date.now() - MIN });
  return { rig, cos, schedule: now };
}

test("GET /schedules lists active schedules with their spec, and ?all=1 adds the finished ones; DELETE stops one", async () => {
  const { rig, schedule } = await withSchedule();
  expect((await rig.ok<Schedule[]>("GET", "/schedules")).map((s) => s.id)).toEqual([schedule.id]);
  const cancelled = await rig.ok<Schedule>("DELETE", `/schedules/${schedule.id}`);
  expect(cancelled).toMatchObject({ id: schedule.id, status: "cancelled", nextFireAt: null });
  expect(await rig.ok<Schedule[]>("GET", "/schedules")).toEqual([]);
  expect((await rig.ok<Schedule[]>("GET", "/schedules?all=1")).map((s) => s.status)).toEqual(["cancelled"]);
  expect((await rig.call("DELETE", `/schedules/${schedule.id}`)).status).toBe(409);
  expect((await rig.call("DELETE", "/schedules/nope")).status).toBe(404);
});

test("the service's scheduler turns a due wake into an event in its chief's Inbox", async () => {
  const { rig, cos, schedule } = await withSchedule();
  expect(rig.harness.scheduler.tick()).toBe(1);
  const page = await rig.ok<TicketEventPage>("GET", `/tickets/${cos.ticketId}/events?limit=50`);
  expect(page.items.filter((e) => e.sourceKind === "schedule")).toEqual([expect.objectContaining({ title: "Weekday check", targetId: cos.ticketId })]);
  expect((await rig.ok<Schedule[]>("GET", "/schedules"))[0]!.lastOutcome).toBe("fired");
  expect((await rig.ok<Schedule[]>("GET", "/schedules"))[0]!.id).toBe(schedule.id);
});
