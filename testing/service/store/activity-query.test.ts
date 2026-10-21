import { expect, test } from "bun:test";
import { CursorError } from "../../../service/src/store/search";
import { ScopedStore } from "../../../service/src/store/scope";
import { fakeClock } from "../../builders/clock";
import { addProject, addTicket, makeStore } from "../../builders/store";

const HOUR = 3_600_000;

/** Group Work (WK) and group Home (HM), one ticket each, every entry stamped by a clock the test moves. */
function board() {
  const clock = fakeClock(1_700_000_000_000);
  const store = makeStore({ now: clock });
  const work = store.groups.findOrCreate("Work");
  const home = store.groups.findOrCreate("Home");
  const wk = addProject(store, { key: "WK", groupId: work.id });
  const hm = addProject(store, { key: "HM", groupId: home.id, path: "/hm" });
  const w1 = addTicket(store, wk, { title: "walrus one" });
  const h1 = addTicket(store, hm, { title: "home one" });
  const log = (t: typeof w1, kind: "note" | "blocked" | "answered" | "approved", body: string, meta = {}) =>
    store.activity.add({ sessionId: t.sessionId, ticketId: t.id, kind, author: kind === "answered" ? "human" : "agent", body, meta });
  const scoped = (group: string | "all") => new ScopedStore(store, group === "all" ? "all" : { group });
  return { clock, store, work, home, wk, hm, w1, h1, log, scoped };
}

const bodies = (r: { hits: { entry: { body: string } }[] }) => r.hits.map((h) => h.entry.body);

test("time range is from-inclusive and to-exclusive, newest first", () => {
  const { clock, log, w1, scoped } = board();
  log(w1, "note", "early");
  clock.advance(HOUR);
  const noon = clock();
  log(w1, "note", "noon");
  clock.advance(HOUR);
  log(w1, "note", "late");
  const sc = scoped("all");
  expect(bodies(sc.queryActivity({}))).toEqual(["late", "noon", "early"]);
  expect(bodies(sc.queryActivity({ from: noon }))).toEqual(["late", "noon"]);
  expect(bodies(sc.queryActivity({ to: noon }))).toEqual(["early"]);
  expect(bodies(sc.queryActivity({ from: noon, to: noon + HOUR }))).toEqual(["noon"]);
});

test("project, ticket and kind filters narrow the page; an unknown project or ticket is an empty page", () => {
  const { log, w1, h1, scoped } = board();
  log(w1, "note", "w note");
  log(w1, "approved", "w approved");
  log(h1, "note", "h note");
  const sc = scoped("all");
  expect(bodies(sc.queryActivity({ projectKeys: ["HM"] }))).toEqual(["h note"]);
  expect(bodies(sc.queryActivity({ projectKeys: ["HM", "WK"] }))).toHaveLength(3);
  expect(bodies(sc.queryActivity({ ticketKey: w1.key }))).toEqual(["w approved", "w note"]);
  expect(bodies(sc.queryActivity({ kinds: ["approved"] }))).toEqual(["w approved"]);
  expect(sc.queryActivity({ projectKeys: ["NOPE"] }).hits).toEqual([]);
  expect(sc.queryActivity({ projectKeys: [] }).hits).toEqual([]);
  expect(sc.queryActivity({ ticketKey: "NOPE-1" }).hits).toEqual([]);
});

test("a group scope never sees another group's rows, by project, by ticket id or unfiltered; all sees every group", () => {
  const { log, w1, h1, work, home, scoped } = board();
  log(w1, "note", "work secret");
  log(h1, "note", "home secret");
  expect(bodies(scoped(work.id).queryActivity({}))).toEqual(["work secret"]);
  expect(bodies(scoped(home.id).queryActivity({}))).toEqual(["home secret"]);
  // Naming the other group's project or ticket doesn't get around it, and doesn't say it exists.
  expect(scoped(work.id).queryActivity({ projectKeys: ["HM"] })).toEqual({ hits: [], nextCursor: null });
  expect(scoped(work.id).queryActivity({ ticketKey: h1.key })).toEqual({ hits: [], nextCursor: null });
  expect(scoped(work.id).queryActivity({ ticketKey: "NOPE-1" })).toEqual(scoped(work.id).queryActivity({ ticketKey: h1.key }));
  expect(bodies(scoped("all").queryActivity({})).sort()).toEqual(["home secret", "work secret"]);
});

test("rows with no ticket, a chief's own ticket and the internal project are never returned, even to all", () => {
  const { store, log, w1, scoped } = board();
  log(w1, "note", "visible");
  store.activity.add({ sessionId: w1.sessionId, ticketId: null, kind: "note", author: "system", body: "no ticket" });
  const hidden = addTicket(store, store.projects.internal("/internal"), { title: "internal" });
  log(hidden, "note", "internal project");
  const cos = store.tickets.create({ key: "CHIEF-77", projectId: w1.projectId, kind: "cos", title: "Chief", spec: "", status: "in_progress", sessionId: hidden.sessionId, driver: "claude-code", parentId: null, dependsOn: [], autoStart: false, externalRef: null, workdir: null });
  store.activity.add({ sessionId: hidden.sessionId, ticketId: cos.id, kind: "note", author: "agent", body: "chief" });
  expect(bodies(scoped("all").queryActivity({}))).toEqual(["visible"]);
});

test("paging walks rows that share one timestamp without skipping or repeating any", () => {
  const { log, w1, scoped } = board();
  for (let i = 0; i < 5; i++) log(w1, "note", `n${i}`); // the clock never moves: every created_at is equal
  const sc = scoped("all");
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = sc.queryActivity({ limit: 2, cursor });
    seen.push(...bodies(page));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen.sort()).toEqual(["n0", "n1", "n2", "n3", "n4"]);
  expect(() => scoped("all").queryActivity({ cursor: "garbage" })).toThrow(CursorError);
});

test("a blocked entry comes with the human's replies that name it, and not with those of a later block", () => {
  const { clock, log, w1, scoped } = board();
  const first = log(w1, "blocked", "Which db?", { question: "Which db?" });
  clock.advance(1000);
  log(w1, "answered", "Postgres", { answers: first.id });
  clock.advance(1000);
  const second = log(w1, "blocked", "Which region?", { question: "Which region?" });
  const hits = scoped("all").queryActivity({ kinds: ["blocked"] }).hits;
  const byId = Object.fromEntries(hits.map((h) => [h.entry.id, h.answers.map((a) => a.body)]));
  expect(byId[first.id]).toEqual(["Postgres"]);
  expect(byId[second.id]).toEqual([]);
});
