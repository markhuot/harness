import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, openDb, SCHEMA_VERSION } from "../db";
import { Store } from "./index";

const mk = () => new Store(openDb(":memory:"));

function ticketFor(store: Store, projectId: string, key: string, deps: string[] = []) {
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
    externalRef: null,
    workdir: null,
  });
}

describe("db", () => {
  test("migrations set user_version and are idempotent; WAL on file dbs", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-db-"));
    const db = openDb(join(dir, "h.db"));
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    migrate(db); // second run must not re-create tables
    db.close();
    const again = openDb(join(dir, "h.db"));
    expect((again.query("PRAGMA user_version").get() as any).user_version).toBe(SCHEMA_VERSION);
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

  test("update keeps its own key without bumping to KEY2", () => {
    const s = mk();
    const a = s.projects.create({ path: "/a/foo", name: "foo" });
    expect(s.projects.update(a.id, { key: "foo" })!.key).toBe("FOO");
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

describe("tickets", () => {
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
  });
});
