import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import type { Ticket, TicketStatus } from "@harness/shared";
import { ensureSearchIndex, hasSearchIndex, migrate, MIGRATIONS, openDb } from "../db";
import { Store } from "./index";
import { clampLimit, CursorError, decodeCursor, encodeCursor, ftsQuery } from "./search";

afterEach(() => setSystemTime());

let clock = 1_000_000;
/** Advance the fake clock so every write gets a distinct timestamp. */
const tick = () => setSystemTime(new Date((clock += 1000)));

function seed() {
  const s = new Store(openDb(":memory:"));
  const p = s.projects.create({ path: "/a/alpha", name: "alpha", key: "A" });
  const q = s.projects.create({ path: "/a/beta", name: "beta", key: "B" });
  const add = (projectId: string, over: { title?: string; description?: string; status?: TicketStatus } = {}): Ticket => {
    tick();
    const key = s.transaction(() => s.projects.takeNextKey(projectId, (k) => s.tickets.keyExists(k)));
    const session = s.sessions.create({ key, kind: "ticket", ticketId: null, driver: "dummy", cwd: "/tmp", title: key });
    return s.tickets.create({
      key,
      projectId,
      kind: "task",
      title: over.title ?? key,
      description: over.description ?? "",
      status: over.status ?? "planning",
      sessionId: session.id,
      driver: "dummy",
      parentId: null,
      dependsOn: [],
      autoStart: false,
      externalRef: null,
      workdir: null,
    });
  };
  const complete = (t: Ticket) => {
    tick();
    return s.tickets.update(t.id, { status: "done" })!;
  };
  return { s, p, q, add, complete };
}

/** Every page of a done column, fetched one page at a time, with `between` run between fetches. */
function drain(s: Store, opts: { projectId?: string; limit: number; q?: string }, between: (page: number) => void = () => {}) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const res = s.tickets.page({ status: "done", ...opts, cursor });
    seen.push(...res.tickets.map((t) => t.key));
    cursor = res.nextCursor;
    between(page++);
  } while (cursor);
  return seen;
}

describe("completedAt", () => {
  test("set on entering done, kept while done, cleared on leaving, set again on re-entry", () => {
    const { s, p, add, complete } = seed();
    const t = add(p.id);
    expect(t.completedAt).toBeNull();
    const done = complete(t);
    expect(done.completedAt).toBe(clock);
    const firstDone = clock;
    tick();
    // An edit while done doesn't move it in the Done column.
    expect(s.tickets.update(t.id, { title: "renamed" })!.completedAt).toBe(firstDone);
    expect(s.tickets.update(t.id, { status: "done" })!.completedAt).toBe(firstDone);
    tick();
    expect(s.tickets.update(t.id, { status: "review" })!.completedAt).toBeNull();
    const again = complete(t);
    expect(again.completedAt).toBe(clock);
    expect(again.completedAt).toBeGreaterThan(firstDone);
  });

  test("a ticket created straight into done gets its creation time", () => {
    const { p, add } = seed();
    const t = add(p.id, { status: "done" });
    expect(t.completedAt).toBe(t.createdAt);
  });

  test("migration backfills done tickets from updatedAt and indexes existing tickets + latest summaries", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    for (let v = 0; v < 5; v++) db.exec(MIGRATIONS[v]!);
    db.exec("PRAGMA user_version = 5");
    db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p', 'OLD', 'old', '/x', 1, 1)`);
    const ins = db.query(
      `INSERT INTO tickets (id, key, project_id, kind, title, description, status, session_id, driver, created_at, updated_at)
       VALUES ($id, $key, 'p', 'task', $title, '', $status, $sid, 'dummy', 1, $u)`,
    );
    ins.run({ id: "t1", key: "OLD-1", title: "Shipped thing", status: "done", sid: "s1", u: 500 });
    ins.run({ id: "t2", key: "OLD-2", title: "Open thing", status: "review", sid: "s2", u: 700 });
    db.exec(`INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES
      ('m1', 's1', 't1', 'agent', 'stale words', 10), ('m2', 's1', 't1', 'agent', 'fresh zebra notes', 20)`);
    db.exec(`INSERT INTO ticket_key_aliases (key, ticket_id, created_at) VALUES ('ANCIENT-1', 't1', 1)`);
    migrate(db);
    const s = new Store(db);
    expect(s.tickets.get("t1")!.completedAt).toBe(500);
    expect(s.tickets.get("t2")!.completedAt).toBeNull();
    expect(s.tickets.search({ q: "zebra" }).tickets.map((t) => t.id)).toEqual(["t1"]);
    // Only the latest summary counts.
    expect(s.tickets.search({ q: "stale" }).total).toBe(0);
    expect(s.tickets.search({ q: "ancient-1" }).tickets.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("status filter", () => {
  test("list({ statuses }) returns only those statuses; an empty list returns nothing", () => {
    const { s, p, add, complete } = seed();
    const a = add(p.id);
    const b = add(p.id);
    complete(b);
    s.tickets.update(a.id, { status: "review" });
    add(p.id);
    expect(s.tickets.list({ projectId: p.id, statuses: ["planning", "review"] }).map((t) => t.status).sort()).toEqual(["planning", "review"]);
    expect(s.tickets.list({ statuses: ["done"] }).map((t) => t.id)).toEqual([b.id]);
    expect(s.tickets.list({ statuses: [] })).toEqual([]);
    expect(s.tickets.list({ projectId: p.id })).toHaveLength(3);
  });
});

describe("page", () => {
  test("done pages newest completion first, not by creation or update order", () => {
    const { s, p, add, complete } = seed();
    const [a, b, c] = [add(p.id), add(p.id), add(p.id)];
    complete(b);
    complete(a);
    complete(c);
    tick();
    s.tickets.update(b.id, { title: "edited after completion" }); // updatedAt changes; completion order doesn't
    const res = s.tickets.page({ status: "done", projectId: p.id });
    expect(res.tickets.map((t) => t.key)).toEqual([c.key, a.key, b.key]);
    expect(res.total).toBe(3);
    expect(res.nextCursor).toBeNull();
  });

  test("cursor continuity: no dupes or skips when tickets complete or are deleted between fetches", () => {
    const { s, p, add, complete } = seed();
    const tickets = Array.from({ length: 10 }, () => add(p.id));
    for (const t of tickets) complete(t);
    const late = add(p.id);
    const expected = [...tickets].reverse().map((t) => t.key); // newest completion first
    const deleted = expected[5]!; // on the second page, deleted after the first fetch
    const seen = drain(s, { projectId: p.id, limit: 3 }, (page) => {
      if (page === 0) {
        complete(late); // newer than everything: lands before the cursor, not in a later page
        s.tickets.delete(tickets.find((t) => t.key === deleted)!.id);
        s.tickets.delete(tickets.find((t) => t.key === expected[0])!.id); // already fetched
      }
    });
    expect(seen).toEqual(expected.filter((k) => k !== deleted));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("ties on completion time are broken by id, so paging over equal timestamps is still exact", () => {
    const { s, p, add } = seed();
    const tickets = Array.from({ length: 7 }, () => add(p.id));
    s.db.exec("UPDATE tickets SET status = 'done', completed_at = 42");
    const seen = drain(s, { projectId: p.id, limit: 2 });
    expect(seen.sort()).toEqual(tickets.map((t) => t.key).sort());
  });

  test("other statuses page by position then creation", () => {
    const { s, p, add } = seed();
    const [a, b, c, d] = [add(p.id), add(p.id), add(p.id), add(p.id)];
    s.tickets.update(d.id, { position: 0.5 });
    s.tickets.update(b.id, { position: a.position }); // same position as a, created later
    const first = s.tickets.page({ status: "planning", projectId: p.id, limit: 2 });
    expect(first.tickets.map((t) => t.key)).toEqual([d.key, a.key]);
    const second = s.tickets.page({ status: "planning", projectId: p.id, limit: 2, cursor: first.nextCursor });
    expect(second.tickets.map((t) => t.key)).toEqual([b.key, c.key]);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(4);
  });

  test("limit is clamped to 1..200 and total counts the whole filter", () => {
    const { s, p, q, add } = seed();
    for (let i = 0; i < 205; i++) add(p.id, { status: "done" });
    add(q.id, { status: "done" });
    expect(s.tickets.page({ status: "done", limit: 1000 }).tickets).toHaveLength(200);
    expect(s.tickets.page({ status: "done", limit: 0 }).tickets).toHaveLength(1);
    expect(s.tickets.page({ status: "done" }).tickets).toHaveLength(50);
    expect(s.tickets.page({ status: "done", projectId: p.id, limit: 5 }).total).toBe(205);
    expect(s.tickets.page({ status: "done" }).total).toBe(206);
    expect(s.tickets.page({ status: "review" })).toEqual({ tickets: [], nextCursor: null, total: 0 });
  });

  test("q narrows a page (and its total) to search hits", () => {
    const { s, p, add } = seed();
    add(p.id, { status: "done", title: "fix login bug" });
    add(p.id, { status: "done", title: "unrelated" });
    add(p.id, { status: "done", title: "login screen polish" });
    add(p.id, { status: "planning", title: "login later" });
    const first = s.tickets.page({ status: "done", q: "login", limit: 1 });
    expect(first.total).toBe(2);
    const second = s.tickets.page({ status: "done", q: "login", limit: 1, cursor: first.nextCursor });
    expect([...first.tickets, ...second.tickets].map((t) => t.title)).toEqual(["login screen polish", "fix login bug"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a cursor from another ordering or garbage is rejected", () => {
    const { s, p, add } = seed();
    add(p.id);
    add(p.id);
    const planning = s.tickets.page({ status: "planning", limit: 1 }).nextCursor!;
    expect(() => s.tickets.page({ status: "done", cursor: planning })).toThrow(CursorError);
    expect(() => s.tickets.page({ status: "done", cursor: "not-a-cursor" })).toThrow(CursorError);
    expect(() => s.tickets.search({ q: "a", cursor: planning })).toThrow(CursorError);
  });
});

describe("search", () => {
  function corpus() {
    const env = seed();
    const { s, p, q, add, complete } = env;
    const login = add(p.id, { title: "Login page", description: "the form" }); // A-1
    const other = add(p.id, { title: "Settings", description: "remember the login choice" }); // A-2
    const summarized = add(p.id, { title: "Refactor", description: "internals" }); // A-3
    s.summaries.add({ sessionId: summarized.sessionId, ticketId: summarized.id, author: "agent", body: "reworked the login throttle" });
    const beta = add(q.id, { title: "Login for beta", description: "" }); // B-1
    complete(beta);
    return { ...env, login, other, summarized, beta };
  }

  test("matches title, description and latest summary; title hits rank above the rest, newest first", () => {
    const { s, login, other, summarized, beta } = corpus();
    const res = s.tickets.search({ q: "login" });
    // Title matches (newest first), then description/summary matches (newest first), across statuses.
    expect(res.tickets.map((t) => t.id)).toEqual([beta.id, login.id, summarized.id, other.id]);
    expect(res.total).toBe(4);
    expect(s.tickets.search({ q: "throttle" }).tickets.map((t) => t.id)).toEqual([summarized.id]);
    expect(s.tickets.search({ q: "rememb" }).tickets.map((t) => t.id)).toEqual([other.id]); // prefix
    expect(s.tickets.search({ q: "LOGIN FORM" }).tickets.map((t) => t.id)).toEqual([login.id]); // every term, any column
  });

  test("key matches rank first: exact, then prefix; old keys via aliases resolve too", () => {
    const { s, p, add, login, other } = corpus();
    for (let i = 0; i < 8; i++) add(p.id); // A-4..A-11
    const exact = s.tickets.search({ q: "a-1" });
    expect(exact.tickets[0]!.id).toBe(login.id);
    expect(exact.tickets.slice(1, 3).map((t) => t.key)).toEqual(["A-11", "A-10"]); // prefix hits, newest first
    s.projects.rekey(p.id, "ZED");
    expect(s.tickets.search({ q: "a-2" }).tickets[0]!.id).toBe(other.id); // pre-rename key
    expect(s.tickets.search({ q: "zed-2" }).tickets[0]!.id).toBe(other.id);
    // A key hit beats a title hit on the same word.
    const titled = add(p.id, { title: "zed-2 lookalike" });
    expect(s.tickets.search({ q: "ZED-2" }).tickets.map((t) => t.id).slice(0, 2)).toEqual([other.id, titled.id]);
  });

  test("user input with FTS syntax is literal, never a syntax error", () => {
    const { s, p, add } = corpus();
    const quoted = add(p.id, { title: `say "hello" (loudly)`, description: "a:b c-d e*f NOT near" });
    for (const q of [`"`, `"hello`, `hello"`, `*`, `hel*`, `-`, `-hello`, `:`, `title:hello`, `(`, `)`, `(hello`, `hello)`, `NOT`, `AND OR`, `^`, `{title}`, `'`, `%`, `_`, `\\`]) {
      expect(() => s.tickets.search({ q })).not.toThrow();
    }
    expect(s.tickets.search({ q: `"hello"` }).tickets.map((t) => t.id)).toEqual([quoted.id]);
    expect(s.tickets.search({ q: `(loud` }).tickets.map((t) => t.id)).toEqual([quoted.id]);
    expect(s.tickets.search({ q: `-hello` }).tickets.map((t) => t.id)).toEqual([quoted.id]); // not a NOT
    expect(s.tickets.search({ q: `a:b` }).tickets.map((t) => t.id)).toEqual([quoted.id]); // not a column filter
    expect(s.tickets.search({ q: `c-d` }).tickets.map((t) => t.id)).toEqual([quoted.id]);
    expect(s.tickets.search({ q: `NOT` }).tickets.map((t) => t.id)).toEqual([quoted.id]); // a word, not an operator
    // Punctuation-only queries match nothing (rather than everything).
    expect(s.tickets.search({ q: `*` }).total).toBe(0);
    expect(s.tickets.search({ q: `" ( ) :` }).total).toBe(0);
    // LIKE wildcards in a key query are literal.
    expect(s.tickets.search({ q: `%` }).total).toBe(0);
    expect(s.tickets.search({ q: `_` }).total).toBe(0);
  });

  test("projectId scopes results and total", () => {
    const { s, p, q, beta } = corpus();
    expect(s.tickets.search({ q: "login", projectId: q.id }).tickets.map((t) => t.id)).toEqual([beta.id]);
    expect(s.tickets.search({ q: "login", projectId: p.id }).total).toBe(3);
  });

  test("pages through results with no dupes or skips", () => {
    const { s, p, add } = seed();
    for (let i = 0; i < 7; i++) add(p.id, { title: `widget ${i}` });
    for (let i = 0; i < 6; i++) add(p.id, { description: `widget body ${i}` });
    const all = s.tickets.search({ q: "widget", limit: 200 }).tickets.map((t) => t.id);
    expect(all).toHaveLength(13);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const res = s.tickets.search({ q: "widget", limit: 4, cursor });
      expect(res.total).toBe(13);
      paged.push(...res.tickets.map((t) => t.id));
      cursor = res.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all);
  });

  test("index stays in sync after update, rename, delete and new summaries", () => {
    const { s, p, add } = seed();
    const t = add(p.id, { title: "alpha words", description: "bravo" });
    expect(s.tickets.search({ q: "alpha" }).total).toBe(1);
    s.tickets.update(t.id, { title: "charlie words", description: "delta" });
    expect(s.tickets.search({ q: "alpha" }).total).toBe(0);
    expect(s.tickets.search({ q: "bravo" }).total).toBe(0);
    expect(s.tickets.search({ q: "charlie delta" }).total).toBe(1);

    s.summaries.add({ sessionId: t.sessionId, ticketId: t.id, author: "agent", body: "first echo" });
    expect(s.tickets.search({ q: "echo" }).total).toBe(1);
    tick();
    s.summaries.add({ sessionId: t.sessionId, ticketId: t.id, author: "agent", body: "second foxtrot" });
    expect(s.tickets.search({ q: "echo" }).total).toBe(0); // only the latest summary is indexed
    expect(s.tickets.search({ q: "foxtrot" }).total).toBe(1);

    s.projects.rekey(p.id, "NEWKEY");
    expect(s.tickets.search({ q: "newkey" }).tickets.map((x) => x.key)).toEqual(["NEWKEY-1"]);
    expect(s.tickets.search({ q: "a-1" }).tickets.map((x) => x.key)).toEqual(["NEWKEY-1"]);

    s.tickets.delete(t.id);
    for (const q of ["charlie", "foxtrot", "newkey", "a-1"]) expect(s.tickets.search({ q }).total).toBe(0);
    const ftsRows = s.db.query("SELECT COUNT(*) AS n FROM ticket_fts WHERE ticket_fts MATCH 'charlie'").get() as { n: number };
    expect(ftsRows.n).toBe(0);
  });

  test("without the FTS index, search falls back to LIKE with the same ranking; the index rebuilds when reopened", () => {
    const { s, p, add } = seed();
    const titled = add(p.id, { title: "Gamma ray" });
    const described = add(p.id, { description: "a gamma burst" });
    s.db.exec("DROP TABLE ticket_fts; DROP TRIGGER IF EXISTS ticket_fts_insert; DROP TRIGGER IF EXISTS ticket_fts_delete; DROP TRIGGER IF EXISTS ticket_fts_update;");
    expect(hasSearchIndex(s.db)).toBe(false);
    const fallback = new Store(s.db);
    const later = add(p.id, { title: "gamma (again)" }); // written while there's no index
    expect(fallback.tickets.search({ q: "GAMMA" }).tickets.map((t) => t.id)).toEqual([later.id, titled.id, described.id]);
    expect(fallback.tickets.search({ q: `(again` }).tickets.map((t) => t.id)).toEqual([later.id]);
    expect(fallback.tickets.search({ q: "%" }).total).toBe(0);
    expect(ensureSearchIndex(s.db)).toBe(true);
    const rebuilt = new Store(s.db);
    expect(rebuilt.tickets.search({ q: "gam" }).tickets.map((t) => t.id)).toEqual([later.id, titled.id, described.id]);
  });
});

describe("helpers", () => {
  test("clampLimit", () => {
    expect(clampLimit(undefined, 50)).toBe(50);
    expect(clampLimit("", 50)).toBe(50);
    expect(clampLimit("abc", 50)).toBe(50);
    expect(clampLimit("0", 50)).toBe(1);
    expect(clampLimit("-5", 50)).toBe(1);
    expect(clampLimit("201", 50)).toBe(200);
    expect(clampLimit("7.9", 50)).toBe(7);
  });

  test("cursor round-trips and rejects a wrong tag or shape", () => {
    const c = encodeCursor("d", [5, "id"]);
    expect(decodeCursor(c, "d", ["n", "s"])).toEqual([5, "id"]);
    expect(() => decodeCursor(c, "p", ["n", "s"])).toThrow(CursorError);
    expect(() => decodeCursor(c, "d", ["s", "s"])).toThrow(CursorError);
    expect(() => decodeCursor(encodeCursor("d", [5]), "d", ["n", "s"])).toThrow(CursorError);
  });

  test("ftsQuery quotes each term with a prefix star and doubles quotes", () => {
    expect(ftsQuery(`  foo  "bar" `)).toBe(`"foo"* """bar"""*`);
    expect(ftsQuery("a b", "title")).toBe(`{title} : ("a"* "b"*)`);
    expect(ftsQuery(" * - ")).toBeNull();
  });
});
