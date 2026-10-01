// Done paging and board search scenarios (shared/src/state/paging.ts, every case in
// paging.test.ts plus edge cases) for HarnessKit's Paging.swift. See ../board.ts.
import { ALL_SCOPE, matchesQuery, searchStatusText, type SearchState } from "../../src/state";
import type { Ticket } from "../../src/protocol";
import { cases } from "../case";
import { detail, done, ev, page, scenario, snapshot, tk, upsert, type Probe } from "../board";

// paging.test.ts scaled down to keep the JSON small: 12 done tickets in p1 (TS: 120), completed
// at 1000 (oldest) … 1011 (newest); pages of 5 newest-first (TS: 50).
const allDone = Array.from({ length: 12 }, (_, i) => done(`d${i}`, 1000 + i));
const newestFirst = [...allDone].reverse();
const p1 = page(newestFirst.slice(0, 5), "c5", 12);
const p2 = page(newestFirst.slice(5, 10), "c10", 12);
const p3 = page(newestFirst.slice(10), null, 12);
const live = tk("w1", { status: "in_progress", createdAt: 20 });
const boot = snapshot([live], { scope: "p1", page: p1 });

const paging = (scope = "p1"): Probe[] => [["doneCount", scope, 0], ["canLoadMoreDone", scope], ["needsFirstDonePage", scope]];

export const doneScenarios = [
  scenario("the snapshot's first page fills Done; the header count is the server total", [
    { actions: [boot], probes: [["boardColumns", "p1"], ["doneCount", "p1", 50], ["canLoadMoreDone", "p1"]] },
  ]),
  scenario("an older done ticket loaded out of band stays out of Done until paging reaches it", [
    { actions: [boot, { type: "detail", detail: detail(newestFirst[8]!) }], probes: [["doneColumn", "p1"]] },
    { actions: [{ type: "donePage.request", scope: "p1" }, { type: "donePage", scope: "p1", page: p2, append: true }], probes: [["doneColumn", "p1"], ...paging()] },
  ]),
  scenario("Load more appends in order without duplicates, and the last page lifts the frontier", [
    { actions: [boot, { type: "donePage.request", scope: "p1" }], probes: [["canLoadMoreDone", "p1"]] },
    // Page 2 overlaps page 1 by one ticket (a tie at the boundary): still 9 unique.
    { actions: [{ type: "donePage", scope: "p1", page: page([newestFirst[4]!, ...p2.tickets.slice(0, 4)], "c9", 12), append: true }], probes: [["doneColumn", "p1"]] },
    { actions: [{ type: "donePage", scope: "p1", page: p3, append: true }], probes: [["doneColumn", "p1"], ...paging()] },
  ]),
  scenario("a live completion goes to the top of Done and counts; reopening moves it out and uncounts", [
    { actions: [boot, upsert({ ...live, status: "done", completedAt: 5000, updatedAt: 5000 })], probes: [["boardColumns", "p1"], ["doneCount", "p1", 0]] },
    { actions: [upsert({ ...live, status: "review", completedAt: null, updatedAt: 5001 })], probes: [["boardColumns", "p1"], ["doneCount", "p1", 0]] },
  ]),
  scenario("unloaded tickets: an old done one edited isn't recounted; a new completion or a reopen is", [
    // D2 (completed at 1002, not loaded) gets a title edit: already counted.
    { actions: [boot, upsert({ ...allDone[2]!, title: "renamed", updatedAt: 9000 })], probes: [["doneCount", "p1", 0]] },
    // Completed after the count was taken (newer than the first page's newest): +1.
    { actions: [upsert(done("x1", 2000, { createdAt: 1 }))], probes: [["doneCount", "p1", 0]] },
    // Completed exactly at the newest: already counted.
    { actions: [upsert(done("x2", 1011, { createdAt: 1 }))], probes: [["doneCount", "p1", 0]] },
    // An unloaded done ticket reopened (it existed at snapshot time): -1.
    { actions: [upsert({ ...allDone[1]!, status: "in_progress", completedAt: null, updatedAt: 9001 })], probes: [["doneCount", "p1", 0]] },
    // A brand-new ticket (created after the snapshot) isn't a reopen.
    { actions: [upsert(tk("n1", { createdAt: 99_999 }))], probes: [["doneCount", "p1", 0]] },
    // Created exactly at the snapshot's newest createdAt: a reopen.
    { actions: [upsert(tk("n2", { createdAt: 20 }))], probes: [["doneCount", "p1", 0]] },
    // Another project's ticket leaves p1 alone.
    { actions: [upsert(done("other", 9999, { projectId: "p2" }))], probes: [["doneCount", "p1", 0]] },
  ]),
  scenario("a scope whose first page was empty counts every unloaded completion", [
    { actions: [snapshot([], { scope: "p1", page: page([], null, 0) }), upsert(done("x", 1))], probes: [["doneCount", "p1", 0]] },
  ]),
  scenario("totals never go below zero", [
    { actions: [snapshot([], { scope: "p1", page: page([], null, 0) }), upsert(tk("old", { createdAt: -5 }))], probes: [["doneCount", "p1", 9]] },
  ]),
  scenario("deleting a loaded done ticket uncounts it in every scope it belongs to, and only those", [
    {
      actions: [
        boot,
        { type: "donePage.request", scope: ALL_SCOPE },
        { type: "donePage", scope: ALL_SCOPE, page: page([...p1.tickets, done("o1", 3000, { projectId: "p2" })], "x", 20), append: false },
        { type: "donePage", scope: "p2", page: page([], null, 7), append: false },
        ev({ kind: "ticket.deleted", id: "d11" }),
      ],
      probes: [["doneCount", "p1", 0], ["doneCount", null, 0], ["doneCount", "p2", 0]],
    },
    // Deleting a ticket that isn't loaded changes nothing.
    { actions: [ev({ kind: "ticket.deleted", id: "never-loaded" })], probes: [["doneCount", "p1", 0], ["doneCount", null, 0]] },
  ]),
  scenario("scopes page independently; a scope without paging needs its first page", [
    { probes: [["needsFirstDonePage", "p1"]] },
    { actions: [boot], probes: [["needsFirstDonePage", "p1"], ["needsFirstDonePage", null], ["needsFirstDonePage", "p2"], ["canLoadMoreDone", "p2"]] },
  ]),
  scenario("a reconnect snapshot resets paging; a Load more page from before it is dropped", [
    { actions: [boot, { type: "donePage", scope: "p2", page: page([], null, 3), append: false }], full: true },
    { actions: [boot] },
    { actions: [{ type: "donePage", scope: "p2", page: page([done("late", 1)], null, 3), append: true }] },
  ]),
  scenario("a page's ticket doesn't clobber a newer live version of it", [
    { actions: [boot, upsert({ ...allDone[4]!, title: "live edit", updatedAt: 99_000 }), { type: "donePage", scope: "p1", page: p2, append: true }] },
  ]),
  scenario("a project's full ticket list loads every done ticket but doesn't flood Done", [
    { actions: [boot, { type: "tickets", tickets: allDone }], probes: [["doneColumn", "p1"], ["ticketsForProject", "p1"]] },
  ]),
  scenario("without paging state (an older service) Done shows every loaded done ticket", [
    { actions: [snapshot([live, ...allDone.slice(0, 3)])], probes: [["doneColumn", "p1"], ["doneCount", "p1", 3]] },
  ]),
  scenario("a page request for a new scope starts its paging; an error keeps the cursor for retry", [
    { actions: [boot, { type: "donePage.request", scope: "p2" }], probes: [...paging("p2")], full: true },
    { actions: [{ type: "donePage.error", scope: "p2", error: "offline" }, { type: "donePage.error", scope: "nope", error: "ignored" }], full: true },
    { actions: [{ type: "donePage.request", scope: "p1" }, { type: "donePage.error", scope: "p1", error: "boom" }], probes: [...paging()] },
    { actions: [{ type: "donePage.request", scope: "p1" }], probes: [...paging()] },
  ]),
  scenario("an empty appended page keeps the previous frontier", [
    { actions: [boot, { type: "donePage", scope: "p1", page: page([], "c-next", 120), append: true }], full: true },
  ]),
  scenario("a done page without completedAt falls back to updatedAt", [
    { actions: [snapshot([], { scope: "p1", page: page([tk("u1", { status: "done", completedAt: undefined, updatedAt: 77 }), tk("u2", { status: "done", updatedAt: 66 })], "c", 5) })], probes: [["doneColumn", "p1"]] },
  ]),
  scenario("equal completion times tie-break by id", [
    { actions: [snapshot([], { scope: "p1", page: page([done("b", 5), done("a", 5), done("c", 5)], null, 3) })], probes: [["doneColumn", "p1"]] },
  ]),
];

// createdAt 21 (TS: 20, a full tie with W1 that TS orders by insertion; Swift breaks ties by id).
const child = tk("c1", { title: "Child about widgets", parentId: "cond", status: "in_progress", createdAt: 21 });
const searchBase = snapshot([live, child, tk("w2", { title: "Widgets", status: "review", createdAt: 20 })], { scope: "p1", page: p1 });
const w2 = tk("w2", { title: "Widgets", status: "review", createdAt: 20 });
const searchProbes: Probe[] = [["searchColumns", "p1"], ["searchStatusText"], ["canLoadMoreSearch"]];

export const searchScenarios = [
  scenario("typing shows local matches at once; the server's results replace them", [
    { actions: [searchBase, { type: "search.set", q: " widget ", scope: "p1" }], probes: [...searchProbes], full: true },
    // The server also matches a done ticket that isn't loaded (description hit), and not C1.
    { actions: [{ type: "search.results", q: "widget", scope: "p1", page: page([done("far", 10, { title: "Old", description: "widget cache" }), w2], "n", 3), append: false }], probes: [...searchProbes] },
  ]),
  scenario("stale responses (an older query or scope) are ignored", [
    { actions: [searchBase, { type: "search.set", q: "wid", scope: "p1" }, { type: "search.set", q: "widgets", scope: "p1" }] },
    { actions: [{ type: "search.results", q: "wid", scope: "p1", page: page([live], null, 1), append: false }], full: true },
    { actions: [{ type: "search.results", q: "widgets", scope: ALL_SCOPE, page: page([live], null, 1), append: false }], full: true },
    { actions: [{ type: "search.results", q: "widgets", scope: "p1", page: page([w2], null, 1), append: false }] },
  ]),
  scenario("more results append without duplicates; the last page stops paging", [
    { actions: [searchBase, { type: "search.set", q: "d", scope: "p1" }, { type: "search.results", q: "d", scope: "p1", page: page(allDone.slice(0, 2), "n", 3), append: false }], probes: [...searchProbes] },
    { actions: [{ type: "search.request", q: "d", scope: "p1" }], probes: [["canLoadMoreSearch"]] },
    { actions: [{ type: "search.results", q: "d", scope: "p1", page: page(allDone.slice(1, 3), null, 3), append: true }], probes: [...searchProbes] },
  ]),
  scenario("results follow live moves; a deleted result drops out", [
    { actions: [searchBase, { type: "search.set", q: "widgets", scope: "p1" }, { type: "search.results", q: "widgets", scope: "p1", page: page([w2], null, 1), append: false }] },
    { actions: [upsert({ ...w2, status: "done", completedAt: 7000, updatedAt: 7000 })], probes: [["searchColumns", "p1"]] },
    { actions: [ev({ kind: "ticket.deleted", id: "w2" })], probes: [["searchColumns", "p1"]] },
  ]),
  scenario("clearing the query ends the search; a reconnect re-arms it for a re-run", [
    { actions: [searchBase, { type: "search.set", q: "widgets", scope: "p1" }, { type: "search.results", q: "widgets", scope: "p1", page: page([w2], "more", 4), append: false }] },
    { actions: [boot], probes: [...searchProbes], full: true },
    { actions: [{ type: "search.set", q: "  ", scope: "p1" }], probes: [...searchProbes] },
    { actions: [{ type: "search.set", q: "", scope: "p1" }] },
  ]),
  scenario("the same query again is a no-op; a new scope restarts it", [
    { actions: [searchBase, { type: "search.set", q: "w", scope: "p1" }, { type: "search.results", q: "w", scope: "p1", page: page([w2], null, 1), append: false }, { type: "search.set", q: " w", scope: "p1" }], full: true },
    { actions: [{ type: "search.set", q: "w", scope: ALL_SCOPE }], probes: [["searchColumns", null]] },
  ]),
  scenario("an appended page before the first one is ignored", [
    { actions: [searchBase, { type: "search.set", q: "w", scope: "p1" }, { type: "search.results", q: "w", scope: "p1", page: page([w2], null, 1), append: true }] },
  ]),
  scenario("search errors and requests only apply to the current query", [
    { actions: [searchBase, { type: "search.set", q: "w", scope: "p1" }, { type: "search.error", q: "other", scope: "p1", error: "nope" }, { type: "search.error", q: " w ", scope: "p1", error: "offline" }], probes: [["searchStatusText"]], full: true },
    { actions: [{ type: "search.request", q: "x", scope: "p1" }], full: true },
    { actions: [{ type: "search.request", q: "w", scope: "p1" }], probes: [["searchStatusText"]] },
  ]),
  scenario("local matching covers old keys the store knows about", [
    { actions: [snapshot([tk("r1", { key: "NEW-4", title: "x" })]), { type: "detail", detail: detail(tk("r1", { key: "NEW-4", title: "x" })), requestedKey: "OLD-4" }], probes: [["matchesQuery", "r1", "old-4"], ["matchesQuery", "r1", "new"], ["matchesQuery", "r1", "zzz"]] },
    { actions: [{ type: "search.set", q: "old-4", scope: "p1" }], probes: [["searchColumns", "p1"]] },
  ]),
];

const emptyPage = { scope: "p1", page: page([], null, 0) };

export const unloadedScenarios = [
  scenario("an unloaded dependency is unknown (not pending) until resolved; a 404 marks it missing", [
    { actions: [snapshot([tk("a", { dependsOn: ["D5", "GONE-1", "A"] })], emptyPage)], probes: [["dependencyStates", "a"], ["unresolvedKeys"]] },
    { actions: [{ type: "detail", detail: detail(allDone[5]!), requestedKey: "D5" }, { type: "missingKeys", keys: ["gone-1"] }], probes: [["dependencyStates", "a"], ["unresolvedKeys"], ["unresolvedKeys", ["gone-1", "extra-2", "a"]]] },
  ]),
  scenario("unresolvedKeys is empty before the first snapshot", [
    { actions: [upsert(tk("a", { dependsOn: ["X-1"] }))], probes: [["unresolvedKeys"], ["unresolvedKeys", ["Y-2"]], ["conductorsNeedingChildren"]] },
  ]),
  scenario("an old key resolves through the detail's resolvedFrom (redirect, deps, lookups)", [
    { actions: [snapshot([tk("a", { dependsOn: ["OLD-7"] })], emptyPage)], probes: [["unresolvedKeys"]] },
    { actions: [{ type: "detail", detail: detail(done("r", 50, { key: "NEW-7" }), { resolvedFrom: "OLD-7" }), requestedKey: "old-7" }], probes: [["ticketByKey", "old-7"], ["dependencyStates", "a"], ["unresolvedKeys"]] },
  ]),
  scenario("triage outcomes name tickets to resolve", [
    {
      actions: [
        snapshot([], emptyPage, {
          sessions: [
            { id: "t1", key: "T1", kind: "triage", ticketId: null, driver: "dummy", cwd: "/", title: "", triageStatus: "dispatched", outcome: "Dispatched to NYTIMES as FOO-9 (started).", busy: false, createdAt: 0, updatedAt: 0 },
            { id: "t2", key: "T2", kind: "triage", ticketId: null, driver: "dummy", cwd: "/", title: "", triageStatus: "declined", outcome: "Declined: no ticket", busy: false, createdAt: 1, updatedAt: 1 },
            { id: "s3", key: "S3", kind: "ticket", ticketId: null, driver: "dummy", cwd: "/", title: "", triageStatus: null, outcome: "Mentions BAR-2", busy: false, createdAt: 2, updatedAt: 2 },
          ],
        }),
      ],
      probes: [["unresolvedKeys"], ["triageSessions"]],
    },
  ]),
  scenario("a conductor's detail loads every child (done ones included) and the rollup counts them", [
    { actions: [snapshot([tk("cond", { kind: "conductor", status: "in_progress" }), tk("k1", { parentId: "cond", status: "in_progress" })], emptyPage)], probes: [["conductorsNeedingChildren"]] },
    {
      actions: [{ type: "detail", detail: detail(tk("cond", { kind: "conductor", status: "in_progress" }), { children: [tk("k1", { parentId: "cond", status: "in_progress" }), done("k2", 20, { parentId: "cond" }), done("k3", 30, { parentId: "cond" })] }) }],
      probes: [["conductorsNeedingChildren"], ["childrenOf", "cond"], ["doneColumn", "p1"]],
    },
  ]),
  scenario("a task ticket that takes a child conducts it too: its children get loaded", [
    { actions: [snapshot([tk("task", { status: "in_progress" })], emptyPage)], probes: [["conductorsNeedingChildren"]] },
    { actions: [upsert(tk("task", { status: "in_progress", childCount: 1 }))], probes: [["conductorsNeedingChildren"]] },
    { actions: [{ type: "detail", detail: detail(tk("task", { status: "in_progress", childCount: 1 }), { children: [tk("k1", { parentId: "task" })] }) }], probes: [["conductorsNeedingChildren"]] },
  ]),
  scenario("dependents merge the detail's list (unloaded done ones) with live dependents", [
    { actions: [snapshot([tk("base", { key: "B-1", status: "in_progress" }), tk("l", { key: "L-1", dependsOn: ["b-1"] })], emptyPage)], probes: [["dependentsOf", "base"]] },
    { actions: [{ type: "detail", detail: detail(tk("base", { key: "B-1", status: "in_progress" }), { dependents: ["OLD-DONE-3", "L-1", "l-1"] }) }], probes: [["dependentsOf", "base"], ["unresolvedKeys"]] },
    // A dependent that drops the dependency live leaves the list even though the detail named it.
    { actions: [upsert(tk("l", { key: "L-1", dependsOn: [], updatedAt: 50 }))], probes: [["dependentsOf", "base"]] },
  ]),
  scenario("dependents sort numerically by key", [
    { actions: [snapshot([tk("base", { key: "B-1" }), tk("x10", { key: "X-10", dependsOn: ["B-1"] }), tk("x9", { key: "X-9", dependsOn: ["B-1"] }), tk("a2", { key: "A-2", dependsOn: ["B-1"] })], emptyPage)], probes: [["dependentsOf", "base"]] },
  ]),
  scenario("a child's detail brings its unloaded (done, off-page) conductor into the store for the breadcrumb", [
    { actions: [snapshot([tk("kid", { parentId: "cond", status: "in_progress" })], { scope: "p1", page: page([], null, 1) })], probes: [["ticketByKey", "COND"]] },
    { actions: [{ type: "detail", detail: detail(tk("kid", { parentId: "cond", status: "in_progress" }), { parent: done("cond", 5, { kind: "conductor", title: "Old conductor" }) }) }], probes: [["ticketByKey", "COND"]] },
  ]),
  scenario("a page requested with an old cursor is dropped once a refresh re-seeds the scope", [
    // First run: page 1 → cursor "c1"; the user hits Load more (in flight with "c1").
    { actions: [snapshot([], { scope: "p1", page: page([done("a", 90), done("b", 80)], "c1", 6) })] },
    // Refresh re-seeds the same scope with a new first page and a new cursor.
    { actions: [snapshot([], { scope: "p1", page: page([done("z", 99), done("a", 90)], "c1b", 7) })], full: true },
    // The old Load more (requested with "c1") now lands: it must not splice into the new run.
    { actions: [{ type: "donePage", scope: "p1", page: page([done("old", 10)], null, 6), append: true, cursor: "c1" }], full: true },
    // A Load more for the current cursor still applies.
    { actions: [{ type: "donePage", scope: "p1", page: page([done("y", 70)], null, 7), append: true, cursor: "c1b" }] },
  ]),
  scenario("an appended page with a null cursor only applies when the scope's cursor is null", [
    { actions: [snapshot([], { scope: "p1", page: page([done("a", 90)], "c1", 6) }), { type: "donePage", scope: "p1", page: page([done("x", 10)], null, 6), append: true, cursor: null }], full: true },
    { actions: [{ type: "donePage", scope: "p1", page: page([done("y", 70)], null, 6), append: true, cursor: "c1" }, { type: "donePage", scope: "p1", page: page([done("w", 60)], null, 6), append: true, cursor: null }] },
  ]),
];

const mq = (t: Ticket, q: string, aliases?: Record<string, string>) => ({ ticket: t, q, aliases });
export const matchesQueryCases = cases(({ ticket, q, aliases }: ReturnType<typeof mq>) => matchesQuery(ticket, q, aliases), {
  "old key alias": mq(tk("r1", { key: "NEW-4", title: "x" }), "old-4", { "OLD-4": "r1" }),
  "no aliases": mq(tk("r1", { key: "NEW-4", title: "x" }), "old-4"),
  "alias for another ticket": mq(tk("r1", { key: "NEW-4", title: "x" }), "old-4", { "OLD-4": "r2" }),
  "linked remote ID": mq(tk("r1", { key: "MH-124", title: "x", externalRef: { source: "jira", key: "MH-62", url: null, raw: null } }), "mh-62"),
  "no remote ID": mq(tk("r2", { key: "MH-124", title: "x" }), "mh-62"),
  "title, case-insensitive": mq(tk("r3", { title: "Fix the Widget" }), "WIDGET"),
  "blank query matches everything": mq(tk("r4"), "   "),
  "query is trimmed": mq(tk("r5", { title: "abc" }), " b "),
  "description doesn't match locally": mq(tk("r6", { title: "x", description: "needle" }), "needle"),
  "combining mark: e matches é decomposed": mq(tk("r7", { title: "cafe\u0301" }), "cafe"),
  "NBSP trimmed like JS": mq(tk("r8", { title: "abc" }), " b "),
});

const ss = (over: Partial<SearchState>): SearchState => ({ q: "w", scope: "p1", ids: null, nextCursor: null, total: 0, loading: false, error: null, ...over });
export const searchStatusTextCases = cases(searchStatusText, {
  searching: ss({}),
  "no matches": ss({ ids: [], total: 0 }),
  one: ss({ ids: ["a"], total: 1 }),
  many: ss({ ids: ["a", "b"], total: 2 }),
  partial: ss({ ids: ["a"], total: 132 }),
  error: ss({ ids: ["a"], total: 1, error: "offline" }),
});
