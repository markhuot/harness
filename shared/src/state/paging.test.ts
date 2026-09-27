import { describe, expect, test } from "bun:test";
import type { Session, Ticket, TicketDetail, TicketPage } from "../index";
import {
  ALL_SCOPE,
  canLoadMoreDone,
  canLoadMoreSearch,
  doneCount,
  matchesQuery,
  needsFirstDonePage,
  searchColumns,
  searchStatusText,
} from "./paging";
import {
  boardColumns,
  conductorsNeedingChildren,
  dependencyStates,
  dependentsOf,
  initialState,
  reducer,
  ticketByKey,
  unresolvedKeys,
  type Action,
  type Snapshot,
  type State,
} from "./reducer";

const tk = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id,
  key: id.toUpperCase(),
  projectId: "p1",
  kind: "task",
  title: id,
  description: "",
  status: "planning",
  sessionId: `s-${id}`,
  driver: "dummy",
  parentId: null,
  dependsOn: [],
  autoStart: false,
  agentReview: "pending",
  humanReview: "pending",
  externalRef: null,
  workdir: null,
  branch: null,
  blockedReason: null,
  permissionMode: null,
  busy: false,
  pendingApproval: null,
  allowedTools: [],
  model: null,
  position: 0,
  completedAt: null,
  createdAt: 10,
  updatedAt: 10,
  ...over,
});
/** A done ticket completed at `at` (ms). */
const done = (id: string, at: number, over: Partial<Ticket> = {}) => tk(id, { status: "done", completedAt: at, updatedAt: at, createdAt: 5, ...over });
const page = (tickets: Ticket[], nextCursor: string | null, total: number): TicketPage => ({ tickets, nextCursor, total });

function snapshot(tickets: Ticket[], donePage?: Snapshot["donePage"]): Action {
  return { type: "snapshot", snapshot: { projects: [], tickets, sessions: [], watchers: [], mappings: [], settings: null, drivers: [], donePage } };
}
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);
const upsert = (ticket: Ticket): Action => ({ type: "event", event: { kind: "ticket.upserted", ticket } });
const keys = (ts: Ticket[]) => ts.map((t) => t.key);

// 120 done tickets in p1, completed at 1000 (oldest) … 1119 (newest); pages of 50 newest-first.
const allDone = Array.from({ length: 120 }, (_, i) => done(`d${i}`, 1000 + i));
const newestFirst = [...allDone].reverse();
const p1 = page(newestFirst.slice(0, 50), "c50", 120);
const p2 = page(newestFirst.slice(50, 100), "c100", 120);
const p3 = page(newestFirst.slice(100), null, 120);
const live = tk("w1", { status: "in_progress", createdAt: 20 });
const booted = () => run(initialState, snapshot([live], { scope: "p1", page: p1 }));

describe("done paging", () => {
  test("the snapshot's first page fills Done; the header count is the server total", () => {
    const s = booted();
    const cols = boardColumns(s, "p1");
    expect(cols.done.length).toBe(50);
    expect(cols.done[0]!.key).toBe("D119");
    expect(cols.done[49]!.key).toBe("D70");
    expect(doneCount(s, "p1", cols.done.length)).toBe(120);
    expect(canLoadMoreDone(s, "p1")).toBe(true);
    expect(keys(cols.in_progress)).toEqual(["W1"]);
  });

  test("an older done ticket loaded out of band stays out of Done until paging reaches it", () => {
    let s = booted();
    const old = newestFirst[80]!; // D39: on page 2
    s = run(s, { type: "detail", detail: detail(old) });
    expect(s.tickets[old.id]).toBeDefined();
    expect(boardColumns(s, "p1").done.some((t) => t.id === old.id)).toBe(false);
    s = run(s, { type: "donePage.request", scope: "p1" }, { type: "donePage", scope: "p1", page: p2, append: true });
    const col = boardColumns(s, "p1").done;
    expect(col.length).toBe(100);
    expect(col.findIndex((t) => t.id === old.id)).toBe(80);
  });

  test("Load more appends in order without duplicates, and the last page lifts the frontier", () => {
    let s = booted();
    // Page 2 overlaps page 1 by one ticket (a tie at the boundary): still 99 unique.
    const overlapping = page([newestFirst[49]!, ...p2.tickets.slice(0, 49)], "c99", 120);
    s = run(s, { type: "donePage.request", scope: "p1" });
    expect(s.donePaging.p1!.loading).toBe(true);
    expect(canLoadMoreDone(s, "p1")).toBe(false); // no double-fire while in flight
    s = run(s, { type: "donePage", scope: "p1", page: overlapping, append: true });
    let col = boardColumns(s, "p1").done;
    expect(col.length).toBe(99);
    expect(new Set(keys(col)).size).toBe(99);
    s = run(s, { type: "donePage", scope: "p1", page: p3, append: true });
    col = boardColumns(s, "p1").done;
    expect(col.length).toBe(119); // D20 (newestFirst[99]) was never paged — but the frontier is gone, all loaded show
    expect(s.donePaging.p1!.frontier).toBeNull();
    expect(canLoadMoreDone(s, "p1")).toBe(false);
  });

  test("a live completion goes to the top of Done and counts; reopening moves it out and uncounts", () => {
    let s = booted();
    s = run(s, upsert({ ...live, status: "done", completedAt: 5000, updatedAt: 5000 }));
    let col = boardColumns(s, "p1");
    expect(col.done[0]!.key).toBe("W1");
    expect(col.in_progress).toEqual([]);
    expect(s.donePaging.p1!.total).toBe(121);
    s = run(s, upsert({ ...s.tickets.w1!, status: "review", completedAt: null, updatedAt: 5001 }));
    col = boardColumns(s, "p1");
    expect(col.done.some((t) => t.key === "W1")).toBe(false);
    expect(keys(col.review)).toEqual(["W1"]);
    expect(s.donePaging.p1!.total).toBe(120);
  });

  test("unloaded tickets: an old done one edited isn't recounted; a new completion or a reopen is", () => {
    let s = booted();
    // D10 (completed at 1010, not loaded) gets a title edit: already counted.
    s = run(s, upsert({ ...allDone[10]!, title: "renamed", updatedAt: 9000 }));
    expect(s.donePaging.p1!.total).toBe(120);
    // Completed after the count was taken (newer than the first page's newest): +1.
    s = run(s, upsert(done("x1", 2000, { createdAt: 1 })));
    expect(s.donePaging.p1!.total).toBe(121);
    // An unloaded done ticket reopened (it existed at snapshot time): -1.
    s = run(s, upsert({ ...allDone[3]!, status: "in_progress", completedAt: null, updatedAt: 9001 }));
    expect(s.donePaging.p1!.total).toBe(120);
    // A brand-new ticket (created after the snapshot) isn't a reopen.
    s = run(s, upsert(tk("n1", { createdAt: 99_999 })));
    expect(s.donePaging.p1!.total).toBe(120);
  });

  test("deleting a loaded done ticket uncounts it in every scope it belongs to, and only those", () => {
    let s = booted();
    s = run(s, { type: "donePage.request", scope: ALL_SCOPE }, { type: "donePage", scope: ALL_SCOPE, page: page([...p1.tickets, done("o1", 3000, { projectId: "p2" })], "x", 200), append: false });
    s = run(s, { type: "donePage", scope: "p2", page: page([], null, 7), append: false });
    s = run(s, { type: "event", event: { kind: "ticket.deleted", id: "d119" } });
    expect([s.donePaging.p1!.total, s.donePaging[ALL_SCOPE]!.total, s.donePaging.p2!.total]).toEqual([119, 199, 7]);
  });

  test("scopes page independently; a scope without paging needs its first page", () => {
    const s = booted();
    expect(needsFirstDonePage(s, "p1")).toBe(false);
    expect(needsFirstDonePage(s, null)).toBe(true);
    expect(needsFirstDonePage(s, "p2")).toBe(true);
    expect(needsFirstDonePage(initialState, "p1")).toBe(false); // not before the snapshot
  });

  test("a reconnect snapshot resets paging; a Load more page from before it is dropped", () => {
    let s = booted();
    s = run(s, { type: "donePage", scope: "p2", page: page([], null, 3), append: false });
    s = run(s, snapshot([live], { scope: "p1", page: p1 }));
    expect(Object.keys(s.donePaging)).toEqual(["p1"]);
    s = run(s, { type: "donePage", scope: "p2", page: page([done("late", 1)], null, 3), append: true });
    expect(s.donePaging.p2).toBeUndefined();
    expect(s.tickets.late).toBeUndefined();
  });

  test("a page's ticket doesn't clobber a newer live version of it", () => {
    let s = booted();
    s = run(s, upsert({ ...allDone[30]!, title: "live edit", updatedAt: 99_000 }));
    s = run(s, { type: "donePage", scope: "p1", page: p2, append: true });
    expect(s.tickets[allDone[30]!.id]!.title).toBe("live edit");
  });

  test("a project's full ticket list (project settings) loads every done ticket but doesn't flood Done", () => {
    let s = booted();
    s = run(s, { type: "tickets", tickets: allDone });
    expect(Object.values(s.tickets).filter((t) => t.status === "done").length).toBe(120);
    expect(boardColumns(s, "p1").done.length).toBe(50);
  });

  test("without paging state (an older service) Done shows every loaded done ticket", () => {
    const s = run(initialState, snapshot([live, ...allDone.slice(0, 3)]));
    expect(keys(boardColumns(s, "p1").done)).toEqual(["D2", "D1", "D0"]);
    expect(doneCount(s, "p1", 3)).toBe(3);
  });
});

describe("search", () => {
  const child = tk("c1", { title: "Child about widgets", parentId: "cond", status: "in_progress", createdAt: 20 });
  const base = () => run(initialState, snapshot([live, child, tk("w2", { title: "Widgets", status: "review", createdAt: 20 })], { scope: "p1", page: p1 }));

  test("typing shows local matches at once; the server's results replace them", () => {
    let s = run(base(), { type: "search.set", q: " widget ", scope: "p1" });
    const local = searchColumns(s, "p1");
    expect(local.pending).toBe(true);
    expect(keys(local.columns.review)).toEqual(["W2"]);
    expect(keys(local.columns.in_progress)).toEqual(["C1"]); // children included
    expect(searchStatusText(s.search!)).toBe("Searching…");
    // The server also matches a done ticket that isn't loaded (description hit) — and not C1.
    const hit = done("far", 10, { title: "Old", description: "widget cache" });
    s = run(s, { type: "search.results", q: "widget", scope: "p1", page: page([hit, s.tickets.w2!], "n", 3), append: false });
    const server = searchColumns(s, "p1");
    expect(server.pending).toBe(false);
    expect(keys(server.columns.done)).toEqual(["FAR"]);
    expect(server.columns.in_progress).toEqual([]);
    expect(searchStatusText(s.search!)).toBe("Showing 2 of 3 matches");
    expect(canLoadMoreSearch(s.search)).toBe(true);
  });

  test("stale responses (an older query or scope) are ignored", () => {
    let s = run(base(), { type: "search.set", q: "wid", scope: "p1" }, { type: "search.set", q: "widgets", scope: "p1" });
    s = run(s, { type: "search.results", q: "wid", scope: "p1", page: page([s.tickets.w1!], null, 1), append: false });
    expect(s.search!.ids).toBeNull();
    s = run(s, { type: "search.results", q: "widgets", scope: ALL_SCOPE, page: page([s.tickets.w1!], null, 1), append: false });
    expect(s.search!.ids).toBeNull();
    s = run(s, { type: "search.results", q: "widgets", scope: "p1", page: page([s.tickets.w2!], null, 1), append: false });
    expect(s.search!.ids).toEqual(["w2"]);
  });

  test("more results append without duplicates; the last page stops paging", () => {
    let s = run(base(), { type: "search.set", q: "d", scope: "p1" });
    s = run(s, { type: "search.results", q: "d", scope: "p1", page: page(allDone.slice(0, 2), "n", 3), append: false });
    s = run(s, { type: "search.request", q: "d", scope: "p1" });
    expect(canLoadMoreSearch(s.search)).toBe(false);
    s = run(s, { type: "search.results", q: "d", scope: "p1", page: page(allDone.slice(1, 3), null, 3), append: true });
    expect(s.search!.ids).toEqual(["d0", "d1", "d2"]);
    expect(canLoadMoreSearch(s.search)).toBe(false);
    expect(searchStatusText(s.search!)).toBe("3 matches");
  });

  test("results follow live moves; a deleted result drops out", () => {
    let s = run(base(), { type: "search.set", q: "widgets", scope: "p1" });
    s = run(s, { type: "search.results", q: "widgets", scope: "p1", page: page([s.tickets.w2!], null, 1), append: false });
    s = run(s, upsert({ ...s.tickets.w2!, status: "done", completedAt: 7000, updatedAt: 7000 }));
    expect(keys(searchColumns(s, "p1").columns.done)).toEqual(["W2"]);
    s = run(s, { type: "event", event: { kind: "ticket.deleted", id: "w2" } });
    expect(Object.values(searchColumns(s, "p1").columns).flat()).toEqual([]);
  });

  test("clearing the query ends the search; a reconnect re-arms it for a re-run", () => {
    let s = run(base(), { type: "search.set", q: "widgets", scope: "p1" });
    s = run(s, { type: "search.results", q: "widgets", scope: "p1", page: page([s.tickets.w2!], null, 1), append: false });
    const rearmed = run(s, snapshot([live], { scope: "p1", page: p1 }));
    expect(rearmed.search).toMatchObject({ q: "widgets", ids: null, loading: true });
    expect(run(s, { type: "search.set", q: "  ", scope: "p1" }).search).toBeNull();
    expect(searchStatusText({ ...s.search!, total: 0, ids: [] })).toBe("No matches");
  });

  test("local matching covers old keys the store knows about", () => {
    const t = tk("r1", { key: "NEW-4", title: "x" });
    expect(matchesQuery(t, "old-4", { "OLD-4": "r1" })).toBe(true);
    expect(matchesQuery(t, "old-4")).toBe(false);
  });
});

function detail(ticket: Ticket, over: Partial<TicketDetail> = {}): TicketDetail {
  const session = { id: ticket.sessionId } as Session;
  return { ticket, session, summaries: [], runs: [], dependents: [], children: [], ...over };
}

describe("tickets that aren't loaded", () => {
  test("an unloaded dependency is unknown (not pending) until resolved; a 404 marks it missing", () => {
    let s = run(initialState, snapshot([tk("a", { dependsOn: ["D5", "GONE-1", "A"] })], { scope: "p1", page: page([], null, 0) }));
    s = { ...s, tickets: { ...s.tickets, a: { ...s.tickets.a!, dependsOn: ["D5", "GONE-1"] } } };
    expect(dependencyStates(s, s.tickets.a!).map((d) => d.state)).toEqual(["unknown", "unknown"]);
    expect(unresolvedKeys(s).sort()).toEqual(["D5", "GONE-1"]);
    s = run(s, { type: "detail", detail: detail(allDone[5]!), requestedKey: "D5" }, { type: "missingKeys", keys: ["gone-1"] });
    expect(dependencyStates(s, s.tickets.a!).map((d) => [d.state, !!d.missing])).toEqual([["done", false], ["unknown", true]]);
    expect(unresolvedKeys(s)).toEqual([]);
  });

  test("an old key resolves through the detail's resolvedFrom (redirect, deps, lookups)", () => {
    let s = run(initialState, snapshot([tk("a", { dependsOn: ["OLD-7"] })], { scope: "p1", page: page([], null, 0) }));
    expect(unresolvedKeys(s)).toEqual(["OLD-7"]);
    const renamed = done("r", 50, { key: "NEW-7" });
    s = run(s, { type: "detail", detail: detail(renamed, { resolvedFrom: "OLD-7" }), requestedKey: "old-7" });
    expect(ticketByKey(s, "old-7")?.key).toBe("NEW-7");
    expect(dependencyStates(s, s.tickets.a!)[0]).toMatchObject({ state: "done", ticket: { key: "NEW-7" } });
    expect(unresolvedKeys(s)).toEqual([]);
  });

  test("triage outcomes name tickets to resolve", () => {
    const triage = { id: "t1", kind: "triage", outcome: "Dispatched to NYTIMES as FOO-9 (started)." } as Session;
    const s = run(initialState, snapshot([], { scope: "p1", page: page([], null, 0) }));
    expect(unresolvedKeys({ ...s, sessions: { t1: triage } })).toEqual(["FOO-9"]);
  });

  test("a conductor's detail loads every child (done ones included) and the rollup counts them", () => {
    const cond = tk("cond", { kind: "conductor", status: "in_progress" });
    const kids = [tk("k1", { parentId: "cond", status: "in_progress" }), done("k2", 20, { parentId: "cond" }), done("k3", 30, { parentId: "cond" })];
    let s = run(initialState, snapshot([cond, kids[0]!], { scope: "p1", page: page([], null, 0) }));
    expect(conductorsNeedingChildren(s).map((t) => t.id)).toEqual(["cond"]);
    s = run(s, { type: "detail", detail: detail(cond, { children: kids }) });
    expect(conductorsNeedingChildren(s)).toEqual([]);
    const children = Object.values(s.tickets).filter((t) => t.parentId === "cond");
    expect(children.length).toBe(3);
    // Loaded children older than the (empty) Done page don't flood the board's Done column.
    expect(boardColumns(s, "p1").done.length).toBe(2); // nextCursor null → everything loaded shows
  });

  test("dependents merge the detail's list (unloaded done ones) with live dependents", () => {
    const t = tk("base", { key: "B-1", status: "in_progress" });
    const liveDep = tk("l", { key: "L-1", dependsOn: ["B-1"] });
    let s = run(initialState, snapshot([t, liveDep], { scope: "p1", page: page([], null, 0) }));
    s = run(s, { type: "detail", detail: detail(t, { dependents: ["OLD-DONE-3", "L-1"] }) });
    expect(dependentsOf(s, t).map((d) => [d.key, !!d.ticket])).toEqual([["L-1", true], ["OLD-DONE-3", false]]);
    expect(unresolvedKeys(s)).toEqual(["OLD-DONE-3"]);
    // A dependent that drops the dependency live leaves the list even though the detail named it.
    s = run(s, upsert({ ...liveDep, dependsOn: [], updatedAt: 50 }));
    expect(dependentsOf(s, t).map((d) => d.key)).toEqual(["OLD-DONE-3"]);
  });
});

describe("parent conductor from the detail", () => {
  test("a child's detail brings its unloaded (done, off-page) conductor into the store for the breadcrumb", () => {
    const conductor = done("cond", 5, { kind: "conductor", title: "Old conductor" });
    const child = tk("kid", { parentId: "cond", status: "in_progress" });
    let s = run(initialState, snapshot([child], { scope: "p1", page: page([], null, 1) }));
    expect(s.tickets.cond).toBeUndefined();
    s = run(s, { type: "detail", detail: detail(child, { parent: conductor }) });
    expect(s.tickets.cond?.title).toBe("Old conductor");
  });
});
