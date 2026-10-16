import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_NOTIFICATION_SETTINGS, type Watcher } from "@harness/shared";
import { EventBus } from "../../service/src/events";
import { NotificationService } from "../../service/src/notifications/dispatcher";
import { PresenceRegistry } from "../../service/src/notifications/presence";
import { WatcherRunner } from "../../service/src/orchestrator/watchers";
import { fakeClock } from "../builders/clock";
import { startHarness } from "../builders/harness";
import { addProject, addTicket, makeStore } from "../builders/store";
import { tempDir } from "../builders/tmp";

const HOUR = 3_600_000;

describe("store", () => {
  test("every row is stamped by the injected clock, and moves when it does", () => {
    const clock = fakeClock(5_000);
    const store = makeStore({ now: clock });
    const project = addProject(store);
    const ticket = addTicket(store, project);
    expect([project.createdAt, ticket.createdAt, ticket.updatedAt]).toEqual([5_000, 5_000, 5_000]);

    clock.advance(777);
    store.tickets.update(ticket.id, { status: "in_progress" });
    expect(store.tickets.get(ticket.id)!.updatedAt).toBe(5_777);
    expect(store.tickets.get(ticket.id)!.createdAt).toBe(5_000);
  });

  test("two stores in one process keep their own time", () => {
    const early = makeStore({ now: fakeClock(1) });
    const late = makeStore({ now: fakeClock(9) });
    expect([addProject(early).createdAt, addProject(late).createdAt]).toEqual([1, 9]);
  });

  test("the default clock is the real one", () => {
    const before = Date.now();
    const project = addProject(makeStore());
    expect(project.createdAt).toBeGreaterThanOrEqual(before);
    expect(project.createdAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("orchestrator", () => {
  test("an unused upload is swept once the injected clock says it is a day old", async () => {
    const clock = fakeClock(Date.now());
    const h = await startHarness({ now: clock });
    try {
      const upload = h.orchestrator.uploadAttachment(new TextEncoder().encode("hello"), "note.txt", "text/plain");
      expect(h.orchestrator.sweepUploads()).toEqual([]);
      expect(existsSync(upload.path)).toBe(true);

      clock.advance(25 * HOUR);
      expect(h.orchestrator.sweepUploads()).toHaveLength(1);
      expect(existsSync(upload.path)).toBe(false);
      expect(h.store.attachments.get(upload.id)).toBeNull();
    } finally {
      await h.stop();
    }
  });
});

describe("notifications", () => {
  test("a push result is stamped with the injected clock", async () => {
    const clock = fakeClock(42_000);
    const store = makeStore({ now: clock });
    const keyDir = tempDir();
    writeFileSync(join(keyDir, "AuthKey_ABC123DEFG_APN_Sandbox.p8"), "unused by the fake");
    const svc = new NotificationService({
      store,
      bus: new EventBus(),
      presence: new PresenceRegistry(),
      settings: () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, apnsKeyDir: keyDir, apnsTeamId: "TEAM" }),
      apns: { send: async () => ({ ok: true, status: 200, reason: null }), close() {} },
      now: clock,
    });
    svc.registerDevice({ id: "d1", platform: "ios", name: "Phone", apnsToken: "a".repeat(64), environment: "sandbox" });
    clock.advance(1_234);
    await svc.sendTest();
    expect(svc.status().keys.find((k) => k.environment === "sandbox")!.lastResult!.at).toBe(43_234);
  });
});

describe("watchers", () => {
  test("a watcher's state change is stamped with the injected clock", () => {
    const clock = fakeClock(10_000);
    const runner = new WatcherRunner({ onOutput() {}, onStatus() {}, now: clock });
    runner.sync([{ id: "w1", enabled: false } as Watcher]);
    expect(runner.live("w1")!.since).toBe(10_000);
    clock.advance(500);
    runner.sync([{ id: "w1", enabled: false } as Watcher, { id: "w2", enabled: false } as Watcher]);
    expect(runner.live("w1")!.since).toBe(10_000);
    expect(runner.live("w2")!.since).toBe(10_500);
  });
});
