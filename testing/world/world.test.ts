import { describe, expect, test } from "bun:test";
import { TICKET_STATUSES } from "@harness/shared";
import { isFresh, render } from "./generate";
import { world } from "./index";

const unique = (xs: string[]) => new Set(xs).size === xs.length;

describe("world invariants (a bad edit fails here, not as a blank screen)", () => {
  test("ids and keys are unique", () => {
    expect(unique(world.projects.map((p) => p.id))).toBe(true);
    expect(unique(world.tickets.map((t) => t.key))).toBe(true);
    expect(unique(world.tickets.map((t) => t.id))).toBe(true);
    expect(unique(world.sessions.map((s) => s.id))).toBe(true);
    expect(unique(world.transcript.map((e) => e.id))).toBe(true);
  });

  test("every ticket belongs to a project and owns a session", () => {
    const projectIds = new Set(world.projects.map((p) => p.id));
    for (const t of world.tickets) {
      expect(projectIds.has(t.projectId)).toBe(true);
      expect(world.sessions.find((s) => s.id === t.sessionId)?.ticketId).toBe(t.id);
    }
  });

  test("every label a ticket carries is in the collection, with the count of its tickets in any status", () => {
    const names = new Set(world.labels.map((l) => l.name));
    for (const t of world.tickets) for (const n of t.labels ?? []) expect(names.has(n)).toBe(true);
    expect(world.labels.find((l) => l.name === "Bugfix")?.count).toBe(3);
    expect(world.labels.find((l) => l.name === "Docs")?.count).toBe(1);
    expect(world.labels.find((l) => l.name === "Archive")?.count).toBe(0);
    expect(world.labels.map((l) => l.lastUsedAt)).toEqual([...world.labels.map((l) => l.lastUsedAt)].sort((a, b) => b - a));
  });

  test("every status is present", () => {
    expect(new Set(world.tickets.map((t) => t.status))).toEqual(new Set(TICKET_STATUSES));
  });

  test("parents, dependencies and child counts agree", () => {
    const keys = new Set(world.tickets.map((t) => t.key));
    for (const t of world.tickets) {
      for (const d of t.dependsOn) expect(keys.has(d)).toBe(true);
      expect(t.childCount).toBe(world.tickets.filter((c) => c.parentId === t.id).length);
      if (t.parentId) expect(world.tickets.some((p) => p.id === t.parentId)).toBe(true);
    }
  });

  test("runs, transcript and activity point at real sessions and tickets", () => {
    const sessionIds = new Set(world.sessions.map((s) => s.id));
    const ticketIds = new Set(world.tickets.map((t) => t.id));
    for (const r of world.runs) expect(sessionIds.has(r.sessionId)).toBe(true);
    for (const e of world.transcript) expect(sessionIds.has(e.sessionId)).toBe(true);
    for (const a of world.activity) expect(ticketIds.has(a.ticketId ?? "")).toBe(true);
  });

  test("nothing is dated after the world's now", () => {
    for (const t of world.tickets) expect(t.updatedAt).toBeLessThanOrEqual(world.now);
    for (const e of world.transcript) expect(e.createdAt).toBeLessThanOrEqual(world.now);
    for (const a of world.activity) expect(a.createdAt).toBeLessThanOrEqual(world.now);
  });

  test("the chiefs of staff cover every Inbox state, an empty chief and a project with its chief off", () => {
    expect(new Set(world.ticketEvents.map((e) => e.status))).toEqual(new Set(["pending", "handling", "ignored", "escalated", "handled"]));
    expect(world.chiefs.filter((c) => !world.ticketEvents.some((e) => e.targetId === c.ticketId))).toHaveLength(1);
    expect(world.projects.some((p) => p.cosEnabled === false)).toBe(true);
    expect(world.cosBadge.byCos["cos-all"]).toBe(3);
  });
});

describe("world.json", () => {
  test("the committed copy matches the TypeScript world", () => {
    expect(isFresh(), "run `bun testing/world/generate.ts`").toBe(true);
  });

  test("rendering is deterministic", () => {
    expect(render()).toBe(render());
  });
});
