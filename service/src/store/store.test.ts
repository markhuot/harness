import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MIGRATIONS, migrate, openDb, SCHEMA_VERSION } from "../db";
import type { ExternalRef, SummaryAttachment } from "@harness/shared";
import { Store } from "./index";
import { insideGitCheckout } from "./projects";
import { tempDir } from "@harness/shared/testing";

const mk = () => new Store(openDb(":memory:"));

function ticketFor(store: Store, projectId: string, key: string, deps: string[] = [], externalRef: ExternalRef | null = null) {
  const session = store.sessions.create({ key, kind: "ticket", ticketId: null, driver: "dummy", cwd: "/tmp", title: key });
  return store.tickets.create({
    key,
    projectId,
    kind: "task",
    title: key,
    description: "",
    status: "planning",
    sessionId: session.id,
    driver: "dummy",
    parentId: null,
    dependsOn: deps,
    autoStart: false,
    externalRef,
    workdir: null,
  });
}

const ext = (key: string): ExternalRef => ({ source: "jira", key, url: null, raw: {} });

describe("db", () => {
  test("migrations set user_version and are idempotent; WAL on file dbs", () => {
    const dir = tempDir("harness-db-");
    const db = openDb(join(dir, "h.db"));
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    migrate(db); // second run must not re-create tables
    db.close();
    const again = openDb(join(dir, "h.db"));
    expect((again.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
    again.close();
  });

  test("migration 7 turns autoComplete on for projects that already exist", () => {
    const db = new Database(":memory:", { strict: true });
    for (const [v, sql] of MIGRATIONS.slice(0, 6).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec(`INSERT INTO projects (id, key, name, path, next_seq, created_at, updated_at) VALUES ('p1', 'OLD', 'old', '/old', 1, 0, 0)`);
    migrate(db);
    const store = new Store(db);
    expect(store.projects.get("p1")!.autoComplete).toBe(true);
    const off = store.projects.update("p1", { autoComplete: false })!;
    expect(off.autoComplete).toBe(false);
    expect(store.projects.update("p1", { name: "renamed" })!.autoComplete).toBe(false);
  });

  test("migration 8 gives existing watchers an empty prompt and keeps their command + args", () => {
    const db = new Database(":memory:", { strict: true });
    for (const [v, sql] of MIGRATIONS.slice(0, 7).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec(
      `INSERT INTO watchers (id, name, command, args, created_at, updated_at) VALUES ('w1', 'jira', 'node', '["watch-jira.js","--project","FOO"]', 0, 0)`,
    );
    migrate(db);
    const w = new Store(db).watchers.get("w1")!;
    expect(w.prompt).toBe("");
    expect(w.command).toBe("node");
    expect(w.args).toEqual(["watch-jira.js", "--project", "FOO"]);
  });

  test("migration 9 drops the mappings table and its rows, leaving projects and watchers alone", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    for (const [v, sql] of MIGRATIONS.slice(0, 8).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'FOO', 'Foo', '/tmp/foo', 0, 0)`);
    db.exec(`INSERT INTO watchers (id, name, command, prompt, created_at, updated_at) VALUES ('w1', 'jira', 'node', 'Dispatch to FOO', 0, 0)`);
    db.exec(`INSERT INTO mappings (id, pattern, project_id, notes, created_at) VALUES ('m1', 'FOO', 'p1', 'foo team', 0), ('m2', '/^BAR-/', 'p1', '', 0)`);
    migrate(db);
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'mappings'").get()).toBeNull();
    const store = new Store(db);
    expect(store.projects.get("p1")!.key).toBe("FOO");
    expect(store.watchers.get("w1")!.prompt).toBe("Dispatch to FOO");
    // The rows that pointed at p1 are gone with the table, so the project still deletes cleanly.
    store.projects.delete("p1");
    expect(store.projects.get("p1")).toBeNull();
  });

  test("migration 10 leaves existing projects without a color; update sets, keeps and clears it", () => {
    const db = new Database(":memory:", { strict: true });
    for (const [v, sql] of MIGRATIONS.slice(0, 9).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'OLD', 'old', '/old', 0, 0)`);
    migrate(db);
    const store = new Store(db);
    expect(store.projects.get("p1")!.color).toBeNull();
    expect(store.projects.update("p1", { color: "teal" })!.color).toBe("teal");
    expect(store.projects.update("p1", { name: "renamed" })!.color).toBe("teal");
    expect(store.projects.update("p1", { color: null })!.color).toBeNull();
    expect(store.projects.create({ path: "/new", name: "new", color: "#12ab34" }).color).toBe("#12ab34");
  });

  test("refuses a database from a newer schema", () => {
    const db = new Database(":memory:");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
  });
});

describe("projects", () => {
  test("keys derive from the path and de-duplicate", () => {
    const s = mk();
    const a = s.projects.create({ path: "/Users/x/nytimes", name: "a" });
    const b = s.projects.create({ path: "/other/nytimes/", name: "b" });
    const c = s.projects.create({ path: "/third/NYTimes", name: "c" });
    expect([a.key, b.key, c.key]).toEqual(["NYTIMES", "NYTIMES2", "NYTIMES3"]);
    const custom = s.projects.create({ path: "/x/y", name: "d", key: "my-app" });
    expect(custom.key).toBe("MYAPP");
  });

  test("update patches settings but never the key", () => {
    const s = mk();
    const a = s.projects.create({ path: "/a/foo", name: "foo" });
    const u = s.projects.update(a.id, { name: "Foo", useWorktrees: false, key: "BAR" } as any)!;
    expect(u.key).toBe("FOO");
    expect(u.name).toBe("Foo");
    expect(u.useWorktrees).toBe(false);
  });

  test("isGit: true in a repo and below its root (a .git dir or a worktree's .git file), false elsewhere", () => {
    const plain = tempDir("harness-nogit-");
    const repo = tempDir("harness-git-");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    const worktree = tempDir("harness-wt-");
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    expect([plain, repo, join(repo, "packages", "app"), worktree].map(insideGitCheckout)).toEqual([false, true, true, true]);
    const s = mk();
    expect(s.projects.create({ path: plain, name: "p" }).isGit).toBe(false);
    expect(s.projects.create({ path: join(repo, "packages", "app"), name: "a" }).isGit).toBe(true);
  });

  test("derived keys skip the reserved TRIAGE prefix", () => {
    const s = mk();
    expect(s.projects.create({ path: "/x/triage", name: "t" }).key).toBe("TRIAGE2");
  });

  test("native keys come from nextSeq and skip keys already taken", () => {
    const s = mk();
    const p = s.projects.create({ path: "/a/foo", name: "foo" });
    const k1 = s.transaction(() => s.projects.takeNextKey(p.id, (k) => s.tickets.keyExists(k)));
    ticketFor(s, p.id, k1);
    ticketFor(s, p.id, "FOO-2"); // external mirror that collides with the native sequence
    const k2 = s.transaction(() => s.projects.takeNextKey(p.id, (k) => s.tickets.keyExists(k)));
    expect(k1).toBe("FOO-1");
    expect(k2).toBe("FOO-3");
    expect(s.projects.get(p.id)!.nextSeq).toBe(4);
  });
});

describe("project rekey", () => {
  function seed() {
    const s = mk();
    const p = s.projects.create({ path: "/a/helloharness", name: "hello" });
    const other = s.projects.create({ path: "/a/other", name: "other" });
    const take = () => s.transaction(() => s.projects.takeNextKey(p.id, (k) => s.tickets.keyExists(k)));
    const t1 = ticketFor(s, p.id, take());
    const t2 = ticketFor(s, p.id, take(), [t1.key]);
    const t3 = ticketFor(s, p.id, take(), [t2.key, "FOO-123"]);
    const mirror = ticketFor(s, p.id, "FOO-123", [], ext("FOO-123"));
    // An external mirror that happens to share the native prefix is still external.
    const lookalike = ticketFor(s, p.id, "HELLOHARNESS-40", [], ext("HELLOHARNESS-40"));
    const crossDep = ticketFor(s, other.id, "OTHER-1", [t3.key]);
    return { s, p, other, t1, t2, t3, mirror, lookalike, crossDep, take };
  }

  test("renames native tickets, their sessions and every dependency; external keys stay", () => {
    const { s, p, t1, t2, t3, mirror, lookalike, crossDep } = seed();
    expect(s.projects.nativeTicketKeys(p.id).map((n) => n.key)).toEqual(["HELLOHARNESS-1", "HELLOHARNESS-2", "HELLOHARNESS-3"]);
    const { renames, depTicketIds } = s.projects.rekey(p.id, "HEL");
    expect([...renames]).toEqual([
      ["HELLOHARNESS-1", "HEL-1"],
      ["HELLOHARNESS-2", "HEL-2"],
      ["HELLOHARNESS-3", "HEL-3"],
    ]);
    expect(depTicketIds.sort()).toEqual([t2.id, t3.id, crossDep.id].sort());
    expect(s.projects.get(p.id)!.key).toBe("HEL");
    expect(s.tickets.get(t1.id)!.key).toBe("HEL-1");
    expect(s.sessions.get(t1.sessionId)!.key).toBe("HEL-1");
    expect(s.tickets.get(t2.id)!.dependsOn).toEqual(["HEL-1"]);
    expect(s.tickets.get(t3.id)!.dependsOn).toEqual(["HEL-2", "FOO-123"]);
    expect(s.tickets.get(crossDep.id)!.dependsOn).toEqual(["HEL-3"]);
    expect(s.tickets.dependents("HEL-3").map((t) => t.key)).toEqual(["OTHER-1"]);
    expect(s.tickets.get(mirror.id)!.key).toBe("FOO-123");
    expect(s.tickets.get(lookalike.id)!.key).toBe("HELLOHARNESS-40");
    expect(s.sessions.get(lookalike.sessionId)!.key).toBe("HELLOHARNESS-40");
    // The old keys stay as aliases of the renamed tickets (see "ticket key aliases").
    expect(s.tickets.getByKey("HELLOHARNESS-1")!.id).toBe(t1.id);
    expect(s.tickets.aliases(mirror.id)).toEqual([]);
  });

  test("nextSeq continues under the new key", () => {
    const { s, p, take } = seed();
    s.projects.rekey(p.id, "HEL");
    expect(s.projects.get(p.id)!.nextSeq).toBe(4);
    expect(take()).toBe("HEL-4");
  });

  test("collisions are reported and abort the whole rename", () => {
    const { s, p, other, t1 } = seed();
    ticketFor(s, other.id, "HEL-2", [], ext("HEL-2"));
    expect(s.projects.rekeyConflicts(p.id, "HEL")).toEqual(["HEL-2"]);
    expect(() => s.projects.rekey(p.id, "HEL")).toThrow(/HEL-2/);
    expect(s.projects.get(p.id)!.key).toBe("HELLOHARNESS");
    expect(s.tickets.get(t1.id)!.key).toBe("HELLOHARNESS-1");
    expect(s.sessions.get(t1.sessionId)!.key).toBe("HELLOHARNESS-1");
  });

  test("a session key collision counts too (triage sessions are keyed TRIAGE-n)", () => {
    const { s, p } = seed();
    s.sessions.create({ key: "HX-1", kind: "triage", ticketId: null, driver: "dummy", cwd: "/", title: "" });
    expect(s.projects.rekeyConflicts(p.id, "HX")).toEqual(["HX-1"]);
  });

  test("renaming to the current key is a no-op", () => {
    const { s, p } = seed();
    expect(s.projects.rekey(p.id, "HELLOHARNESS").renames.size).toBe(0);
  });
});

describe("ticket key aliases", () => {
  function seed() {
    const s = mk();
    const p = s.projects.create({ path: "/a/alpha", name: "alpha", key: "A" });
    const take = () => s.transaction(() => s.projects.takeNextKey(p.id, (k) => s.tickets.keyExists(k)));
    const t1 = ticketFor(s, p.id, take());
    const t2 = ticketFor(s, p.id, take());
    return { s, p, t1, t2, take };
  }

  test("an old key resolves to the renamed ticket, case-insensitively, reporting the alias", () => {
    const { s, p, t1, t2 } = seed();
    s.projects.rekey(p.id, "B");
    const hit = s.tickets.lookup(" a-2 ")!;
    expect(hit.ticket.id).toBe(t2.id);
    expect(hit.ticket.key).toBe("B-2");
    expect(hit.alias).toBe("A-2");
    expect(s.tickets.lookup("B-2")!.alias).toBeNull();
    expect(s.tickets.resolveKey("A-1")).toBe("B-1");
    expect(s.tickets.resolveKey("A-3")).toBeNull();
    // Aliases never make a key "exist": they don't block new tickets or renames.
    expect(s.tickets.keyExists("A-1")).toBe(false);
    expect(s.tickets.aliases(t1.id)).toEqual(["A-1"]);
  });

  test("chained renames A → B → C keep every earlier key; renaming back makes the key real again", () => {
    const { s, p, t1 } = seed();
    s.projects.rekey(p.id, "B");
    s.projects.rekey(p.id, "C");
    expect(s.tickets.getByKey("A-1")!.id).toBe(t1.id);
    expect(s.tickets.getByKey("B-1")!.id).toBe(t1.id);
    expect(s.tickets.getByKey("C-1")!.key).toBe("C-1");
    expect(s.tickets.aliases(t1.id)).toEqual(["A-1", "B-1"]);
    s.projects.rekey(p.id, "A");
    expect(s.tickets.lookup("A-1")).toMatchObject({ alias: null, ticket: { id: t1.id, key: "A-1" } });
    expect(s.tickets.aliases(t1.id).sort()).toEqual(["B-1", "C-1"]);
    expect(s.tickets.getByKey("C-1")!.key).toBe("A-1");
  });

  test("a real ticket holding the key wins over an alias", () => {
    const { s, p, t1 } = seed();
    s.projects.rekey(p.id, "B");
    // A stale alias row for a key a real ticket holds (inserted directly, bypassing create's cleanup).
    const q = s.projects.create({ path: "/a/other", name: "other", key: "Q" });
    const real = ticketFor(s, q.id, "Q-1");
    s.db.query("INSERT INTO ticket_key_aliases (key, ticket_id, created_at) VALUES ('Q-1', $id, 0)").run({ id: t1.id });
    expect(s.tickets.lookup("Q-1")).toMatchObject({ alias: null, ticket: { id: real.id } });
    expect(s.tickets.resolveKey("Q-1")).toBe("Q-1");
  });

  test("creating a ticket with an aliased key takes the key back: the alias is deleted", () => {
    const { s, p, t1 } = seed();
    s.projects.rekey(p.id, "B");
    const q = s.projects.create({ path: "/a/new-a", name: "new a", key: "A" });
    const fresh = ticketFor(s, q.id, s.transaction(() => s.projects.takeNextKey(q.id, (k) => s.tickets.keyExists(k))));
    expect(fresh.key).toBe("A-1");
    expect(s.tickets.getByKey("A-1")!.id).toBe(fresh.id);
    expect(s.tickets.aliases(t1.id)).toEqual([]);
    // Deleting the new ticket doesn't hand A-1 back to the old one.
    s.tickets.delete(fresh.id);
    expect(s.tickets.getByKey("A-1")).toBeNull();
  });

  test("a rename into a key another ticket's alias holds drops that alias", () => {
    const { s, p, t1 } = seed();
    s.projects.rekey(p.id, "B"); // alias A-1 → t1
    const q = s.projects.create({ path: "/a/q", name: "q", key: "Q" });
    const other = ticketFor(s, q.id, s.transaction(() => s.projects.takeNextKey(q.id, (k) => s.tickets.keyExists(k))));
    s.projects.rekey(q.id, "A"); // Q-1 → A-1: the key is now real for `other`
    expect(s.tickets.getByKey("A-1")!.id).toBe(other.id);
    expect(s.tickets.aliases(t1.id)).toEqual([]);
    expect(s.tickets.getByKey("Q-1")!.id).toBe(other.id);
  });

  test("deleting a ticket (or its project) removes its aliases", () => {
    const { s, p, t1, t2 } = seed();
    s.projects.rekey(p.id, "B");
    s.projects.rekey(p.id, "C");
    s.tickets.delete(t1.id);
    expect(s.tickets.getByKey("A-1")).toBeNull();
    expect(s.tickets.getByKey("B-1")).toBeNull();
    expect(s.tickets.getByKey("A-2")!.id).toBe(t2.id);
    s.projects.delete(p.id);
    expect(s.tickets.getByKey("A-2")).toBeNull();
    expect((s.db.query("SELECT COUNT(*) AS n FROM ticket_key_aliases").get() as { n: number }).n).toBe(0);
  });
});

describe("tickets", () => {
  test("useWorktree keeps null (follow the project) apart from false (the project checkout)", () => {
    const s = mk();
    const p = s.projects.create({ path: "/a/foo", name: "foo" });
    const make = (key: string, useWorktree: boolean | null | undefined) => {
      const session = s.sessions.create({ key, kind: "ticket", ticketId: null, driver: "dummy", cwd: "/tmp", title: key });
      const base = { projectId: p.id, kind: "task", title: key, description: "", status: "planning", sessionId: session.id, driver: "dummy", parentId: null, autoStart: false, externalRef: null, workdir: null } as const;
      return s.tickets.create({ ...base, dependsOn: [], key, useWorktree }).id;
    };
    const ids = [make("FOO-1", undefined), make("FOO-2", null), make("FOO-3", false), make("FOO-4", true)];
    expect(ids.map((id) => s.tickets.get(id)!.useWorktree)).toEqual([null, null, false, true]);
  });

  test("round-trip dependsOn in order, busy derived from runs, unique keys", () => {
    const s = mk();
    const p = s.projects.create({ path: "/a/foo", name: "foo" });
    ticketFor(s, p.id, "FOO-1");
    ticketFor(s, p.id, "FOO-2");
    const t = ticketFor(s, p.id, "FOO-3", ["foo-2", "FOO-1"]);
    expect(t.dependsOn).toEqual(["FOO-2", "FOO-1"]);
    expect(t.busy).toBe(false);
    expect(s.tickets.dependents("FOO-1").map((x) => x.key)).toEqual(["FOO-3"]);

    const run = s.runs.create({ sessionId: t.sessionId, kind: "work", driver: "dummy", prompt: "hi" });
    expect(s.tickets.get(t.id)!.busy).toBe(true);
    expect(s.sessions.get(t.sessionId)!.busy).toBe(true);
    s.runs.finish(run.id, "succeeded");
    expect(s.tickets.get(t.id)!.busy).toBe(false);

    expect(() => ticketFor(s, p.id, "FOO-1")).toThrow();
    expect(s.tickets.getByKey("foo-3")!.id).toBe(t.id);
  });

  test("update patches only given fields and replaces deps", () => {
    const s = mk();
    const p = s.projects.create({ path: "/a/foo", name: "foo" });
    const t = ticketFor(s, p.id, "FOO-1", ["BAR-1"]);
    const u = s.tickets.update(t.id, { status: "blocked", blockedReason: "why?", autoStart: true, dependsOn: [] })!;
    expect(u.status).toBe("blocked");
    expect(u.blockedReason).toBe("why?");
    expect(u.autoStart).toBe(true);
    expect(u.dependsOn).toEqual([]);
    expect(u.title).toBe("FOO-1");
  });
});

describe("transcript", () => {
  test("seq is monotonic per session", () => {
    const s = mk();
    const a = s.sessions.create({ key: "A", kind: "triage", ticketId: null, driver: "dummy", cwd: "/", title: "" });
    const b = s.sessions.create({ key: "B", kind: "triage", ticketId: null, driver: "dummy", cwd: "/", title: "" });
    const seqs = [
      s.transcript.append(a.id, null, "user", { type: "text", text: "1" }).seq,
      s.transcript.append(b.id, null, "user", { type: "text", text: "x" }).seq,
      s.transcript.append(a.id, null, "assistant", { type: "text", text: "2" }).seq,
      s.transcript.append(a.id, null, "system", { type: "status", text: "3" }).seq,
    ];
    expect(seqs).toEqual([1, 1, 2, 3]);
    expect(s.transcript.list(a.id, 1).map((e) => e.content)).toEqual([
      { type: "text", text: "2" },
      { type: "status", text: "3" },
    ]);
  });
});

describe("misc", () => {
  test("seen items dedupe by source+key+version", () => {
    const s = mk();
    expect(s.seen.markSeen("w1", "FOO-1", "v1")).toBe(true);
    expect(s.seen.markSeen("w1", "FOO-1", "v1")).toBe(false);
    expect(s.seen.markSeen("w1", "FOO-1", "v2")).toBe(true);
    expect(s.seen.markSeen("w2", "FOO-1", "v1")).toBe(true);
    expect(s.seen.markSeen("w1", "FOO-2", null)).toBe(true);
    expect(s.seen.markSeen("w1", "FOO-2", null)).toBe(false);
  });

  test("counters increment independently", () => {
    const s = mk();
    expect([s.counters.next("triage"), s.counters.next("triage"), s.counters.next("other")]).toEqual([1, 2, 1]);
  });

  test("watcher json fields round-trip", () => {
    const s = mk();
    const w = s.watchers.create({ name: "jira", command: "node", args: ["watch.js", "--x"], env: { A: "1" }, mode: "interval", intervalSec: 60 });
    expect(w.args).toEqual(["watch.js", "--x"]);
    expect(w.env).toEqual({ A: "1" });
    const u = s.watchers.update(w.id, { enabled: false, lastError: "boom" })!;
    expect(u.enabled).toBe(false);
    expect(u.lastError).toBe("boom");
    expect(u.mode).toBe("interval");
    expect(u.prompt).toBe("");
    const p = s.watchers.update(w.id, { prompt: "Dispatch anything assigned to me" })!;
    expect(p.prompt).toBe("Dispatch anything assigned to me");
    expect(s.watchers.update(w.id, { name: "renamed" })!.prompt).toBe("Dispatch anything assigned to me");
  });
});

describe("summary attachments", () => {
  const shot = (id: string, patch: Partial<SummaryAttachment> = {}): SummaryAttachment => ({ id, kind: "image", mimeType: "image/png", name: `${id}.png`, size: 10, width: 4, height: 3, ...patch });

  test("migration 14 adds the table to a database with existing summaries, which get no attachments", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    for (const [v, sql] of MIGRATIONS.slice(0, 13).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec(`INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES ('old', 's1', NULL, 'agent', 'before', 1)`);
    migrate(db);
    const s = new Store(db);
    expect(s.summaries.listBySession("s1")).toEqual([{ id: "old", sessionId: "s1", ticketId: null, author: "agent", body: "before", createdAt: 1, attachments: [] }]);
    const added = s.summaries.add({ sessionId: "s1", ticketId: null, author: "agent", body: "after", attachments: [shot("a1")] });
    expect(added.attachments).toEqual([shot("a1")]);
  });

  test("round-trip keeps each summary's attachments in the given order, apart from other summaries and sessions", () => {
    const s = mk();
    // ids sort the opposite way from the order given, so ordering can't come from the id
    const first = s.summaries.add({ sessionId: "s1", ticketId: null, author: "agent", body: "one", attachments: [shot("z"), shot("m", { kind: "video", mimeType: "video/mp4", name: "flow.mp4", width: undefined, height: undefined }), shot("a")] });
    const plain = s.summaries.add({ sessionId: "s1", ticketId: null, author: "human", body: "two" });
    s.summaries.add({ sessionId: "s2", ticketId: null, author: "agent", body: "elsewhere", attachments: [shot("other")] });
    const list = s.summaries.listBySession("s1");
    expect(list.map((x) => x.id)).toEqual([first.id, plain.id]);
    expect(list[0]!.attachments.map((a) => a.id)).toEqual(["z", "m", "a"]);
    expect(list[0]!.attachments[1]).toEqual({ id: "m", kind: "video", mimeType: "video/mp4", name: "flow.mp4", size: 10 });
    expect(list[1]!.attachments).toEqual([]);
    expect(s.summaries.attachment("m")).toEqual(list[0]!.attachments[1]!);
    expect(s.summaries.attachment("nope")).toBeNull();
    expect(s.summaries.attachmentsBySession("s1").map((a) => a.id).sort()).toEqual(["a", "m", "z"]);
  });

  test("a duplicate attachment id rolls back the whole summary", () => {
    const s = mk();
    s.summaries.add({ sessionId: "s1", ticketId: null, author: "agent", body: "one", attachments: [shot("dup")] });
    expect(() => s.summaries.add({ sessionId: "s1", ticketId: null, author: "agent", body: "two", attachments: [shot("fresh"), shot("dup")] })).toThrow();
    expect(s.summaries.listBySession("s1").map((x) => x.body)).toEqual(["one"]);
    expect(s.summaries.attachment("fresh")).toBeNull();
  });

  test("deleting the session deletes its attachment rows", () => {
    const s = mk();
    const session = s.sessions.create({ key: "X-1", kind: "ticket", ticketId: null, driver: "dummy", cwd: "/tmp", title: "x" });
    s.summaries.add({ sessionId: session.id, ticketId: null, author: "agent", body: "b", attachments: [shot("gone")] });
    s.summaries.add({ sessionId: "keep", ticketId: null, author: "agent", body: "b", attachments: [shot("kept")] });
    s.sessions.delete(session.id);
    expect(s.summaries.attachment("gone")).toBeNull();
    expect(s.summaries.attachment("kept")).not.toBeNull();
  });
});

describe("migration 18: completion actions", () => {
  function upTo17() {
    const db = new Database(":memory:", { strict: true });
    for (const [v, sql] of MIGRATIONS.slice(0, 17).entries()) {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    return db;
  }

  test("existing projects default to merge; tickets have no choice or pull request yet", () => {
    const db = upTo17();
    db.exec(`INSERT INTO projects (id, key, name, path, next_seq, created_at, updated_at) VALUES ('p1', 'OLD', 'old', '/old', 1, 0, 0)`);
    migrate(db);
    const s = new Store(db);
    expect(s.projects.get("p1")!.completionAction).toBe("merge");
    const t = ticketFor(s, "p1", "OLD-1");
    expect(t).toMatchObject({ completionAction: null, completionInstructions: null, pullRequestUrl: null });
    const u = s.tickets.update(t.id, { completionAction: "pr", completionInstructions: "label it", pullRequestUrl: "https://github.com/a/b/pull/1" })!;
    expect(u).toMatchObject({ completionAction: "pr", completionInstructions: "label it", pullRequestUrl: "https://github.com/a/b/pull/1" });
    expect(s.projects.update("p1", { completionAction: "custom" })!.completionAction).toBe("custom");
    expect(s.projects.update("p1", { name: "renamed" })!.completionAction).toBe("custom");
  });

  test("saved overrides of the renamed completion prompts move to their new ids, without clobbering a newer one", () => {
    const db = upTo17();
    const put = (value: unknown) => db.query("INSERT INTO settings (key, value) VALUES ('prompts', $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({ v: JSON.stringify(value) });
    put({ "system.complete": "old system", "run.complete": "old run", "system.work": "work" });
    migrate(db);
    expect(new Store(db).settings.all().prompts).toEqual({ "system.complete_merge": "old system", "run.complete_merge": "old run", "system.work": "work" });

    const db2 = upTo17();
    db2.query("INSERT INTO settings (key, value) VALUES ('prompts', $v)").run({ v: JSON.stringify({ "system.complete": "old", "system.complete_merge": "new" }) });
    migrate(db2);
    expect(new Store(db2).settings.all().prompts).toEqual({ "system.complete_merge": "new" });
  });
});
