import { describe, expect, test } from "bun:test";
import { COS_CEILING_MS, COS_HOUR_MS, COS_QUIET_MS, collapseMoves, nextWakeAllowedAt, nextWakeAt, ownerOf, cosSeesStatus, resolveCosStatuses, routineActivityReason, type CosChief } from "../../../shared/src/cos";

const chief = (ticketId: string, scope: CosChief["scope"], enabled = true): CosChief => ({ ticketId, scope, groupId: scope === "all" ? null : scope.slice(6), enabled });
const all = chief("all-1", "all");
const work = chief("work-1", "group:g-work");
const on = { cosEnabled: true };

describe("ownerOf", () => {
  test("the project's group chief owns it, and the All chief takes what no group chief covers", () => {
    expect(ownerOf({ groupId: "g-work", cosEnabled: null }, on, [all, work])).toBe("work-1");
    expect(ownerOf({ groupId: "g-home", cosEnabled: null }, on, [all, work])).toBe("all-1");
    expect(ownerOf({ groupId: null, cosEnabled: null }, on, [all, work])).toBe("all-1");
  });

  test("a switched-off group chief hands its events to the All chief; with both off nobody owns them", () => {
    const offWork = chief("work-1", "group:g-work", false);
    expect(ownerOf({ groupId: "g-work", cosEnabled: null }, on, [all, offWork])).toBe("all-1");
    expect(ownerOf({ groupId: "g-work", cosEnabled: null }, on, [chief("all-1", "all", false), offWork])).toBeNull();
  });

  test("a project that turned chiefs off has no owner, whatever the app says; one that turned them on beats an app that is off", () => {
    expect(ownerOf({ groupId: "g-work", cosEnabled: false }, on, [all, work])).toBeNull();
    expect(ownerOf({ groupId: "g-work", cosEnabled: true }, { cosEnabled: false }, [all, work])).toBe("work-1");
    expect(ownerOf({ groupId: "g-work", cosEnabled: null }, { cosEnabled: false }, [all, work])).toBeNull();
  });

  test("an event with no project goes to the All chief when the app has chiefs on", () => {
    expect(ownerOf(null, on, [all, work])).toBe("all-1");
    expect(ownerOf(null, { cosEnabled: false }, [all, work])).toBeNull();
    expect(ownerOf(null, on, [work])).toBeNull();
  });
});

describe("nextWakeAt", () => {
  test("is 45 seconds after the last event, so a quiet board triages soon after its one event", () => {
    expect(nextWakeAt([1_000])).toBe(1_000 + COS_QUIET_MS);
    expect(nextWakeAt([1_000, 20_000])).toBe(20_000 + COS_QUIET_MS);
  });

  test("never waits past five minutes from the first event, however busy it stays", () => {
    const busy = Array.from({ length: 20 }, (_, i) => 1_000 + i * 30_000); // an event every 30s
    expect(nextWakeAt(busy)).toBe(1_000 + COS_CEILING_MS);
  });

  test("has no time for an empty batch", () => {
    expect(nextWakeAt([])).toBeNull();
  });
});

describe("nextWakeAllowedAt", () => {
  const now = 10 * COS_HOUR_MS;
  test("is now while the hour holds fewer wakes than the cap", () => {
    expect(nextWakeAllowedAt([now - 1000, now - 2000], now, 3)).toBe(now);
  });

  test("waits for the oldest wake in the hour to age out once the cap is spent", () => {
    const wakes = [now - 50 * 60_000, now - 30 * 60_000, now - 10 * 60_000];
    expect(nextWakeAllowedAt(wakes, now, 3)).toBe(now - 50 * 60_000 + COS_HOUR_MS);
  });

  test("ignores wakes older than an hour", () => {
    expect(nextWakeAllowedAt([now - 2 * COS_HOUR_MS, now - 2 * COS_HOUR_MS, now - 2 * COS_HOUR_MS], now, 3)).toBe(now);
  });
});

describe("collapseMoves", () => {
  const mv = (id: string, ticketId: string, from: string, to: string, createdAt: number) => ({ id, ticketId, kind: "moved", from, to, createdAt });

  test("several moves of one ticket become the last one, carrying the net move", () => {
    const r = collapseMoves([mv("a", "T1", "planning", "in_progress", 1), mv("b", "T1", "in_progress", "review", 2), mv("c", "T1", "review", "blocked", 3)]);
    expect(r.dropped).toEqual([{ id: "a", into: "c" }, { id: "b", into: "c" }]);
    expect(r.net.get("c")).toEqual({ from: "planning", to: "blocked" });
  });

  test("moves that end where they started disappear", () => {
    const r = collapseMoves([mv("a", "T1", "review", "in_progress", 1), mv("b", "T1", "in_progress", "review", 2)]);
    expect(r.dropped).toEqual([{ id: "a", into: null }, { id: "b", into: null }]);
    expect(r.net.size).toBe(0);
  });

  test("tickets collapse separately, and other kinds of event are never touched", () => {
    const r = collapseMoves([
      mv("a", "T1", "planning", "in_progress", 1),
      mv("b", "T2", "planning", "in_progress", 2),
      { id: "n", ticketId: "T1", kind: "note", createdAt: 3 },
      mv("c", "T1", "in_progress", "review", 4),
    ]);
    expect(r.dropped).toEqual([{ id: "a", into: "c" }]);
  });

  test("a single move stays as it is", () => {
    expect(collapseMoves([mv("a", "T1", "planning", "in_progress", 1)])).toEqual({ dropped: [], net: new Map() });
  });
});

describe("routineActivityReason", () => {
  const act = (kind: string, from: string | null = null, to: string | null = null) => ({ kind, from, to });
  test("an agent review's approval is routine only while the ticket waits on a human", () => {
    expect(routineActivityReason(act("review_approved"), "review")).toContain("waits for a human");
    expect(routineActivityReason(act("review_approved"), "in_progress")).toBeNull();
  });
  test("a ticket that completed as planned is routine; one that moved to done from anywhere else is not", () => {
    expect(routineActivityReason(act("approved"), "done")).toContain("completed as planned");
    expect(routineActivityReason(act("moved", "review", "done"), "done")).toContain("completed as planned");
    expect(routineActivityReason(act("moved", "in_progress", "done"), "done")).toBeNull();
  });
  test("blocks, failures, answers, requested changes and ordinary moves are never routine", () => {
    for (const kind of ["blocked", "failed", "answered", "answer", "changes_requested", "message", "reopened", "system", "permission", "submitted"]) expect(routineActivityReason(act(kind), "review")).toBeNull();
    expect(routineActivityReason(act("moved", "in_progress", "blocked"), "blocked")).toBeNull();
  });
});

describe("cosSeesStatus", () => {
  test("nothing is checked until someone checks a column", () => {
    for (const status of ["planning", "in_progress", "blocked", "review", "done"]) expect(cosSeesStatus(null, {}, status)).toBe(false);
  });

  test("a column is seen only when it is in the set; the project's own set replaces the app's", () => {
    const app = { cosStatuses: ["review" as const, "done" as const] };
    expect(cosSeesStatus({ cosStatuses: null }, app, "review")).toBe(true);
    expect(cosSeesStatus({ cosStatuses: null }, app, "in_progress")).toBe(false);
    expect(cosSeesStatus({ cosStatuses: ["in_progress"] }, app, "in_progress")).toBe(true);
    expect(cosSeesStatus({ cosStatuses: ["in_progress"] }, app, "review")).toBe(false);
  });

  test("an empty project set is its own choice, not inherit", () => {
    expect(resolveCosStatuses({ cosStatuses: [] }, { cosStatuses: ["done"] })).toEqual([]);
    expect(resolveCosStatuses({ cosStatuses: null }, { cosStatuses: ["done"] })).toEqual(["done"]);
  });
});
