import type { Database } from "bun:sqlite";
import type { Project } from "@harness/shared";
import { projectKeyFromPath } from "@harness/shared";
import { bool, int, newId, now } from "./util";

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  path: string;
  next_seq: number;
  default_driver: string | null;
  use_worktrees: number;
  require_human_review: number;
  created_at: number;
  updated_at: number;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  key: r.key,
  name: r.name,
  path: r.path,
  nextSeq: r.next_seq,
  defaultDriver: r.default_driver,
  useWorktrees: bool(r.use_worktrees),
  requireHumanReview: bool(r.require_human_review),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Normalize a user-supplied key: upper-case letters/digits, starting with a letter. */
export function normalizeProjectKey(raw: string): string {
  return projectKeyFromPath(raw.replace(/\//g, ""));
}

export interface NewProject {
  path: string;
  name: string;
  key?: string;
  defaultDriver?: string | null;
  useWorktrees?: boolean;
  requireHumanReview?: boolean;
}

export class ProjectRepo {
  constructor(private db: Database) {}

  list(): Project[] {
    return (this.db.query("SELECT * FROM projects ORDER BY created_at, key").all() as ProjectRow[]).map(toProject);
  }

  get(id: string): Project | null {
    const r = this.db.query("SELECT * FROM projects WHERE id = $id").get({ id }) as ProjectRow | null;
    return r ? toProject(r) : null;
  }

  getByKey(key: string): Project | null {
    const r = this.db.query("SELECT * FROM projects WHERE key = $key").get({ key: key.toUpperCase() }) as ProjectRow | null;
    return r ? toProject(r) : null;
  }

  getByPath(path: string): Project | null {
    const r = this.db.query("SELECT * FROM projects WHERE path = $path ORDER BY created_at LIMIT 1").get({ path }) as ProjectRow | null;
    return r ? toProject(r) : null;
  }

  /** First free key: BASE, BASE2, BASE3, ... */
  uniqueKey(base: string, exceptId?: string): string {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}${n}`;
      const hit = this.db.query("SELECT id FROM projects WHERE key = $key").get({ key: candidate }) as { id: string } | null;
      if (!hit || hit.id === exceptId) return candidate;
    }
  }

  create(input: NewProject): Project {
    const id = newId();
    const t = now();
    this.db.transaction(() => {
      const key = this.uniqueKey(input.key ? normalizeProjectKey(input.key) : projectKeyFromPath(input.path));
      this.db
        .query(
          `INSERT INTO projects (id, key, name, path, next_seq, default_driver, use_worktrees, require_human_review, created_at, updated_at)
           VALUES ($id, $key, $name, $path, 1, $defaultDriver, $useWorktrees, $requireHumanReview, $t, $t)`,
        )
        .run({
          id,
          key,
          name: input.name,
          path: input.path,
          defaultDriver: input.defaultDriver ?? null,
          useWorktrees: int(input.useWorktrees ?? true),
          requireHumanReview: int(input.requireHumanReview ?? true),
          t,
        });
    })();
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Omit<NewProject, "path">> & { path?: string }): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    const key = patch.key !== undefined ? this.uniqueKey(normalizeProjectKey(patch.key), id) : existing.key;
    this.db
      .query(
        `UPDATE projects SET key = $key, name = $name, path = $path, default_driver = $defaultDriver,
           use_worktrees = $useWorktrees, require_human_review = $requireHumanReview, updated_at = $t WHERE id = $id`,
      )
      .run({
        id,
        key,
        name: patch.name ?? existing.name,
        path: patch.path ?? existing.path,
        defaultDriver: patch.defaultDriver !== undefined ? patch.defaultDriver : existing.defaultDriver,
        useWorktrees: int(patch.useWorktrees ?? existing.useWorktrees),
        requireHumanReview: int(patch.requireHumanReview ?? existing.requireHumanReview),
        t: now(),
      });
    return this.get(id);
  }

  delete(id: string) {
    this.db.query("DELETE FROM projects WHERE id = $id").run({ id });
  }

  /**
   * Hand out the next native ticket key (KEY-n) inside the caller's transaction, skipping
   * numbers already taken (e.g. an external mirror that happens to share the prefix).
   */
  takeNextKey(projectId: string, isTaken: (key: string) => boolean): string {
    const p = this.get(projectId);
    if (!p) throw new Error(`Unknown project ${projectId}`);
    let seq = p.nextSeq;
    while (isTaken(`${p.key}-${seq}`)) seq++;
    this.db.query("UPDATE projects SET next_seq = $next, updated_at = $t WHERE id = $id").run({ id: projectId, next: seq + 1, t: now() });
    return `${p.key}-${seq}`;
  }
}
