import { afterEach, expect, test } from "bun:test";
import type { Ticket, TicketEventPage } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

/** A service with two tickets that never run, so only the events the test inserts exist. */
async function twoTickets() {
  const rig = await boot();
  const project = await rig.project("ACME");
  const a = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "A" });
  const b = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "B" });
  const add = (target: Ticket, ref: string, patch: { sourceKind?: "child" | "subscription"; filtered?: string; createdAt?: number } = {}) =>
    rig.harness.store.ticketEvents.insert({ cosId: null, targetId: target.id, projectId: project.id, ticketId: b.id, sourceKind: patch.sourceKind ?? "child", sourceRef: ref, actor: "agent", title: ref, ready: true, ...patch })!;
  const hasEvents = async (t: Ticket) => (await rig.ok<{ ticket: Ticket }>("GET", `/tickets/${t.key}`)).ticket.hasEvents;
  return { rig, project, a, b, add, hasEvents };
}

test("GET /tickets/:key/events pages the events aimed at that ticket only, newest first, by key or id, with a status filter", async () => {
  const { rig, a, b, add } = await twoTickets();
  const rows = [1, 2, 3].map((n) => add(a, `a-${n}`, { createdAt: n * 1000, sourceKind: n === 2 ? "subscription" : "child" }));
  add(b, "b-1");

  const all = await rig.ok<TicketEventPage>("GET", `/tickets/${a.key}/events`);
  expect(all.items.map((e) => e.id)).toEqual([rows[2]!.id, rows[1]!.id, rows[0]!.id]);
  expect(all.items.map((e) => e.sourceKind)).toEqual(["child", "subscription", "child"]);
  expect(all.items.every((e) => e.targetId === a.id)).toBe(true);
  expect((await rig.ok<TicketEventPage>("GET", `/tickets/${a.id}/events`)).items).toHaveLength(3);

  const first = await rig.ok<TicketEventPage>("GET", `/tickets/${a.key}/events?limit=2`);
  expect(first.items).toHaveLength(2);
  const second = await rig.ok<TicketEventPage>("GET", `/tickets/${a.key}/events?limit=2&before=${encodeURIComponent(first.nextCursor!)}`);
  expect([...first.items, ...second.items].map((e) => e.id)).toEqual(all.items.map((e) => e.id));
  expect(second.nextCursor).toBeNull();

  rig.harness.store.ticketEvents.update(rows[0]!.id, { status: "handled" });
  expect((await rig.ok<TicketEventPage>("GET", `/tickets/${a.key}/events?status=handled`)).items.map((e) => e.id)).toEqual([rows[0]!.id]);
  expect(await rig.call("GET", `/tickets/${a.key}/events?status=nonsense`)).toMatchObject({ status: 400 });
  expect(await rig.call("GET", "/tickets/NOPE-1/events")).toMatchObject({ status: 404 });
});

test("hasEvents is false until an event is aimed at the ticket, flips once on the first, and is pushed to clients when it does", async () => {
  const { rig, a, b, add, hasEvents } = await twoTickets();
  expect(await hasEvents(a)).toBe(false);
  const pushes = () => rig.busEvents.filter((e) => e.kind === "ticket.upserted" && e.ticket.id === a.id && e.ticket.hasEvents).length;

  add(a, "a-1");
  expect(await hasEvents(a)).toBe(true);
  expect(await hasEvents(b)).toBe(false);
  expect(pushes()).toBe(1);
  // A second event doesn't change the flag, so it doesn't push the ticket again.
  add(a, "a-2");
  expect(pushes()).toBe(1);
});

test("an event a coded rule dropped doesn't give the ticket an Events tab", async () => {
  const { a, add, hasEvents } = await twoTickets();
  add(a, "a-filtered", { filtered: "its own move" });
  expect(await hasEvents(a)).toBe(false);
});

test("pruning the last event takes the flag away and pushes the ticket; pruning one of several leaves it", async () => {
  const { rig, a, add, hasEvents } = await twoTickets();
  const settled = add(a, "settled");
  const waiting = add(a, "waiting");
  rig.harness.store.ticketEvents.update(settled.id, { status: "handled" });
  const before = rig.busEvents.length;
  const pushedOff = () => rig.busEvents.slice(before).filter((e) => e.kind === "ticket.upserted" && e.ticket.id === a.id && !e.ticket.hasEvents).length;
  const future = Date.now() + 60_000;

  // Only the settled row goes; the one still waiting keeps the tab.
  rig.harness.store.ticketEvents.prune(future);
  expect(rig.harness.store.ticketEvents.list({ targetId: a.id, limit: 10 }).map((e) => e.id)).toEqual([waiting.id]);
  expect(await hasEvents(a)).toBe(true);
  expect(pushedOff()).toBe(0);

  rig.harness.store.ticketEvents.update(waiting.id, { status: "handled" });
  rig.harness.store.ticketEvents.prune(future);
  expect(rig.harness.store.ticketEvents.list({ targetId: a.id, limit: 10 })).toEqual([]);
  expect(await hasEvents(a)).toBe(false);
  expect(pushedOff()).toBe(1);
});
