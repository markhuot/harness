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
  // Break the last migration's target: it adds a column that already exists.
  db.exec("ALTER TABLE cos_wakes ADD COLUMN run_id TEXT");
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
  expect(store.cosEvents.activitySeq()).toBe(3);
  expect(store.activity.listAfter(store.cosEvents.activitySeq(), 10)).toEqual([]);
  // The old rows carry no actor: they never count as a chief's.
  expect(db.query("SELECT actor FROM activity WHERE id = 'a'").get()).toEqual({ actor: null });
  // A source is only ever one event.
  const base = { cosId: null, projectId: null, ticketId: null, sourceKind: "watcher" as const, sourceRef: "r", actor: "watcher:x", title: "t" };
  expect(store.cosEvents.insert(base)).not.toBeNull();
  expect(store.cosEvents.insert(base)).toBeNull();
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
  db.query("SELECT source_ref AS ref, cos_id AS cosId, status, verdict, reason, actor, payload FROM cos_events WHERE source_kind = 'watcher' ORDER BY created_at").all() as {
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
  MIGRATION_CODE[49]!(db, paths());
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
