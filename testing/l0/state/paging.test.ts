import { describe, expect, test } from "bun:test";
import type { Project, Ticket, TicketPage } from "../../../shared/src/protocol";
import {
  ALL_SCOPE,
  adjustDoneTotals,
  canLoadMoreDone,
  canLoadMoreSearch,
  completedAtOf,
  doneColumn,
  doneCount,
  currentGroupScope,
  groupScope,
  inScope,
  matchesQuery,
  mergeTickets,
  needsFirstDonePage,
  pagingFromPage,
  reducePaging,
  scopeGroup,
  scopeOf,
  scopeProject,
  scopeQuery,
  searchColumns,
  searchStatusText,
  type DonePaging,
  type SearchState,
} from "../../../shared/src/state/paging";
import { initialState, type State } from "../../../shared/src/state/reducer";
import { makeTicket } from "../../builders/ticket";

const done = (id: string, completedAt: number, extra: Partial<Ticket> = {}): Ticket =>
  makeTicket({ status: "done", key: `K-${id}`, id, completedAt, updatedAt: completedAt, ...extra } as never);
const live = (id: string, extra: Partial<Ticket> = {}): Ticket => makeTicket({ status: "review", key: `K-${id}`, id, ...extra });
const withTickets = (tickets: Ticket[], over: Partial<State> = {}): State => ({ ...initialState, tickets: Object.fromEntries(tickets.map((t) => [t.id, t])), ...over });
const paging = (over: Partial<DonePaging> = {}): DonePaging => ({ total: 10, nextCursor: "c", loading: false, frontier: null, newest: null, error: null, ...over });
const page = (tickets: Ticket[], nextCursor: string | null, total = 99): TicketPage => ({ tickets, nextCursor, total });
const proj = (id: string, groupId: string | null): Project => ({ id, groupId }) as Project;

describe("scopes", () => {
  test("group scopes round-trip and are told apart from All and project scopes", () => {
    expect(scopeGroup(groupScope("Work"))).toBe("Work");
    expect(scopeGroup(ALL_SCOPE)).toBeNull();
    expect(scopeGroup("p1")).toBeNull();
    expect(scopeGroup(groupScope(""))).toBe("");
  });
  test("currentGroupScope swaps a saved group name for its id and leaves other scopes alone", () => {
    const groups = [{ id: "g-1", name: "Work" }];
    expect(currentGroupScope(groupScope("work"), groups)).toBe(groupScope("g-1"));
    expect(currentGroupScope(groupScope("g-1"), groups)).toBe(groupScope("g-1"));
    expect(currentGroupScope(groupScope("Gone"), groups)).toBe(groupScope("Gone"));
    expect(currentGroupScope("p1", groups)).toBe("p1");
    expect(currentGroupScope(ALL_SCOPE, groups)).toBe(ALL_SCOPE);
  });
  test("a null, undefined or empty board is All projects", () => {
    expect(scopeOf(null)).toBe(ALL_SCOPE);
    expect(scopeOf(undefined)).toBe(ALL_SCOPE);
    expect(scopeOf("")).toBe(ALL_SCOPE);
    expect(scopeOf("p1")).toBe("p1");
  });
  test("scopeProject and scopeQuery send a project id only for a project scope", () => {
    expect(scopeProject(ALL_SCOPE)).toBeUndefined();
    expect(scopeProject(groupScope("Work"))).toBeUndefined();
    expect(scopeProject("p1")).toBe("p1");
    expect(scopeQuery(ALL_SCOPE)).toEqual({});
    expect(scopeQuery(groupScope("Work"))).toEqual({ groupId: "Work" });
    expect(scopeQuery("p1")).toEqual({ projectId: "p1" });
  });
  test("inScope: All takes everything, a group its projects' tickets, a project its own", () => {
    const state = { projects: { a: proj("a", "Work"), b: proj("b", null) } };
    const ta = live("1", { projectId: "a" });
    const tb = live("2", { projectId: "b" });
    const tx = live("3", { projectId: "missing" });
    expect([ta, tb, tx].map((t) => inScope(state, t, ALL_SCOPE))).toEqual([true, true, true]);
    expect([ta, tb, tx].map((t) => inScope(state, t, groupScope("Work")))).toEqual([true, false, false]);
    expect([ta, tb].map((t) => inScope(state, t, "a"))).toEqual([true, false]);
  });
});

test("completedAtOf falls back to updatedAt", () => {
  expect(completedAtOf(done("1", 50, { updatedAt: 99 }))).toBe(50);
  expect(completedAtOf(live("1", { updatedAt: 7 }))).toBe(7);
});

describe("mergeTickets", () => {
  test("nothing incoming returns the same object", () => {
    const m = { a: live("a") };
    expect(mergeTickets(m, [])).toBe(m);
  });
  test("a newer or equal incoming version replaces; an older one loses to a live event", () => {
    const m = { a: live("a", { updatedAt: 10, title: "cur" }) };
    expect(mergeTickets(m, [live("a", { updatedAt: 9, title: "stale" })]).a!.title).toBe("cur");
    expect(mergeTickets(m, [live("a", { updatedAt: 10, title: "same" })]).a!.title).toBe("same");
    expect(mergeTickets(m, [live("a", { updatedAt: 11, title: "new" })]).a!.title).toBe("new");
  });
  test("new ids are added without mutating the input", () => {
    const m = { a: live("a") };
    const out = mergeTickets(m, [live("b")]);
    expect(Object.keys(out).sort()).toEqual(["a", "b"]);
    expect(Object.keys(m)).toEqual(["a"]);
  });
});

describe("pagingFromPage", () => {
  test("a first page sets the frontier to its oldest and newest to its newest", () => {
    const p = pagingFromPage(page([done("a", 30), done("b", 10), done("c", 20)], "next", 7), undefined, false);
    expect(p).toEqual({ total: 7, nextCursor: "next", loading: false, frontier: 10, newest: 30, error: null });
  });
  test("the last page (no cursor) lifts the frontier bound", () => {
    expect(pagingFromPage(page([done("a", 30)], null), undefined, false).frontier).toBeNull();
  });
  test("an empty first page has no frontier or newest", () => {
    const p = pagingFromPage(page([], null, 0), undefined, false);
    expect([p.frontier, p.newest]).toEqual([null, null]);
  });
  test("an appended page moves the frontier back only, and keeps the first page's newest", () => {
    const prev = paging({ frontier: 20, newest: 50 });
    const p = pagingFromPage(page([done("a", 15), done("b", 12)], "n"), prev, true);
    expect([p.frontier, p.newest]).toEqual([12, 50]);
    // a page whose tickets are newer than the frontier (reordered) can't move it forward
    expect(pagingFromPage(page([done("a", 40)], "n"), prev, true).frontier).toBe(20);
  });
  test("an empty appended page keeps the previous frontier", () => {
    expect(pagingFromPage(page([], "n"), paging({ frontier: 20, newest: 50 }), true).frontier).toBe(20);
  });
  test("an append over a state with a null frontier takes the page's oldest", () => {
    expect(pagingFromPage(page([done("a", 9)], "n"), paging({ frontier: null, newest: 5 }), true).frontier).toBe(9);
  });
  test("append with no previous state takes the page as a first page", () => {
    expect(pagingFromPage(page([done("a", 9)], "n"), undefined, true).newest).toBe(9);
  });
  test("loading and error reset", () => {
    expect(pagingFromPage(page([], null), paging({ loading: true, error: "x" }), false)).toMatchObject({ loading: false, error: null });
  });
});

describe("reducePaging: done pages", () => {
  test("request creates a loading entry for a new scope, and keeps the rest of an existing one", () => {
    const fresh = reducePaging(initialState, { type: "donePage.request", scope: "p" });
    expect(fresh.donePaging.p).toEqual({ total: 0, nextCursor: null, loading: true, frontier: null, newest: null, error: null });
    const s = { ...initialState, donePaging: { p: paging({ error: "boom", total: 4 }) } };
    expect(reducePaging(s, { type: "donePage.request", scope: "p" }).donePaging.p).toMatchObject({ total: 4, loading: true, error: null });
  });
  test("a page merges its tickets and sets paging", () => {
    const out = reducePaging(initialState, { type: "donePage", scope: "p", page: page([done("a", 5)], "n", 3), append: false });
    expect(out.tickets.a).toBeDefined();
    expect(out.donePaging.p).toMatchObject({ total: 3, nextCursor: "n", frontier: 5 });
  });
  test("an appended page for a scope that was reset is dropped", () => {
    const out = reducePaging(initialState, { type: "donePage", scope: "p", page: page([done("a", 5)], null), append: true });
    expect(out).toBe(initialState);
  });
  test("an appended page whose cursor no longer matches is dropped; a matching or unstated cursor applies", () => {
    const s = { ...initialState, donePaging: { p: paging({ nextCursor: "new" }) } };
    const p = page([done("a", 5)], null);
    expect(reducePaging(s, { type: "donePage", scope: "p", page: p, append: true, cursor: "old" })).toBe(s);
    expect(reducePaging(s, { type: "donePage", scope: "p", page: p, append: true, cursor: "new" }).tickets.a).toBeDefined();
    expect(reducePaging(s, { type: "donePage", scope: "p", page: p, append: true }).tickets.a).toBeDefined();
  });
  test("a non-append page ignores a mismatched cursor (a refresh re-seeds)", () => {
    const s = { ...initialState, donePaging: { p: paging({ nextCursor: "new" }) } };
    expect(reducePaging(s, { type: "donePage", scope: "p", page: page([done("a", 5)], null), append: false, cursor: "old" }).tickets.a).toBeDefined();
  });
  test("an error stops loading and records it, but only for a known scope", () => {
    const s = { ...initialState, donePaging: { p: paging({ loading: true }) } };
    expect(reducePaging(s, { type: "donePage.error", scope: "p", error: "x" }).donePaging.p).toMatchObject({ loading: false, error: "x" });
    expect(reducePaging(s, { type: "donePage.error", scope: "zz", error: "x" })).toBe(s);
  });
});

describe("reducePaging: search", () => {
  const searching = (over: Partial<SearchState> = {}): State => ({ ...initialState, search: { q: "foo", scope: "p", ids: null, nextCursor: null, total: 0, loading: true, error: null, ...over } });
  test("a blank query clears the search, and leaves state alone when there was none", () => {
    expect(reducePaging(searching(), { type: "search.set", q: "  ", scope: "p" }).search).toBeNull();
    expect(reducePaging(initialState, { type: "search.set", q: "", scope: "p" })).toBe(initialState);
  });
  test("a new query starts a pending search with the trimmed text; the same q and scope is a no-op", () => {
    const s = reducePaging(initialState, { type: "search.set", q: "  foo ", scope: "p" });
    expect(s.search).toEqual({ q: "foo", scope: "p", ids: null, nextCursor: null, total: 0, loading: true, error: null });
    expect(reducePaging(s, { type: "search.set", q: "foo", scope: "p" })).toBe(s);
    expect(reducePaging(s, { type: "search.set", q: "foo", scope: "other" }).search?.scope).toBe("other");
  });
  test("request, results and error apply only to the current q and scope", () => {
    const s = searching({ loading: false });
    expect(reducePaging(s, { type: "search.request", q: "foo", scope: "p" }).search?.loading).toBe(true);
    expect(reducePaging(s, { type: "search.request", q: "bar", scope: "p" })).toBe(s);
    expect(reducePaging(s, { type: "search.request", q: "foo", scope: "x" })).toBe(s);
    expect(reducePaging(initialState, { type: "search.request", q: "foo", scope: "p" })).toBe(initialState);
    const r = { type: "search.results" as const, scope: "p", page: page([live("a")], null, 1), append: false };
    expect(reducePaging(s, { ...r, q: "bar" })).toBe(s);
    expect(reducePaging(s, { ...r, scope: "x", q: "foo" })).toBe(s);
    expect(reducePaging(s, { type: "search.error", q: "bar", scope: "p", error: "e" })).toBe(s);
    expect(reducePaging(s, { type: "search.error", q: "foo", scope: "p", error: "e" }).search).toMatchObject({ loading: false, error: "e" });
  });
  test("results set ids in server order, merge tickets and the totals; q is compared trimmed", () => {
    const out = reducePaging(searching(), { type: "search.results", q: " foo ", scope: "p", page: page([live("b"), live("a")], "n", 5), append: false });
    expect(out.search).toMatchObject({ ids: ["b", "a"], nextCursor: "n", total: 5, loading: false });
    expect(Object.keys(out.tickets).sort()).toEqual(["a", "b"]);
  });
  test("an appended page adds only unseen ids; before a first page it is dropped", () => {
    const s = searching({ ids: ["a", "b"] });
    const out = reducePaging(s, { type: "search.results", q: "foo", scope: "p", page: page([live("b"), live("c")], null, 3), append: true });
    expect(out.search?.ids).toEqual(["a", "b", "c"]);
    const pending = searching({ ids: null });
    expect(reducePaging(pending, { type: "search.results", q: "foo", scope: "p", page: page([live("c")], null, 1), append: true })).toBe(pending);
  });
});

describe("adjustDoneTotals", () => {
  const base = (over: Partial<State> = {}): State => ({ ...initialState, donePaging: { [ALL_SCOPE]: paging({ total: 10, newest: 100 }) }, ticketsAsOf: 500, ...over });
  const total = (s: State, scope = ALL_SCOPE) => adjustDoneTotals(s, undefined, null)[scope]?.total;
  test("no paging at all returns the same map", () => {
    expect(adjustDoneTotals(initialState, undefined, live("a"))).toBe(initialState.donePaging);
  });
  test("nothing to go on (no prev, no next) returns the same map", () => {
    const s = base();
    expect(adjustDoneTotals(s, undefined, null)).toBe(s.donePaging);
  });
  test("a loaded ticket moving into or out of done counts +1 / -1; staying put counts 0", () => {
    const s = base();
    expect(adjustDoneTotals(s, live("a"), done("a", 1))[ALL_SCOPE]!.total).toBe(11);
    expect(adjustDoneTotals(s, done("a", 1), live("a"))[ALL_SCOPE]!.total).toBe(9);
    expect(adjustDoneTotals(s, done("a", 1), done("a", 2))).toBe(s.donePaging);
    expect(adjustDoneTotals(s, live("a"), live("a"))).toBe(s.donePaging);
  });
  test("deleting a loaded done ticket decrements; deleting a live one does not", () => {
    const s = base();
    expect(adjustDoneTotals(s, done("a", 1), null)[ALL_SCOPE]!.total).toBe(9);
    expect(adjustDoneTotals(s, live("a"), null)).toBe(s.donePaging);
  });
  test("an unloaded ticket arriving done counts only when completed after the first page's newest", () => {
    const s = base();
    expect(adjustDoneTotals(s, undefined, done("a", 101))[ALL_SCOPE]!.total).toBe(11);
    expect(adjustDoneTotals(s, undefined, done("a", 100))).toBe(s.donePaging);
    expect(adjustDoneTotals(s, undefined, done("a", 50))).toBe(s.donePaging);
  });
  test("with no newest (an empty first page) any unloaded done ticket is new", () => {
    const s = base({ donePaging: { [ALL_SCOPE]: paging({ total: 0, newest: null }) } });
    expect(adjustDoneTotals(s, undefined, done("a", 1))[ALL_SCOPE]!.total).toBe(1);
  });
  test("an unloaded non-done ticket: created by the snapshot time means a reopened done ticket (-1), later means brand new", () => {
    const s = base();
    expect(adjustDoneTotals(s, undefined, live("a", { createdAt: 500 }))[ALL_SCOPE]!.total).toBe(9);
    expect(adjustDoneTotals(s, undefined, live("a", { createdAt: 501 }))).toBe(s.donePaging);
    const noSnapshot = base({ ticketsAsOf: null });
    expect(adjustDoneTotals(noSnapshot, undefined, live("a", { createdAt: 1 }))).toBe(noSnapshot.donePaging);
  });
  test("the total never goes below zero", () => {
    const s = base({ donePaging: { [ALL_SCOPE]: paging({ total: 0 }) } });
    expect(adjustDoneTotals(s, done("a", 1), null)[ALL_SCOPE]!.total).toBe(0);
  });
  test("only scopes the ticket belongs to change", () => {
    const s = base({ projects: { a: proj("a", null), b: proj("b", null) }, donePaging: { a: paging({ total: 5 }), b: paging({ total: 5 }) } });
    const out = adjustDoneTotals(s, live("t", { projectId: "a" }), done("t", 1, { projectId: "a" }));
    expect([out.a!.total, out.b!.total]).toEqual([6, 5]);
  });
  test("moving to done in a group's scope counts for that group", () => {
    const s = base({ projects: { a: proj("a", "Work") }, donePaging: { [groupScope("Work")]: paging({ total: 2 }), [groupScope("Home")]: paging({ total: 2 }) } });
    const out = adjustDoneTotals(s, live("t", { projectId: "a" }), done("t", 1, { projectId: "a" }));
    expect([out[groupScope("Work")]!.total, out[groupScope("Home")]!.total]).toEqual([3, 2]);
  });
});

describe("doneColumn / doneCount", () => {
  test("only done tickets in scope, newest completion first, ties by id", () => {
    const s = withTickets([done("b", 10), done("a", 10), done("c", 30), live("x"), done("o", 5, { projectId: "other" })], { projects: {} });
    expect(doneColumn(s, null).map((t) => t.id)).toEqual(["c", "a", "b", "o"]);
    expect(doneColumn(s, "project-TEST").map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
  test("the frontier hides older loaded done tickets, inclusive at the boundary", () => {
    const s = withTickets([done("new", 30), done("edge", 20), done("old", 10)], { donePaging: { [ALL_SCOPE]: paging({ frontier: 20 }) } });
    expect(doneColumn(s, null).map((t) => t.id)).toEqual(["new", "edge"]);
  });
  test("a null frontier shows every loaded one", () => {
    const s = withTickets([done("a", 30), done("b", 1)], { donePaging: { [ALL_SCOPE]: paging({ frontier: null }) } });
    expect(doneColumn(s, null)).toHaveLength(2);
  });
  test("a frontier of 0 still applies (not treated as absent)", () => {
    const s = withTickets([done("a", 30), done("b", -5)], { donePaging: { [ALL_SCOPE]: paging({ frontier: 0 }) } });
    expect(doneColumn(s, null).map((t) => t.id)).toEqual(["a"]);
  });
  test("doneCount prefers the server total, else the loaded count", () => {
    expect(doneCount(withTickets([], { donePaging: { [ALL_SCOPE]: paging({ total: 12 }) } }), null, 3)).toBe(12);
    expect(doneCount(initialState, null, 3)).toBe(3);
  });
});

describe("load-more guards", () => {
  test("canLoadMoreDone needs paging state with a cursor and no request in flight", () => {
    const at = (p?: Partial<DonePaging>) => canLoadMoreDone({ ...initialState, donePaging: p ? { [ALL_SCOPE]: paging(p) } : {} }, null);
    expect(at()).toBe(false);
    expect(at({ nextCursor: "c" })).toBe(true);
    expect(at({ nextCursor: null })).toBe(false);
    expect(at({ nextCursor: "c", loading: true })).toBe(false);
  });
  test("needsFirstDonePage waits for the snapshot, then for a scope without paging", () => {
    expect(needsFirstDonePage({ ...initialState, ready: false }, null)).toBe(false);
    expect(needsFirstDonePage({ ...initialState, ready: true }, null)).toBe(true);
    expect(needsFirstDonePage({ ...initialState, ready: true, donePaging: { p: paging() } }, "p")).toBe(false);
    expect(needsFirstDonePage({ ...initialState, ready: true, donePaging: { p: paging() } }, null)).toBe(true);
  });
  test("canLoadMoreSearch needs landed results, a cursor and no request in flight", () => {
    const s = (o: Partial<SearchState>): SearchState => ({ q: "q", scope: "*", ids: [], nextCursor: "n", total: 9, loading: false, error: null, ...o });
    expect(canLoadMoreSearch(null)).toBe(false);
    expect(canLoadMoreSearch(s({}))).toBe(true);
    expect(canLoadMoreSearch(s({ ids: null }))).toBe(false);
    expect(canLoadMoreSearch(s({ nextCursor: null }))).toBe(false);
    expect(canLoadMoreSearch(s({ loading: true }))).toBe(false);
  });
});

describe("matchesQuery", () => {
  const t = live("1", { key: "ABC-12", title: "Fix the Widget", externalRef: { key: "JIRA-9" } as never });
  test("a blank query matches everything", () => {
    expect(matchesQuery(t, "   ")).toBe(true);
  });
  test("key, title and external key match without case; others don't", () => {
    expect(matchesQuery(t, "abc-1")).toBe(true);
    expect(matchesQuery(t, " WIDGET ")).toBe(true);
    expect(matchesQuery(t, "jira")).toBe(true);
    expect(matchesQuery(t, "nope")).toBe(false);
    expect(matchesQuery(live("2"), "jira")).toBe(false);
  });
  test("an old key alias matches only for this ticket's id", () => {
    expect(matchesQuery(t, "old-5", { "OLD-5": "1" })).toBe(true);
    expect(matchesQuery(t, "old-5", { "OLD-5": "other" })).toBe(false);
  });
});

describe("searchColumns", () => {
  const search = (over: Partial<SearchState>): State => ({ ...initialState, search: { q: "widget", scope: "*", ids: null, nextCursor: null, total: 0, loading: false, error: null, ...over } });
  test("no search gives empty columns", () => {
    const r = searchColumns(withTickets([live("a")]), null);
    expect(r.pending).toBe(false);
    expect(Object.values(r.columns).flat()).toEqual([]);
  });
  test("before results land: loaded tickets that match locally, in scope, flagged pending", () => {
    const s = { ...search({}), tickets: withTickets([live("a", { title: "widget" }), live("b", { title: "other" }), live("c", { title: "widget", projectId: "other" }), done("d", 5, { title: "widget" })]).tickets };
    const r = searchColumns(s, "project-TEST");
    expect(r.pending).toBe(true);
    expect(r.columns.review.map((t) => t.id)).toEqual(["a"]);
    expect(r.columns.done.map((t) => t.id)).toEqual(["d"]);
  });
  test("with results: server order is kept to the ids, each in its current status column; a missing ticket is skipped", () => {
    const s = { ...search({ ids: ["b", "gone", "a"] }), tickets: withTickets([live("a", { position: 2 }), live("b", { position: 1 })]).tickets };
    const r = searchColumns(s, null);
    expect(r.pending).toBe(false);
    expect(r.columns.review.map((t) => t.id)).toEqual(["b", "a"]);
  });
  test("live columns sort by position then creation; done by completion desc", () => {
    const s = { ...search({ ids: ["a", "b", "c", "d", "e"] }), tickets: withTickets([live("a", { position: 1, createdAt: 5 }), live("b", { position: 1, createdAt: 2 }), live("c", { position: 0, createdAt: 9 }), done("d", 5), done("e", 9)]).tickets };
    const r = searchColumns(s, null);
    expect(r.columns.review.map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(r.columns.done.map((t) => t.id)).toEqual(["e", "d"]);
  });
});

describe("searchStatusText", () => {
  const s = (o: Partial<SearchState>): SearchState => ({ q: "q", scope: "*", ids: [], nextCursor: null, total: 0, loading: false, error: null, ...o });
  test("error wins over everything", () => {
    expect(searchStatusText(s({ error: "boom", ids: null }))).toBe("Search failed: boom");
  });
  test("pending, none, partial, singular and plural", () => {
    expect(searchStatusText(s({ ids: null }))).toBe("Searching…");
    expect(searchStatusText(s({ total: 0 }))).toBe("No matches");
    expect(searchStatusText(s({ ids: ["a"], total: 3 }))).toBe("Showing 1 of 3 matches");
    expect(searchStatusText(s({ ids: ["a"], total: 1 }))).toBe("1 match");
    expect(searchStatusText(s({ ids: ["a", "b"], total: 2 }))).toBe("2 matches");
  });
});
