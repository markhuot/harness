import type { Database } from "bun:sqlite";
import type { CompletionAction, ExternalRef, MessageAnnotation, PendingApproval, PermissionMode, PromptAttachment, ReviewState, Ticket, TicketKind, TicketPage, TicketStatus } from "@harness/shared";
import { isCompletionAction } from "@harness/shared";
import { hasSearchIndex } from "../db";
import { clampLimit, decodeCursor, DEFAULT_PAGE_LIMIT, DEFAULT_SEARCH_LIMIT, encodeCursor, ftsQuery, keyCandidate, likePattern, searchTerms } from "./search";
import { bool, fromJson, int, newId, now, toJson } from "./util";

interface TicketRow {
  id: string;
  key: string;
  project_id: string;
  kind: string;
  title: string;
  spec: string;
  spec_revision: number;
  spec_baseline_revision: number | null;
  status: string;
  session_id: string;
  driver: string;
  parent_id: string | null;
  auto_start: number;
  agent_review: string;
  human_review: string;
  external_ref: string | null;
  workdir: string | null;
  branch: string | null;
  blocked_reason: string | null;
  permission_mode: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  pending_approval: string | null;
  allowed_tools: string;
  review_rejections: number;
  model: string | null;
  use_worktree: number | null;
  base_branch: string | null;
  requested_branch: string | null;
  skip_agent_review: number;
  skip_human_review?: number;
  completion_action?: string | null;
  completion_instructions?: string | null;
  pull_request_url?: string | null;
  has_changes?: number | null;
  draft?: number;
  prompt_attachments?: string;
  prompt_annotations?: string;
  completed_at: number | null;
  busy: number;
  child_count: number;
}

/**
 * Identity of a tool call for one-time grants: tool name + canonical input. A Bash call's
 * `description`, `timeout` and `run_in_background` are how the model labels and runs the command
 * (and it changes them on a retry); they aren't part of what the human approved, so they're left
 * out. Everything else (command, dangerouslyDisableSandbox, ...) must match.
 */
const BASH_EXECUTION_KEYS = ["description", "timeout", "run_in_background"];

export function grantKey(toolName: string, input: unknown): string {
  let i = input;
  if (toolName === "Bash" && i && typeof i === "object" && !Array.isArray(i)) {
    i = Object.fromEntries(Object.entries(i as Record<string, unknown>).filter(([k]) => !BASH_EXECUTION_KEYS.includes(k)));
  }
  return `${toolName}\u0000${canonicalJson(i)}`;
}

/** JSON with object keys sorted, so deep-equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value) ?? null);
}

const BUSY = `EXISTS(SELECT 1 FROM runs r WHERE r.session_id = t.session_id AND r.status IN ('queued','running')) AS busy`;
const CHILD_COUNT = `(SELECT COUNT(*) FROM tickets c WHERE c.parent_id = t.id) AS child_count`;
/** Columns computed per row on top of `t.*`. */
const DERIVED = `${BUSY}, ${CHILD_COUNT}`;
const SELECT = `SELECT t.*, ${DERIVED} FROM tickets t`;

type SqlParams = Record<string, string | number | null>;

export interface NewTicket {
  key: string;
  projectId: string;
  kind: TicketKind;
  title: string;
  /** Revision 1 of the spec */
  spec: string;
  status: TicketStatus;
  sessionId: string;
  driver: string;
  parentId: string | null;
  dependsOn: string[];
  autoStart: boolean;
  externalRef: ExternalRef | null;
  workdir: string | null;
  model?: string | null;
  useWorktree?: boolean | null;
  baseBranch?: string | null;
  requestedBranch?: string | null;
  skipAgentReview?: boolean;
  skipHumanReview?: boolean;
  /** A draft (Ticket.draft): never runs until submitted */
  draft?: boolean;
  /** Ticket.promptAttachments, already validated */
  promptAttachments?: PromptAttachment[];
  /** Ticket.promptAnnotations, already validated against promptAttachments */
  promptAnnotations?: MessageAnnotation[];
}

/** Every column but the spec, which only SpecRepo writes (a revision each time). */
export type TicketPatch = Partial<{
  title: string;
  status: TicketStatus;
  driver: string;
  autoStart: boolean;
  agentReview: ReviewState;
  humanReview: ReviewState;
  workdir: string | null;
  branch: string | null;
  blockedReason: string | null;
  permissionMode: PermissionMode | null;
  position: number;
  dependsOn: string[];
  pendingApproval: PendingApproval | null;
  allowedTools: string[];
  reviewRejections: number;
  model: string | null;
  baseBranch: string | null;
  requestedBranch: string | null;
  skipAgentReview: boolean;
  skipHumanReview: boolean;
  completionAction: CompletionAction | null;
  completionInstructions: string | null;
  pullRequestUrl: string | null;
  hasChanges: boolean | null;
  draft: boolean;
  kind: TicketKind;
  useWorktree: boolean | null;
  promptAttachments: PromptAttachment[];
  promptAnnotations: MessageAnnotation[];
}>;

const COLUMNS: Record<string, string> = {
  title: "title",
  status: "status",
  driver: "driver",
  autoStart: "auto_start",
  agentReview: "agent_review",
  humanReview: "human_review",
  workdir: "workdir",
  branch: "branch",
  blockedReason: "blocked_reason",
  permissionMode: "permission_mode",
  position: "position",
  pendingApproval: "pending_approval",
  allowedTools: "allowed_tools",
  reviewRejections: "review_rejections",
  model: "model",
  baseBranch: "base_branch",
  requestedBranch: "requested_branch",
  skipAgentReview: "skip_agent_review",
  skipHumanReview: "skip_human_review",
  completionAction: "completion_action",
  completionInstructions: "completion_instructions",
  pullRequestUrl: "pull_request_url",
  hasChanges: "has_changes",
  draft: "draft",
  kind: "kind",
  useWorktree: "use_worktree",
  promptAttachments: "prompt_attachments",
  promptAnnotations: "prompt_annotations",
};

const JSON_FIELDS = new Set(["pendingApproval", "allowedTools", "promptAttachments", "promptAnnotations"]);

export class TicketRepo {
  constructor(private db: Database) {}

  private deps(ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = this.db
      .query(`SELECT ticket_id, depends_on_key FROM ticket_deps WHERE ticket_id IN (${ids.map(() => "?").join(",")}) ORDER BY ord`)
      .all(...ids) as { ticket_id: string; depends_on_key: string }[];
    for (const r of rows) {
      const list = out.get(r.ticket_id) ?? [];
      list.push(r.depends_on_key);
      out.set(r.ticket_id, list);
    }
    return out;
  }

  private map(rows: TicketRow[]): Ticket[] {
    const deps = this.deps(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      projectId: r.project_id,
      kind: r.kind as TicketKind,
      title: r.title,
      spec: r.spec,
      specRevision: r.spec_revision ?? 1,
      specBaselineRevision: r.spec_baseline_revision ?? null,
      status: r.status as TicketStatus,
      sessionId: r.session_id,
      driver: r.driver,
      parentId: r.parent_id,
      dependsOn: deps.get(r.id) ?? [],
      autoStart: bool(r.auto_start),
      agentReview: r.agent_review as ReviewState,
      humanReview: r.human_review as ReviewState,
      externalRef: fromJson<ExternalRef | null>(r.external_ref, null),
      workdir: r.workdir,
      branch: r.branch,
      requestedBranch: r.requested_branch ?? null,
      baseBranch: r.base_branch ?? null,
      blockedReason: r.blocked_reason,
      permissionMode: (r.permission_mode as PermissionMode | null) ?? null,
      busy: bool(r.busy),
      childCount: r.child_count ?? 0,
      pendingApproval: fromJson<PendingApproval | null>(r.pending_approval, null),
      allowedTools: fromJson<string[]>(r.allowed_tools, []),
      model: r.model ?? null,
      useWorktree: r.use_worktree === null || r.use_worktree === undefined ? null : bool(r.use_worktree),
      skipAgentReview: bool(r.skip_agent_review ?? 0),
      skipHumanReview: bool(r.skip_human_review ?? 0),
      completionAction: isCompletionAction(r.completion_action) ? r.completion_action : null,
      completionInstructions: r.completion_instructions ?? null,
      pullRequestUrl: r.pull_request_url ?? null,
      hasChanges: r.has_changes === null || r.has_changes === undefined ? null : bool(r.has_changes),
      draft: bool(r.draft ?? 0),
      promptAttachments: fromJson<PromptAttachment[]>(r.prompt_attachments ?? null, []),
      promptAnnotations: fromJson<MessageAnnotation[]>(r.prompt_annotations ?? null, []),
      position: r.position,
      completedAt: r.completed_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** `drafts: false` leaves drafts out (what agents see). */
  list(filter: { projectId?: string; parentId?: string; statuses?: TicketStatus[]; drafts?: boolean } = {}): Ticket[] {
    const where: string[] = [];
    if (filter.drafts === false) where.push("t.draft = 0");
    const params: Record<string, string> = {};
    if (filter.statuses) {
      if (!filter.statuses.length) return [];
      where.push(`t.status IN (${filter.statuses.map((_, i) => `$status${i}`).join(", ")})`);
      filter.statuses.forEach((st, i) => (params[`status${i}`] = st));
    }
    if (filter.projectId) {
      where.push("t.project_id = $projectId");
      params.projectId = filter.projectId;
    }
    if (filter.parentId) {
      where.push("t.parent_id = $parentId");
      params.parentId = filter.parentId;
    }
    const sql = `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.position, t.created_at`;
    return this.map(this.db.query(sql).all(params) as TicketRow[]);
  }

  /**
   * The search hit set for `q` as CTEs ending in `hits(id, rank)`: rank 0 exact key, 1 key
   * prefix (current key or an old one from before a rename), 2 exact remote ID, 3 remote ID
   * prefix, 4 every term in the title, 5 every term somewhere in key/old keys/title/spec/
   * latest note/remote ID. FTS5 prefix matching when the index exists, LIKE substring
   * matching otherwise.
   */
  private hitsCte(q: string, params: SqlParams): string {
    const k = keyCandidate(q);
    params.kExact = k;
    params.kPrefix = k === null ? null : likePattern(k, true);
    let text: string;
    if (this.fts()) {
      const all = ftsQuery(q);
      const title = ftsQuery(q, "title");
      if (all && title) {
        params.ftsAll = all;
        params.ftsTitle = title;
        const via = (p: string) =>
          `SELECT s.ticket_id AS id FROM ticket_fts JOIN ticket_search s ON s.rowid = ticket_fts.rowid WHERE ticket_fts MATCH $${p}`;
        text = `fts AS (${via("ftsAll")}), ftitle AS (${via("ftsTitle")})`;
      } else {
        text = "fts AS (SELECT NULL AS id WHERE 0), ftitle AS (SELECT NULL AS id WHERE 0)";
      }
    } else {
      const terms = searchTerms(q);
      if (terms.length) {
        const cols = ["key", "aliases", "title", "spec", "latest_note", "external_key"];
        terms.forEach((term, i) => (params[`like${i}`] = `%${likePattern(term, false)}%`));
        const anyCol = terms.map((_, i) => `(${cols.map((c) => `s.${c} LIKE $like${i} ESCAPE '\\'`).join(" OR ")})`).join(" AND ");
        const inTitle = terms.map((_, i) => `s.title LIKE $like${i} ESCAPE '\\'`).join(" AND ");
        text = `fts AS (SELECT s.ticket_id AS id FROM ticket_search s WHERE ${anyCol}), ftitle AS (SELECT s.ticket_id AS id FROM ticket_search s WHERE ${inTitle})`;
      } else {
        text = "fts AS (SELECT NULL AS id WHERE 0), ftitle AS (SELECT NULL AS id WHERE 0)";
      }
    }
    return `WITH ${text},
      kexact AS (SELECT id FROM tickets WHERE key = $kExact UNION SELECT ticket_id FROM ticket_key_aliases WHERE key = $kExact),
      kprefix AS (SELECT id FROM tickets WHERE key LIKE $kPrefix ESCAPE '\\' UNION SELECT ticket_id FROM ticket_key_aliases WHERE key LIKE $kPrefix ESCAPE '\\'),
      rexact AS (SELECT id FROM tickets WHERE external_key = $kExact),
      rprefix AS (SELECT id FROM tickets WHERE external_key LIKE $kPrefix ESCAPE '\\'),
      hits AS (
        SELECT t.id AS id, CASE
          WHEN t.id IN (SELECT id FROM kexact) THEN 0
          WHEN t.id IN (SELECT id FROM kprefix) THEN 1
          WHEN t.id IN (SELECT id FROM rexact) THEN 2
          WHEN t.id IN (SELECT id FROM rprefix) THEN 3
          WHEN t.id IN (SELECT id FROM ftitle) THEN 4
          ELSE 5 END AS rank
        FROM tickets t WHERE t.id IN (SELECT id FROM kprefix) OR t.id IN (SELECT id FROM rprefix) OR t.id IN (SELECT id FROM fts)
      )`;
  }

  private ftsAvailable: boolean | undefined;
  private fts(): boolean {
    return (this.ftsAvailable ??= hasSearchIndex(this.db));
  }

  /**
   * One page of a single column, keyset-paged (no OFFSET, so tickets completed, moved or deleted
   * between fetches never cause a duplicate or a skip). done: newest completion first; other
   * statuses: position, then creation. `q` narrows to search hits (same matching as search).
   * Throws CursorError for a cursor that isn't from this ordering.
   */
  page(opts: { status: TicketStatus; projectId?: string; q?: string; limit?: number; cursor?: string | null }): TicketPage {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE_LIMIT);
    const params: SqlParams = { status: opts.status };
    const where = ["t.status = $status"];
    if (opts.projectId) {
      where.push("t.project_id = $projectId");
      params.projectId = opts.projectId;
    }
    let cte = "";
    if (opts.q !== undefined) {
      cte = this.hitsCte(opts.q, params);
      where.push("t.id IN (SELECT id FROM hits)");
    }
    const total = (this.db.query(`${cte} SELECT COUNT(*) AS n FROM tickets t WHERE ${where.join(" AND ")}`).get(params) as { n: number }).n;

    const done = opts.status === "done";
    const keyed = [...where];
    const pageParams: SqlParams = { ...params, limit: limit + 1 };
    if (opts.cursor) {
      if (done) {
        const [c, id] = decodeCursor(opts.cursor, "d", ["n", "s"]);
        keyed.push("(t.completed_at < $cC OR (t.completed_at = $cC AND t.id < $cId))");
        Object.assign(pageParams, { cC: c!, cId: id! });
      } else {
        const [pos, created, id] = decodeCursor(opts.cursor, "p", ["n", "n", "s"]);
        keyed.push("(t.position > $cP OR (t.position = $cP AND (t.created_at > $cT OR (t.created_at = $cT AND t.id > $cId))))");
        Object.assign(pageParams, { cP: pos!, cT: created!, cId: id! });
      }
    }
    const order = done ? "t.completed_at DESC, t.id DESC" : "t.position, t.created_at, t.id";
    const rows = this.db.query(`${cte} SELECT t.*, ${DERIVED} FROM tickets t WHERE ${keyed.join(" AND ")} ORDER BY ${order} LIMIT $limit`).all(pageParams) as TicketRow[];
    const more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      more && last
        ? done
          ? encodeCursor("d", [last.completed_at ?? 0, last.id])
          : encodeCursor("p", [last.position, last.created_at, last.id])
        : null;
    return { tickets: this.map(pageRows), nextCursor, total };
  }

  /**
   * Search every status (see hitsCte for matching and ranks): rank first, newest first within a
   * rank, keyset-paged. The caller rejects an empty `q`. Throws CursorError for a bad cursor.
   */
  search(opts: { q: string; projectId?: string; limit?: number; cursor?: string | null; drafts?: boolean }): TicketPage {
    const limit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT);
    const params: SqlParams = {};
    const cte = this.hitsCte(opts.q, params);
    const where = ["1"];
    if (opts.drafts === false) where.push("t.draft = 0");
    if (opts.projectId) {
      where.push("t.project_id = $projectId");
      params.projectId = opts.projectId;
    }
    const from = "FROM tickets t JOIN hits h ON h.id = t.id";
    const total = (this.db.query(`${cte} SELECT COUNT(*) AS n ${from} WHERE ${where.join(" AND ")}`).get(params) as { n: number }).n;
    const pageParams: SqlParams = { ...params, limit: limit + 1 };
    if (opts.cursor) {
      const [rank, created, id] = decodeCursor(opts.cursor, "s", ["n", "n", "s"]);
      where.push("(h.rank > $cR OR (h.rank = $cR AND (t.created_at < $cT OR (t.created_at = $cT AND t.id < $cId))))");
      Object.assign(pageParams, { cR: rank!, cT: created!, cId: id! });
    }
    const rows = this.db
      .query(`${cte} SELECT t.*, ${DERIVED}, h.rank AS rank ${from} WHERE ${where.join(" AND ")} ORDER BY h.rank, t.created_at DESC, t.id DESC LIMIT $limit`)
      .all(pageParams) as (TicketRow & { rank: number })[];
    const more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      tickets: this.map(pageRows),
      nextCursor: more && last ? encodeCursor("s", [last.rank, last.created_at, last.id]) : null,
      total,
    };
  }

  get(id: string): Ticket | null {
    return this.map(this.db.query(`${SELECT} WHERE t.id = $id`).all({ id }) as TicketRow[])[0] ?? null;
  }

  /**
   * Look a ticket up by key: its current key first, then an old key it had before a project
   * rename (ticket_key_aliases). A real ticket holding the key always wins over an alias.
   * This is the one place key lookups resolve aliases, so every route, tool and HarnessOps
   * method that goes through getByKey accepts old keys.
   */
  getByKey(key: string): Ticket | null {
    return this.lookup(key)?.ticket ?? null;
  }

  /** getByKey, plus the alias the lookup went through (null when `key` is the current key). */
  lookup(key: string): { ticket: Ticket; alias: string | null } | null {
    const k = key.trim().toUpperCase();
    const direct = this.map(this.db.query(`${SELECT} WHERE t.key = $key`).all({ key: k }) as TicketRow[])[0];
    if (direct) return { ticket: direct, alias: null };
    const viaAlias = this.map(
      this.db.query(`${SELECT} JOIN ticket_key_aliases a ON a.ticket_id = t.id WHERE a.key = $key`).all({ key: k }) as TicketRow[],
    )[0];
    return viaAlias ? { ticket: viaAlias, alias: k } : null;
  }

  /** The current key for `key` (itself, or the ticket an alias points at), or null if unknown. */
  resolveKey(key: string): string | null {
    return this.lookup(key)?.ticket.key ?? null;
  }

  /** Old keys that resolve to this ticket, oldest first. */
  aliases(ticketId: string): string[] {
    return (
      this.db.query("SELECT key FROM ticket_key_aliases WHERE ticket_id = $ticketId ORDER BY created_at, rowid").all({ ticketId }) as { key: string }[]
    ).map((r) => r.key);
  }

  getBySession(sessionId: string): Ticket | null {
    return this.map(this.db.query(`${SELECT} WHERE t.session_id = $sessionId`).all({ sessionId }) as TicketRow[])[0] ?? null;
  }

  /** Whether a ticket currently holds exactly this key. Aliases don't count: they never block a key. */
  keyExists(key: string): boolean {
    return !!this.db.query("SELECT 1 FROM tickets WHERE key = $key").get({ key: key.toUpperCase() });
  }

  /** Keys of tickets that list `key` in their dependsOn. */
  dependents(key: string): Ticket[] {
    const ids = (this.db.query("SELECT ticket_id FROM ticket_deps WHERE depends_on_key = $key").all({ key }) as { ticket_id: string }[]).map(
      (r) => r.ticket_id,
    );
    return ids.map((id) => this.get(id)).filter((t): t is Ticket => !!t);
  }

  nextPosition(projectId: string): number {
    const r = this.db.query("SELECT MAX(position) AS p FROM tickets WHERE project_id = $projectId").get({ projectId }) as { p: number | null };
    return (r.p ?? 0) + 1;
  }

  create(input: NewTicket): Ticket {
    const id = newId();
    const t = now();
    // A new ticket takes its key back from any alias: the real key would shadow it anyway, and
    // leaving the row would make the key resolve to the old ticket again if this one is deleted.
    this.db.query("DELETE FROM ticket_key_aliases WHERE key = $key").run({ key: input.key.toUpperCase() });
    this.db
      .query(
        `INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, parent_id, auto_start,
           agent_review, human_review, external_ref, external_key, workdir, branch, blocked_reason, position, model, use_worktree, base_branch, requested_branch, skip_agent_review, skip_human_review, draft, prompt_attachments, prompt_annotations, created_at, updated_at)
         VALUES ($id, $key, $projectId, $kind, $title, $spec, $status, $sessionId, $driver, $parentId, $autoStart,
           'pending', 'pending', $externalRef, $externalKey, $workdir, NULL, NULL, $position, $model, $useWorktree, $baseBranch, $requestedBranch, $skipAgentReview, $skipHumanReview, $draft, $promptAttachments, $promptAnnotations, $t, $t)`,
      )
      .run({
        id,
        key: input.key.toUpperCase(),
        projectId: input.projectId,
        kind: input.kind,
        title: input.title,
        spec: input.spec,
        status: input.status,
        sessionId: input.sessionId,
        driver: input.driver,
        parentId: input.parentId,
        autoStart: int(input.autoStart),
        externalRef: toJson(input.externalRef),
        externalKey: input.externalRef?.key ? input.externalRef.key.toUpperCase() : null,
        workdir: input.workdir,
        position: this.nextPosition(input.projectId),
        model: input.model ?? null,
        useWorktree: input.useWorktree === null || input.useWorktree === undefined ? null : int(input.useWorktree),
        baseBranch: input.baseBranch ?? null,
        requestedBranch: input.requestedBranch ?? null,
        skipAgentReview: int(input.skipAgentReview ?? false),
        skipHumanReview: int(input.skipHumanReview ?? false),
        draft: int(input.draft ?? false),
        promptAttachments: toJson(input.promptAttachments ?? []),
        promptAnnotations: toJson(input.promptAnnotations ?? []),
        t,
      });
    this.setDeps(id, input.dependsOn);
    this.db
      .query(
        "INSERT INTO spec_revisions (id, ticket_id, rev, body, author, run_id, run_kind, note, approved_baseline, created_at) VALUES ($rid, $id, 1, $spec, 'system', NULL, NULL, 'Created', 0, $t)",
      )
      .run({ rid: newId(), id, spec: input.spec, t });
    return this.get(id)!;
  }

  private setDeps(id: string, keys: string[]) {
    this.db.query("DELETE FROM ticket_deps WHERE ticket_id = $id").run({ id });
    const insert = this.db.query("INSERT OR IGNORE INTO ticket_deps (ticket_id, depends_on_key, ord) VALUES ($id, $key, $ord)");
    keys.forEach((key, ord) => insert.run({ id, key: key.toUpperCase(), ord }));
  }

  update(id: string, patch: TicketPatch): Ticket | null {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id, t: now() };
    for (const [field, value] of Object.entries(patch)) {
      const col = COLUMNS[field];
      if (!col || value === undefined) continue;
      sets.push(`${col} = $${field}`);
      params[field] = JSON_FIELDS.has(field) ? toJson(value) : typeof value === "boolean" ? int(value) : (value as string | number | null);
    }
    this.db.transaction(() => {
      this.db.query(`UPDATE tickets SET ${[...sets, "updated_at = $t"].join(", ")} WHERE id = $id`).run(params);
      if (patch.dependsOn) this.setDeps(id, patch.dependsOn);
    })();
    return this.get(id);
  }

  /**
   * Move a ticket to another project under `newKey` (a draft changing project): the ticket and its
   * session take the new key, it goes to the end of the new project's board, its branch choices
   * reset (they were the old project's), and the old key becomes an alias (as with a project
   * rename, see ProjectRepo.rekey) so anything that learned it keeps resolving. Dependencies that
   * named the old key follow. Runs inside the caller's transaction.
   */
  moveToProject(id: string, projectId: string, newKey: string): { from: string; to: string } {
    const t = now();
    const row = this.db.query("SELECT key FROM tickets WHERE id = $id").get({ id }) as { key: string } | null;
    if (!row) throw new Error(`Unknown ticket ${id}`);
    const from = row.key;
    const to = newKey.toUpperCase();
    this.db.query("DELETE FROM ticket_key_aliases WHERE key = $to").run({ to });
    this.db
      .query(
        `UPDATE tickets SET key = $to, project_id = $projectId, position = $position, requested_branch = NULL, base_branch = NULL,
           use_worktree = NULL, updated_at = $t WHERE id = $id`,
      )
      .run({ id, to, projectId, position: this.nextPosition(projectId), t });
    this.db.query("UPDATE sessions SET key = $to, updated_at = $t WHERE id = (SELECT session_id FROM tickets WHERE id = $id)").run({ id, to, t });
    this.db.query("INSERT OR REPLACE INTO ticket_key_aliases (key, ticket_id, created_at) VALUES ($from, $id, $t)").run({ from, id, t });
    this.db.query("UPDATE ticket_deps SET depends_on_key = $to WHERE depends_on_key = $from").run({ from, to });
    return { from, to };
  }

  /**
   * Link the ticket to a remote item, or unlink it with null. external_key (the indexed remote ID)
   * follows external_ref, so related-ticket lookups and search see the change.
   */
  setExternalRef(id: string, ref: ExternalRef | null): Ticket | null {
    const externalRef = ref ? { ...ref, key: ref.key.trim().toUpperCase() } : null;
    this.db
      .query("UPDATE tickets SET external_ref = $ref, external_key = $key, updated_at = $t WHERE id = $id")
      .run({ id, ref: toJson(externalRef), key: externalRef?.key ?? null, t: now() });
    return this.get(id);
  }

  /**
   * Tickets linked to this remote ID, newest first. `drafts: false` leaves drafts out (what agents
   * see). Never consulted by lookup: a remote ID doesn't identify a ticket.
   */
  byExternalKey(key: string, opts: { drafts?: boolean } = {}): Ticket[] {
    const k = key.trim().toUpperCase();
    if (!k) return [];
    const drafts = opts.drafts === false ? " AND t.draft = 0" : "";
    return this.map(this.db.query(`${SELECT} WHERE t.external_key = $k${drafts} ORDER BY t.created_at DESC, t.id DESC`).all({ k }) as TicketRow[]);
  }

  delete(id: string) {
    this.db.query("DELETE FROM tickets WHERE id = $id").run({ id });
  }

  reviewRejections(id: string): number {
    const r = this.db.query("SELECT review_rejections AS n FROM tickets WHERE id = $id").get({ id }) as { n: number } | null;
    return r?.n ?? 0;
  }

  /** Record a one-time grant for exactly this tool call. */
  addGrant(ticketId: string, toolName: string, input: unknown) {
    this.db
      .query("INSERT INTO approval_grants (ticket_id, tool_name, input, created_at) VALUES ($ticketId, $toolName, $input, $t)")
      .run({ ticketId, toolName, input: canonicalJson(input), t: now() });
  }

  /**
   * Consume a one-time grant matching toolName + deep-equal input (see grantKey: a Bash call's
   * `description` doesn't count). Returns true if one existed.
   */
  consumeGrant(ticketId: string, toolName: string, input: unknown): boolean {
    const key = grantKey(toolName, input);
    const row = this.listGrants(ticketId).find((g) => grantKey(g.toolName, g.input) === key);
    if (!row) return false;
    this.db.query("DELETE FROM approval_grants WHERE id = $id").run({ id: row.id });
    return true;
  }

  /** Drop these one-time grants of the ticket (ones already used up are ignored). */
  dropGrants(ticketId: string, ids: number[]) {
    const q = this.db.query("DELETE FROM approval_grants WHERE ticket_id = $ticketId AND id = $id");
    for (const id of ids) q.run({ ticketId, id });
  }

  /** The ticket's unconsumed one-time grants, oldest first. */
  listGrants(ticketId: string): { id: number; toolName: string; input: unknown }[] {
    const rows = this.db.query("SELECT id, tool_name, input FROM approval_grants WHERE ticket_id = $ticketId ORDER BY id").all({ ticketId }) as {
      id: number;
      tool_name: string;
      input: string;
    }[];
    return rows.map((r) => ({ id: r.id, toolName: r.tool_name, input: JSON.parse(r.input) }));
  }
}
