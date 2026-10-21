import type { Database } from "bun:sqlite";
import type { CompletionAction, Group, PermissionMode, PhaseModels, Project } from "@harness/shared";
import { legacyWork, sameGroup, isCompletionAction, offeredCompletionActions, projectKeyFromPath, RESERVED_PROJECT_KEYS } from "@harness/shared";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PullRequestTarget, pullRequestTarget } from "./remotes";
import { bool, fromJson, int, newId, toJson } from "./util";
import { type Clock, systemClock } from "../clock";

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  path: string;
  next_seq: number;
  default_driver: string | null;
  use_worktrees: number;
  skip_agent_review: number;
  skip_human_review: number;
  permission_mode?: string | null;
  color?: string | null;
  group_name?: string | null;
  group_id?: string | null;
  /** The joined groups.name (PROJECT_SELECT) */
  group_label?: string | null;
  base_branch?: string | null;
  completion_action?: string | null;
  default_models: string;
  phase_models?: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * pullRequestTarget reads two small files; projects are read many times a second while agents
 * run, so the answer is kept for a moment. A remote added or a gh login shows up within it.
 */
const PR_TARGET_TTL_MS = 2000;
const prTargets = new Map<string, { at: number; target: PullRequestTarget | null }>();

export function cachedPullRequestTarget(path: string): PullRequestTarget | null {
  const hit = prTargets.get(path);
  const t = Date.now();
  if (hit && t - hit.at < PR_TARGET_TTL_MS) return hit.target;
  const target = pullRequestTarget(path);
  prTargets.set(path, { at: t, target });
  return target;
}

/** Forget cached pull request targets (tests that change a repo's remote or gh's login). */
export function clearPullRequestTargets() {
  prTargets.clear();
}

/** A project row with its group's current name (group_label), so a rename shows at once. */
const PROJECT_SELECT = "SELECT p.*, g.name AS group_label FROM projects p LEFT JOIN groups g ON g.id = p.group_id";

const toProject = (r: ProjectRow): Project => {
  const isGit = insideGitCheckout(r.path);
  const pullRequestHost = isGit ? (cachedPullRequestTarget(r.path)?.host ?? null) : null;
  const phaseModels = fromJson<PhaseModels>(r.phase_models, {});
  const legacy = legacyWork(phaseModels);
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    path: r.path,
    nextSeq: r.next_seq,
    phaseModels,
    defaultDriver: legacy.driver,
    useWorktrees: bool(r.use_worktrees),
    isGit,
    skipAgentReview: bool(r.skip_agent_review),
    skipHumanReview: bool(r.skip_human_review),
    requireHumanReview: !bool(r.skip_human_review),
    permissionMode: (r.permission_mode as PermissionMode | null | undefined) ?? null,
    color: r.color ?? null,
    group: r.group_label ?? null,
    groupId: r.group_id ?? null,
    baseBranch: r.base_branch ?? null,
    completionAction: isCompletionAction(r.completion_action) ? r.completion_action : "merge",
    completionActions: offeredCompletionActions({ isGit, pullRequestHost }),
    pullRequestHost,
    defaultModels: legacy.models,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

/**
 * Whether `path` is inside a git checkout: `.git` (a directory, or a file in worktrees and
 * submodules) in it or any parent, the way git finds its repository. A few stats, so it's cheap
 * enough to run on every read. It only drives what clients show; begin() asks git itself.
 */
export function insideGitCheckout(path: string): boolean {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Normalize a user-supplied key: upper-case letters/digits, starting with a letter. */
export function normalizeProjectKey(raw: string): string {
  return projectKeyFromPath(raw.replace(/\//g, ""));
}

export interface NewProject {
  path: string;
  name: string;
  key?: string;
  useWorktrees?: boolean;
  skipAgentReview?: boolean;
  skipHumanReview?: boolean;
  color?: string | null;
  /** The id of an existing group (the orchestrator resolves names to ids); null → none */
  groupId?: string | null;
  baseBranch?: string | null;
  completionAction?: CompletionAction;
  /** The project's own per-phase choices (the legacy default_driver / default_models columns follow its Work choice) */
  phaseModels?: PhaseModels;
}

export class ProjectRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  list(): Project[] {
    return (this.db.query(`${PROJECT_SELECT} ORDER BY p.created_at, p.key`).all() as ProjectRow[]).map(toProject);
  }

  get(id: string): Project | null {
    const r = this.db.query(`${PROJECT_SELECT} WHERE p.id = $id`).get({ id }) as ProjectRow | null;
    return r ? toProject(r) : null;
  }

  getByKey(key: string): Project | null {
    const r = this.db.query(`${PROJECT_SELECT} WHERE p.key = $key`).get({ key: key.toUpperCase() }) as ProjectRow | null;
    return r ? toProject(r) : null;
  }

  getByPath(path: string): Project | null {
    const r = this.db.query(`${PROJECT_SELECT} WHERE p.path = $path ORDER BY p.created_at LIMIT 1`).get({ path }) as ProjectRow | null;
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
    const t = this.now();
    this.db.transaction(() => {
      const key = this.uniqueKey(input.key ? normalizeProjectKey(input.key) : projectKeyFromPath(input.path));
      this.db
        .query(
          `INSERT INTO projects (id, key, name, path, next_seq, default_driver, use_worktrees, skip_agent_review, skip_human_review, color, group_id, group_name, base_branch, completion_action, default_models, phase_models, created_at, updated_at)
           VALUES ($id, $key, $name, $path, 1, $defaultDriver, $useWorktrees, $skipAgentReview, $skipHumanReview, $color, $groupId, (SELECT name FROM groups WHERE id = $groupId), $baseBranch, $completionAction, $defaultModels, $phaseModels, $t, $t)`,
        )
        .run({
          id,
          key,
          name: input.name,
          path: input.path,
          defaultDriver: legacyWork(input.phaseModels).driver,
          useWorktrees: int(input.useWorktrees ?? true),
          skipAgentReview: int(input.skipAgentReview ?? false),
          skipHumanReview: int(input.skipHumanReview ?? false),
          color: input.color ?? null,
          groupId: input.groupId ?? null,
          baseBranch: input.baseBranch ?? null,
          completionAction: input.completionAction ?? "merge",
          defaultModels: toJson(legacyWork(input.phaseModels).models),
          phaseModels: toJson(input.phaseModels ?? {}),
          t,
        });
    })();
    return this.get(id)!;
  }

  /** Patch settings. The key is changed with rekey(), never here. */
  update(id: string, patch: Partial<Omit<NewProject, "path" | "key">> & { path?: string }): Project | null {
    const existing = this.get(id);
    if (!existing) return null;
    const phaseModels = patch.phaseModels ?? existing.phaseModels ?? {};
    const legacy = legacyWork(phaseModels);
    this.db
      .query(
        `UPDATE projects SET name = $name, path = $path, default_driver = $defaultDriver,
           use_worktrees = $useWorktrees, skip_agent_review = $skipAgentReview, skip_human_review = $skipHumanReview, color = $color, group_id = $groupId, group_name = (SELECT name FROM groups WHERE id = $groupId), base_branch = $baseBranch, completion_action = $completionAction, default_models = $defaultModels, phase_models = $phaseModels,
           updated_at = $t WHERE id = $id`,
      )
      .run({
        id,
        name: patch.name ?? existing.name,
        path: patch.path ?? existing.path,
        defaultDriver: legacy.driver,
        useWorktrees: int(patch.useWorktrees ?? existing.useWorktrees),
        skipAgentReview: int(patch.skipAgentReview ?? !!existing.skipAgentReview),
        skipHumanReview: int(patch.skipHumanReview ?? !!existing.skipHumanReview),
        color: patch.color !== undefined ? patch.color : existing.color,
        groupId: patch.groupId !== undefined ? patch.groupId : (existing.groupId ?? null),
        baseBranch: patch.baseBranch !== undefined ? patch.baseBranch : (existing.baseBranch ?? null),
        completionAction: patch.completionAction ?? existing.completionAction ?? "merge",
        defaultModels: toJson(legacy.models),
        phaseModels: toJson(phaseModels),
        t: this.now(),
      });
    if (existing.groupId && patch.groupId !== undefined && patch.groupId !== existing.groupId) this.pruneGroups();
    return this.get(id);
  }

  /** Drop the groups no project is in, so a name an emptied group had is free again. */
  private pruneGroups() {
    this.db.query("DELETE FROM groups WHERE id NOT IN (SELECT group_id FROM projects WHERE group_id IS NOT NULL)").run();
  }

  /**
   * Native tickets of a project: key is `<project key>-<n>`. Those are the ones a key change
   * renames. A ticket linked to a remote ID is native too; only a legacy mirror, whose key is its
   * remote ID (created before remote IDs had their own field), keeps its key. Mirrors the
   * client's `nativeTickets` (shared/src/state/projectKey.ts).
   */
  nativeTicketKeys(id: string): { ticketId: string; key: string; number: number; suffix: string }[] {
    const p = this.get(id);
    if (!p) return [];
    const rows = this.db
      .query("SELECT id, key FROM tickets WHERE project_id = $id AND (external_key IS NULL OR external_key <> key)")
      .all({ id }) as { id: string; key: string }[];
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
      const t = this.now();
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
    this.db.query("UPDATE projects SET permission_mode = $mode, updated_at = $t WHERE id = $id").run({ id, mode, t: this.now() });
  }

  delete(id: string) {
    this.db.query("DELETE FROM projects WHERE id = $id").run({ id });
    this.pruneGroups();
  }

  /**
   * Hand out the next native ticket key (KEY-n) inside the caller's transaction, skipping
   * numbers already taken (e.g. a legacy mirror whose remote ID happens to share the prefix).
   */
  takeNextKey(projectId: string, isTaken: (key: string) => boolean): string {
    const p = this.get(projectId);
    if (!p) throw new Error(`Unknown project ${projectId}`);
    let seq = p.nextSeq;
    while (isTaken(`${p.key}-${seq}`)) seq++;
    this.db.query("UPDATE projects SET next_seq = $next, updated_at = $t WHERE id = $id").run({ id: projectId, next: seq + 1, t: this.now() });
    return `${p.key}-${seq}`;
  }
}

/** Raised by GroupRepo.rename when another group already has the name. */
export class GroupNameTaken extends Error {
  constructor(readonly name: string) {
    super(`A group named "${name}" already exists`);
  }
}

/** The groups_name index refused the name (a clash the in-code check missed). */
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE";

interface GroupRow {
  id: string;
  name: string;
  created_at: number;
}

const toGroup = (r: GroupRow): Group => ({ id: r.id, name: r.name, createdAt: r.created_at });

/**
 * Project groups (DESIGN.md "Project groups"). A group's id never changes; its name is unique
 * without case. A group is deleted when its last project leaves (ProjectRepo), so a name it had is
 * free again. Callers normalize names first (normalizeProjectGroup).
 */
export class GroupRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  list(): Group[] {
    return (this.db.query("SELECT * FROM groups ORDER BY name COLLATE NOCASE, id").all() as GroupRow[]).map(toGroup);
  }

  get(id: string): Group | null {
    const r = this.db.query("SELECT * FROM groups WHERE id = $id").get({ id }) as GroupRow | null;
    return r ? toGroup(r) : null;
  }

  /** The group with this name, in any case ("work" finds "Work"). */
  findByName(name: string): Group | null {
    return this.list().find((g) => sameGroup(g.name, name)) ?? null;
  }

  /** The group named `name`, made if there is none. */
  findOrCreate(name: string): Group {
    const hit = this.findByName(name);
    if (hit) return hit;
    const id = newId();
    try {
      this.db.query("INSERT INTO groups (id, name, created_at) VALUES ($id, $name, $t)").run({ id, name, t: this.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw new GroupNameTaken(name);
      throw err;
    }
    return this.get(id)!;
  }

  /**
   * Change a group's name, and mirror it into group_name of its projects, in one transaction.
   * Throws GroupNameTaken when another group has the name (in any case); a case-only change of the
   * group's own name is fine. Returns null for an unknown id.
   */
  rename(id: string, name: string): { group: Group; projectIds: string[] } | null {
    return this.db.transaction(() => {
      if (!this.get(id)) return null;
      const clash = this.list().find((g) => g.id !== id && sameGroup(g.name, name));
      if (clash) throw new GroupNameTaken(name);
      try {
        this.db.query("UPDATE groups SET name = $name WHERE id = $id").run({ id, name });
      } catch (err) {
        if (isUniqueViolation(err)) throw new GroupNameTaken(name);
        throw err;
      }
      const projectIds = (this.db.query("SELECT id FROM projects WHERE group_id = $id ORDER BY created_at, key").all({ id }) as { id: string }[]).map((r) => r.id);
      this.db.query("UPDATE projects SET group_name = $name, updated_at = $t WHERE group_id = $id").run({ id, name, t: this.now() });
      return { group: this.get(id)!, projectIds };
    })();
  }
}
