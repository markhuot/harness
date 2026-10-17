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

  test("the inbox has triage sessions in every state", () => {
    const states = world.sessions.filter((s) => s.kind === "triage").map((s) => s.triageStatus);
    expect(new Set(states)).toEqual(new Set(["triaging", "dispatched", "declined", "failed"]));
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
