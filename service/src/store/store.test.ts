import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, openDb, SCHEMA_VERSION } from "../db";
import type { ExternalRef } from "@harness/shared";
import { Store } from "./index";

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

  test("update patches settings but never the key", () => {
    const s = mk();
    const a = s.projects.create({ path: "/a/foo", name: "foo" });
    const u = s.projects.update(a.id, { name: "Foo", useWorktrees: false, key: "BAR" } as any)!;
    expect(u.key).toBe("FOO");
    expect(u.name).toBe("Foo");
    expect(u.useWorktrees).toBe(false);
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
    expect(s.tickets.getByKey("HELLOHARNESS-1")).toBeNull();
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
