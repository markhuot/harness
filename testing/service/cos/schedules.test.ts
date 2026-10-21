import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_MAX_ACTIVE, SCHEDULE_MIN_INTERVAL_MS, SCHEDULE_STALE_MS, type ScheduleSpec } from "../../../shared/src/cos";
import { type CosTriage, type TriageInput, type TriageResult } from "../../../service/src/cos/triage";
import { Scheduler, fireId } from "../../../service/src/cos/scheduler";
import { advance, nextFire, validateSpec } from "../../../service/src/cos/schedule-time";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Never asked for a verdict by a schedule's wake: asking is the failure. */
class CountingTriage implements CosTriage {
  readonly backend = "fake";
  readonly model = "haiku-test";
  readonly calls: TriageInput[] = [];
  async triage(input: TriageInput): Promise<TriageResult> {
    this.calls.push(input);
    return { verdicts: input.events.map((e) => ({ id: e.id, verdict: "ignore" as const, reason: "routine", brief: null, project: null })), model: this.model, tokensIn: 1, tokensOut: 1 };
  }
}

const noTimers = { set: () => 0, clear: () => {} };

async function setup() {
  const triage = new CountingTriage();
  const h = makeOrchestrator({ tools: undefined, cosTriage: triage, cosTimers: noTimers });
  h.orch.start();
  const chief = h.orch.openCos("all");
  const reminders: { title: string; body: string }[] = [];
  const notifier = { remind: (r: { title: string; body: string }) => void reminders.push(r) };
  const make = () => new Scheduler({ store: h.store, now: h.clock, sink: h.orch.cosEngine, notifier, intervalMs: 0 });
  const scheduler = make();
  const add = (spec: ScheduleSpec, extra: { kind?: "reminder" | "wake"; cosId?: string; title?: string; projectId?: string | null } = {}) =>
    h.store.schedules.insert({
      cosId: extra.cosId ?? chief.ticketId,
      kind: extra.kind ?? "wake",
      title: extra.title ?? "Check the board",
      message: "Look at everything",
      spec,
      projectId: extra.projectId ?? null,
      nextFireAt: nextFire(spec, h.clock())!,
    });
  const events = () => h.store.cosEvents.list({ limit: 500 }).filter((e) => e.sourceKind === "schedule");
  return { h, chief, triage, reminders, scheduler, make, add, events };
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

test("a one-shot fires once, at its time, and is done", async () => {
  const s = await setup();
  const sched = s.add({ type: "at", at: s.h.clock() + 10 * MIN });
  expect(s.scheduler.tick()).toBe(0);
  s.h.clock.advance(9 * MIN);
  expect(s.scheduler.tick()).toBe(0);
  s.h.clock.advance(MIN);
  expect(s.scheduler.tick()).toBe(1);
  expect(s.events()).toHaveLength(1);
  expect(s.h.store.schedules.get(sched.id)).toMatchObject({ status: "done", nextFireAt: null, lastOutcome: "fired" });
  s.h.clock.advance(HOUR);
  expect(s.scheduler.tick()).toBe(0);
  expect(s.events()).toHaveLength(1);
});

test("an interval fires every time it comes round, each with its own fire id", async () => {
  const s = await setup();
  const t0 = s.h.clock();
  const sched = s.add({ type: "every", everyMs: 10 * MIN });
  for (let i = 1; i <= 3; i++) {
    s.h.clock.advance(10 * MIN);
    expect(s.scheduler.tick()).toBe(1);
  }
  expect(s.events().map((e) => e.sourceRef).sort()).toEqual([1, 2, 3].map((i) => fireId(sched.id, t0 + i * 10 * MIN)).sort());
  expect(s.h.store.schedules.get(sched.id)).toMatchObject({ status: "active", nextFireAt: t0 + 40 * MIN });
});

test("after a long gap an interval fires once, not once per missed time, and keeps its phase", async () => {
  const s = await setup();
  const t0 = s.h.clock();
  const sched = s.add({ type: "every", everyMs: 10 * MIN });
  s.h.clock.advance(3 * HOUR + 5 * MIN); // the Mac slept through 18 fires
  expect(s.scheduler.tick()).toBe(1);
  expect(s.events()).toHaveLength(1);
  expect(s.h.store.schedules.get(sched.id)!.nextFireAt).toBe(t0 + 3 * HOUR + 10 * MIN);
  expect(s.scheduler.tick()).toBe(0);
});

test("a cron schedule that was due over a weekend fires once and moves to the next matching time", async () => {
  const s = await setup();
  s.h.clock.set(new Date(2026, 9, 21, 8, 0).getTime()); // Wed 21 Oct 2026, 08:00 local
  const sched = s.add({ type: "cron", cron: "0 9 * * 1-5" });
  expect(new Date(sched.nextFireAt!).getHours()).toBe(9);
  s.h.clock.set(new Date(2026, 9, 22, 8, 0).getTime());
  s.scheduler.tick(); // Wed 09:00 was due
  s.h.clock.set(new Date(2026, 9, 26, 10, 0).getTime()); // Mon 26th, 10:00: Thu's and Fri's 09:00 were missed
  expect(s.scheduler.tick()).toBe(1);
  expect(s.events()).toHaveLength(2);
  expect(new Date(s.h.store.schedules.get(sched.id)!.nextFireAt!)).toEqual(new Date(2026, 9, 27, 9, 0)); // Tue
});

test("a restart never fires the same time twice: the fire id is the dedupe key, and a reminder isn't pushed again", async () => {
  const s = await setup();
  const reminder = s.add({ type: "at", at: s.h.clock() + 5 * MIN }, { kind: "reminder", title: "Deploy" });
  const wake = s.add({ type: "at", at: s.h.clock() + 5 * MIN });
  s.h.clock.advance(5 * MIN);
  s.scheduler.tick();
  expect(s.events()).toHaveLength(2);
  expect(s.reminders).toHaveLength(1);
  // The rows' move was lost (a crash after the event, say): both look due again to a new service.
  for (const sc of [reminder, wake]) s.h.store.db.run("UPDATE schedules SET status = 'active', next_fire_at = ? WHERE id = ?", [sc.nextFireAt!, sc.id]);
  s.make().start();
  expect(s.events()).toHaveLength(2);
  expect(s.reminders).toHaveLength(1);
  expect(s.h.store.schedules.list({ all: true }).every((x) => x.status === "done")).toBe(true);
});

test("start() catches up what came due while the service was down, once", async () => {
  const s = await setup();
  s.add({ type: "every", everyMs: 15 * MIN });
  s.h.clock.advance(2 * HOUR);
  const fresh = s.make();
  fresh.start();
  fresh.stop();
  expect(s.events()).toHaveLength(1);
});

test("a cancelled schedule never fires", async () => {
  const s = await setup();
  const sched = s.add({ type: "every", everyMs: 10 * MIN });
  expect(s.h.orch.cancelSchedule(sched.id).status).toBe("cancelled");
  s.h.clock.advance(HOUR);
  expect(s.scheduler.tick()).toBe(0);
  expect(s.events()).toHaveLength(0);
  expect(() => s.h.orch.cancelSchedule(sched.id)).toThrow(/already cancelled/);
  expect(() => s.h.orch.cancelSchedule("nope")).toThrow(/Unknown schedule/);
});

test("a one-shot found more than a day late is missed, not fired", async () => {
  const s = await setup();
  const sched = s.add({ type: "at", at: s.h.clock() + 10 * MIN });
  s.h.clock.advance(10 * MIN + SCHEDULE_STALE_MS + 1);
  expect(s.scheduler.tick()).toBe(0);
  expect(s.events()).toHaveLength(0);
  expect(s.h.store.schedules.get(sched.id)).toMatchObject({ status: "missed", lastOutcome: "missed" });
});

test("a one-shot that is merely late still fires, and its event says so", async () => {
  const s = await setup();
  s.add({ type: "at", at: s.h.clock() + 10 * MIN });
  s.h.clock.advance(10 * MIN + 3 * HOUR);
  expect(s.scheduler.tick()).toBe(1);
  expect(JSON.stringify(s.events()[0]!.payload)).toMatch(/late: fired/);
});

// ---------------------------------------------------------------------------
// What a fire does
// ---------------------------------------------------------------------------

test("a reminder notifies the human, shows in the Inbox as ignored and starts no run", async () => {
  const s = await setup();
  s.add({ type: "at", at: s.h.clock() + MIN }, { kind: "reminder", title: "Deploy SHOP-4" });
  const runsBefore = s.h.driver.requests.length;
  s.h.clock.advance(MIN);
  s.scheduler.tick();
  await s.h.orch.cosEngine.tick();
  await s.h.settle();
  expect(s.reminders).toEqual([{ title: "Deploy SHOP-4", body: expect.stringContaining("Look at everything") }]);
  expect(s.events()).toEqual([expect.objectContaining({ title: "Reminder: Deploy SHOP-4", status: "ignored", verdict: "filtered", cosId: s.chief.ticketId })]);
  expect(s.h.driver.requests.length).toBe(runsBefore);
});

test("a wake becomes an event for its chief, goes straight to a wake without triage, and sends no notification", async () => {
  const s = await setup();
  s.add({ type: "at", at: s.h.clock() + MIN }, { title: "Weekday check" });
  s.h.clock.advance(MIN);
  s.scheduler.tick();
  expect(s.events()).toEqual([expect.objectContaining({ title: "Weekday check", status: "pending", cosId: s.chief.ticketId, projectId: null, actor: expect.stringMatching(/^schedule:/) })]);
  expect(s.reminders).toHaveLength(0);

  s.h.clock.advance(6 * MIN);
  await s.h.orch.cosEngine.tick();
  await s.h.settle();
  expect(s.triage.calls).toHaveLength(0); // it asked to be woken; nothing second-guesses that
  expect(s.events()[0]!.status).not.toBe("pending");
  expect(s.h.driver.requests.at(-1)!.prompt).toContain("Weekday check");
});

test("a wake carries its project when it has one", async () => {
  const s = await setup();
  s.add({ type: "at", at: s.h.clock() + MIN }, { projectId: s.h.project.id });
  s.h.clock.advance(MIN);
  s.scheduler.tick();
  expect(s.events()[0]).toMatchObject({ projectId: s.h.project.id });
});

test("a switched-off chief doesn't wake: the fire is skipped and nothing queues for when it is back; reminders still go", async () => {
  const s = await setup();
  s.add({ type: "every", everyMs: 10 * MIN });
  s.add({ type: "every", everyMs: 10 * MIN }, { kind: "reminder", title: "Stand-up" });
  s.h.orch.setCosEnabled(s.chief.ticketId, false);
  s.h.clock.advance(10 * MIN);
  expect(s.scheduler.tick()).toBe(1); // only the reminder
  expect(s.events().map((e) => e.title)).toEqual(["Reminder: Stand-up"]);
  expect(s.reminders).toHaveLength(1);
  expect(s.h.store.schedules.list().find((x) => x.kind === "wake")).toMatchObject({ lastOutcome: "skipped", status: "active" });

  s.h.orch.setCosEnabled(s.chief.ticketId, true);
  await s.h.orch.cosEngine.tick();
  expect(s.events().filter((e) => e.title === "Check the board")).toHaveLength(0);
  s.h.clock.advance(10 * MIN);
  s.scheduler.tick();
  expect(s.events().filter((e) => e.title === "Check the board")).toHaveLength(1); // the next one is on time again
});

test("a group chief's project-less wake stays with the chief that made it when events are re-homed", async () => {
  const s = await setup();
  const dir = join(s.h.home, "proj", "work1");
  mkdirSync(dir, { recursive: true });
  s.h.orch.createProject({ path: dir, name: "WORK1", key: "WORK1", useWorktrees: false, group: "Work" });
  const groupId = s.h.store.groups.findByName("Work")!.id;
  const group = s.h.orch.openCos({ group: groupId });
  s.add({ type: "at", at: s.h.clock() + MIN }, { cosId: group.ticketId });
  s.h.clock.advance(MIN);
  s.scheduler.tick();
  expect(s.events()[0]!.cosId).toBe(group.ticketId);
  s.h.orch.cosEngine.rehome();
  expect(s.h.store.cosEvents.get(s.events()[0]!.id)!.cosId).toBe(group.ticketId);
});

test("deleting a chief's ticket takes its schedules with it", async () => {
  const s = await setup();
  s.add({ type: "every", everyMs: 10 * MIN });
  s.h.store.db.run("DELETE FROM cos WHERE ticket_id = ?", [s.chief.ticketId]);
  expect(s.h.store.schedules.list({ all: true })).toEqual([]);
});

// ---------------------------------------------------------------------------
// Time rules
// ---------------------------------------------------------------------------

test("validateSpec refuses the past, too-tight repeats, and bad cron; cron's tightest gap counts", () => {
  const now = Date.parse("2026-10-21T08:00:00");
  expect(() => validateSpec({ type: "at", at: now - 1 }, now)).toThrow(/future/);
  expect(() => validateSpec({ type: "every", everyMs: SCHEDULE_MIN_INTERVAL_MS - 1 }, now)).toThrow(/at most every/);
  expect(() => validateSpec({ type: "every", everyMs: SCHEDULE_MIN_INTERVAL_MS }, now)).not.toThrow();
  expect(() => validateSpec({ type: "cron", cron: "* * * * *" }, now)).toThrow(/at most every/);
  expect(() => validateSpec({ type: "cron", cron: "0,2 * * * *" }, now)).toThrow(/at most every/);
  expect(() => validateSpec({ type: "cron", cron: "*/5 * * * *" }, now)).not.toThrow();
  expect(() => validateSpec({ type: "cron", cron: "0 9 * *" }, now)).toThrow(/5 fields/);
  expect(() => validateSpec({ type: "cron", cron: "99 9 * * *" }, now)).toThrow(/valid cron/);
});

test("advance keeps an interval's phase and never replays a missed time", () => {
  expect(advance({ type: "every", everyMs: 10 }, 100, 100)).toBe(110);
  expect(advance({ type: "every", everyMs: 10 }, 100, 134)).toBe(140);
  expect(advance({ type: "every", everyMs: 10 }, 100, 140)).toBe(150);
  expect(advance({ type: "at", at: 100 }, 100, 100)).toBeNull();
});

test("cron around daylight saving: a time the clocks skip fires once that day, a time they repeat fires once", () => {
  const was = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const count = (cron: string, from: Date, to: Date) => {
      let n = 0;
      for (let t = nextFire({ type: "cron", cron }, from.getTime()); t !== null && t < to.getTime(); t = nextFire({ type: "cron", cron }, t)) n++;
      return n;
    };
    // 2026-03-08: 02:00-03:00 doesn't exist. 2026-11-01: 01:00-02:00 happens twice.
    expect(count("30 2 * * *", new Date("2026-03-08T00:00:00-05:00"), new Date("2026-03-08T23:59:00-04:00"))).toBe(1);
    expect(count("30 1 * * *", new Date("2026-11-01T00:00:00-04:00"), new Date("2026-11-01T23:59:00-05:00"))).toBe(1);
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** A chief's run that calls `calls`, and what it saw. */
async function run(s: Awaited<ReturnType<typeof setup>>, cosId: string, calls: [string, unknown][]) {
  const { steps, results } = callTools(calls);
  s.h.driver.script(steps);
  await s.h.orch.sendCosMessage(cosId, { text: "go" });
  await s.h.settle();
  return results;
}

test("schedule_create, schedule_list and schedule_cancel work on the chief's own schedules", async () => {
  const s = await setup();
  const at = new Date(s.h.clock() + 3 * HOUR).toISOString();
  const [created, created2, listed] = await run(s, s.chief.ticketId, [
    ["schedule_create", { kind: "reminder", title: "Deploy SHOP-4", message: "Friday", at }],
    ["schedule_create", { kind: "wake", title: "Weekday check", cron: "0 9 * * 1-5", project_key: s.h.project.key }],
    ["schedule_list", {}],
  ]);
  expect(created!.text).toMatch(/^Scheduled reminder /);
  expect(created2!.isError).toBe(false);
  const list = JSON.parse(listed!.text) as { id: string; kind: string; project?: string }[];
  expect(list.map((x) => x.kind).sort()).toEqual(["reminder", "wake"]);
  expect(list.find((x) => x.kind === "wake")!.project).toBe(s.h.project.key);

  const [cancelled, after] = await run(s, s.chief.ticketId, [["schedule_cancel", { id: list[0]!.id }], ["schedule_list", {}]]);
  expect(cancelled!.text).toMatch(/^Cancelled/);
  expect((JSON.parse(after!.text) as unknown[]).length).toBe(1);
  expect(s.h.store.schedules.list({ all: true }).filter((x) => x.status === "cancelled")).toHaveLength(1);
});

test("a chief can't see or cancel another chief's schedules", async () => {
  const s = await setup();
  const dir = join(s.h.home, "proj", "work1");
  mkdirSync(dir, { recursive: true });
  s.h.orch.createProject({ path: dir, name: "WORK1", key: "WORK1", useWorktrees: false, group: "Work" });
  const group = s.h.orch.openCos({ group: s.h.store.groups.findByName("Work")!.id });
  const theirs = s.add({ type: "every", everyMs: 10 * MIN }, { cosId: s.chief.ticketId });

  const [listed, cancelled] = await run(s, group.ticketId, [["schedule_list", {}], ["schedule_cancel", { id: theirs.id }]]);
  expect(listed!.text).toBe("No schedules.");
  expect(cancelled).toMatchObject({ isError: true, text: expect.stringContaining("Unknown schedule") });
  expect(s.h.store.schedules.get(theirs.id)!.status).toBe("active");
  // The human sees every chief's.
  expect(s.h.orch.listSchedules().map((x) => x.id)).toEqual([theirs.id]);
});

test("schedule_create refuses what can't work and says why", async () => {
  const s = await setup();
  const past = new Date(s.h.clock() - HOUR).toISOString();
  const future = new Date(s.h.clock() + HOUR).toISOString();
  const results = await run(s, s.chief.ticketId, [
    ["schedule_create", { kind: "wake", title: "x", at: past }],
    ["schedule_create", { kind: "wake", title: "x", every_minutes: 1 }],
    ["schedule_create", { kind: "wake", title: "x", cron: "* * * * *" }],
    ["schedule_create", { kind: "wake", title: "x" }],
    ["schedule_create", { kind: "wake", title: "x", at: future, cron: "0 9 * * *" }],
    ["schedule_create", { kind: "wake", title: "x", at: "next friday" }],
    ["schedule_create", { kind: "wake", title: "x", at: future, project_key: "NOPE" }],
  ]);
  expect(results.map((r) => r.isError)).toEqual(results.map(() => true));
  expect(results[0]!.text).toMatch(/future/);
  expect(results[3]!.text).toMatch(/exactly one/);
  expect(results[6]!.text).toMatch(/Unknown project/);
  expect(s.h.store.schedules.list({ all: true })).toEqual([]);
});

test("a chief has a bounded number of active schedules, and cancelling one makes room", async () => {
  const s = await setup();
  for (let i = 0; i < SCHEDULE_MAX_ACTIVE; i++) s.add({ type: "every", everyMs: HOUR });
  const at = new Date(s.h.clock() + HOUR).toISOString();
  const [full] = await run(s, s.chief.ticketId, [["schedule_create", { kind: "wake", title: "one too many", at }]]);
  expect(full).toMatchObject({ isError: true, text: expect.stringContaining(`${SCHEDULE_MAX_ACTIVE} active`) });
  s.h.orch.cancelSchedule(s.h.store.schedules.list()[0]!.id);
  const [room] = await run(s, s.chief.ticketId, [["schedule_create", { kind: "wake", title: "fits now", at }]]);
  expect(room!.isError).toBe(false);
});

test("a group chief can only schedule for projects in its group", async () => {
  const s = await setup();
  const dir = join(s.h.home, "proj", "work1");
  mkdirSync(dir, { recursive: true });
  s.h.orch.createProject({ path: dir, name: "WORK1", key: "WORK1", useWorktrees: false, group: "Work" });
  const group = s.h.orch.openCos({ group: s.h.store.groups.findByName("Work")!.id });
  const at = new Date(s.h.clock() + HOUR).toISOString();
  const [outside, inside] = await run(s, group.ticketId, [
    ["schedule_create", { kind: "wake", title: "x", at, project_key: s.h.project.key }],
    ["schedule_create", { kind: "wake", title: "y", at, project_key: "WORK1" }],
  ]);
  expect(outside).toMatchObject({ isError: true, text: expect.stringContaining("Unknown project") });
  expect(inside!.isError).toBe(false);
});

test("the chief's context lists its active schedules, not another's", async () => {
  const s = await setup();
  const mine = s.add({ type: "every", everyMs: HOUR }, { title: "Hourly look" });
  await run(s, s.chief.ticketId, []);
  const first = s.h.driver.requests.find((r) => r.kind === "cos")!;
  expect(first.runContext).toContain("## Your schedules");
  expect(first.runContext).toContain(mine.id);
  expect(first.runContext).toContain("Hourly look");
});

