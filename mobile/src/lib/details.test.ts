import { expect, test } from "bun:test";
import { HarnessApiError, type Ticket, type TicketDetail } from "@harness/shared";
import { dependencyStates, initialState, progressOf, childrenOf, reducer, type Action, type State } from "@harness/shared/state";
import { DetailFetcher } from "./details";

let n = 0;
const tk = (key: string, extra: Partial<Ticket> = {}): Ticket =>
  ({ id: `id-${key}`, key, title: key, status: "planning", kind: "task", projectId: "p", parentId: null, dependsOn: [], position: 0, createdAt: ++n, updatedAt: n, completedAt: null, sessionId: `s-${key}`, ...extra }) as Ticket;
const detailOf = (t: Ticket, children: Ticket[] = []): TicketDetail => ({ ticket: t, session: { id: t.sessionId } as TicketDetail["session"], summaries: [], runs: [], dependents: [], children });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(open: Ticket[], concurrency = 2) {
  let state: State = reducer(initialState, { type: "snapshot", snapshot: { projects: [], tickets: open, sessions: [], watchers: [], settings: null, drivers: [] } });
  const dispatch = (a: Action) => (state = reducer(state, a));
  const calls: { key: string; d: ReturnType<typeof deferred<TicketDetail>> }[] = [];
  const related: Record<string, string[]> = {};
  const remote: Record<string, string[]> = {};
  const f = new DetailFetcher({
    client: {
      getTicket: (key) => {
        const d = deferred<TicketDetail>();
        calls.push({ key, d });
        return d.promise;
      },
    },
    dispatch,
    concurrency,
    onRelated: (id, list) => (related[id] = list.map((r) => r.key)),
    onRemoteKey: (key, list) => (remote[key] = list.map((r) => r.key)),
  });
  return { f, calls, related, remote, get state() { return state; } };
}

test("an unloaded (older, done) dependency is fetched once and its chip settles from unknown to done", async () => {
  const waiting = tk("A-2", { dependsOn: ["A-1"] });
  const h = setup([waiting]);
  expect(dependencyStates(h.state, waiting)[0]!.state).toBe("unknown");
  h.f.sync(h.state);
  h.f.sync(h.state); // a re-render before the answer
  expect(h.calls.map((c) => c.key)).toEqual(["A-1"]);
  h.calls[0]!.d.resolve(detailOf(tk("A-1", { status: "done", completedAt: 5 })));
  await flush();
  expect(dependencyStates(h.state, waiting)[0]).toMatchObject({ state: "done", done: true });
  h.f.sync(h.state);
  expect(h.calls.length).toBe(1);
});

test("a 404 is recorded as missing and not asked for again", async () => {
  const h = setup([tk("A-2", { dependsOn: ["GONE-1"] })]);
  h.f.sync(h.state);
  h.calls[0]!.d.reject(new HarnessApiError(404, "Unknown ticket"));
  await flush();
  expect(h.state.missingKeys["GONE-1"]).toBe(true);
  h.f.reset();
  h.f.sync(h.state);
  expect(h.calls.length).toBe(1);
});

test("a conductor's detail fills in its done children, so the card rollup counts them", async () => {
  const conductor = tk("C-1", { kind: "conductor", status: "in_progress" });
  const live = tk("C-3", { parentId: conductor.id, status: "in_progress" });
  const h = setup([conductor, live]);
  expect(progressOf(childrenOf(h.state, conductor.id)).total).toBe(1);
  h.f.sync(h.state);
  expect(h.calls.map((c) => c.key)).toEqual(["C-1"]);
  h.calls[0]!.d.resolve(detailOf(conductor, [tk("C-2", { parentId: conductor.id, status: "done", completedAt: 3 }), live]));
  await flush();
  const p = progressOf(childrenOf(h.state, conductor.id));
  expect([p.total, p.byStatus.done]).toEqual([2, 1]);
});

test("at most `concurrency` requests at a time; the rest queue", async () => {
  const h = setup([tk("X-9", { dependsOn: ["X-1", "X-2", "X-3"] })], 2);
  h.f.sync(h.state);
  expect(h.calls.map((c) => c.key)).toEqual(["X-1", "X-2"]);
  h.calls[0]!.d.resolve(detailOf(tk("X-1", { status: "done" })));
  await flush();
  expect(h.calls.map((c) => c.key)).toEqual(["X-1", "X-2", "X-3"]);
});

test("load() for a screen shares the request already in flight for the same key", async () => {
  const h = setup([tk("A-2", { dependsOn: ["A-1"] })]);
  h.f.sync(h.state);
  const p = h.f.load("a-1");
  expect(h.calls.length).toBe(1);
  h.calls[0]!.d.resolve(detailOf(tk("A-1")));
  expect((await p).ticket.key).toBe("A-1");
});

const linked = (key: string) => ({ key, title: key, status: "planning" as const, projectId: "p", externalKey: "JIRA-9" });

test("a detail's relatedTickets are handed over by ticket id; an older service's detail leaves them alone", async () => {
  const h = setup([]);
  const a = tk("MH-124");
  const p = h.f.load("MH-124");
  h.calls[0]!.d.resolve({ ...detailOf(a), relatedTickets: [linked("MH-130")] });
  await p;
  expect(h.related[a.id]).toEqual(["MH-130"]);
  const q = h.f.load("MH-124");
  h.calls[1]!.d.resolve(detailOf(a));
  await q;
  expect(h.related[a.id]).toEqual(["MH-130"]);
});

test("a remote-only key's 404 hands over the tickets it points to; a plain 404 hands over none", async () => {
  const h = setup([]);
  const p = h.f.load("jira-9").catch((e: unknown) => e);
  h.calls[0]!.d.reject(new HarnessApiError(404, "Unknown ticket", { requested: "JIRA-9", relatedTickets: [linked("MH-124"), linked("MH-130")] }));
  expect(await p).toBeInstanceOf(HarnessApiError);
  expect(h.remote["JIRA-9"]).toEqual(["MH-124", "MH-130"]);
  expect(h.state.missingKeys["JIRA-9"]).toBe(true);
  const q = h.f.load("GONE-1").catch(() => {});
  h.calls[1]!.d.reject(new HarnessApiError(404, "Unknown ticket"));
  await q;
  expect(h.remote["GONE-1"]).toEqual([]);
});
