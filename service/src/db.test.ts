// Migration 26 (the spec and Activity) on a database at the schema before it: descriptions become
// specs with revision 1, summaries become Activity notes, their attachments become the ticket's
// and still resolve to their files, search follows the renamed columns, and the dropped prompt
// override goes.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { attachmentPath } from "./attachments";
import { ensureSearchIndex, migrate, MIGRATIONS, SCHEMA_VERSION } from "./db";
import { Store } from "./store";

/** The FTS index as services before migration 26 built it (over description and summary). */
const OLD_SEARCH_INDEX = `
  CREATE VIRTUAL TABLE ticket_fts USING fts5(key, aliases, title, description, summary, external_key,
    content = 'ticket_search', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER ticket_fts_insert AFTER INSERT ON ticket_search BEGIN
    INSERT INTO ticket_fts (rowid, key, aliases, title, description, summary, external_key)
    VALUES (NEW.rowid, NEW.key, NEW.aliases, NEW.title, NEW.description, NEW.summary, NEW.external_key);
  END;
  CREATE TRIGGER ticket_fts_delete AFTER DELETE ON ticket_search BEGIN
    INSERT INTO ticket_fts (ticket_fts, rowid, key, aliases, title, description, summary, external_key)
    VALUES ('delete', OLD.rowid, OLD.key, OLD.aliases, OLD.title, OLD.description, OLD.summary, OLD.external_key);
  END;
  CREATE TRIGGER ticket_fts_update AFTER UPDATE ON ticket_search BEGIN
    INSERT INTO ticket_fts (ticket_fts, rowid, key, aliases, title, description, summary, external_key)
    VALUES ('delete', OLD.rowid, OLD.key, OLD.aliases, OLD.title, OLD.description, OLD.summary, OLD.external_key);
    INSERT INTO ticket_fts (rowid, key, aliases, title, description, summary, external_key)
    VALUES (NEW.rowid, NEW.key, NEW.aliases, NEW.title, NEW.description, NEW.summary, NEW.external_key);
  END;`;

/** A database migrated only up to `version`, as an older service left it. */
function dbAt(version: number): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  for (let v = 0; v < version; v++) db.exec(MIGRATIONS[v]!);
  db.exec(`PRAGMA user_version = ${version}`);
  if (version < 26) db.exec(OLD_SEARCH_INDEX);
  else ensureSearchIndex(db);
  return db;
}

describe("migration 26: spec + Activity", () => {
  test("a database at schema 25 keeps its data under the new names", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(26);
    const db = dbAt(25);
    const t0 = 1_700_000_000_000;
    db.exec(`
      INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'WEB', 'Web', '/tmp/web', ${t0}, ${t0});
      INSERT INTO sessions (id, key, kind, ticket_id, driver, cwd, created_at, updated_at) VALUES ('s1', 'WEB-1', 'ticket', 't1', 'fake', '/tmp/web', ${t0}, ${t0});
      INSERT INTO sessions (id, key, kind, ticket_id, driver, cwd, created_at, updated_at) VALUES ('s2', 'WEB-2', 'ticket', 't2', 'fake', '/tmp/web', ${t0}, ${t0});
      INSERT INTO sessions (id, key, kind, ticket_id, driver, cwd, created_at, updated_at) VALUES ('s3', 'TRIAGE-1', 'triage', NULL, 'fake', '/tmp', ${t0}, ${t0});
      INSERT INTO tickets (id, key, project_id, kind, title, description, status, session_id, driver, created_at, updated_at)
        VALUES ('t1', 'WEB-1', 'p1', 'task', 'Toggle', 'Make the toggle remember its state', 'review', 's1', 'fake', ${t0}, ${t0});
      INSERT INTO tickets (id, key, project_id, kind, title, description, status, session_id, driver, created_at, updated_at)
        VALUES ('t2', 'WEB-2', 'p1', 'task', 'Footer', 'Fix the footer', 'planning', 's2', 'fake', ${t0}, ${t0});
      INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES ('m1', 's1', 't1', 'agent', 'First pass done', ${t0 + 1});
      INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES ('m2', 's1', 't1', 'agent', 'Persisted with localStorage', ${t0 + 2});
      INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES ('m3', 's3', NULL, 'system', 'Triage note', ${t0 + 3});
      INSERT INTO summary_attachments (id, summary_id, ord, kind, mime_type, name, size, width, height, created_at)
        VALUES ('a1', 'm2', 0, 'image', 'image/png', 'after.png', 10, 800, 600, ${t0 + 2});
      INSERT INTO summary_attachments (id, summary_id, ord, kind, mime_type, name, size, width, height, created_at)
        VALUES ('a2', 'm2', 1, 'video', 'video/mp4', 'flow.mp4', 20, NULL, NULL, ${t0 + 2});
      INSERT INTO settings (key, value) VALUES ('prompts', '{"system.summaries":"old summaries text","system.work":"my work prompt"}');
    `);
    // The files the attachments name, where the service stores them.
    const dir = join(tempDir("harness-migrate-"), "attachments");
    mkdirSync(dir, { recursive: true });
    for (const a of [{ id: "a1", mimeType: "image/png" }, { id: "a2", mimeType: "video/mp4" }]) writeFileSync(attachmentPath(dir, a), "bytes");

    migrate(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    const store = new Store(db);

    // Descriptions are specs at revision 1; the ticket that had left planning has it as its baseline.
    const t1 = store.tickets.get("t1")!;
    const t2 = store.tickets.get("t2")!;
    expect(t1).toMatchObject({ spec: "Make the toggle remember its state", specRevision: 1, specBaselineRevision: 1 });
    expect(t2).toMatchObject({ spec: "Fix the footer", specRevision: 1, specBaselineRevision: null });
    expect(store.specs.get("t1", 1)).toMatchObject({ body: "Make the toggle remember its state", author: "system", approvedBaseline: true });
    expect(store.specs.get("t2", 1)).toMatchObject({ approvedBaseline: false });

    // Summaries are Activity notes, in order; one with attachments links them as images.
    expect(store.activity.listBySession("s1").map((e) => [e.id, e.kind, e.author, e.body])).toEqual([
      ["m1", "note", "agent", "First pass done"],
      ["m2", "note", "agent", "Persisted with localStorage\n\n![after.png](attachment:a1)\n![flow.mp4](attachment:a2)"],
    ]);
    expect(store.activity.listBySession("s3").map((e) => e.body)).toEqual(["Triage note"]);

    // Attachments belong to the ticket now, and still resolve to their files.
    expect(store.attachments.listByTicket("t1").map((a) => a.id)).toEqual(["a1", "a2"]);
    const a1 = store.attachments.get("a1")!;
    expect(a1).toMatchObject({ kind: "image", mimeType: "image/png", name: "after.png", width: 800, height: 600 });
    expect(existsSync(attachmentPath(dir, a1))).toBe(true);
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('summaries', 'summary_attachments')").all()).toEqual([]);

    // Search reads the renamed columns: the spec, and the latest note.
    expect(store.tickets.search({ q: "localStorage" }).tickets.map((t) => t.key)).toEqual(["WEB-1"]);
    expect(store.tickets.search({ q: "footer" }).tickets.map((t) => t.key)).toEqual(["WEB-2"]);
    store.activity.add({ sessionId: "s2", ticketId: "t2", kind: "note", author: "agent", body: "Padding fixed" });
    store.activity.add({ sessionId: "s2", ticketId: "t2", kind: "message", author: "human", body: "Zebra stripes please" });
    expect(store.tickets.search({ q: "padding" }).tickets.map((t) => t.key)).toEqual(["WEB-2"]);
    // Only notes and submits feed the latest note.
    expect(store.tickets.search({ q: "zebra" }).tickets).toEqual([]);

    // The system.summaries override is dropped; others stay.
    expect(store.settings.all().prompts).toEqual({ "system.work": "my work prompt" });
  });

  test("deleting a ticket takes its revisions and attachment rows with it", () => {
    const db = dbAt(26);
    // The rest of the migrations, so today's TicketRepo can write its columns.
    migrate(db);
    const store = new Store(db);
    db.exec(`INSERT INTO projects (id, key, name, path, created_at, updated_at) VALUES ('p1', 'WEB', 'Web', '/tmp/web', 1, 1)`);
    const t = store.tickets.create({ key: "WEB-1", projectId: "p1", kind: "task", title: "t", spec: "v1", status: "planning", sessionId: "s1", driver: "fake", parentId: null, dependsOn: [], autoStart: false, externalRef: null, workdir: null });
    store.specs.revise(t.id, { body: "v2", author: "human", note: "edit", baseRevision: 1 });
    store.attachments.add(t.id, [{ id: "x1", kind: "image", mimeType: "image/png", name: "a.png", size: 1 }]);
    store.tickets.delete(t.id);
    expect(db.query("SELECT COUNT(*) AS n FROM spec_revisions").get()).toEqual({ n: 0 });
    expect(store.attachments.get("x1")).toBeNull();
  });
});
