import { expect, test } from "bun:test";
import { ScopedStore } from "../../../service/src/store/scope";
import { addProject, addTicket, makeStore } from "../../builders/store";

/** Group Work (WK, two tickets), group Home (HM, one ticket), and ST, in no group. */
function board() {
  const store = makeStore();
  const work = store.groups.findOrCreate("Work");
  const home = store.groups.findOrCreate("Home");
  const wk = addProject(store, { key: "WK", groupId: work.id });
  const hm = addProject(store, { key: "HM", groupId: home.id, path: "/hm" });
  const st = addProject(store, { key: "ST", path: "/st" });
  const w1 = addTicket(store, wk, { title: "walrus one" });
  const w2 = addTicket(store, wk, { title: "walrus two", status: "in_progress" });
  const h1 = addTicket(store, hm, { title: "walrus home" });
  const s1 = addTicket(store, st, { title: "walrus loose" });
  return { store, work, home, wk, hm, st, w1, w2, h1, s1, scoped: (group: string | "all") => new ScopedStore(store, group === "all" ? "all" : { group }) };
}

test("under a group scope, lookups, lists, pages and searches count only that group's tickets", () => {
  const { work, scoped, w1, w2, h1, s1 } = board();
  const sc = scoped(work.id);
  expect(sc.tickets.get(w1.id)?.key).toBe(w1.key);
  expect(sc.tickets.get(h1.id)).toBeNull();
  expect(sc.tickets.getByKey(s1.key)).toBeNull();
  expect(sc.tickets.lookup(h1.key)).toBeNull();
  expect(sc.tickets.list().map((t) => t.key).sort()).toEqual([w1.key, w2.key]);
  // The total is the group's, not the board's, and a project outside it has no page at all.
  expect(sc.tickets.page({ status: "planning" })).toMatchObject({ total: 1, tickets: [expect.objectContaining({ key: w1.key })] });
  expect(sc.tickets.page({ status: "planning", projectId: h1.projectId })).toEqual({ tickets: [], nextCursor: null, total: 0 });
  expect(sc.tickets.search({ q: "walrus" }).total).toBe(2);
  expect(sc.tickets.search({ q: "walrus", projectId: s1.projectId }).total).toBe(0);
  expect(scoped("all").tickets.search({ q: "walrus" }).total).toBe(4);
});

test("a scope's project, group and watcher lists hold only what it covers", () => {
  const { store, work, scoped } = board();
  store.watchers.create({ name: "w", command: "echo", args: [], prompt: "", cwd: null, env: {}, mode: "interval", intervalSec: 60, enabled: false, driver: null });
  expect(scoped(work.id).projects.list().map((p) => p.key)).toEqual(["WK"]);
  expect(scoped(work.id).projects.getByKey("HM")).toBeNull();
  expect(scoped(work.id).groups.list().map((g) => g.id)).toEqual([work.id]);
  expect(scoped(work.id).watchers.list()).toEqual([]);
  expect(scoped("all").projects.list()).toHaveLength(3);
  expect(scoped("all").groups.list()).toHaveLength(2);
  expect(scoped("all").watchers.list()).toHaveLength(1);
});

test("edges to tickets outside the scope are dropped from a ticket, its dependents and its lookups", () => {
  const { store, work, scoped, w1, w2, h1 } = board();
  const dependent = store.tickets.create({ key: "WK-9", projectId: w1.projectId, kind: "task" as const, title: "d", spec: "", status: "planning" as const, sessionId: w1.sessionId, driver: "claude-code", parentId: h1.id, dependsOn: [h1.key, w2.key], autoStart: false, externalRef: null, workdir: null });
  const sc = scoped(work.id);
  expect(sc.tickets.get(dependent.id)).toMatchObject({ parentId: null, dependsOn: [w2.key] });
  expect(scoped("all").tickets.get(dependent.id)).toMatchObject({ parentId: h1.id, dependsOn: [h1.key, w2.key] });
  expect(sc.tickets.dependents(w2.key).map((t) => t.key)).toEqual([dependent.key]);
  expect(sc.tickets.dependents(h1.key)).toEqual([]);
  expect(scoped(work.id).tickets.list({ parentId: h1.id })).toHaveLength(1);
});

test("a chief of staff's own ticket and the hidden project are in no scope, not even all", () => {
  const { store, scoped, work } = board();
  const hidden = store.projects.internal("/home");
  const ticket = addTicket(store, hidden);
  store.db.query("UPDATE tickets SET kind = 'cos' WHERE id = $id").run({ id: ticket.id });
  for (const sc of [scoped("all"), scoped(work.id)]) {
    expect(sc.tickets.get(ticket.id)).toBeNull();
    expect(sc.tickets.getByKey(ticket.key)).toBeNull();
    expect(sc.projects.get(hidden.id)).toBeNull();
    expect(sc.projects.getByKey(hidden.key)).toBeNull();
  }
  expect(store.projects.internal("/elsewhere").id).toBe(hidden.id);
});

test("the chiefs of staff table holds one row per scope", () => {
  const { store, wk, work } = board();
  const hidden = store.projects.internal("/home");
  const a = addTicket(store, hidden);
  const b = addTicket(store, hidden);
  expect(store.cos.insert(a.id, "all")).toMatchObject({ scope: "all", groupId: null, enabled: true });
  expect(() => store.cos.insert(b.id, "all")).toThrow();
  expect(store.cos.insert(b.id, { group: work.id })).toMatchObject({ scope: `group:${work.id}`, groupId: work.id });
  expect(store.cos.getByScope({ group: work.id })?.ticketId).toBe(b.id);
  expect(store.cos.getByScope({ group: "other" })).toBeNull();
  expect(store.cos.setEnabled("missing", false)).toBeNull();
  expect(store.cos.setEnabled(a.id, false)?.enabled).toBe(false);
  // Deleting the ticket takes its row with it.
  store.tickets.delete(a.id);
  expect(store.cos.list().map((c) => c.ticketId)).toEqual([b.id]);
  expect(wk.groupId).toBe(work.id);
});
