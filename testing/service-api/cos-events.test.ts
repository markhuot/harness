import { afterEach, expect, test } from "bun:test";
import type { Cos, CosBadge, CosChatPage, CosEvent, CosEventPage, Ticket } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

/**
 * A service with a chief of staff and the events of `tickets` tickets that each ran once (the
 * scripted driver replies "ok"), settled: the chief's own batch is never triaged here because the
 * quiet time is far off and no model is reachable under test.
 */
async function inbox(tickets = 2) {
  const rig = await boot();
  // Every column is checked, or no event would reach the chief at all (the default).
  await rig.ok("PATCH", "/settings", { cosStatuses: ["planning", "in_progress", "blocked", "review", "done"] });
  const project = await rig.project("ACME");
  const made: Ticket[] = [];
  for (let i = 0; i < tickets; i++) made.push(await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: `Ticket ${i}`, skipAgentReview: true, skipHumanReview: true }));
  for (const t of made) {
    for (let i = 0; i < 400; i++) {
      const now = await rig.ok<{ ticket: Ticket }>("GET", `/tickets/${t.key}`);
      if (!now.ticket.busy && now.ticket.status !== "planning") break;
      await Bun.sleep(10);
    }
  }
  const cos = await rig.ok<Cos>("POST", "/cos", { scope: "all" });
  return { rig, project, made, cos };
}

test("GET /cos/:id/events pages newest first with a cursor, filters by status, and lists unassigned events too", async () => {
  const { rig, cos } = await inbox();
  const all = await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=200`);
  expect(all.nextCursor).toBeNull();
  expect(all.items.length).toBeGreaterThan(2);
  const event = all.items.find((e) => e.status === "pending")!;
  expect(Object.keys(event).sort()).toEqual(
    ["actor", "cosId", "createdAt", "handledBy", "id", "model", "outcome", "projectKey", "reason", "sourceKind", "status", "summary", "ticketKey", "title", "triageSessionId", "verdict", "wakeId"].sort(),
  );
  expect(event).toMatchObject({ cosId: cos.ticketId, projectKey: "ACME", sourceKind: "activity", status: "pending", verdict: "pending", reason: null, model: null, handledBy: null, outcome: null });
  expect([...all.items].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)).map((e) => e.id)).toEqual(all.items.map((e) => e.id));

  const first = await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=2`);
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).toBeTruthy();
  const second = await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=2&before=${encodeURIComponent(first.nextCursor!)}`);
  expect([...first.items, ...second.items].map((e) => e.id)).toEqual(all.items.slice(0, 2 + second.items.length).map((e) => e.id));

  expect((await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?status=handled`)).items).toEqual([]);
  expect((await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?status=pending`)).items.length).toBe(all.items.filter((e) => e.status === "pending").length);
  expect(await rig.call("GET", `/cos/${cos.ticketId}/events?status=nonsense`)).toMatchObject({ status: 400 });
  expect(await rig.call("GET", `/cos/${cos.ticketId}/events?before=garbage`)).toMatchObject({ status: 400 });
  expect(await rig.call("GET", "/cos/missing/events")).toMatchObject({ status: 404 });
});

test("GET /cos/events/badge counts the events still open per chief", async () => {
  const { rig, cos } = await inbox();
  const badge = await rig.ok<CosBadge>("GET", "/cos/events/badge");
  // Routine activity (an approval, a ticket that completed) is filtered on the way in and isn't open.
  const open = (await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=200`)).items.filter((e) => e.verdict !== "filtered").length;
  expect(badge).toEqual({ total: open, byCos: { [cos.ticketId]: open } });
});

test("POST /cos/events/:id/escalate wakes the chief, announces the change on the bus, and is refused for a handled event", async () => {
  const { rig, cos } = await inbox(1);
  const [event] = (await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=1`)).items;
  expect(await rig.call("POST", "/cos/events/missing/escalate")).toMatchObject({ status: 404 });
  const out = await rig.ok<CosEvent>("POST", `/cos/events/${event!.id}/escalate`);
  expect(out).toMatchObject({ id: event!.id, verdict: "escalate" });
  const handled = await rig.busEvent((e) => e.kind === "cos.event.upserted" && e.event.id === event!.id && e.event.status === "handled");
  expect(handled).toMatchObject({ kind: "cos.event.upserted", event: { verdict: "escalate" } });
  expect(rig.busEvents.some((e) => e.kind === "cos.badge")).toBe(true);
  expect(await rig.call("POST", `/cos/events/${event!.id}/escalate`)).toMatchObject({ status: 409 });
});

test("POST /cos/:id/messages answers with the new transcript entry, which GET /cos/:id/transcript then shows", async () => {
  const { rig, cos } = await inbox(1);
  expect(await rig.call("POST", `/cos/${cos.ticketId}/messages`, { text: "  " })).toMatchObject({ status: 400 });
  expect(await rig.call("POST", "/cos/missing/messages", { text: "hi" })).toMatchObject({ status: 404 });
  const { entryId } = await rig.ok<{ entryId: string }>("POST", `/cos/${cos.ticketId}/messages`, { text: "good morning" });
  const page = await rig.ok<CosChatPage>("GET", `/cos/${cos.ticketId}/transcript`);
  expect(page.entries.find((e) => e.id === entryId)).toMatchObject({ kind: "message", role: "user", text: "good morning", cosId: cos.ticketId });
  expect(await rig.call("GET", "/cos/missing/transcript")).toMatchObject({ status: 404 });
});

test("watcher output injected over the API is a pending event for the All chief, deduped, and in its Inbox with the watcher as the actor", async () => {
  const { rig, cos } = await inbox(0);
  const first = await rig.ok<CosEvent>("POST", "/watchers/inject", { source: "github", text: "PR 12 has review feedback" });
  expect(first).toMatchObject({ sourceKind: "watcher", actor: "watcher:github", cosId: cos.ticketId, status: "pending" });
  expect(await rig.ok("POST", "/watchers/inject", { source: "github", text: "PR 12 has review feedback" })).toBeNull();
  const page = await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=200`);
  expect(page.items.find((e) => e.id === first.id)).toMatchObject({ actor: "watcher:github", title: "github: PR 12 has review feedback" });
  expect((await rig.ok<CosBadge>("GET", "/cos/events/badge")).byCos[cos.ticketId]).toBe(page.items.length);
});

test("DELETE /tickets/:key puts the deletion in the chief's Inbox with the ticket's key and title", async () => {
  const { rig, made, cos } = await inbox(1);
  const doomed = made[0]!;
  await rig.ok("DELETE", `/tickets/${doomed.key}`);
  const page = await rig.ok<CosEventPage>("GET", `/cos/${cos.ticketId}/events?limit=200`);
  const ev = page.items.find((e) => e.title.includes(`${doomed.key} deleted`));
  expect(ev).toMatchObject({ cosId: cos.ticketId, sourceKind: "activity", ticketKey: null, projectKey: "ACME", actor: "human", status: "pending" });
  expect(ev!.title).toContain(doomed.title);
});
