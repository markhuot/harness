// Seed library for tests, check scripts and dev tools that run the real daemon: git-init'd seed
// repos, direct database writes for state a run would otherwise have to produce, and the settings
// every dummy-driver world starts from. Not imported by production code.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Run git with a fixed identity and no signing; throws with git's stderr on a non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=Harness Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} → exit ${code}\n${(err || out).trim()}`);
  return out.trim();
}

export type SeedRepoOptions = {
  /** Branches created at the initial commit. */
  branches?: string[];
  /** Extra worktrees, each on a new branch: `{ branch, path }`. */
  worktrees?: { branch: string; path: string }[];
};

/**
 * A git repository at `dir` with `files` (path → content) committed as "Initial commit" on main.
 * Idempotent: a directory that is already a repository is left as it is (no second commit, no
 * error for branches or worktrees that exist), so a kept or reused scratch dir seeds once.
 */
export async function seedRepo(dir: string, files: Record<string, string>, opts: SeedRepoOptions = {}): Promise<string> {
  if (!existsSync(join(dir, ".git"))) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    mkdirSync(dir, { recursive: true });
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "Initial commit");
  }
  const have = new Set((await git(dir, "branch", "--format=%(refname:short)")).split("\n"));
  for (const b of opts.branches ?? []) if (!have.has(b)) await git(dir, "branch", b);
  for (const w of opts.worktrees ?? []) {
    if (have.has(w.branch) || existsSync(w.path)) continue;
    await git(dir, "worktree", "add", "-q", "-b", w.branch, w.path);
  }
  return dir;
}

/** The little "greeter" project the iPhone and dev-sim worlds share. */
export const GREETER_FILES: Record<string, string> = {
  "README.md": "# Greeter\n\nSays hello.\n",
  "src/app.ts": 'export function main(name = "world") {\n  console.log("Hello, " + name);\n}\n',
};

/** Opens the daemon's database for a direct write (the daemon keeps running; busy_timeout covers its writes). */
export function withDb<T>(home: string, fn: (db: Database) => T): T {
  const db = new Database(join(home, "harness.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return fn(db);
  } finally {
    db.close();
  }
}

/** Reads a settings row (JSON-decoded), or null. */
export function readSetting<T = unknown>(home: string, key: string): T | null {
  return withDb(home, (db) => {
    const row = db.query("SELECT value FROM settings WHERE key = $k").get({ $k: key }) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : null;
  });
}

/** Writes a settings row (JSON-encoded), replacing what was there. */
export function writeSetting(home: string, key: string, value: unknown): void {
  withDb(home, (db) => {
    db.query("INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({ $k: key, $v: JSON.stringify(value) });
  });
}

/** The context-gauge usage of a ticket's session (what a Claude Code run would have reported). */
export function setSessionContext(home: string, sessionId: string, ctx: Record<string, unknown> | null): void {
  withDb(home, (db) => {
    db.query("UPDATE sessions SET context = $c WHERE id = $id").run({ $c: ctx ? JSON.stringify(ctx) : null, $id: sessionId });
  });
}

/**
 * A compact run going on a session, which is what makes a ticket's `compacting` true. The service's
 * startup sweep fails runs it didn't start, so insert it after the daemon is up.
 */
export function startCompactRun(home: string, sessionId: string, id: string): void {
  withDb(home, (db) => {
    const t = Date.now();
    db.query("INSERT INTO runs (id, session_id, kind, status, driver, prompt, attachments, created_at, started_at) VALUES ($id, $s, 'compact', 'running', 'claude-code', '/compact', '[]', $t, $t)").run({ $id: id, $s: sessionId, $t: t });
  });
}

/** Settings every dummy-driver world starts from: the dummy driver by default, no classifier calls. */
export async function seedDummySettings(api: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>): Promise<void> {
  await api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });
}
