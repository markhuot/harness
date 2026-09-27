import type { Database } from "bun:sqlite";
import type { ExternalRef, PendingApproval, PermissionMode, ReviewState, Ticket, TicketKind, TicketStatus } from "@harness/shared";
import { bool, fromJson, int, newId, now, toJson } from "./util";

interface TicketRow {
  id: string;
  key: string;
  project_id: string;
  kind: string;
  title: string;
  description: string;
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
  busy: number;
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

const SELECT = `SELECT t.*, EXISTS(SELECT 1 FROM runs r WHERE r.session_id = t.session_id AND r.status IN ('queued','running')) AS busy FROM tickets t`;

export interface NewTicket {
  key: string;
  projectId: string;
  kind: TicketKind;
  title: string;
  description: string;
  status: TicketStatus;
  sessionId: string;
  driver: string;
  parentId: string | null;
  dependsOn: string[];
  autoStart: boolean;
  externalRef: ExternalRef | null;
  workdir: string | null;
  model?: string | null;
}

export type TicketPatch = Partial<{
  title: string;
  description: string;
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
}>;

const COLUMNS: Record<string, string> = {
  title: "title",
  description: "description",
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
};

const JSON_FIELDS = new Set(["pendingApproval", "allowedTools"]);

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
      description: r.description,
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
      blockedReason: r.blocked_reason,
      permissionMode: (r.permission_mode as PermissionMode | null) ?? null,
      busy: bool(r.busy),
      pendingApproval: fromJson<PendingApproval | null>(r.pending_approval, null),
      allowedTools: fromJson<string[]>(r.allowed_tools, []),
      model: r.model ?? null,
      position: r.position,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  list(filter: { projectId?: string; parentId?: string } = {}): Ticket[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
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

  get(id: string): Ticket | null {
    return this.map(this.db.query(`${SELECT} WHERE t.id = $id`).all({ id }) as TicketRow[])[0] ?? null;
  }

  getByKey(key: string): Ticket | null {
    return this.map(this.db.query(`${SELECT} WHERE t.key = $key`).all({ key: key.trim().toUpperCase() }) as TicketRow[])[0] ?? null;
  }

  getBySession(sessionId: string): Ticket | null {
    return this.map(this.db.query(`${SELECT} WHERE t.session_id = $sessionId`).all({ sessionId }) as TicketRow[])[0] ?? null;
  }

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
    this.db
      .query(
        `INSERT INTO tickets (id, key, project_id, kind, title, description, status, session_id, driver, parent_id, auto_start,
           agent_review, human_review, external_ref, workdir, branch, blocked_reason, position, model, created_at, updated_at)
         VALUES ($id, $key, $projectId, $kind, $title, $description, $status, $sessionId, $driver, $parentId, $autoStart,
           'pending', 'pending', $externalRef, $workdir, NULL, NULL, $position, $model, $t, $t)`,
      )
      .run({
        id,
        key: input.key.toUpperCase(),
        projectId: input.projectId,
        kind: input.kind,
        title: input.title,
        description: input.description,
        status: input.status,
        sessionId: input.sessionId,
        driver: input.driver,
        parentId: input.parentId,
        autoStart: int(input.autoStart),
        externalRef: toJson(input.externalRef),
        workdir: input.workdir,
        position: this.nextPosition(input.projectId),
        model: input.model ?? null,
        t,
      });
    this.setDeps(id, input.dependsOn);
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

  /** Consume a one-time grant matching toolName + deep-equal input. Returns true if one existed. */
  consumeGrant(ticketId: string, toolName: string, input: unknown): boolean {
    const row = this.db
      .query("SELECT id FROM approval_grants WHERE ticket_id = $ticketId AND tool_name = $toolName AND input = $input ORDER BY id LIMIT 1")
      .get({ ticketId, toolName, input: canonicalJson(input) }) as { id: number } | null;
    if (!row) return false;
    this.db.query("DELETE FROM approval_grants WHERE id = $id").run({ id: row.id });
    return true;
  }
}
