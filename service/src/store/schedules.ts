import type { Database } from "bun:sqlite";
import type { Schedule, ScheduleKind, ScheduleOutcome, ScheduleSpec, ScheduleStatus } from "@harness/shared";
import { fromJson, newId } from "./util";
import { type Clock, systemClock } from "../clock";

interface ScheduleRow {
  id: string;
  cos_id: string;
  kind: string;
  title: string;
  message: string;
  spec: string;
  project_id: string | null;
  project_key: string | null;
  status: string;
  next_fire_at: number | null;
  last_fire_at: number | null;
  last_outcome: string | null;
  created_at: number;
}

const SELECT = "SELECT s.*, p.key AS project_key FROM schedules s LEFT JOIN projects p ON p.id = s.project_id";

const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  cosId: r.cos_id,
  kind: r.kind as ScheduleKind,
  title: r.title,
  message: r.message,
  spec: fromJson<ScheduleSpec>(r.spec, { type: "at", at: 0 }),
  projectKey: r.project_key,
  status: r.status as ScheduleStatus,
  nextFireAt: r.next_fire_at,
  lastFireAt: r.last_fire_at,
  lastOutcome: r.last_outcome as ScheduleOutcome | null,
  createdAt: r.created_at,
});

export interface NewSchedule {
  cosId: string;
  kind: ScheduleKind;
  title: string;
  message: string;
  spec: ScheduleSpec;
  projectId: string | null;
  nextFireAt: number;
}

/** What one fire changes on its schedule. */
export interface FireResult {
  status: ScheduleStatus;
  nextFireAt: number | null;
  lastFireAt: number;
  outcome: ScheduleOutcome;
}

/** A chief of staff's schedules (DESIGN.md "Schedules"); the scheduler fires them, the tools and the HTTP API create and cancel. */
export class ScheduleRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  insert(input: NewSchedule): Schedule {
    const id = newId();
    this.db
      .query(
        `INSERT INTO schedules (id, cos_id, kind, title, message, spec, project_id, status, next_fire_at, created_at)
         VALUES ($id, $cosId, $kind, $title, $message, $spec, $projectId, 'active', $nextFireAt, $t)`,
      )
      .run({ id, cosId: input.cosId, kind: input.kind, title: input.title, message: input.message, spec: JSON.stringify(input.spec), projectId: input.projectId, nextFireAt: input.nextFireAt, t: this.now() });
    return this.get(id)!;
  }

  get(id: string): Schedule | null {
    const r = this.db.query(`${SELECT} WHERE s.id = $id`).get({ id }) as ScheduleRow | null;
    return r ? toSchedule(r) : null;
  }

  /** A chief's schedules, soonest first; the finished ones only with `all`. */
  list(opts: { cosId?: string; all?: boolean; limit?: number } = {}): Schedule[] {
    const where = [opts.all ? "1" : "s.status = 'active'", opts.cosId ? "s.cos_id = $cosId" : "1"].join(" AND ");
    const rows = this.db
      .query(`${SELECT} WHERE ${where} ORDER BY s.status = 'active' DESC, s.next_fire_at IS NULL, s.next_fire_at, s.created_at LIMIT $limit`)
      .all({ ...(opts.cosId ? { cosId: opts.cosId } : {}), limit: opts.limit ?? 200 }) as ScheduleRow[];
    return rows.map(toSchedule);
  }

  countActive(cosId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM schedules WHERE cos_id = $cosId AND status = 'active'").get({ cosId }) as { n: number }).n;
  }

  /** Active schedules whose time has come, oldest first. */
  due(at: number): Schedule[] {
    const rows = this.db.query(`${SELECT} WHERE s.status = 'active' AND s.next_fire_at IS NOT NULL AND s.next_fire_at <= $at ORDER BY s.next_fire_at, s.created_at`).all({ at }) as ScheduleRow[];
    return rows.map(toSchedule);
  }

  /** Record a fire (or a skipped or missed one) of the occurrence due at `scheduledFor` and move the schedule on; false when it is no longer active at that time (cancelled meanwhile), so a fire can't undo a cancel. */
  fired(id: string, scheduledFor: number, r: FireResult): boolean {
    return (
      this.db
        .query("UPDATE schedules SET status = $status, next_fire_at = $next, last_fire_at = $last, last_outcome = $outcome WHERE id = $id AND status = 'active' AND next_fire_at = $scheduledFor")
        .run({ id, scheduledFor, status: r.status, next: r.nextFireAt, last: r.lastFireAt, outcome: r.outcome }).changes > 0
    );
  }

  /** Cancel an active schedule; false when it isn't one. */
  cancel(id: string): boolean {
    return this.db.query("UPDATE schedules SET status = 'cancelled', next_fire_at = NULL WHERE id = $id AND status = 'active'").run({ id }).changes > 0;
  }
}
