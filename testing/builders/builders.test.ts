import { describe, expect, test } from "bun:test";
import { TICKET_STATUSES } from "@harness/shared";
import { makeTicket } from "./ticket";
import { addProject, addTicket, makeStore } from "./store";

describe("makeTicket", () => {
  test("a status is all it takes, and the same call builds the same ticket", () => {
    expect(makeTicket({ status: "review" })).toEqual(makeTicket({ status: "review" }));
    expect(makeTicket({ status: "review" }).status).toBe("review");
  });

  test("ids follow the key, so two keys never collide", () => {
    const a = makeTicket({ status: "done", key: "A-1" });
    const b = makeTicket({ status: "done", key: "A-2" });
    expect(a.id).not.toBe(b.id);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("overrides win", () => {
    const t = makeTicket({ status: "blocked", dependsOn: ["X-1"], id: "custom" });
    expect([t.id, t.dependsOn]).toEqual(["custom", ["X-1"]]);
  });
});

describe("store builders", () => {
  test("a ticket is written in the status asked for", () => {
    const store = makeStore();
    const project = addProject(store);
    for (const status of TICKET_STATUSES) expect(store.tickets.get(addTicket(store, project, { status }).id)!.status).toBe(status);
  });

  test("two stores never share rows", () => {
    const a = makeStore();
    const b = makeStore();
    addProject(a);
    expect(b.projects.list()).toEqual([]);
  });
});
