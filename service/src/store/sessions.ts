import type { Database } from "bun:sqlite";
import type { Session, SessionKind, TriageStatus } from "@harness/shared";
import { bool, fromJson, newId, now, toJson } from "./util";

interface SessionRow {
  id: string;
  key: string;
  kind: string;
  ticket_id: string | null;
  driver: string;
  cwd: string;
  title: string;
  triage_status: string | null;
  outcome: string | null;
  driver_state: string | null;
  meta: string | null;
  created_at: number;
  updated_at: number;
  busy: number;
}

const SELECT = `SELECT s.*, EXISTS(SELECT 1 FROM runs r WHERE r.session_id = s.id AND r.status IN ('queued','running')) AS busy FROM sessions s`;

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  key: r.key,
  kind: r.kind as SessionKind,
  ticketId: r.ticket_id,
  driver: r.driver,
  cwd: r.cwd,
  title: r.title,
  triageStatus: (r.triage_status as TriageStatus | null) ?? null,
  outcome: r.outcome,
  busy: bool(r.busy),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface NewSession {
  id?: string;
  key: string;
  kind: SessionKind;
  ticketId: string | null;
  driver: string;
  cwd: string;
  title: string;
  triageStatus?: TriageStatus | null;
  meta?: unknown;
}

export type SessionPatch = Partial<{
  key: string;
  ticketId: string | null;
  driver: string;
  cwd: string;
  title: string;
  triageStatus: TriageStatus | null;
  outcome: string | null;
}>;

const COLUMNS: Record<string, string> = {
  key: "key",
  ticketId: "ticket_id",
  driver: "driver",
  cwd: "cwd",
  title: "title",
  triageStatus: "triage_status",
  outcome: "outcome",
};

export class SessionRepo {
  constructor(private db: Database) {}

  list(kind?: SessionKind): Session[] {
    const rows = kind
      ? (this.db.query(`${SELECT} WHERE s.kind = $kind ORDER BY s.created_at DESC`).all({ kind }) as SessionRow[])
      : (this.db.query(`${SELECT} ORDER BY s.created_at DESC`).all() as SessionRow[]);
    return rows.map(toSession);
  }

  get(id: string): Session | null {
    const r = this.db.query(`${SELECT} WHERE s.id = $id`).get({ id }) as SessionRow | null;
    return r ? toSession(r) : null;
  }

  create(input: NewSession): Session {
    const id = input.id ?? newId();
    const t = now();
    this.db
      .query(
        `INSERT INTO sessions (id, key, kind, ticket_id, driver, cwd, title, triage_status, outcome, driver_state, meta, next_seq, created_at, updated_at)
         VALUES ($id, $key, $kind, $ticketId, $driver, $cwd, $title, $triageStatus, NULL, NULL, $meta, 1, $t, $t)`,
      )
      .run({
        id,
        key: input.key,
        kind: input.kind,
        ticketId: input.ticketId,
        driver: input.driver,
        cwd: input.cwd,
        title: input.title,
        triageStatus: input.triageStatus ?? null,
        meta: toJson(input.meta),
        t,
      });
    return this.get(id)!;
  }

  update(id: string, patch: SessionPatch): Session | null {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id, t: now() };
    for (const [field, value] of Object.entries(patch)) {
      const col = COLUMNS[field];
      if (!col || value === undefined) continue;
      sets.push(`${col} = $${field}`);
      params[field] = value as string | null;
    }
    this.db.query(`UPDATE sessions SET ${[...sets, "updated_at = $t"].join(", ")} WHERE id = $id`).run(params);
    return this.get(id);
  }

  getDriverState(id: string): unknown {
    const r = this.db.query("SELECT driver_state FROM sessions WHERE id = $id").get({ id }) as { driver_state: string | null } | null;
    return fromJson<unknown>(r?.driver_state, null);
  }

  setDriverState(id: string, state: unknown) {
    this.db.query("UPDATE sessions SET driver_state = $state, updated_at = $t WHERE id = $id").run({ id, state: toJson(state), t: now() });
  }

  getMeta<T>(id: string): T | null {
    const r = this.db.query("SELECT meta FROM sessions WHERE id = $id").get({ id }) as { meta: string | null } | null;
    return fromJson<T | null>(r?.meta, null);
  }

  delete(id: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM transcript WHERE session_id = $id").run({ id });
      this.db.query("DELETE FROM subagents WHERE session_id = $id").run({ id });
      this.db.query("DELETE FROM summaries WHERE session_id = $id").run({ id });
      this.db.query("DELETE FROM runs WHERE session_id = $id").run({ id });
      this.db.query("DELETE FROM sessions WHERE id = $id").run({ id });
    })();
  }
}
