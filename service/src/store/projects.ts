import type { Database } from "bun:sqlite";
import type { PermissionMode, Project } from "@harness/shared";
import { projectKeyFromPath, RESERVED_PROJECT_KEYS } from "@harness/shared";
import { bool, fromJson, int, newId, now, toJson } from "./util";

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  path: string;
  next_seq: number;
  default_driver: string | null;
  use_worktrees: number;
  require_human_review: number;
  permission_mode?: string | null;
  default_models: string;
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
  permissionMode: (r.permission_mode as PermissionMode | null | undefined) ?? null,
  defaultModels: fromJson<Record<string, string>>(r.default_models, {}),
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
  defaultModels?: Record<string, string>;
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
      if ((RESERVED_PROJECT_KEYS as readonly string[]).includes(candidate)) continue;
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
          `INSERT INTO projects (id, key, name, path, next_seq, default_driver, use_worktrees, require_human_review, default_models, created_at, updated_at)
           VALUES ($id, $key, $name, $path, 1, $defaultDriver, $useWorktrees, $requireHumanReview, $defaultModels, $t, $t)`,
        )
        .run({
          id,
          key,
          name: input.name,
          path: input.path,
          defaultDriver: input.defaultDriver ?? null,
          useWorktrees: int(input.useWorktrees ?? true),
          requireHumanReview: int(input.requireHumanReview ?? true),
          defaultModels: toJson(input.defaultModels ?? {}),
          t,
        });
    })();
    return this.get(id)!;
  }

  /** Patch settings. The key is changed with rekey(), never here. */
  update(id: string, patch: Partial<Omit<NewProject, "path" | "key">> & { path?: string }): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .query(
        `UPDATE projects SET name = $name, path = $path, default_driver = $defaultDriver,
           use_worktrees = $useWorktrees, require_human_review = $requireHumanReview, default_models = $defaultModels,
           updated_at = $t WHERE id = $id`,
      )
      .run({
        id,
        name: patch.name ?? existing.name,
        path: patch.path ?? existing.path,
        defaultDriver: patch.defaultDriver !== undefined ? patch.defaultDriver : existing.defaultDriver,
        useWorktrees: int(patch.useWorktrees ?? existing.useWorktrees),
        requireHumanReview: int(patch.requireHumanReview ?? existing.requireHumanReview),
        defaultModels: toJson(patch.defaultModels ?? existing.defaultModels),
        t: now(),
      });
    return this.get(id);
  }

  /**
   * Native tickets of a project: key is `<project key>-<n>` and not mirrored from an external
   * system. Those are the ones a key change renames.
   */
  nativeTicketKeys(id: string): { ticketId: string; key: string; number: number; suffix: string }[] {
    const p = this.get(id);
    if (!p) return [];
    const rows = this.db.query("SELECT id, key FROM tickets WHERE project_id = $id AND external_ref IS NULL").all({ id }) as { id: string; key: string }[];
    const out: { ticketId: string; key: string; number: number; suffix: string }[] = [];
    for (const r of rows) {
      if (!r.key.startsWith(`${p.key}-`)) continue;
      const rest = r.key.slice(p.key.length + 1);
      if (/^\d+$/.test(rest)) out.push({ ticketId: r.id, key: r.key, number: Number(rest), suffix: rest });
    }
    return out.sort((a, b) => a.number - b.number);
  }

  /**
   * Change the project key and rename its native tickets OLD-n → NEW-n (numbers kept), along
   * with their sessions and every dependency that points at them. Runs in one transaction.
   * The caller validates the key and checks for collisions first (see Orchestrator.updateProject).
   * Returns the old → new key map and the ids of every ticket whose dependsOn was rewritten.
   */
  /**
   * Keys a rename to newKey would collide with: ticket or session keys NEW-n that already exist
   * and don't belong to the ticket being renamed into them.
   */
  rekeyConflicts(id: string, newKey: string): string[] {
    const hit = this.db.query("SELECT id FROM tickets WHERE key = $key");
    const sessionHit = this.db.query("SELECT s.id FROM sessions s WHERE s.key = $key AND s.id IS NOT (SELECT session_id FROM tickets WHERE id = $ticketId)");
    const out: string[] = [];
    for (const n of this.nativeTicketKeys(id)) {
      const to = `${newKey}-${n.suffix}`;
      const t = hit.get({ key: to }) as { id: string } | null;
      const s = sessionHit.get({ key: to, ticketId: n.ticketId });
      if ((t && t.id !== n.ticketId) || s) out.push(to);
    }
    return out;
  }

  rekey(id: string, newKey: string): { renames: Map<string, string>; depTicketIds: string[] } {
    return this.db.transaction(() => {
      const p = this.get(id);
      if (!p) throw new Error(`Unknown project ${id}`);
      const renames = new Map<string, string>();
      if (p.key === newKey) return { renames, depTicketIds: [] };
      const conflicts = this.rekeyConflicts(id, newKey);
      if (conflicts.length) throw new Error(`Renaming to ${newKey} would collide with ${conflicts.join(", ")}`);
      const native = this.nativeTicketKeys(id);
      const t = now();
      const renameTicket = this.db.query("UPDATE tickets SET key = $to, updated_at = $t WHERE id = $id");
      const renameSession = this.db.query(
        "UPDATE sessions SET key = $to, updated_at = $t WHERE key = $from AND id = (SELECT session_id FROM tickets WHERE id = $id)",
      );
      const renameDep = this.db.query("UPDATE ticket_deps SET depends_on_key = $to WHERE depends_on_key = $from");
      const depHolders = this.db.query("SELECT DISTINCT ticket_id FROM ticket_deps WHERE depends_on_key = $from");
      // Old key → ticket, so anything that learned OLD-n keeps resolving (see TicketRepo.lookup).
      const addAlias = this.db.query("INSERT OR REPLACE INTO ticket_key_aliases (key, ticket_id, created_at) VALUES ($from, $id, $t)");
      const dropAlias = this.db.query("DELETE FROM ticket_key_aliases WHERE key = $to");
      const touched = new Set<string>();
      for (const n of native) {
        const to = `${newKey}-${n.suffix}`;
        renames.set(n.key, to);
        renameTicket.run({ id: n.ticketId, to, t });
        dropAlias.run({ to }); // the key is real again (e.g. renamed back): no alias for it
        addAlias.run({ from: n.key, id: n.ticketId, t });
        renameSession.run({ id: n.ticketId, from: n.key, to, t });
        for (const r of depHolders.all({ from: n.key }) as { ticket_id: string }[]) touched.add(r.ticket_id);
        renameDep.run({ from: n.key, to });
      }
      // dependsOn is part of the ticket, so holders count as updated too.
      for (const tid of touched) this.db.query("UPDATE tickets SET updated_at = $t WHERE id = $id").run({ id: tid, t });
      this.db.query("UPDATE projects SET key = $key, updated_at = $t WHERE id = $id").run({ id, key: newKey, t });
      return { renames, depTicketIds: [...touched] };
    })();
  }

  /** Set (or clear, with null) the project's permission-mode override. */
  setPermissionMode(id: string, mode: PermissionMode | null) {
    this.db.query("UPDATE projects SET permission_mode = $mode, updated_at = $t WHERE id = $id").run({ id, mode, t: now() });
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
