// SQLite schema + migrations (tracked with PRAGMA user_version).

import { Database } from "bun:sqlite";

export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1,
    default_driver TEXT,
    use_worktrees INTEGER NOT NULL DEFAULT 0,
    require_human_review INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    ticket_id TEXT,
    driver TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    triage_status TEXT,
    outcome TEXT,
    driver_state TEXT,
    meta TEXT,
    next_seq INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_kind ON sessions(kind);

  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT NOT NULL,
    driver TEXT NOT NULL,
    parent_id TEXT,
    auto_start INTEGER NOT NULL DEFAULT 0,
    agent_review TEXT NOT NULL DEFAULT 'pending',
    human_review TEXT NOT NULL DEFAULT 'pending',
    external_ref TEXT,
    workdir TEXT,
    branch TEXT,
    blocked_reason TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tickets_project ON tickets(project_id);
  CREATE INDEX tickets_parent ON tickets(parent_id);

  CREATE TABLE ticket_deps (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    depends_on_key TEXT NOT NULL,
    ord INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, depends_on_key)
  );
  CREATE INDEX ticket_deps_key ON ticket_deps(depends_on_key);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    driver TEXT NOT NULL,
    prompt TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX runs_session ON runs(session_id, created_at);
  CREATE INDEX runs_status ON runs(status);

  CREATE TABLE transcript (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, seq)
  );

  CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ticket_id TEXT,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX summaries_session ON summaries(session_id, created_at);

  CREATE TABLE watchers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    cwd TEXT,
    env TEXT NOT NULL DEFAULT '{}',
    mode TEXT NOT NULL DEFAULT 'loop',
    interval_sec INTEGER NOT NULL DEFAULT 300,
    enabled INTEGER NOT NULL DEFAULT 1,
    driver TEXT,
    last_run_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE mappings (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE seen_items (
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source, key, version)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  `,
  // 2: tool-permission approvals, agent-review rejection counter, acceptEdits default
  `
  ALTER TABLE tickets ADD COLUMN pending_approval TEXT;
  ALTER TABLE tickets ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tickets ADD COLUMN review_rejections INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE approval_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX approval_grants_ticket ON approval_grants(ticket_id, tool_name);

  UPDATE settings SET value = '"acceptEdits"' WHERE key = 'claudePermissionMode' AND value = '"bypassPermissions"';
  `,
  // 3: model selection: per-ticket model, per-project default models, settings.defaultModels
  //    replaces claudeModel / anthropicModel
  `
  ALTER TABLE tickets ADD COLUMN model TEXT;
  ALTER TABLE projects ADD COLUMN default_models TEXT NOT NULL DEFAULT '{}';

  INSERT OR IGNORE INTO settings (key, value)
  SELECT 'defaultModels', json_object(
    'claude-code', (SELECT json(value) FROM settings WHERE key = 'claudeModel'),
    'anthropic-api', (SELECT json(value) FROM settings WHERE key = 'anthropicModel'))
  WHERE EXISTS (SELECT 1 FROM settings WHERE key IN ('claudeModel', 'anthropicModel'));
  DELETE FROM settings WHERE key IN ('claudeModel', 'anthropicModel');
  `,
  // 4: harness permission modes (auto | ask | read_only) replace settings.claudePermissionMode;
  //    per-project and per-ticket overrides. acceptEdits (and bypassPermissions) → ask,
  //    auto → auto, dontAsk → read_only (dontAsk denied every write that wasn't pre-approved).
  `
  ALTER TABLE projects ADD COLUMN permission_mode TEXT;
  ALTER TABLE tickets ADD COLUMN permission_mode TEXT;

  INSERT OR REPLACE INTO settings (key, value)
  SELECT 'permissionMode', CASE value WHEN '"auto"' THEN '"auto"' WHEN '"dontAsk"' THEN '"read_only"' ELSE '"ask"' END
  FROM settings WHERE key = 'claudePermissionMode';
  DELETE FROM settings WHERE key = 'claudePermissionMode';
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Database) {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this service (${MIGRATIONS.length})`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
