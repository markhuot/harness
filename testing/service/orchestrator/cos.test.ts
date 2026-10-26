import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCosSetting, resolveCosStatuses, type Cos, type CosScope } from "@harness/shared";
import type { CosTriage } from "../../../service/src/cos/triage";
import { FakeDriver } from "../fake-driver";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

/**
 * Three projects: ACME (in no group), WORK1 (group Work) and HOME1 (group Home), a ticket in each,
 * and a runner that sends a message to a chief of staff whose scripted run calls `calls`.
 */
async function board(opts: { cosTriage?: CosTriage } = {}) {
  const h = makeOrchestrator<FakeDriver>({ tools: undefined, ...opts });
  const project = (key: string, group?: string) => {
    const dir = join(h.home, "proj", key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    return h.orch.createProject({ path: dir, name: key, key, useWorktrees: false, ...(group ? { group } : {}) });
  };
  const work = project("WORK1", "Work");
  const home = project("HOME1", "Home");
  const ticket = async (projectId: string, spec: string, extra: Record<string, unknown> = {}) => {
    const t = await h.orch.createTicket({ projectId, spec, start: false, ...extra });
    await h.settle();
    return t;
  };
  const a = await ticket(h.project.id, "Acme ticket about narwhals");
  const w = await ticket(work.id, "Work ticket about walruses");
  const o = await ticket(home.id, "Home ticket about otters");
  const groupOf = (name: string) => h.store.groups.findByName(name)!.id;
  /** The scripted chief of staff of `scope` calls `calls`; the results it saw. */
  async function asCos(scope: CosScope, calls: [string, unknown][]) {
    const cos = h.orch.openCos(scope);
    const { steps, results } = callTools(calls);
    h.driver.script(steps);
    await h.orch.sendMessage(cos.key, "go");
    await h.settle();
    return results;
  }
  return { h, work, home, a, w, o, groupOf, asCos, ticket, project };
}
const json = (text: string) => JSON.parse(text.slice(text.search(/[[{]/)));

test("a group's chief of staff sees its group's tickets and projects only; All sees everything", async () => {
  const { groupOf, asCos, a, w, o } = await board();
  const scoped = await asCos({ group: groupOf("Work") }, [["list_tickets", {}], ["list_projects", {}], ["search_tickets", { query: "otters" }], ["search_tickets", { query: "walruses" }]]);
  expect((json(scoped[0]!.text) as { key: string }[]).map((t) => t.key)).toEqual([w.key]);
  expect((json(scoped[1]!.text) as { key: string }[]).map((p) => p.key)).toEqual(["WORK1"]);
  expect(scoped[2]!.text).toBe('No tickets match "otters".');
  expect((json(scoped[3]!.text) as { hits: { key: string }[] }).hits.map((t) => t.key)).toEqual([w.key]);

  const all = await asCos("all", [["list_tickets", {}], ["list_projects", {}]]);
  expect((json(all[0]!.text) as { key: string }[]).map((t) => t.key).sort()).toEqual([a.key, w.key, o.key].sort());
  expect((json(all[1]!.text) as { key: string }[]).map((p) => p.key).sort()).toEqual(["ACME", "HOME1", "WORK1"]);
});

test("a ticket outside a group's scope reads as not found, in the words a missing ticket gets, for every route that takes a key", async () => {
  const { h, groupOf, asCos, o, w } = await board();
  const out = o.key;
  const missing = "ZZZ-99";
  const calls: [string, Record<string, unknown>][] = [
    ["get_ticket", { key: "$K" }],
    ["update_ticket", { key: "$K", title: "hijacked" }],
    ["move_ticket", { key: "$K", status: "done" }],
    ["start_ticket", { key: "$K" }],
    ["message_ticket", { key: "$K", text: "hello" }],
    ["cancel_ticket", { key: "$K" }],
    ["reopen_ticket", { key: "$K", notes: "again" }],
  ];
  const run = (key: string) => asCos({ group: groupOf("Work") }, calls.map(([n, i]) => [n, JSON.parse(JSON.stringify(i).replace("$K", key))]));
  const forOut = await run(out);
  const forMissing = await run(missing);
  forOut.forEach((r, i) => {
    expect(r.isError, calls[i]![0]).toBe(true);
    // Same message once the key is swapped: nothing tells the agent the ticket exists.
    expect(r.text.replaceAll(out, "K"), calls[i]![0]).toBe(forMissing[i]!.text.replaceAll(missing, "K"));
  });
  expect(h.ticket(out).title).not.toBe("hijacked");
  expect(h.ticket(out).status).toBe("planning");
  // In scope, the same calls work.
  const own = await asCos({ group: groupOf("Work") }, [["get_ticket", { key: w.key }], ["update_ticket", { key: w.key, title: "Renamed" }]]);
  expect(own.map((r) => r.isError)).toEqual([false, false]);
  expect(h.ticket(w.key).title).toBe("Renamed");
  // And All reaches the other group's ticket.
  const all = await asCos("all", [["update_ticket", { key: out, title: "By all" }]]);
  expect(all[0]!.isError).toBe(false);
  expect(h.ticket(out).title).toBe("By all");
});

test("parent, child and dependency edges that leave the scope are dropped from what the group's chief reads", async () => {
  const { h, groupOf, asCos, w, o, work, ticket } = await board();
  // A ticket in Work that depends on a Home ticket and is a child of another Home ticket, and a Work ticket with children in both groups.
  const edges = await ticket(work.id, "Edges", { dependsOn: [o.key], parentId: o.id });
  const sameGroup = await ticket(work.id, "Same group", { dependsOn: [w.key] });
  const parent = await ticket(work.id, "Parent of two");
  await ticket(work.id, "Work child", { parentId: parent.id });
  await ticket(h.store.projects.getByKey("HOME1")!.id, "Home child", { parentId: parent.id });
  const read = (keys: string[]) => keys.map((key) => ["get_ticket", { key }] as [string, unknown]);
  const scoped = await asCos({ group: groupOf("Work") }, read([edges.key, sameGroup.key, parent.key]));
  const [e, s, p] = scoped.map((r) => json(r.text) as { dependsOn: string[]; parent: string | null; children: string[] });
  expect(e!.dependsOn).toEqual([]);
  expect(e!.parent).toBeNull();
  expect(s!.dependsOn).toEqual([w.key]);
  expect(p!.children).toHaveLength(1);
  const all = await asCos("all", read([edges.key, parent.key]));
  const [e2, p2] = all.map((r) => json(r.text) as { dependsOn: string[]; parent: string | null; children: string[] });
  expect(e2!.dependsOn).toEqual([o.key]);
  expect(e2!.parent).toBe(o.key);
  expect(p2!.children).toHaveLength(2);
});

test("create_ticket by a group's chief needs a project of its own, in scope, and dependencies in scope", async () => {
  const { h, groupOf, asCos, o, w } = await board();
  const r = await asCos({ group: groupOf("Work") }, [
    ["create_ticket", { title: "No project", spec: "x" }],
    ["create_ticket", { title: "Wrong group", spec: "x", project_key: "HOME1" }],
    ["create_ticket", { title: "Ungrouped", spec: "x", project_key: "ACME" }],
    ["create_ticket", { title: "Bad dependency", spec: "x", project_key: "WORK1", depends_on: [o.key] }],
    ["update_ticket", { key: w.key, depends_on: [o.key] }],
    ["create_ticket", { title: "Fine", spec: "x", project_key: "WORK1", depends_on: [w.key] }],
  ]);
  expect(r.map((x) => x.isError)).toEqual([true, true, true, true, true, false]);
  expect(r[0]!.text).toMatch(/project_key is required/);
  expect(r[1]!.text).toMatch(/Unknown project: HOME1/);
  expect(r[3]!.text).toMatch(/Unknown dependency/);
  const created = h.store.tickets.list({ projectId: h.store.projects.getByKey("WORK1")!.id }).find((t) => t.title === "Fine")!;
  expect(created.dependsOn).toEqual([w.key]);
  // The ticket's own Activity says who made it.
  expect(h.store.activity.listBySession(created.sessionId).map((e) => e.body)).toContain(`Chief of staff (${h.orch.listCos()[0]!.key}) created it`);
});

test("watchers belong to no project: only the All chief sees them", async () => {
  const { h, groupOf, asCos } = await board();
  h.orch.createWatcher({ name: "pager", command: "echo hi", mode: "interval", intervalSec: 60, enabled: false });
  const scoped = await asCos({ group: groupOf("Work") }, [["list_watchers", {}]]);
  expect(scoped.map((r) => r.text)).toEqual(["No watchers are configured."]);
  const all = await asCos("all", [["list_watchers", {}]]);
  expect(all[0]!.text).toContain("pager");
});

test("the scope is read from the chief's row on every call, so moving a project between groups takes effect at once", async () => {
  const { h, groupOf, asCos, w, work } = await board();
  const scope = { group: groupOf("Work") };
  expect((await asCos(scope, [["get_ticket", { key: w.key }]]))[0]!.isError).toBe(false);
  // Move WORK1 into Home: Work now has no projects, so its group (and chief) is gone; keep it alive with another project first.
  const keep = h.orch.createProject({ path: h.project.path, name: "Keep", key: "KEEP", useWorktrees: false, group: "Work" });
  h.orch.updateProject(work.id, { group: "Home" });
  expect(h.store.groups.get(scope.group)).not.toBeNull();
  expect((await asCos(scope, [["get_ticket", { key: w.key }]]))[0]!.isError).toBe(true);
  expect(keep.groupId).toBe(scope.group);
});

test("with Blocked unchecked a chief refuses to touch a blocked ticket but still reports it; on, it answers", async () => {
  const { h, asCos, a, groupOf } = await board();
  h.store.tickets.update(a.id, { status: "blocked", blockedReason: "Which database?" });
  const calls: [string, unknown][] = [["get_ticket", { key: a.key }], ["message_ticket", { key: a.key, text: "Postgres" }], ["move_ticket", { key: a.key, status: "planning" }]];
  const off = await asCos("all", calls);
  expect(off[0]!.isError).toBe(false);
  expect(json(off[0]!.text)).toMatchObject({ key: a.key, status: "blocked", blockedReason: "Which database?" });
  for (const r of off.slice(1)) {
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Blocked");
    expect(r.text).toContain("Which database?");
  }
  expect(h.ticket(a.key).status).toBe("blocked");

  // The app turns it on; the project overrides it off; the project override wins either way.
  h.orch.updateSettings({ cosStatuses: ["blocked"] });
  expect((await asCos("all", [calls[1]!]))[0]!.isError).toBe(false);
  h.store.tickets.update(a.id, { status: "blocked", blockedReason: "Again?" });
  h.orch.updateProject(h.project.id, { cosStatuses: ["review"] });
  expect((await asCos("all", [calls[1]!]))[0]!.text).toContain("Blocked");
  h.orch.updateProject(h.project.id, { cosStatuses: null });
  expect((await asCos("all", [calls[1]!]))[0]!.isError).toBe(false);
  // A ticket that isn't blocked is unaffected by Blocked being unchecked.
  h.orch.updateSettings({ cosStatuses: [] });
  const planning = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  await h.settle();
  expect((await asCos({ group: groupOf("Work") }, [])).length).toBe(0);
  expect((await asCos("all", [["update_ticket", { key: planning.key, title: "Fine" }]]))[0]!.isError).toBe(false);
});

test("an unblock by a chief shows in the ticket's Activity as the chief, and only where its project allows it", async () => {
  const { h, asCos, a, w, groupOf } = await board();
  const key = () => h.orch.listCos()[0]!.key;
  const block = (t: { id: string }, why: string) => h.store.tickets.update(t.id, { status: "blocked", blockedReason: why });
  const bodies = (t: { key: string }) => h.store.activity.listBySession(h.ticket(t.key).sessionId).map((e) => e.body);
  // ACME turns it on for itself, the app default stays off: WORK1's blocked ticket is not touched.
  h.orch.updateProject(h.project.id, { cosStatuses: ["blocked"] });
  block(a, "Which database?");
  block(w, "Which cache?");
  const r = await asCos("all", [["message_ticket", { key: a.key, text: "Postgres" }], ["message_ticket", { key: w.key, text: "Redis" }], ["move_ticket", { key: w.key, status: "planning" }]]);
  expect(r.map((x) => x.isError)).toEqual([false, true, true]);
  expect(h.ticket(w.key).status).toBe("blocked");
  expect(bodies(w).some((b) => b.startsWith("Chief of staff"))).toBe(false);
  expect(bodies(a)).toContain(`Chief of staff (${key()}) sent it a message`);
  // Moving it out of blocked is attributed too.
  block(a, "Again?");
  await asCos("all", [["move_ticket", { key: a.key, status: "planning" }]]);
  expect(h.ticket(a.key).status).toBe("planning");
  expect(bodies(a)).toContain(`Chief of staff (${key()}) moved it to planning`);
  // A group's chief can't reach another group's blocked ticket even where the app allows unblocking.
  h.orch.updateSettings({ cosStatuses: ["blocked"] });
  block(w, "Which queue?");
  const scoped = await asCos({ group: groupOf("Home") }, [["message_ticket", { key: w.key, text: "SQS" }]]);
  expect(scoped[0]!.isError).toBe(true);
  expect(h.ticket(w.key).status).toBe("blocked");
});

test("a chief's changes to a ticket are on that ticket's Activity under its name", async () => {
  const { h, asCos, a } = await board();
  await asCos("all", [["update_ticket", { key: a.key, title: "Renamed" }], ["message_ticket", { key: a.key, text: "ping" }]]);
  const key = h.orch.listCos()[0]!.key;
  const bodies = h.store.activity.listBySession(h.ticket(a.key).sessionId).map((e) => e.body);
  expect(bodies).toContain(`Chief of staff (${key}) edited title`);
  expect(bodies).toContain(`Chief of staff (${key}) sent it a message`);
});

test("a project inherits the app's CoS settings, overrides them, and goes back to inheriting with null", async () => {
  const { h } = await board();
  const read = () => {
    const p = h.orch.listProjects().find((x) => x.key === "ACME")!;
    return { enabled: resolveCosSetting(p, h.orch.settings(), "cosEnabled"), statuses: resolveCosStatuses(p, h.orch.settings()), own: [p.cosEnabled, p.cosStatuses] };
  };
  expect(read()).toEqual({ enabled: true, statuses: [], own: [null, null] });
  h.orch.updateSettings({ cosEnabled: false, cosStatuses: ["done", "blocked"] });
  expect(read()).toEqual({ enabled: false, statuses: ["blocked", "done"], own: [null, null] });
  h.orch.updateProject(h.project.id, { cosEnabled: true, cosStatuses: [] });
  expect(read()).toEqual({ enabled: true, statuses: [], own: [true, []] });
  // Another field's PATCH leaves the overrides alone; null resets one.
  h.orch.updateProject(h.project.id, { name: "Renamed" });
  expect(read().own).toEqual([true, []]);
  h.orch.updateProject(h.project.id, { cosEnabled: null });
  expect(read()).toEqual({ enabled: false, statuses: [], own: [null, []] });
  h.orch.updateProject(h.project.id, { cosStatuses: null });
  expect(read()).toEqual({ enabled: false, statuses: ["blocked", "done"], own: [null, null] });
  expect(() => h.orch.updateProject(h.project.id, { cosEnabled: "yes" as unknown as boolean })).toThrow(/cosEnabled must be true, false or null/);
  expect(() => h.orch.updateSettings({ cosStatuses: ["blocked", "nope"] as unknown as never })).toThrow(/cosStatuses must be a list of columns/);
  expect(() => h.orch.updateSettings({ cosStatuses: "blocked" as unknown as never })).toThrow(/cosStatuses must be a list of columns/);
  expect(() => h.orch.updateProject(h.project.id, { cosStatuses: ["nope"] as unknown as never })).toThrow(/cosStatuses must be a list of columns/);
});

test("a chief of staff is made when first asked for, once per scope, outside every project list", async () => {
  const { h, groupOf, a } = await board();
  expect(h.orch.listCos()).toEqual([]);
  const first = h.orch.openCos("all");
  expect(h.orch.openCos("all")).toEqual(first);
  const work = h.orch.openCos({ group: groupOf("Work") });
  expect(work.ticketId).not.toBe(first.ticketId);
  expect(h.orch.openCos({ group: groupOf("Work") })).toEqual(work);
  expect(h.orch.listCos().map((c: Cos) => c.scope)).toEqual(["all", `group:${groupOf("Work")}`]);
  expect(() => h.orch.openCos({ group: "no-such-group" })).toThrow(/Unknown group/);
  const ticket = h.store.tickets.get(first.ticketId)!;
  expect(ticket).toMatchObject({ kind: "cos", status: "in_progress", title: "Chief of staff" });
  expect(h.store.tickets.get(work.ticketId)!.title).toBe("Chief of staff: Work");
  // Hidden: no project list, project key lookup, ticket list, page or search has it.
  expect(h.orch.listProjects().map((p) => p.key)).not.toContain("COS");
  expect(h.store.projects.getByKey("COS")).toBeNull();
  expect(h.store.tickets.list().map((t) => t.kind)).not.toContain("cos");
  expect(h.store.tickets.page({ status: "in_progress" }).tickets).toEqual([]);
  expect(h.store.tickets.search({ q: "chief" }).tickets).toEqual([]);
  expect(h.store.tickets.get(a.id)).not.toBeNull();
  // It can't be deleted as a ticket, and its project can't be deleted either.
  await expect(h.orch.deleteTicket(ticket.key)).rejects.toThrow(/chief of staff/);
  await expect(h.orch.deleteProject(ticket.projectId)).rejects.toThrow(/Unknown project/);
  // A project asked for the key COS later still works.
  const dir = join(h.home, "proj", "cos");
  mkdirSync(dir, { recursive: true });
  // The hidden project's key is taken, listed or not: asking for it is refused, not silently COS2.
  expect(() => h.orch.createProject({ path: dir, key: "COS", useWorktrees: false })).toThrow(/already used/);
  const other = h.orch.createProject({ path: dir, key: "OTHER", useWorktrees: false });
  expect(() => h.orch.updateProject(other.id, { key: "COS" })).toThrow(/already used/);
  // The hidden project can't be edited or get tickets.
  expect(() => h.orch.updateProject(ticket.projectId, { path: dir })).toThrow(/Unknown project/);
  await expect(h.orch.createTicket({ projectId: ticket.projectId, spec: "sneaky", start: false })).rejects.toThrow(/Unknown project/);
});

test("the on/off switch is the chief's own, persists, and a chief that's off takes no new messages", async () => {
  const { h } = await board();
  const cos = h.orch.openCos("all");
  expect(cos.enabled).toBe(true);
  expect(h.orch.setCosEnabled(cos.ticketId, false).enabled).toBe(false);
  expect(h.store.cos.get(cos.ticketId)!.enabled).toBe(false);
  expect(h.orch.listCos()[0]!.enabled).toBe(false);
  await expect(h.orch.sendMessage(cos.key, "wake up")).rejects.toThrow(/switched off/);
  expect(h.store.runs.listBySession(h.ticket(cos.key).sessionId)).toEqual([]);
  expect(h.orch.setCosEnabled(cos.ticketId, true).enabled).toBe(true);
  await h.orch.sendMessage(cos.key, "wake up");
  await h.settle();
  expect(h.store.runs.listBySession(h.ticket(cos.key).sessionId).map((r) => r.kind)).toEqual(["cos"]);
  expect(() => h.orch.setCosEnabled(cos.ticketId, "yes")).toThrow(/enabled must be true or false/);
  expect(() => h.orch.setCosEnabled("nope", true)).toThrow(/Unknown chief of staff/);
});

test("a group's chief goes with the group when its last project leaves", async () => {
  const { h, groupOf, work, w } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  const sessionId = h.ticket(cos.key).sessionId;
  const events: string[] = [];
  h.bus.on((e: { kind: string }) => events.push(e.kind));
  h.orch.updateProject(work.id, { group: null });
  await h.orch.pruneCos();
  expect(events).toEqual(expect.arrayContaining(["ticket.deleted", "session.deleted"]));
  expect(h.store.groups.findByName("Work")).toBeNull();
  expect(h.orch.listCos()).toEqual([]);
  expect(h.store.tickets.get(cos.ticketId)).toBeNull();
  expect(h.store.sessions.get(sessionId)).toBeNull();
  expect(h.store.tickets.get(w.id)).not.toBeNull();
});

test("a project that joins the group while its chief is being torn down keeps the chief", async () => {
  const { h, groupOf, work, home } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  const orch = h.orch as unknown as { browser: { close: (id: string) => Promise<void> } };
  const close = orch.browser.close.bind(orch.browser);
  orch.browser.close = async (id) => {
    await close(id);
    h.orch.updateProject(home.id, { group: "Work" }); // lands during removeTicket's awaits
  };
  h.orch.updateProject(work.id, { group: null });
  await h.orch.pruneCos();
  expect(h.store.tickets.get(cos.ticketId)).not.toBeNull();
  expect(h.orch.listCos().map((c) => c.ticketId)).toEqual([cos.ticketId]);
  expect(h.store.groups.findByName("Work")).not.toBeNull();
});

test("a chief of staff cannot be opened for a group with no projects, so none is orphaned at birth", async () => {
  const { h, groupOf, work } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  const group = groupOf("Work");
  h.orch.updateProject(work.id, { group: null }); // the chief still holds the emptied group
  expect(() => h.orch.openCos({ group })).toThrow(/no projects/); // not even the doomed chief is handed out
  await h.orch.pruneCos();
  expect(h.orch.listCos()).toEqual([]);
  expect(h.store.tickets.get(cos.ticketId)).toBeNull();
  expect(() => h.orch.openCos({ group })).toThrow(/Unknown group/);
  expect(h.orch.listCos()).toEqual([]);
});

test("starting the service tears down a chief whose group emptied while it was down", async () => {
  const { h, groupOf, work } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  h.store.db.query("UPDATE projects SET group_id = NULL, group_name = NULL WHERE id = $id").run({ id: work.id });
  expect(h.store.projects.orphanedCosTickets()).toEqual([cos.ticketId]);
  h.orch.start();
  await h.orch.pruneCos();
  expect(h.orch.listCos()).toEqual([]);
  expect(h.store.tickets.get(cos.ticketId)).toBeNull();
});

test("every operation that takes a key answers an out-of-scope key like a missing one, and a new operation has to be classified", async () => {
  const { h, groupOf, o } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  const ticket = h.ticket(cos.key);
  const ctx = { runId: "r", runKind: "cos", session: h.store.sessions.get(ticket.sessionId)!, ticket, cwd: h.home, ops: h.orch.ops, browser: undefined as never, signal: new AbortController().signal } as Parameters<typeof h.orch.ops.getTicket>[0];
  const ops = h.orch.ops;
  const keyed: Record<string, (key: string) => Promise<unknown>> = {
    getTicket: (k) => ops.getTicket(ctx, k),
    getTicketAgent: (k) => ops.getTicketAgent(ctx, k, "agent-1"),
    updateTicket: (k) => ops.updateTicket(ctx, k, { title: "x" }),
    moveTicket: (k) => ops.moveTicket(ctx, k, "done"),
    startTicket: (k) => ops.startTicket(ctx, k),
    messageTicket: (k) => ops.messageTicket(ctx, k, "x"),
    cancelTicket: (k) => ops.cancelTicket(ctx, k),
    reopenTicket: (k) => ops.reopenTicket(ctx, k, "x"),
    reviewTicket: (k) => ops.reviewTicket(ctx, k, "approve", "x"),
    completeTicket: (k) => ops.completeTicket(ctx, k),
    deleteTicket: (k) => ops.deleteTicket(ctx, k),
    updateWatcher: (k) => ops.updateWatcher(ctx, k, { enabled: false }),
    deleteWatcher: (k) => ops.deleteWatcher(ctx, k),
    runWatcher: (k) => ops.runWatcher(ctx, k),
    updateProject: (k) => ops.updateProject(ctx, k, { name: "x" }),
    deleteProject: (k) => ops.deleteProject(ctx, k),
  };
  // Operations that take no reference to something with a scope of its own (or make something new, the subscriptions act on the caller's own ticket).
  const unkeyed = [
    "postNote", "updateNotes", "wroteNotes", "statusLine", "readSpec", "editSpec", "updateSpec", "block", "unblock", "resumeWork", "returnToPlanning", "submitForReview", "updateBranch", "reviewDecision", "subscribeTicket", "unsubscribeTicket", "listSubscriptions",
    "listTickets", "searchTickets", "listProjects", "listInbox", "createTicket", "recordPullRequest", "requestApproval", "checkPermission", "fileOutputScope",
    "listWatchers", "getSettings", "listPrompts", "listDrivers", "createWatcher", "createProject", "updateSettings", "scheduleCreate", "scheduleList", "scheduleCancel", "queryActivity", "readMemory", "updateMemorySection", "recordEventOutcomes", "recordTriageVerdict", "listTerminals", "readTerminal", "writeTerminal", "arrangePanes",
  ];
  expect(Object.keys(ops).sort()).toEqual([...Object.keys(keyed), ...unkeyed].sort());
  const message = async (fn: () => Promise<unknown>, key: string) => {
    try {
      await fn();
    } catch (err) {
      return (err as Error).message.replaceAll(key, "KEY");
    }
    return "(did not throw)";
  };
  for (const [name, call] of Object.entries(keyed)) {
    const forOut = await message(() => call(o.key), o.key);
    const forMissing = await message(() => call("ZZZ-99"), "ZZZ-99");
    expect(forOut, name).not.toBe("(did not throw)");
    expect(forOut, name).toBe(forMissing);
  }
  expect(h.ticket(o.key).title).toBe("Home ticket about otters");
});

test("a chief of staff's ticket is scoped and tooled by its kind, whatever kind of run it is in", async () => {
  const { h, groupOf, a } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  const ticket = h.ticket(cos.key);
  const ctx = (runKind: string) => ({ runId: "r", runKind, session: null, ticket, cwd: h.home, ops: {}, signal: new AbortController().signal }) as never;
  // Even a chat run (a human's message to a blocked chief would start one) sees only the group.
  for (const kind of ["chat", "work", "cos"]) {
    const sc = (h.orch as unknown as { scopeOf(c: unknown): { scope: unknown; tickets: { getByKey(k: string): unknown } } }).scopeOf(ctx(kind));
    expect(sc.scope).toEqual({ group: groupOf("Work") });
    expect(sc.tickets.getByKey(a.key)).toBeNull();
  }
  // A message to it is a chief of staff run, and a tool approval never moves it off in progress.
  await h.orch.sendMessage(cos.key, "hi");
  await h.settle();
  expect(h.store.runs.listBySession(ticket.sessionId).map((r) => r.kind)).toEqual(["cos"]);
  // Board lifecycle and PATCH routes refuse it.
  await expect(h.orch.updateTicket(cos.key, { status: "done" })).rejects.toThrow(/chief of staff/);
  await expect(h.orch.submitTicket(cos.key, { start: true })).rejects.toThrow(/chief of staff/);
  await expect(h.orch.startTicket(cos.key)).rejects.toThrow(/chief of staff/);
  await expect(h.orch.reopenTicket(cos.key, { notes: "x" })).rejects.toThrow(/chief of staff/);
  await expect(h.orch.completeTicket(cos.key)).rejects.toThrow(/chief of staff/);
  expect(h.ticket(cos.key).status).toBe("in_progress");
});

test("a chief's sessions stay off the session list, its attachments and app-wide settings are refused", async () => {
  const { h, groupOf } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  expect(h.orch.listSessions().map((s) => s.ticketId)).not.toContain(cos.ticketId);
  expect(h.orch.listSessions("ticket").length).toBeGreaterThan(0);
  const results = await (async () => {
    const { steps, results } = callTools([["create_ticket", { project_key: "WORK1", title: "t", spec: "s", attachments: ["/etc/hosts"] }], ["get_settings", {}]]);
    h.driver.script(steps);
    await h.orch.sendMessage(cos.key, "go");
    await h.settle();
    return results;
  })();
  expect(results[0]!.text).toMatch(/can't attach files/);
  expect(results[1]!.text).toMatch(/only the All chief of staff/);
});

// ---------------------------------------------------------------------------
// Which model a chief runs on: the project of a wake about one project, else the app's
// ---------------------------------------------------------------------------

/** A chief whose app default runs on `fake` and whose project WORK1 chose `alt`; wake it like the engine does. */
async function modelRig() {
  const alt = new FakeDriver({ id: "alt" });
  const fake = new FakeDriver();
  const h = makeOrchestrator({ tools: undefined, driver: fake, drivers: [fake, alt] });
  const dir = join(h.home, "proj", "work1");
  mkdirSync(dir, { recursive: true });
  const work = h.orch.createProject({ path: dir, name: "WORK1", key: "WORK1", useWorktrees: false });
  h.store.projects.update(work.id, { cosModel: { driver: "alt", model: "alt-model" } });
  const cos = h.orch.openCos("all");
  const wake = async (projectKey: string | null) => {
    await (h.orch as unknown as { wakeCos(id: string, text: string, key: string | null): Promise<string | null> }).wakeCos(cos.ticketId, "wake", projectKey);
    await h.settle();
  };
  return { h, alt, cos, wake };
}

test("a wake about one project runs on that project's chief model", async () => {
  const { h, alt, wake } = await modelRig();
  await wake("WORK1");
  expect(h.driver.requests).toHaveLength(0);
  expect(alt.requests.map((r) => r.model)).toEqual(["alt-model"]);
});

test("a wake that spans projects (no project) runs on the app's model", async () => {
  const { h, alt, wake } = await modelRig();
  await wake(null);
  expect(alt.requests).toHaveLength(0);
  expect(h.driver.requests).toHaveLength(1);
});

test("a chat message to the chief runs on the app's model even after a wake about a project", async () => {
  const { h, alt, cos, wake } = await modelRig();
  await wake("WORK1");
  await h.orch.sendMessage(cos.key, "how is it going?");
  await h.settle();
  expect(alt.requests).toHaveLength(1);
  expect(h.driver.requests).toHaveLength(1);
});

test("switching the chief's driver starts a fresh conversation instead of resuming the other driver's", async () => {
  const { h, alt, cos, wake } = await modelRig();
  await wake(null); // fake writes a session
  expect(h.driver.requests[0]!.state).toBeNull();
  await wake("WORK1"); // alt must not be handed fake's session
  expect(alt.requests[0]!.state).toBeNull();
  await h.orch.sendMessage(cos.key, "back on the app's model"); // fake can't resume alt's either
  await h.settle();
  expect(h.driver.requests[1]!.state).toBeNull();
});

/** The wakes a chief got for a followed ticket: they carry the reason it subscribed with. */
const subWakes = (h: { driver: FakeDriver }) => h.driver.requests.filter((r) => r.prompt.includes("Your reason for following"));
const REASON = "waiting for it to reach review";
const escalateAll: CosTriage = {
  backend: "fake",
  model: "m",
  triage: async (i) => ({ verdicts: i.events.map((e) => ({ id: e.id, verdict: "escalate", reason: "r", brief: "b", project: null })), model: "m", tokensIn: 0, tokensOut: 0 }),
};
/** Let the batch window pass and triage what is waiting. */
const triaged = async (h: { clock: { advance(ms: number): void }; orch: { cosEngine: { tick(): Promise<void> } }; settle(): Promise<void> }) => {
  h.clock.advance(6 * 60_000);
  await h.orch.cosEngine.tick();
  await h.settle();
};

test("a chief subscribed to a ticket is woken once per change through triage, and the activity feed doesn't wake it a second time", async () => {
  const { h, a } = await board({ cosTriage: escalateAll });
  h.orch.updateSettings({ cosStatuses: ["review"] }); // the chief handles review, so the feed would wake it too
  const cos = h.orch.openCos("all");
  const { steps, results } = callTools([["subscribe_ticket", { key: a.key, mode: "forever", reason: REASON }]]);
  h.driver.script(steps);
  await h.orch.sendMessage(cos.key, "follow it");
  await h.settle();
  expect(results[0]).toMatchObject({ isError: false });
  // Running service: the bus nudges the chief's feed the moment an entry is written, before the subscription's row exists
  h.orch.start();
  await h.orch.updateTicket(a.key, { status: "review" });
  await h.settle();
  await triaged(h);
  const wakes = subWakes(h);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.prompt).toContain(a.key);
  expect(wakes[0]!.prompt).toContain(REASON);
  expect(wakes[0]!.prompt).not.toContain("Updates from tickets you subscribed to");
  // The move's activity entry is an ignored row, not a second wake; the row that woke the chief is in its Events too
  const events = h.orch.eventsPage(cos.key, {}).items;
  const feed = events.filter((e) => e.sourceKind === "activity");
  expect(feed.length).toBeGreaterThan(0);
  expect(feed.every((e) => e.status === "ignored" && /subscription/.test(e.reason ?? ""))).toBe(true);
  expect(events.filter((e) => e.sourceKind === "subscription")).toHaveLength(1);
  await h.orch.stop();
});

test("a note on a followed ticket wakes a subscribed chief once, in the running service", async () => {
  const { h, a } = await board({ cosTriage: escalateAll });
  h.orch.updateSettings({ cosStatuses: ["planning"] });
  const cos = h.orch.openCos("all");
  h.driver.script(callTools([["subscribe_ticket", { key: a.key, mode: "once", events: ["note"], reason: REASON }]]).steps);
  await h.orch.sendMessage(cos.key, "follow it");
  await h.settle();
  h.orch.start();
  (h.orch as unknown as { addActivityLine(t: unknown, k: string, a: string, b: string): unknown }).addActivityLine(h.store.tickets.get(a.id), "note", "agent", "halfway there");
  await h.settle();
  await triaged(h);
  expect(subWakes(h)).toHaveLength(1);
  expect(h.orch.eventsPage(cos.key, {}).items.filter((e) => e.sourceKind === "activity" && e.status !== "ignored")).toHaveLength(0);
  await h.orch.stop();
});

test("a switched-off chief isn't woken by a subscription, and the change doesn't wake it once it is switched on", async () => {
  const { h, a } = await board({ cosTriage: escalateAll });
  const cos = h.orch.openCos("all");
  h.driver.script(callTools([["subscribe_ticket", { key: a.key, mode: "forever", reason: REASON }]]).steps);
  await h.orch.sendMessage(cos.key, "follow it");
  await h.settle();
  h.orch.setCosEnabled(cos.ticketId, false);
  await h.orch.updateTicket(a.key, { status: "review" });
  await h.settle();
  // The change is kept as an ignored row the human can read, and the subscription stays
  const rows = h.orch.eventsPage(cos.key, {}).items.filter((e) => e.sourceKind === "subscription");
  expect(rows.map((e) => [e.status, e.reason])).toEqual([["ignored", "the chief of staff is switched off"]]);
  expect(h.store.subscriptions.listBySubscriber(cos.ticketId)).toHaveLength(1);
  h.orch.setCosEnabled(cos.ticketId, true);
  await h.settle();
  await triaged(h);
  expect(subWakes(h)).toHaveLength(0);
});

test("a chief of staff has to give a reason when it subscribes", async () => {
  const { h, a } = await board();
  const cos = h.orch.openCos("all");
  const { steps, results } = callTools([
    ["subscribe_ticket", { key: a.key }],
    ["subscribe_ticket", { key: a.key, reason: "   " }],
    ["subscribe_ticket", { key: a.key, reason: "only tell me if it ends up blocked" }],
  ]);
  h.driver.script(steps);
  await h.orch.sendMessage(cos.key, "follow it");
  await h.settle();
  expect(results.map((r) => r.isError)).toEqual([true, true, false]);
  expect(results[0]!.text).toMatch(/reason is required/);
  expect(h.store.subscriptions.get(cos.ticketId, a.id)?.reason).toBe("only tell me if it ends up blocked");
});

test("a scoped chief can't subscribe outside its scope, and a ticket that leaves its scope stops waking it", async () => {
  const { h, groupOf, o, w, work, project } = await board();
  const cos = h.orch.openCos({ group: groupOf("Work") });
  const { steps, results } = callTools([
    ["subscribe_ticket", { key: o.key, reason: REASON }],
    ["subscribe_ticket", { key: w.key, mode: "forever", reason: REASON }],
  ]);
  h.driver.script(steps);
  await h.orch.sendMessage(cos.key, "follow");
  await h.settle();
  expect(results.map((r) => r.isError)).toEqual([true, false]);
  expect(h.store.subscriptions.listBySubscriber(cos.ticketId).map((s) => s.targetId)).toEqual([w.id]);
  // Another project keeps the Work group alive while WORK1 moves out of it
  project("SPARE", "Work");
  h.orch.updateProject(work.id, { group: "Home" });
  await h.orch.updateTicket(w.key, { status: "blocked" });
  await h.settle();
  expect(subWakes(h)).toHaveLength(0);
  expect(h.store.subscriptions.listBySubscriber(cos.ticketId)).toHaveLength(0);
});
