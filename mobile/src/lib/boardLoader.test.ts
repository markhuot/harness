import { expect, test } from "bun:test";
import type { Ticket, TicketPage } from "@harness/shared";
import { ALL_SCOPE, boardColumns, initialState, reducer, searchColumns, type Action, type State } from "@harness/shared/state";
import { BoardLoader, shouldAutoFill, type LoaderClient, type Timers } from "./boardLoader";

let seq = 0;
const tk = (id: string, extra: Partial<Ticket> = {}): Ticket =>
  ({
    id,
    key: `T-${id}`,
    title: id,
    description: "",
    status: "done",
    kind: "task",
    projectId: "p1",
    parentId: null,
    dependsOn: [],
    position: 0,
    createdAt: ++seq,
    updatedAt: seq,
    completedAt: 1000 - seq,
    ...extra,
  }) as Ticket;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  const timers: Timers = { set: (fn) => (pending.set(++id, fn), id), clear: (h) => void pending.delete(h as number) };
  const fire = () => {
    const fns = [...pending.values()];
    pending.clear();
    fns.forEach((f) => f());
  };
  return { timers, fire, pending };
}

/**
 * A real shared reducer behind the loader. `lag` makes getState return what the app last
 * rendered rather than the latest dispatch, like stateRef in the React store.
 */
function harness(opts: { lag?: boolean } = {}) {
  let state: State = initialState;
  let rendered: State = initialState;
  const dispatch = (a: Action) => {
    state = reducer(state, a);
    if (!opts.lag) rendered = state;
  };
  const pages: { cursor: string | null; projectId?: string; limit?: number; d: ReturnType<typeof deferred<TicketPage>> }[] = [];
  const searches: { q: string; cursor: string | null; projectId?: string; d: ReturnType<typeof deferred<TicketPage>> }[] = [];
  const client: LoaderClient = {
    ticketPage: (o) => {
      const d = deferred<TicketPage>();
      pages.push({ cursor: o.cursor ?? null, projectId: o.projectId, limit: o.limit, d });
      return d.promise;
    },
    searchTickets: (o) => {
      const d = deferred<TicketPage>();
      searches.push({ q: o.q, cursor: o.cursor ?? null, projectId: o.projectId, d });
      return d.promise;
    },
  };
  const clock = fakeTimers();
  const loader = new BoardLoader({ client, dispatch, getState: () => rendered, timers: clock.timers, debounceMs: 200 });
  const snapshot = (open: Ticket[], donePage: TicketPage | null, scope = ALL_SCOPE) => {
    dispatch({
      type: "snapshot",
      snapshot: { projects: [], tickets: open, sessions: [], watchers: [], mappings: [], settings: null, drivers: [], ...(donePage ? { donePage: { scope, page: donePage } } : {}) },
    });
    loader.snapshotApplied();
  };
  return {
    loader,
    pages,
    searches,
    clock,
    snapshot,
    dispatch,
    render: () => (rendered = state),
    get state() {
      return state;
    },
  };
}

test("shouldAutoFill: a short column with a page to load fills itself; a full one waits for the scroll", () => {
  expect(shouldAutoFill(0, true, 12)).toBe(true);
  expect(shouldAutoFill(11, true, 12)).toBe(true);
  expect(shouldAutoFill(12, true, 12)).toBe(false);
  expect(shouldAutoFill(0, false, 12)).toBe(false);
});

test("onEndReached firing again before React re-renders asks for the page once", async () => {
  const h = harness({ lag: true });
  h.snapshot([], { tickets: [tk("a")], nextCursor: "c1", total: 3 });
  h.render();
  void h.loader.loadMoreDone(null);
  void h.loader.loadMoreDone(null); // stale state still says "not loading"
  expect(h.pages.length).toBe(1);
  h.pages[0]!.d.resolve({ tickets: [tk("b")], nextCursor: "c2", total: 3 });
  await flush();
  // The page landed but the app hasn't rendered it: the old cursor must not be asked for again.
  void h.loader.loadMoreDone(null);
  expect(h.pages.length).toBe(1);
  h.render();
  void h.loader.loadMoreDone(null);
  expect(h.pages.map((p) => p.cursor)).toEqual(["c1", "c2"]);
});

test("no request without a next cursor, and none after a failure until Retry", async () => {
  const h = harness();
  h.snapshot([], { tickets: [tk("a")], nextCursor: "c1", total: 5 });
  const first = h.loader.loadMoreDone(null);
  h.pages[0]!.d.reject(new Error("offline"));
  await first;
  expect(h.state.donePaging[ALL_SCOPE]!.error).toBe("offline");
  expect(h.loader.canLoadMoreDone(null)).toBe(false);
  await h.loader.loadMoreDone(null);
  expect(h.pages.length).toBe(1);
  const retry = h.loader.retryDone(null);
  expect(h.pages[1]!.cursor).toBe("c1");
  h.pages[1]!.d.resolve({ tickets: [tk("b")], nextCursor: null, total: 5 });
  await retry;
  expect(h.loader.canLoadMoreDone(null)).toBe(false); // last page
  await h.loader.loadMoreDone(null);
  expect(h.pages.length).toBe(2);
  expect(boardColumns(h.state, null).done.map((t) => t.id)).toEqual(["a", "b"]);
});

test("a Load more page that lands after a refetch is dropped (it belongs to the old paging run)", async () => {
  const h = harness();
  h.snapshot([], { tickets: [tk("a")], nextCursor: "old-cursor", total: 9 });
  const more = h.loader.loadMoreDone(null);
  h.snapshot([], { tickets: [tk("fresh")], nextCursor: "new-cursor", total: 9 }); // back from the background
  h.pages[0]!.d.resolve({ tickets: [tk("stale")], nextCursor: "older-cursor", total: 9 });
  await more;
  expect(h.state.tickets.stale).toBeUndefined();
  expect(h.state.donePaging[ALL_SCOPE]!.nextCursor).toBe("new-cursor");
  void h.loader.loadMoreDone(null);
  expect(h.pages.at(-1)!.cursor).toBe("new-cursor");
});

test("ensureFirstPage fetches a project's first page once; the legacy service is never paged", async () => {
  const h = harness();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  const p = h.loader.ensureFirstPage("p2");
  void h.loader.ensureFirstPage("p2");
  expect(h.pages.map((x) => [x.projectId, x.cursor])).toEqual([["p2", null]]);
  h.pages[0]!.d.resolve({ tickets: [tk("x", { projectId: "p2" })], nextCursor: null, total: 1 });
  await p;
  await h.loader.ensureFirstPage("p2");
  expect(h.pages.length).toBe(1);

  const old = harness();
  old.loader.legacy = true;
  old.snapshot([tk("d1")], null);
  await old.loader.ensureFirstPage(null);
  await old.loader.loadMoreDone(null);
  expect(old.pages.length).toBe(0);
});

test("search is debounced: one request for the last text of a burst", () => {
  const h = harness();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  h.loader.setQuery("g", null);
  h.loader.setQuery("gr", null);
  h.loader.setQuery("gre ", null);
  expect(h.searches.length).toBe(0);
  expect(h.state.search).toMatchObject({ q: "gre", ids: null });
  h.clock.fire();
  expect(h.searches.map((s) => s.q)).toEqual(["gre"]);
  h.loader.setQuery("gre", null); // trailing space trimmed away: same query, no new request
  h.clock.fire();
  expect(h.searches.length).toBe(1);
});

test("a slow response for an earlier query never overwrites a newer query's results (even the same text)", async () => {
  const h = harness();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  h.loader.setQuery("ab", null);
  h.clock.fire();
  h.loader.setQuery("abc", null);
  h.clock.fire();
  h.loader.setQuery("ab", null); // backspace: same text as the first, slow request
  h.clock.fire();
  expect(h.searches.map((s) => s.q)).toEqual(["ab", "abc", "ab"]);
  h.searches[2]!.d.resolve({ tickets: [tk("new", { title: "ab renamed" })], nextCursor: null, total: 1 });
  await flush();
  h.searches[0]!.d.resolve({ tickets: [tk("ancient")], nextCursor: null, total: 1 });
  h.searches[1]!.d.resolve({ tickets: [tk("abc-hit")], nextCursor: null, total: 1 });
  await flush();
  expect(h.state.search!.ids).toEqual(["new"]);
  expect(h.state.tickets.ancient).toBeUndefined();
});

test("clearing the search cancels a pending debounce and drops the response in flight", async () => {
  const h = harness();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  h.loader.setQuery("first", null);
  h.clock.fire();
  h.loader.setQuery("second", null);
  h.loader.setQuery("", null);
  expect(h.state.search).toBeNull();
  h.clock.fire();
  expect(h.searches.map((s) => s.q)).toEqual(["first"]);
  h.searches[0]!.d.resolve({ tickets: [tk("late")], nextCursor: null, total: 1 });
  await flush();
  expect(h.state.search).toBeNull();
  expect(h.state.tickets.late).toBeUndefined();
});

test("search load-more pages with the cursor once; results land in their status columns", async () => {
  const h = harness();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  h.loader.setQuery("x", "p1");
  h.clock.fire();
  expect(h.searches[0]!.projectId).toBe("p1");
  h.searches[0]!.d.resolve({ tickets: [tk("d1"), tk("r1", { status: "review", completedAt: null })], nextCursor: "s1", total: 3 });
  await flush();
  void h.loader.loadMoreSearch();
  void h.loader.loadMoreSearch();
  expect(h.searches.filter((s) => s.cursor === "s1").length).toBe(1);
  h.searches[1]!.d.resolve({ tickets: [tk("d2")], nextCursor: null, total: 3 });
  await flush();
  const { columns, pending } = searchColumns(h.state, "p1");
  expect(pending).toBe(false);
  expect(columns.done.map((t) => t.id)).toEqual(["d1", "d2"]);
  expect(columns.review.map((t) => t.id)).toEqual(["r1"]);
  expect(h.loader.canLoadMoreSearch()).toBe(false);
});

test("a refetch re-runs the active search and ignores the answer to the one before it", async () => {
  const h = harness();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  h.loader.setQuery("zap", null);
  h.clock.fire();
  h.snapshot([], { tickets: [], nextCursor: null, total: 0 });
  expect(h.searches.map((s) => s.q)).toEqual(["zap", "zap"]);
  h.searches[1]!.d.resolve({ tickets: [tk("fresh")], nextCursor: null, total: 1 });
  await flush();
  h.searches[0]!.d.resolve({ tickets: [tk("stale")], nextCursor: null, total: 1 });
  await flush();
  expect(h.state.search!.ids).toEqual(["fresh"]);
});
