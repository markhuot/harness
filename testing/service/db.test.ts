import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinPhaseModels } from "@harness/shared";
import { migrate, MIGRATION_CODE, MIGRATIONS, openDb, SCHEMA_VERSION, ensureSearchIndex, hasSearchIndex } from "../../service/src/db";
import { Store } from "../../service/src/store";
import { fakeClock } from "../builders/clock";
import { tempDir } from "../builders/tmp";

/** A database frozen after migration `version`, the way an older install left it. */
function dbAt(version: number): Database {
  const db = new Database(":memory:", { strict: true });
  for (const [v, sql] of MIGRATIONS.slice(0, version).entries()) {
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  return db;
}
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const paths = () => {
  const home = tempDir();
  return { attachmentsDir: join(home, "attachments"), uploadsDir: join(home, "uploads"), now: fakeClock(7_000) };
};
const columns = (db: Database, table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test("a fresh database lands on the newest version and migrating again changes nothing", () => {
  const db = openDb(":memory:", paths());
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  const before = JSON.stringify(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all());
  migrate(db, paths());
  expect(JSON.stringify(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all())).toBe(before);
});

test("a database from a newer service is refused rather than downgraded", () => {
  const db = new Database(":memory:");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  expect(() => migrate(db)).toThrow(/newer than this service/);
  expect(version(db)).toBe(SCHEMA_VERSION + 1);
});

test("a failing migration rolls back whole and leaves the version where it was", () => {
  const db = dbAt(SCHEMA_VERSION - 1);
  // Break the last migration's target: it creates a table that is already there.
  db.exec("CREATE TABLE labels (id TEXT)");
  expect(() => migrate(db, paths())).toThrow();
  expect(version(db)).toBe(SCHEMA_VERSION - 1);
});

test("a file database turns on WAL and foreign keys; an in-memory one skips WAL", () => {
  const dir = tempDir();
  const file = openDb(join(dir, "h.db"), paths());
  expect((file.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect((file.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  file.close();
  const mem = openDb(":memory:", paths());
  expect((mem.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("memory");
});

test("an in-memory database with nothing to backfill migrates without being given any folders", () => {
  const db = dbAt(29);
  db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p', 'K', 'n', '/p', 0, 0)`);
  expect(() => migrate(db)).not.toThrow();
  expect(version(db)).toBe(SCHEMA_VERSION);
});

test("migration 21 turns a project's old require_human_review into skipHumanReview, per project and per ticket", () => {
  const db = dbAt(20);
  for (const [id, key, review] of [["off", "OFF", 0], ["on", "ON", 1]] as const) {
    db.query(`INSERT INTO projects (id, key, name, path, next_seq, require_human_review, auto_complete, created_at, updated_at) VALUES ($id, $key, $key, '/' || $key, 2, $review, 0, 0, 0)`).run({ id, key, review });
    db.query(
      `INSERT INTO tickets (id, key, project_id, kind, title, description, status, session_id, driver, auto_start, agent_review, human_review, position, created_at, updated_at)
       VALUES ($key || '-1', $key || '-1', $id, 'task', 't', '', 'review', 's', 'dummy', 0, 'approved', 'approved', 0, 0, 0)`,
    ).run({ id, key });
  }
  migrate(db, paths());
  expect(columns(db, "projects")).not.toContain("require_human_review");
  const store = new Store(db);
  expect(store.projects.get("off")).toMatchObject({ skipHumanReview: true, skipAgentReview: false });
  expect(store.projects.get("on")).toMatchObject({ skipHumanReview: false });
  expect([store.tickets.get("OFF-1")!.skipHumanReview, store.tickets.get("ON-1")!.skipHumanReview]).toEqual([true, false]);
});

test("migration 8 gives an existing watcher an empty prompt and keeps its command and args", () => {
  const db = dbAt(7);
  db.exec(`INSERT INTO watchers (id, name, command, args, created_at, updated_at) VALUES ('w1', 'jira', 'node', '["watch.js","--project","FOO"]', 0, 0)`);
  migrate(db, paths());
  expect(new Store(db).watchers.get("w1")).toMatchObject({ prompt: "", command: "node", args: ["watch.js", "--project", "FOO"] });
});

test("migration 30 registers the files a ticket's attachment list names, with kind and size read from disk", () => {
  const p = paths();
  const dir = tempDir();
  const present = join(dir, "notes.txt");
  writeFileSync(present, "hello");
  const db = dbAt(29);
  db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'K', 'n', '/p', 0, 0)`);
  const list = [{ path: present, name: "Notes" }, { path: join(dir, "gone.bin") }, { path: present }, { nope: 1 }];
  db.query(
    `INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, prompt_attachments, created_at, updated_at)
     VALUES ('t1', 'K-1', 'p1', 'task', 't', '', 'planning', 's1', 'dummy', $list, 0, 0)`,
  ).run({ list: JSON.stringify(list) });
  migrate(db, p);
  const converted = JSON.parse((db.query("SELECT prompt_attachments FROM tickets").get() as { prompt_attachments: string }).prompt_attachments) as {
    id: string;
    path: string;
    name: string;
    kind: string;
    size?: number;
  }[];
  // The malformed entry is dropped; the same file listed twice shares one attachment row.
  expect(converted).toHaveLength(3);
  expect(converted[0]).toMatchObject({ path: present, name: "Notes", size: 5 });
  expect(converted[2]!.id).toBe(converted[0]!.id);
  expect(converted[2]!.name).toBe("notes.txt");
  expect(converted[1]).toMatchObject({ kind: "file", name: "gone.bin" });
  expect((db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(2);
  expect((db.query("SELECT created_at FROM attachments LIMIT 1").get() as { created_at: number }).created_at).toBe(7_000);
});

test("migration 38 turns the old driver and model settings into per-phase choices, per level, and drops the old keys", () => {
  const db = dbAt(37);
  const put = (key: string, value: unknown) => db.query("INSERT INTO settings (key, value) VALUES ($key, $v)").run({ key, v: JSON.stringify(value) });
  put("defaultDriver", "copilot");
  put("defaultModels", { copilot: "m-default", other: "m-other" });
  put("reviewModels", { copilot: "m-review" });
  db.exec(`INSERT INTO projects (id, key, name, path, default_driver, default_models, created_at, updated_at) VALUES ('pin', 'PIN', 'n', '/a', 'other', '{"other":"m-proj"}', 0, 0)`);
  db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('inherit', 'INH', 'n', '/b', 0, 0)`);
  const ticket = (id: string, project: string, driver: string, model: string | null) =>
    db.query(`INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, model, created_at, updated_at) VALUES ($id, $id, $project, 'task', 't', '', 'planning', $id, $driver, $model, 0, 0)`).run({ id, project, driver, model });
  ticket("same", "inherit", "copilot", null); // on the driver it would inherit, no model: keeps no choice
  ticket("modelled", "inherit", "copilot", "m-own");
  ticket("elsewhere", "pin", "copilot", null); // not its project's driver: pinned, model falls back to the settings map
  migrate(db, paths());

  const settings = new Store(db).settings.all() as Record<string, unknown>;
  expect(settings.defaultDriver).toBeUndefined();
  expect(settings.defaultModels).toBeUndefined();
  expect(settings.reviewModels).toBeUndefined();
  const phase = settings.phaseModels as Record<string, { driver: string; model: string | null }>;
  expect(phase.plan).toEqual({ driver: "copilot", model: "m-default" });
  expect(phase.work).toEqual({ driver: "copilot", model: "m-default" });
  expect(phase.review).toEqual({ driver: "copilot", model: "m-review" });

  const pm = (table: string, id: string) => JSON.parse((db.query(`SELECT phase_models FROM ${table} WHERE id = $id`).get({ id }) as { phase_models: string | null }).phase_models ?? "null");
  expect(pm("projects", "inherit")).toBeNull();
  expect(pm("projects", "pin")).toEqual({
    plan: { driver: "other", model: "m-proj" },
    work: { driver: "other", model: "m-proj" },
    review: { driver: "other", model: "m-proj" },
  });
  expect(pm("tickets", "same")).toBeNull();
  expect(pm("tickets", "modelled").work).toEqual({ driver: "copilot", model: "m-own" });
  expect(pm("tickets", "modelled").review).toEqual({ driver: "copilot", model: "m-review" });
  expect(pm("tickets", "elsewhere").plan).toEqual({ driver: "copilot", model: "m-default" });
});

test("migration 38 on a fresh install seeds the built-in tiers and doesn't overwrite saved choices", () => {
  const fresh = dbAt(37);
  migrate(fresh, paths());
  const seeded = new Store(fresh).settings.all() as { phaseModels: Record<string, unknown> };
  expect(seeded.phaseModels).toMatchObject(JSON.parse(JSON.stringify(builtinPhaseModels("claude-code"))));

  const saved = dbAt(37);
  saved.query("INSERT INTO settings (key, value) VALUES ('phaseModels', $v)").run({ v: JSON.stringify({ plan: { driver: "x", model: null } }) });
  saved.query("INSERT INTO settings (key, value) VALUES ('defaultDriver', '\"claude-code\"')").run();
  migrate(saved, paths());
  expect(((new Store(saved).settings.all() as { phaseModels: Record<string, unknown> }).phaseModels).plan).toEqual({ driver: "x", model: null });
});

test("migration 42 turns the single pull request link into a trimmed one-item list, or an empty one", () => {
  const db = dbAt(41);
  db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'K', 'n', '/p', 0, 0)`);
  const ticket = (id: string, url: string | null) =>
    db.query(`INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, pull_request_url, created_at, updated_at) VALUES ($id, $id, 'p1', 'task', 't', '', 'planning', $id, 'dummy', $url, 0, 0)`).run({ id, url });
  ticket("linked", " https://github.com/a/b/pull/1 ");
  ticket("blank", "   ");
  ticket("none", null);
  migrate(db, paths());
  const store = new Store(db);
  expect(store.tickets.get("linked")!.pullRequests).toEqual([{ url: "https://github.com/a/b/pull/1", title: null }]);
  expect(store.tickets.get("blank")!.pullRequests).toEqual([]);
  expect(store.tickets.get("none")!.pullRequests).toEqual([]);
});

test("the search index is rebuilt from ticket_search whenever it's missing", () => {
  const db = openDb(":memory:", paths());
  expect(hasSearchIndex(db)).toBe(true);
  const store = new Store(db);
  store.projects.create({ name: "P", path: "/p", key: "P" });
  // As a database migrated by a SQLite without FTS5 would be: no index table and no triggers.
  db.exec("DROP TABLE ticket_fts; DROP TRIGGER ticket_fts_insert; DROP TRIGGER ticket_fts_delete; DROP TRIGGER ticket_fts_update;");
  expect(hasSearchIndex(db)).toBe(false);
  expect(ensureSearchIndex(db)).toBe(true);
  expect(hasSearchIndex(db)).toBe(true);
  expect(ensureSearchIndex(db)).toBe(true);
});

test("migration 44 makes a group per distinct group name, merging case and spacing variants", () => {
  const db = dbAt(43);
  let at = 0;
  const add = (key: string, group: string | null) =>
    db
      .query("INSERT INTO projects (id, key, name, path, group_name, created_at, updated_at) VALUES ($key, $key, $key, $key, $group, $t, $t)")
      .run({ key, group, t: at++ });
  add("A", "Work");
  add("B", "  work ");
  add("C", "work");
  add("D", "work");
  add("E", "Play  time");
  add("F", "play time");
  add("G", null);
  migrate(db, paths());
  const groups = db.query("SELECT id, name FROM groups ORDER BY name").all() as { id: string; name: string }[];
  // "work" is on three of the four Work projects, so it wins. Play time
  // ties one to one, so the first one seen wins.
  expect(groups.map((g) => g.name)).toEqual(["Play time", "work"]);
  const of = (key: string) => db.query("SELECT group_id, group_name FROM projects WHERE key = $key").get({ key }) as { group_id: string | null; group_name: string | null };
  const work = groups.find((g) => g.name === "work")!.id;
  const play = groups.find((g) => g.name === "Play time")!.id;
  expect([of("A").group_id, of("B").group_id, of("C").group_id, of("D").group_id]).toEqual([work, work, work, work]);
  expect([of("E").group_id, of("F").group_id]).toEqual([play, play]);
  expect(of("G")).toEqual({ group_id: null, group_name: null });
  expect(of("A").group_name).toBe("work");
  // The names are unique without case.
  expect(() => db.query("INSERT INTO groups (id, name, created_at) VALUES ('x', 'WORK', 0)").run()).toThrow();
});

test("migration 44 on a database with no groups makes none and a rerun changes nothing", () => {
  const db = dbAt(43);
  migrate(db, paths());
  expect(db.query("SELECT count(*) AS n FROM groups").get()).toEqual({ n: 0 });
  const before = JSON.stringify(db.query("SELECT * FROM projects").all());
  migrate(db, paths());
  expect(JSON.stringify(db.query("SELECT * FROM projects").all())).toBe(before);
});

test("migration 46 seeds the event cursor at the end of existing activity, so the first boot doesn't triage history", () => {
  const db = dbAt(45);
  db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'K', 'n', '/p', 0, 0)`);
  db.exec(`INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, created_at, updated_at) VALUES ('t1', 'K-1', 'p1', 'task', 't', '', 'planning', 's1', 'dummy', 0, 0)`);
  for (const id of ["a", "b", "c"]) db.query("INSERT INTO activity (id, session_id, ticket_id, kind, author, body, meta, created_at) VALUES ($id, 's1', 't1', 'note', 'agent', 'x', '{}', 0)").run({ id });
  migrate(db, paths());
  const store = new Store(db);
  expect(store.ticketEvents.activitySeq()).toBe(3);
  expect(store.activity.listAfter(store.ticketEvents.activitySeq(), 10)).toEqual([]);
  // The old rows carry no actor: they never count as a chief's.
  expect(db.query("SELECT actor FROM activity WHERE id = 'a'").get()).toEqual({ actor: null });
  // A source is only ever one event.
  const base = { cosId: null, projectId: null, ticketId: null, sourceKind: "watcher" as const, sourceRef: "r", actor: "watcher:x", title: "t" };
  expect(store.ticketEvents.insert(base)).not.toBeNull();
  expect(store.ticketEvents.insert(base)).toBeNull();
});

test("migration 55 renames cos_events to ticket_events, keeps its rows and gives each a target", () => {
  const db = dbAt(54);
  const ins = db.query("INSERT INTO cos_events (id, cos_id, project_id, ticket_id, source_kind, source_ref, kind, actor, title, payload, status, created_at, updated_at) VALUES ($id, $cos, NULL, $ticket, $sk, $ref, 'moved', 'a', 't', '{\"x\":1}', 'handled', 5, 6)");
  ins.run({ id: "e1", cos: "chief", ticket: "t1", sk: "activity", ref: "r1" });
  ins.run({ id: "e2", cos: null, ticket: null, sk: "watcher", ref: "r2" });
  migrate(db, paths());
  expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'cos_events%'").all()).toEqual([]);
  expect(db.query("SELECT id, cos_id AS cosId, target_id AS targetId, ticket_id AS ticketId, payload, status, created_at AS c, updated_at AS u FROM ticket_events ORDER BY id").all()).toEqual([
    { id: "e1", cosId: "chief", targetId: "chief", ticketId: "t1", payload: '{"x":1}', status: "handled", c: 5, u: 6 },
    { id: "e2", cosId: null, targetId: null, ticketId: null, payload: '{"x":1}', status: "handled", c: 5, u: 6 },
  ]);
});

test("ticket_events dedupes a source once without a target and once per target with one", () => {
  const db = dbAt(54);
  migrate(db, paths());
  const store = new Store(db);
  const base = { cosId: null, projectId: null, ticketId: null, actor: "a", title: "t" };
  // No target: the same (kind, ref) is one event.
  expect(store.ticketEvents.insert({ ...base, sourceKind: "watcher", sourceRef: "w" })).not.toBeNull();
  expect(store.ticketEvents.insert({ ...base, sourceKind: "watcher", sourceRef: "w" })).toBeNull();
  // One activity wakes several targets, but each only once.
  expect(store.ticketEvents.insert({ ...base, sourceKind: "subscription", sourceRef: "a1", targetId: "T1" })).not.toBeNull();
  expect(store.ticketEvents.insert({ ...base, sourceKind: "subscription", sourceRef: "a1", targetId: "T2" })).not.toBeNull();
  expect(store.ticketEvents.insert({ ...base, sourceKind: "subscription", sourceRef: "a1", targetId: "T1" })).toBeNull();
  // The same change reaches a ticket once, whether as its parent or as a subscriber.
  expect(store.ticketEvents.insert({ ...base, sourceKind: "child", sourceRef: "a1", targetId: "T1" })).toBeNull();
  expect(store.ticketEvents.insert({ ...base, sourceKind: "child", sourceRef: "a1", targetId: "T3" })).not.toBeNull();
});

test("a chief of staff row's target follows its owner, and a repeat of its source still dedupes after triage rehomes it", () => {
  const db = dbAt(54);
  migrate(db, paths());
  const store = new Store(db);
  const base = { cosId: null, projectId: null, ticketId: null, sourceKind: "watcher" as const, sourceRef: "w", actor: "a", title: "t" };
  const ev = store.ticketEvents.insert(base)!;
  const target = (id: string) => (db.query("SELECT target_id AS t FROM ticket_events WHERE id = $id").get({ id }) as { t: string | null }).t;
  expect(target(ev.id)).toBeNull();
  store.ticketEvents.update(ev.id, { cosId: "chief" });
  expect(target(ev.id)).toBe("chief");
  expect(store.ticketEvents.insert(base)).toBeNull();
  expect(store.ticketEvents.insert({ ...base, cosId: "chief", sourceRef: "x" })).not.toBeNull();
  expect((db.query("SELECT target_id AS t FROM ticket_events WHERE source_ref = 'x'").get() as { t: string }).t).toBe("chief");
});

test("rehoming or unassigning a row aimed at another ticket keeps its target, so two such rows with one ref don't collide", () => {
  const db = dbAt(54);
  migrate(db, paths());
  const store = new Store(db);
  const base = { cosId: "chief", projectId: null, ticketId: null, sourceKind: "subscription" as const, sourceRef: "a1", actor: "a", title: "t" };
  const a = store.ticketEvents.insert({ ...base, targetId: "T1" })!;
  const b = store.ticketEvents.insert({ ...base, targetId: "T2" })!;
  store.ticketEvents.update(a.id, { cosId: null });
  store.ticketEvents.update(b.id, { cosId: null });
  const target = (id: string) => (db.query("SELECT target_id AS t FROM ticket_events WHERE id = $id").get({ id }) as { t: string | null }).t;
  expect([target(a.id), target(b.id)]).toEqual(["T1", "T2"]);
});

test("the dedupe lookup on (source_kind, source_ref) is served by an index", () => {
  const db = dbAt(54);
  migrate(db, paths());
  const plan = db.query("EXPLAIN QUERY PLAN SELECT 1 FROM ticket_events WHERE source_kind = 'a' AND source_ref = 'b'").all() as { detail: string }[];
  expect(plan.map((p) => p.detail).join(" ")).toContain("USING");
});

test("a ticket's events are found by its target, newest first, through an index", () => {
  const db = dbAt(56);
  migrate(db, paths());
  const plan = db.query("EXPLAIN QUERY PLAN SELECT 1 FROM ticket_events WHERE target_id = 'x' ORDER BY created_at DESC").all() as { detail: string }[];
  expect(plan.map((p) => p.detail).join(" ")).toContain("ticket_events_target");
});

/** An install at migration 48 with the All chief, a watcher and one TRIAGE session per outcome. */
function triageInstall(withAllChief = true) {
  const db = dbAt(48);
  if (withAllChief) db.exec(`INSERT INTO cos (ticket_id, scope, group_id, enabled, created_at) VALUES ('chief', 'all', NULL, 1, 0)`);
  db.exec(`INSERT INTO watchers (id, name, command, args, prompt, env, mode, interval_sec, enabled, models, created_at, updated_at)
           VALUES ('w', 'jira', 'watch', '[]', '', '{}', 'loop', 60, 1, '{}', 0, 0)`);
  const session = db.query(`INSERT INTO sessions (id, key, kind, driver, cwd, title, triage_status, outcome, meta, created_at, updated_at) VALUES ($key, $key, 'triage', 'dummy', '/', $title, $status, $outcome, $meta, $at, $at)`);
  const meta = (text: string) => JSON.stringify({ source: "jira", text, prompt: "only mine" });
  session.run({ key: "TRIAGE-1", title: "open one", status: "triaging", outcome: null, meta: meta("FOO-1 changed"), at: 10 });
  session.run({ key: "TRIAGE-2", title: "sent on", status: "dispatched", outcome: "Dispatched to K-5 in K", meta: meta("FOO-2 assigned"), at: 20 });
  session.run({ key: "TRIAGE-3", title: "turned down", status: "declined", outcome: "Declined: not mine", meta: meta("FOO-3 closed"), at: 30 });
  db.exec(`INSERT INTO runs (id, session_id, kind, status, driver, prompt, created_at) VALUES ('r1', 'TRIAGE-1', 'triage', 'queued', 'dummy', 'p', 10), ('r2', 'TRIAGE-2', 'triage', 'succeeded', 'dummy', 'p', 20)`);
  session.run({ key: "TRIAGE-4", title: "broke", status: "failed", outcome: "Triage failed: boom", meta: null, at: 40 });
  return db;
}
const eventRows = (db: Database) =>
  db.query("SELECT source_ref AS ref, cos_id AS cosId, status, verdict, reason, actor, payload FROM ticket_events WHERE source_kind = 'watcher' ORDER BY created_at").all() as {
    ref: string; cosId: string | null; status: string; verdict: string; reason: string | null; actor: string; payload: string;
  }[];

test("migration 49 gives existing watchers to the All chief and turns open TRIAGE items into pending events, resolved ones into consumed history", () => {
  const db = triageInstall();
  migrate(db, paths());
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect((db.query("SELECT cos_id FROM watchers WHERE id = 'w'").get() as { cos_id: string | null }).cos_id).toBeNull();
  const rows = eventRows(db);
  expect(rows.map((r) => [r.ref, r.status, r.verdict, r.reason, r.cosId])).toEqual([
    ["triage:TRIAGE-1", "pending", "pending", null, "chief"],
    ["triage:TRIAGE-2", "handled", "escalate", "Dispatched to K-5 in K", "chief"],
    ["triage:TRIAGE-3", "ignored", "ignore", "Declined: not mine", "chief"],
    ["triage:TRIAGE-4", "ignored", "ignore", "Triage failed: boom", "chief"],
  ]);
  expect(rows[0]!.actor).toBe("watcher:jira");
  expect(JSON.parse(rows[0]!.payload)).toMatchObject({ body: "FOO-1 changed", prompt: "only mine", triageKey: "TRIAGE-1" });
  // A triage run still queued can no longer run, so it is failed; a finished one is left alone.
  expect(db.query("SELECT id, status, error FROM runs ORDER BY id").all()).toEqual([
    { id: "r1", status: "failed", error: "Triage was removed" },
    { id: "r2", status: "succeeded", error: null },
  ]);
  // The old sessions are left in place, since tickets and Activity still link to TRIAGE-n, but none is open any more.
  expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'triage'").get() as { n: number }).n).toBe(4);
  expect(db.query("SELECT key, triage_status AS status, outcome FROM sessions WHERE key = 'TRIAGE-1'").get()).toEqual({ key: "TRIAGE-1", status: "failed", outcome: "Moved to the chief of staff" });
  expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'triage' AND triage_status = 'triaging'").get() as { n: number }).n).toBe(0);
  // Resolved ones keep their own outcome.
  expect((db.query("SELECT outcome FROM sessions WHERE key = 'TRIAGE-3'").get() as { outcome: string }).outcome).toBe("Declined: not mine");
});

test("migration 49 with no All chief yet leaves the events unassigned, and replaying its code adds nothing", () => {
  const db = triageInstall(false);
  migrate(db, paths());
  expect(eventRows(db).every((r) => r.cosId === null)).toBe(true);
  const before = eventRows(db).length;
  // The step is written for the table as migration 49 left it, so replay it against that name.
  db.exec("ALTER TABLE ticket_events RENAME TO cos_events");
  MIGRATION_CODE[49]!(db, paths());
  db.exec("ALTER TABLE cos_events RENAME TO ticket_events");
  expect(eventRows(db)).toHaveLength(before);
});

test("deleting a group's chief hands its watchers to All (cos_id goes NULL)", () => {
  const db = triageInstall();
  db.exec(`INSERT INTO cos (ticket_id, scope, group_id, enabled, created_at) VALUES ('g', 'group:x', 'x', 1, 0)`);
  migrate(db, paths());
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("UPDATE watchers SET cos_id = 'g'");
  db.exec("DELETE FROM cos WHERE ticket_id = 'g'");
  expect((db.query("SELECT cos_id FROM watchers WHERE id = 'w'").get() as { cos_id: string | null }).cos_id).toBeNull();
});

test("migration 53 drops cos_wakes.reported and keeps the wakes (which migration 56 then renames)", () => {
  const db = dbAt(52);
  db.exec(`INSERT INTO cos_wakes (id, cos_id, kind, started_at, event_count, run_id, outcome, reported) VALUES ('w1', 'chief', 'wake', 5, 2, 'r1', 'spoke', '{"t1":"blocked:x"}')`);
  expect(columns(db, "cos_wakes")).toContain("reported");
  migrate(db, paths());
  expect(columns(db, "event_wakes")).not.toContain("reported");
  expect(db.query("SELECT id, event_count, run_id, outcome FROM event_wakes").all()).toEqual([{ id: "w1", event_count: 2, run_id: "r1", outcome: "spoke" }]);
});

test("migration 56 keys the wake log by the ticket woken and keeps every wake, in the chief's cap class", () => {
  const db = dbAt(55);
  db.exec(`INSERT INTO cos_wakes (id, cos_id, kind, started_at, event_count) VALUES ('w1', 'chief', 'wake', 5, 2), ('w2', 'chief', 'triage', 6, 1)`);
  migrate(db, paths());
  expect(columns(db, "event_wakes")).toEqual(expect.arrayContaining(["target_id", "event_class"]));
  expect(columns(db, "event_wakes")).not.toContain("cos_id");
  expect(db.query("SELECT id, target_id, event_class, kind FROM event_wakes ORDER BY id").all()).toEqual([
    { id: "w1", target_id: "chief", event_class: "", kind: "wake" },
    { id: "w2", target_id: "chief", event_class: "", kind: "triage" },
  ]);
});

test("migration 54 keeps an old CoS can-unblock choice as the Blocked box, every other column off, for the app and per project", () => {
  const seed = (settingValue: string | null) => {
    const db = dbAt(53);
    if (settingValue !== null) db.query("INSERT INTO settings (key, value) VALUES ('cosCanUnblock', $v)").run({ v: settingValue });
    for (const [id, unblock] of [["yes", 1], ["no", 0], ["inherit", null]] as const) {
      db.query(`INSERT INTO projects (id, key, name, path, next_seq, cos_can_unblock, default_models, created_at, updated_at) VALUES ($id, $id, $id, '/' || $id, 1, $unblock, '{}', 0, 0)`).run({ id, unblock });
    }
    migrate(db, paths());
    return db;
  };
  const setting = (db: Database, key: string) => db.query("SELECT value FROM settings WHERE key = $key").get({ key }) as { value: string } | null;

  const on = seed("true");
  expect(JSON.parse(setting(on, "cosStatuses")!.value)).toEqual(["blocked"]);
  expect(setting(on, "cosCanUnblock")).toBeNull();
  expect(columns(on, "projects")).not.toContain("cos_can_unblock");
  const store = new Store(on);
  expect([store.projects.get("yes")!.cosStatuses, store.projects.get("no")!.cosStatuses, store.projects.get("inherit")!.cosStatuses]).toEqual([["blocked"], [], null]);

  expect(JSON.parse(setting(seed("false"), "cosStatuses")!.value)).toEqual([]);
  // An install that never saved the setting has nothing to carry over: it stays unset and resolves to no column.
  expect(setting(seed(null), "cosStatuses")).toBeNull();
});
