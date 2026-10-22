import type { Database } from "bun:sqlite";
import type { CosBadge, CosEvent, CosEventSource, CosEventStatus, CosEventVerdict } from "@harness/shared";
import { COS_OPEN_STATUSES } from "@harness/shared";
import { fromJson, newId } from "./util";
import { type Clock, systemClock } from "../clock";

/** A stored event: the wire CosEvent plus what the engine needs and clients don't. */
export interface StoredCosEvent extends CosEvent {
  projectId: string | null;
  ticketId: string | null;
  /** The activity kind ("moved", "submitted", ...) for activity events, else "" */
  kind: string;
  sourceRef: string;
  /** Raw content of the event (a watcher's output, an activity body): untrusted */
  payload: Record<string, unknown>;
  /** The run a wake went to, once handed over */
  consumingRunId: string | null;
  updatedAt: number;
}

interface Row {
  id: string;
  cos_id: string | null;
  project_id: string | null;
  ticket_id: string | null;
  source_kind: string;
  source_ref: string;
  kind: string;
  actor: string;
  title: string;
  summary: string;
  payload: string;
  verdict: string;
  reason: string | null;
  model: string | null;
  status: string;
  wake_id: string | null;
  consuming_run_id: string | null;
  created_at: number;
  updated_at: number;
  project_key: string | null;
  ticket_key: string | null;
}

const SELECT = `SELECT e.*, p.key AS project_key, t.key AS ticket_key FROM cos_events e
  LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tickets t ON t.id = e.ticket_id`;

const toEvent = (r: Row): StoredCosEvent => ({
  id: r.id,
  cosId: r.cos_id,
  projectKey: r.project_key,
  sourceKind: r.source_kind as CosEventSource,
  title: r.title,
  summary: r.summary,
  actor: r.actor,
  status: r.status as CosEventStatus,
  verdict: r.verdict as CosEventVerdict,
  reason: r.reason,
  model: r.model,
  ticketKey: r.ticket_key,
  wakeId: r.wake_id,
  handledBy: r.status === "handled" ? r.consuming_run_id : null,
  createdAt: r.created_at,
  projectId: r.project_id,
  ticketId: r.ticket_id,
  kind: r.kind,
  sourceRef: r.source_ref,
  payload: fromJson<Record<string, unknown>>(r.payload, {}),
  consumingRunId: r.consuming_run_id,
  updatedAt: r.updated_at,
});

export interface NewCosEvent {
  cosId: string | null;
  projectId: string | null;
  ticketId: string | null;
  sourceKind: CosEventSource;
  /** Unique per source: an activity row's id, a watcher's content hash, a schedule fire */
  sourceRef: string;
  kind?: string;
  actor: string;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  /** A coded rule dropped it on the way in */
  filtered?: string;
  createdAt?: number;
}

export interface EventPatch {
  cosId?: string | null;
  projectId?: string | null;
  verdict?: CosEventVerdict;
  reason?: string | null;
  model?: string | null;
  status?: CosEventStatus;
  wakeId?: string | null;
  consumingRunId?: string | null;
  summary?: string;
  payload?: Record<string, unknown>;
}

const COLUMNS: Record<keyof EventPatch, string> = {
  cosId: "cos_id",
  projectId: "project_id",
  verdict: "verdict",
  reason: "reason",
  model: "model",
  status: "status",
  wakeId: "wake_id",
  consumingRunId: "consuming_run_id",
  summary: "summary",
  payload: "payload",
};

export interface WakeLog {
  cosId: string;
  kind: "wake" | "triage";
  eventCount: number;
  /** A wake's one-line digest of what triage ignored before it */
  digest?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** The chief-of-staff Inbox (DESIGN.md "Events"): every event with its one owner, verdict and status. */
export class CosEventRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  /** The last activity row the feed read. */
  activitySeq(): number {
    return (this.db.query("SELECT value FROM cos_state WHERE key = 'activity_seq'").get() as { value: number } | null)?.value ?? 0;
  }

  setActivitySeq(seq: number) {
    this.db.query("INSERT INTO cos_state (key, value) VALUES ('activity_seq', $seq) ON CONFLICT(key) DO UPDATE SET value = $seq").run({ seq });
  }

  /** Insert an event; null when the source already produced it (deduped). */
  insert(input: NewCosEvent): StoredCosEvent | null {
    const id = newId();
    const t = this.now();
    const filtered = input.filtered !== undefined;
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO cos_events (id, cos_id, project_id, ticket_id, source_kind, source_ref, kind, actor, title, summary, payload, verdict, reason, status, created_at, updated_at)
         VALUES ($id, $cosId, $projectId, $ticketId, $sourceKind, $sourceRef, $kind, $actor, $title, $summary, $payload, $verdict, $reason, $status, $createdAt, $t)`,
      )
      .run({
        id,
        cosId: input.cosId,
        projectId: input.projectId,
        ticketId: input.ticketId,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        kind: input.kind ?? "",
        actor: input.actor,
        title: input.title,
        summary: input.summary ?? "",
        payload: JSON.stringify(input.payload ?? {}),
        verdict: filtered ? "filtered" : "pending",
        reason: filtered ? (input.filtered ?? null) : null,
        status: filtered ? "ignored" : "pending",
        createdAt: input.createdAt ?? t,
        t,
      });
    return res.changes ? this.get(id) : null;
  }

  get(id: string): StoredCosEvent | null {
    const r = this.db.query(`${SELECT} WHERE e.id = $id`).get({ id }) as Row | null;
    return r ? toEvent(r) : null;
  }

  /** Newest first. A chief's page includes the unassigned events, so a chief that is off or missing never hides them. */
  list(opts: { cosId?: string; status?: CosEventStatus; before?: { createdAt: number; id: string }; limit: number }): StoredCosEvent[] {
    const where: string[] = ["1 = 1"];
    const args: Record<string, string | number> = { limit: opts.limit };
    if (opts.cosId) {
      where.push("(e.cos_id = $cosId OR e.cos_id IS NULL)");
      args.cosId = opts.cosId;
    }
    if (opts.status) {
      where.push("e.status = $status");
      args.status = opts.status;
    }
    if (opts.before) {
      where.push("(e.created_at < $bt OR (e.created_at = $bt AND e.id < $bid))");
      args.bt = opts.before.createdAt;
      args.bid = opts.before.id;
    }
    return (this.db.query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC, e.id DESC LIMIT $limit`).all(args) as Row[]).map(toEvent);
  }

  /** Events with a status, oldest first; `cosId` null for the unassigned ones, undefined for every owner. */
  byStatus(status: CosEventStatus, cosId?: string | null): StoredCosEvent[] {
    const owner = cosId === undefined ? "" : cosId === null ? "AND e.cos_id IS NULL" : "AND e.cos_id = $cosId";
    const args: Record<string, string> = { status };
    if (typeof cosId === "string") args.cosId = cosId;
    return (this.db.query(`${SELECT} WHERE e.status = $status ${owner} ORDER BY e.created_at, e.rowid`).all(args) as Row[]).map(toEvent);
  }

  byWake(wakeId: string): StoredCosEvent[] {
    return (this.db.query(`${SELECT} WHERE e.wake_id = $wakeId ORDER BY e.created_at, e.rowid`).all({ wakeId }) as Row[]).map(toEvent);
  }

  byRun(runId: string, status: CosEventStatus): StoredCosEvent[] {
    return (this.db.query(`${SELECT} WHERE e.consuming_run_id = $runId AND e.status = $status`).all({ runId, status }) as Row[]).map(toEvent);
  }

  update(id: string, patch: EventPatch): StoredCosEvent | null {
    const sets = Object.keys(patch)
      .filter((k) => patch[k as keyof EventPatch] !== undefined)
      .map((k) => `${COLUMNS[k as keyof EventPatch]} = $${k}`);
    if (!sets.length) return this.get(id);
    const args: Record<string, string | number | null> = { id, t: this.now() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) args[k] = k === "payload" ? JSON.stringify(v) : (v as string | null);
    this.db.query(`UPDATE cos_events SET ${sets.join(", ")}, updated_at = $t WHERE id = $id`).run(args);
    return this.get(id);
  }

  /** Open events (pending → handling) per chief, plus the unassigned ones. */
  badge(): CosBadge {
    const marks = COS_OPEN_STATUSES.map((_, i) => `$s${i}`).join(", ");
    const args = Object.fromEntries(COS_OPEN_STATUSES.map((s, i) => [`s${i}`, s]));
    const rows = this.db.query(`SELECT cos_id, COUNT(*) AS n FROM cos_events WHERE status IN (${marks}) GROUP BY cos_id`).all(args) as { cos_id: string | null; n: number }[];
    const byCos: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      total += r.n;
      if (r.cos_id) byCos[r.cos_id] = r.n;
    }
    return { total, byCos };
  }

  /** A crash left events mid-triage: triage starts over. (Events a wake was handling are settled by the engine, which can see whether the run survived.) */
  recover(): number {
    return this.db.query("UPDATE cos_events SET status = 'pending', wake_id = NULL, updated_at = $t WHERE status = 'triaging'").run({ t: this.now() }).changes;
  }

  /** What was ignored for a chief since `since` (the digest an escalation brief ends with), newest first. */
  ignoredSince(cosId: string, since: number): { reason: string | null; title: string }[] {
    return this.db
      .query("SELECT reason, title FROM cos_events WHERE cos_id = $cosId AND status = 'ignored' AND verdict <> 'filtered' AND updated_at > $since ORDER BY updated_at DESC")
      .all({ cosId, since }) as { reason: string | null; title: string }[];
  }

  /** Delete settled events (ignored, handled) last touched before `before`, and the wake log from before it. */
  prune(before: number): number {
    this.db.query("DELETE FROM cos_wakes WHERE started_at < $before").run({ before });
    return this.db.query("DELETE FROM cos_events WHERE status IN ('ignored', 'handled') AND updated_at < $before").run({ before }).changes;
  }

  /** Delete unowned events still waiting (pending, escalated) that are older than `before`, and all but the newest `keep` of the rest. */
  pruneUnassigned(before: number, keep: number): number {
    // Open items converted from the old Inbox (migration 49) wait for the All chief; they are never pruned.
    const open = "cos_id IS NULL AND status IN ('pending', 'escalated') AND source_ref NOT LIKE 'triage:%'";
    const old = this.db.query(`DELETE FROM cos_events WHERE ${open} AND created_at < $before`).run({ before }).changes;
    const over = this.db
      .query(`DELETE FROM cos_events WHERE ${open} AND id IN (SELECT id FROM cos_events WHERE ${open} ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET $keep)`)
      .run({ keep }).changes;
    return old + over;
  }

  addWake(log: WakeLog): string {
    const id = newId();
    this.db
      .query("INSERT INTO cos_wakes (id, cos_id, kind, started_at, event_count, digest, model, tokens_in, tokens_out) VALUES ($id, $cosId, $kind, $t, $n, $digest, $model, $tin, $tout)")
      .run({ id, cosId: log.cosId, kind: log.kind, t: this.now(), n: log.eventCount, digest: log.digest ?? null, model: log.model ?? null, tin: log.tokensIn ?? null, tout: log.tokensOut ?? null });
    return id;
  }

  /** Token counts of a full wake, known once its run reports them. */
  setWakeTokens(id: string, tokensIn: number, tokensOut: number) {
    this.db.query("UPDATE cos_wakes SET tokens_in = $tokensIn, tokens_out = $tokensOut WHERE id = $id").run({ id, tokensIn, tokensOut });
  }

  wakeTimes(cosId: string, kind: "wake" | "triage", since: number): number[] {
    return (this.db.query("SELECT started_at FROM cos_wakes WHERE cos_id = $cosId AND kind = $kind AND started_at > $since ORDER BY started_at").all({ cosId, kind, since }) as { started_at: number }[]).map(
      (r) => r.started_at,
    );
  }

  lastWakeAt(cosId: string): number {
    return (this.db.query("SELECT MAX(started_at) AS t FROM cos_wakes WHERE cos_id = $cosId AND kind = 'wake'").get({ cosId }) as { t: number | null }).t ?? 0;
  }

  wake(id: string): { id: string; cosId: string; kind: string; startedAt: number; eventCount: number; model: string | null; tokensIn: number | null; tokensOut: number | null } | null {
    const r = this.db.query("SELECT * FROM cos_wakes WHERE id = $id").get({ id }) as Record<string, unknown> | null;
    return r
      ? {
          id: r.id as string,
          cosId: r.cos_id as string,
          kind: r.kind as string,
          startedAt: r.started_at as number,
          eventCount: r.event_count as number,
          model: r.model as string | null,
          tokensIn: r.tokens_in as number | null,
          tokensOut: r.tokens_out as number | null,
        }
      : null;
  }

  /** Wakes (full) of a chief older than the cursor, newest first (ties by id), for the chat's event batches. */
  wakesBefore(cosId: string, before: { createdAt: number; id: string } | null, limit: number): { id: string; startedAt: number; digest: string }[] {
    return (
      this.db
        .query(
          `SELECT id, started_at, digest FROM cos_wakes WHERE cos_id = $cosId AND kind = 'wake'
           AND ($bt IS NULL OR started_at < $bt OR (started_at = $bt AND ('wake:' || id) < $bid)) ORDER BY started_at DESC, id DESC LIMIT $limit`,
        )
        .all({ cosId, bt: before?.createdAt ?? null, bid: before?.id ?? "", limit }) as { id: string; started_at: number; digest: string | null }[]
    ).map((r) => ({ id: r.id, startedAt: r.started_at, digest: r.digest ?? "" }));
  }
}
