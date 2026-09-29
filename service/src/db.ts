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
  // 5: ticket key aliases. A project rename (HEL → FOO) records each old native key → ticket id,
  //    so bookmarks, agents and dependsOn inputs that still say HEL-2 keep resolving. Aliases
  //    point at the ticket, not at a key, so chained renames (A → B → C) all resolve. A real
  //    ticket key always wins; deleting the ticket drops its aliases.
  `
  CREATE TABLE ticket_key_aliases (
    key TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ticket_key_aliases_ticket ON ticket_key_aliases(ticket_id);
  `,
  // 6: paging + search (DESIGN.md "HTTP API": /tickets/page, /tickets/search).
  //    tickets.completed_at: when the ticket last entered done (the Done column's sort key). The
  //    triggers keep it right for every write path: set to updated_at on the move into done,
  //    cleared on the move out. Existing done tickets are backfilled from updated_at.
  //    ticket_search: one denormalized search document per ticket (key, old keys, title,
  //    description, latest summary), kept in sync by triggers on tickets, ticket_key_aliases and
  //    summaries. Its INTEGER PRIMARY KEY is the stable rowid the FTS5 index (ticket_fts,
  //    external content = ticket_search) points at; that index is created by ensureSearchIndex
  //    below, outside the versioned migrations, so a SQLite without FTS5 still migrates.
  `
  ALTER TABLE tickets ADD COLUMN completed_at INTEGER;
  UPDATE tickets SET completed_at = updated_at WHERE status = 'done';
  CREATE INDEX tickets_status_completed ON tickets(status, completed_at, id);

  CREATE TRIGGER tickets_completed_at_insert AFTER INSERT ON tickets
  WHEN NEW.status = 'done' AND NEW.completed_at IS NULL BEGIN
    UPDATE tickets SET completed_at = NEW.updated_at WHERE id = NEW.id;
  END;
  CREATE TRIGGER tickets_completed_at_update AFTER UPDATE OF status ON tickets
  WHEN NEW.status IS NOT OLD.status AND (NEW.status = 'done' OR OLD.status = 'done') BEGIN
    UPDATE tickets SET completed_at = CASE WHEN NEW.status = 'done' THEN NEW.updated_at ELSE NULL END WHERE id = NEW.id;
  END;

  CREATE TABLE ticket_search (
    rowid INTEGER PRIMARY KEY,
    ticket_id TEXT NOT NULL UNIQUE,
    key TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT ''
  );

  INSERT INTO ticket_search (ticket_id, key, aliases, title, description, summary)
  SELECT t.id, t.key,
    COALESCE((SELECT group_concat(a.key, ' ') FROM ticket_key_aliases a WHERE a.ticket_id = t.id), ''),
    t.title, t.description,
    COALESCE((SELECT s.body FROM summaries s WHERE s.session_id = t.session_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1), '')
  FROM tickets t;

  CREATE TRIGGER ticket_search_ticket_insert AFTER INSERT ON tickets BEGIN
    INSERT INTO ticket_search (ticket_id, key, aliases, title, description, summary) VALUES (
      NEW.id, NEW.key,
      COALESCE((SELECT group_concat(a.key, ' ') FROM ticket_key_aliases a WHERE a.ticket_id = NEW.id), ''),
      NEW.title, NEW.description,
      COALESCE((SELECT s.body FROM summaries s WHERE s.session_id = NEW.session_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1), ''));
  END;
  CREATE TRIGGER ticket_search_ticket_update AFTER UPDATE OF key, title, description, session_id ON tickets BEGIN
    UPDATE ticket_search SET key = NEW.key, title = NEW.title, description = NEW.description,
      summary = COALESCE((SELECT s.body FROM summaries s WHERE s.session_id = NEW.session_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1), '')
    WHERE ticket_id = NEW.id;
  END;
  CREATE TRIGGER ticket_search_ticket_delete AFTER DELETE ON tickets BEGIN
    DELETE FROM ticket_search WHERE ticket_id = OLD.id;
  END;

  CREATE TRIGGER ticket_search_alias_insert AFTER INSERT ON ticket_key_aliases BEGIN
    UPDATE ticket_search SET aliases = COALESCE((SELECT group_concat(a.key, ' ') FROM ticket_key_aliases a WHERE a.ticket_id = NEW.ticket_id), '')
    WHERE ticket_id = NEW.ticket_id;
  END;
  CREATE TRIGGER ticket_search_alias_delete AFTER DELETE ON ticket_key_aliases BEGIN
    UPDATE ticket_search SET aliases = COALESCE((SELECT group_concat(a.key, ' ') FROM ticket_key_aliases a WHERE a.ticket_id = OLD.ticket_id), '')
    WHERE ticket_id = OLD.ticket_id;
  END;

  CREATE TRIGGER ticket_search_summary_insert AFTER INSERT ON summaries BEGIN
    UPDATE ticket_search SET summary = COALESCE((SELECT s.body FROM summaries s WHERE s.session_id = NEW.session_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1), '')
    WHERE ticket_id IN (SELECT id FROM tickets WHERE session_id = NEW.session_id);
  END;
  CREATE TRIGGER ticket_search_summary_delete AFTER DELETE ON summaries BEGIN
    UPDATE ticket_search SET summary = COALESCE((SELECT s.body FROM summaries s WHERE s.session_id = OLD.session_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1), '')
    WHERE ticket_id IN (SELECT id FROM tickets WHERE session_id = OLD.session_id);
  END;
  CREATE TRIGGER ticket_search_summary_update AFTER UPDATE OF body ON summaries BEGIN
    UPDATE ticket_search SET summary = COALESCE((SELECT s.body FROM summaries s WHERE s.session_id = NEW.session_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1), '')
    WHERE ticket_id IN (SELECT id FROM tickets WHERE session_id = NEW.session_id);
  END;
  `,
  // 7: projects.auto_complete: once both reviews approve, start the complete run without a
  //    human pressing Complete. On by default, existing projects included.
  `
  ALTER TABLE projects ADD COLUMN auto_complete INTEGER NOT NULL DEFAULT 1;
  `,
  // 8: watchers.prompt: the user's instructions for triaging a watcher's output. Existing
  //    watchers get an empty prompt and keep their command + args (direct exec, no shell).
  `
  ALTER TABLE watchers ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
  `,
  // 9: routing moved into the watcher's prompt, so the key-pattern → project table goes. Its rows
  //    are dropped with it; nothing else referenced them.
  `
  DROP TABLE mappings;
  `,
  // 10: projects.color: the key badge's color, a preset id ("blue") or "#rrggbb". NULL (every
  //     existing project) keeps the theme's accent.
  `
  ALTER TABLE projects ADD COLUMN color TEXT;
  `,
  // 11: sub-agents (DESIGN.md "Sub-agents"): agents an agent starts inside its own session.
  //     transcript.subagent_id marks the entries a sub-agent produced (NULL: the session's own
  //     agent); existing entries all belong to the session's agent.
  `
  ALTER TABLE transcript ADD COLUMN subagent_id TEXT;
  CREATE INDEX transcript_subagent ON transcript(session_id, subagent_id, seq);

  CREATE TABLE subagents (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    run_id TEXT,
    parent_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    agent_type TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    result TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
  );
  CREATE INDEX subagents_run ON subagents(run_id, status);
  `,
  // 12: tickets.use_worktree: the per-ticket worktree choice from the composer or create_ticket
  //     (1: own worktree, 0: the project checkout). NULL (every existing ticket) follows the
  //     project's use_worktrees when work starts.
  `
  ALTER TABLE tickets ADD COLUMN use_worktree INTEGER;
  `,
  // 13: drop the sub-agents claude-code's parser made up from the tool_progress heartbeat a Bash
  //     call running over 30s sends (it names the call as parent_tool_use_id). They are the
  //     fallback "Sub-agent" rows with no type, prompt or transcript entries of their own. A real
  //     sub-agent always has an agent type, a prompt, or the output that created it.
  `
  DELETE FROM subagents
  WHERE description = 'Sub-agent' AND agent_type IS NULL AND prompt = ''
    AND NOT EXISTS (SELECT 1 FROM transcript t WHERE t.session_id = subagents.session_id AND t.subagent_id = subagents.id);
  `,
  // 14: summary attachments (DESIGN.md "Summary attachments"): images and videos an agent attached
  //     to a summary, in the order it listed them (ord). The files live in
  //     $HARNESS_HOME/attachments/<id>.<ext>; deleting the summary deletes its rows.
  `
  CREATE TABLE summary_attachments (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    kind TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX summary_attachments_summary ON summary_attachments(summary_id, ord);
  `,
  // 15: watchers.models: model per driver id for the watcher's triage sessions (like
  //     projects.default_models). Existing watchers get {} and follow settings.watcherModels.
  `
  ALTER TABLE watchers ADD COLUMN models TEXT NOT NULL DEFAULT '{}';
  `,
  // 16: branches (DESIGN.md "Branches"). projects.base_branch / tickets.base_branch: the base
  //     branch overrides (NULL inherits: ticket → project → settings.baseBranch).
  //     tickets.requested_branch: the branch chosen for the ticket's worktree (NULL → harness/<key>).
  `
  ALTER TABLE projects ADD COLUMN base_branch TEXT;
  ALTER TABLE tickets ADD COLUMN base_branch TEXT;
  ALTER TABLE tickets ADD COLUMN requested_branch TEXT;
  `,
  // 17: tickets.skip_agent_review: submitting skips the agent review (agent_review 'skipped'),
  //     so the ticket waits only on the human (DESIGN.md "Skipping the agent review").
  `
  ALTER TABLE tickets ADD COLUMN skip_agent_review INTEGER NOT NULL DEFAULT 0;
  `,
  // 18: completion actions (DESIGN.md "Completion"). projects.completion_action: what approving
  //     does by default ('merge', 'pr' or 'custom'). tickets.completion_action /
  //     completion_instructions: the choice made at approval, kept until the completion runs
  //     (NULL → the project's). tickets.pull_request_url: the pull request a 'pr' completion
  //     opened. The completion prompts were renamed system.complete → system.complete_merge and
  //     run.complete → run.complete_merge: saved overrides move with them (unless the new id
  //     already has one).
  `
  ALTER TABLE projects ADD COLUMN completion_action TEXT NOT NULL DEFAULT 'merge';
  ALTER TABLE tickets ADD COLUMN completion_action TEXT;
  ALTER TABLE tickets ADD COLUMN completion_instructions TEXT;
  ALTER TABLE tickets ADD COLUMN pull_request_url TEXT;
  UPDATE settings SET value = json_remove(
      CASE WHEN json_extract(value, '$."system.complete_merge"') IS NULL
        THEN json_set(value, '$."system.complete_merge"', json_extract(value, '$."system.complete"')) ELSE value END,
      '$."system.complete"')
    WHERE key = 'prompts' AND json_valid(value) AND json_type(value, '$."system.complete"') IS NOT NULL;
  UPDATE settings SET value = json_remove(
      CASE WHEN json_extract(value, '$."run.complete_merge"') IS NULL
        THEN json_set(value, '$."run.complete_merge"', json_extract(value, '$."run.complete"')) ELSE value END,
      '$."run.complete"')
    WHERE key = 'prompts' AND json_valid(value) AND json_type(value, '$."run.complete"') IS NOT NULL;
  `,
];

/**
 * The FTS5 index over ticket_search (external content, so it stores only the index). It's
 * derived data: created (and rebuilt from ticket_search) whenever it's missing, which also covers
 * a database migrated by a SQLite without FTS5 and later opened by one with it. Returns whether
 * FTS5 is available; without it, search falls back to LIKE over ticket_search.
 */
export function ensureSearchIndex(db: Database): boolean {
  const exists = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ticket_fts'").get();
  if (exists) return true;
  try {
    db.transaction(() => {
      db.exec(`
        CREATE VIRTUAL TABLE ticket_fts USING fts5(
          key, aliases, title, description, summary,
          content = 'ticket_search', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER ticket_fts_insert AFTER INSERT ON ticket_search BEGIN
          INSERT INTO ticket_fts (rowid, key, aliases, title, description, summary)
          VALUES (NEW.rowid, NEW.key, NEW.aliases, NEW.title, NEW.description, NEW.summary);
        END;
        CREATE TRIGGER ticket_fts_delete AFTER DELETE ON ticket_search BEGIN
          INSERT INTO ticket_fts (ticket_fts, rowid, key, aliases, title, description, summary)
          VALUES ('delete', OLD.rowid, OLD.key, OLD.aliases, OLD.title, OLD.description, OLD.summary);
        END;
        CREATE TRIGGER ticket_fts_update AFTER UPDATE ON ticket_search BEGIN
          INSERT INTO ticket_fts (ticket_fts, rowid, key, aliases, title, description, summary)
          VALUES ('delete', OLD.rowid, OLD.key, OLD.aliases, OLD.title, OLD.description, OLD.summary);
          INSERT INTO ticket_fts (rowid, key, aliases, title, description, summary)
          VALUES (NEW.rowid, NEW.key, NEW.aliases, NEW.title, NEW.description, NEW.summary);
        END;
        INSERT INTO ticket_fts (ticket_fts) VALUES ('rebuild');
      `);
    })();
    return true;
  } catch {
    return false;
  }
}

/** Whether this database has the FTS5 search index (see ensureSearchIndex). */
export function hasSearchIndex(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ticket_fts'").get();
}

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
  ensureSearchIndex(db);
}
