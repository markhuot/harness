import type { Database } from "bun:sqlite";
import type { CosBadge, TicketEvent, CosOutcome, TicketEventSource, TicketEventStatus, TicketEventVerdict } from "@harness/shared";
import { COS_OPEN_STATUSES, COS_OUTCOME_KINDS } from "@harness/shared";
import { fromJson, newId } from "./util";
import { type Clock, systemClock } from "../clock";

/** A stored event: the wire TicketEvent plus what the engine needs and clients don't. */
export interface StoredTicketEvent extends TicketEvent {
  /** The chief that owns it; null while no chief qualifies (unassigned) */
  cosId: string | null;
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
  target_id: string | null;
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

/** The kinds of row that wake an ordinary ticket (a parent hearing its children, a subscriber): delivered by the ticket instance of EventDelivery, never seen by a chief's triage or Inbox. */
export const TICKET_SOURCE_KINDS = ["subscription", "child"] as const;
export type EventScope = "chief" | "ticket";
const TICKET_KINDS_SQL = TICKET_SOURCE_KINDS.map((k) => `'${k}'`).join(", ");
/** The rows a scope reads: the chief of staff's pipeline (activity, watcher, schedule) or the ticket feed (subscription, child). */
const scopeSql = (scope: EventScope) => (scope === "ticket" ? `e.source_kind IN (${TICKET_KINDS_SQL})` : `e.source_kind NOT IN (${TICKET_KINDS_SQL})`);

const SELECT = `SELECT e.*, p.key AS project_key, t.key AS ticket_key FROM ticket_events e
  LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tickets t ON t.id = e.ticket_id`;

/** The outcome kept in a handled event's payload; anything else there reads as none. */
const outcomeOf = (payload: Record<string, unknown>): CosOutcome | null => {
  const o = payload.outcome as Partial<CosOutcome> | undefined;
  return o && (COS_OUTCOME_KINDS as readonly unknown[]).includes(o.kind) && typeof o.text === "string" ? { kind: o.kind!, text: o.text } : null;
};

const toEvent = (r: Row): StoredTicketEvent => {
  const payload = fromJson<Record<string, unknown>>(r.payload, {});
  return {
    id: r.id,
    cosId: r.cos_id,
    targetId: r.target_id,
    projectKey: r.project_key,
    sourceKind: r.source_kind as TicketEventSource,
    title: r.title,
    summary: r.summary,
    actor: r.actor,
    status: r.status as TicketEventStatus,
    verdict: r.verdict as TicketEventVerdict,
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
    outcome: outcomeOf(payload),
    triageSessionId: typeof payload.triageSession === "string" ? payload.triageSession : null,
    payload,
    consumingRunId: r.consuming_run_id,
    updatedAt: r.updated_at,
  };
};

export interface NewTicketEvent {
  cosId: string | null;
  /** The ticket the event wakes. Left out, it is `cosId` (the chief-of-staff kinds); a subscription or child row names it, and dedupes per target. */
  targetId?: string | null;
  projectId: string | null;
  ticketId: string | null;
  sourceKind: TicketEventSource;
  /** Unique per source: an activity row's id, a watcher's content hash, a schedule fire */
  sourceRef: string;
  kind?: string;
  actor: string;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  /** A coded rule dropped it on the way in */
  filtered?: string;
  /** Skip triage: the row waits for delivery at once (the ticket feed, whose rows no chief judges) */
  ready?: boolean;
  createdAt?: number;
}

export interface EventPatch {
  cosId?: string | null;
  projectId?: string | null;
  verdict?: TicketEventVerdict;
  reason?: string | null;
  model?: string | null;
  status?: TicketEventStatus;
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
  /** The ticket that was woken */
  targetId: string;
  /** The cap the wake counts against (the delivery policy's event class; "" for the chief's) */
  eventClass?: string;
  kind: "wake" | "triage";
  eventCount: number;
  /** A wake's one-line digest of what triage ignored before it */
  digest?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** The run the wake went to */
  runId?: string | null;
}

export type WakeOutcome = "spoke" | "quiet" | "failed";

/** What `list` and `count` filter by. */
export interface EventFilter {
  cosId?: string;
  targetId?: string;
  status?: TicketEventStatus;
  /** Any of these (wins over `status`) */
  statuses?: readonly TicketEventStatus[];
  sourceKind?: string;
  /** An event id or the key of the ticket it is about */
  key?: string;
  before?: { createdAt: number; id: string };
  /** Leave out rows a filter dropped (a ticket's Events tab never shows them) */
  hideFiltered?: boolean;
}

/** The events table (DESIGN.md "Events"): every event with its owner, target, verdict and status. A ticket's Events tab, a chief's Inbox and the delivery engines read it. */
export class TicketEventRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  /** The last activity row the feed read. */
  activitySeq(): number {
    return (this.db.query("SELECT value FROM cos_state WHERE key = 'activity_seq'").get() as { value: number } | null)?.value ?? 0;
  }

  setActivitySeq(seq: number) {
    this.db.query("INSERT INTO cos_state (key, value) VALUES ('activity_seq', $seq) ON CONFLICT(key) DO UPDATE SET value = $seq").run({ seq });
  }

  /** Insert an event; null when the source already produced it (deduped). */
  insert(input: NewTicketEvent): StoredTicketEvent | null {
    const id = newId();
    const t = this.now();
    const filtered = input.filtered !== undefined;
    // Rows with no explicit target belong to one source event however triage has since rehomed them, so a
    // repeat dedupes against any owner (the unique indexes only see equal targets).
    if (input.targetId === undefined && this.db.query("SELECT 1 FROM ticket_events WHERE source_kind = $k AND source_ref = $r").get({ k: input.sourceKind, r: input.sourceRef })) return null;
    // One change reaches a ticket once, whether it came as the parent or as a subscriber.
    if (input.targetId && (TICKET_SOURCE_KINDS as readonly string[]).includes(input.sourceKind) && this.db.query(`SELECT 1 FROM ticket_events e WHERE e.target_id = $t AND e.source_ref = $r AND ${scopeSql("ticket")}`).get({ t: input.targetId, r: input.sourceRef })) return null;
    const target = input.targetId === undefined ? input.cosId : input.targetId;
    this.touch(target);
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO ticket_events (id, cos_id, target_id, project_id, ticket_id, source_kind, source_ref, kind, actor, title, summary, payload, verdict, reason, status, created_at, updated_at)
         VALUES ($id, $cosId, $targetId, $projectId, $ticketId, $sourceKind, $sourceRef, $kind, $actor, $title, $summary, $payload, $verdict, $reason, $status, $createdAt, $t)`,
      )
      .run({
        id,
        cosId: input.cosId,
        targetId: target,
        projectId: input.projectId,
        ticketId: input.ticketId,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        kind: input.kind ?? "",
        actor: input.actor,
        title: input.title,
        summary: input.summary ?? "",
        payload: JSON.stringify(input.payload ?? {}),
        verdict: filtered ? "filtered" : input.ready ? "escalate" : "pending",
        reason: filtered ? (input.filtered ?? null) : null,
        status: filtered ? "ignored" : input.ready ? "escalated" : "pending",
        createdAt: input.createdAt ?? t,
        t,
      });
    return res.changes ? this.get(id) : null;
  }

  /** Whether a ticket already has a row (child or subscription) for this source event: the chief's subscription heard it. */
  hasTicketRow(targetId: string, sourceRef: string): boolean {
    return !!this.db.query(`SELECT 1 FROM ticket_events e WHERE e.target_id = $t AND e.source_ref = $r AND ${scopeSql("ticket")}`).get({ t: targetId, r: sourceRef });
  }

  get(id: string): StoredTicketEvent | null {
    const r = this.db.query(`${SELECT} WHERE e.id = $id`).get({ id }) as Row | null;
    return r ? toEvent(r) : null;
  }

  /** The WHERE clause shared by `list` and `count`. */
  private filter(opts: EventFilter): { where: string; args: Record<string, string | number> } {
    const where: string[] = ["1 = 1"];
    const args: Record<string, string | number> = {};
    if (opts.cosId) {
      // A chief's own subscription rows (the change that woke it) show beside its pipeline's
      where.push(`(((e.cos_id = $cosId OR e.cos_id IS NULL) AND ${scopeSql("chief")}) OR (e.target_id = $cosId AND e.source_kind = 'subscription'))`);
      args.cosId = opts.cosId;
    }
    if (opts.hideFiltered) where.push("e.verdict <> 'filtered'");
    if (opts.targetId) {
      where.push("e.target_id = $targetId");
      args.targetId = opts.targetId;
    }
    const statuses = opts.statuses?.length ? opts.statuses : opts.status ? [opts.status] : [];
    if (statuses.length) where.push(`e.status IN (${statuses.map((st, i) => ((args[`s${i}`] = st), `$s${i}`)).join(", ")})`);
    if (opts.sourceKind) {
      where.push("e.source_kind = $sourceKind");
      args.sourceKind = opts.sourceKind;
    }
    if (opts.key) {
      where.push("(UPPER(e.id) = $key OR UPPER(t.key) = $key)");
      args.key = opts.key.toUpperCase();
    }
    if (opts.before) {
      where.push("(e.created_at < $bt OR (e.created_at = $bt AND e.id < $bid))");
      args.bt = opts.before.createdAt;
      args.bid = opts.before.id;
    }
    return { where: where.join(" AND "), args };
  }

  /** Newest first. `targetId` keeps the events that wake one ticket. A chief's page includes the unassigned events, so a chief that is off or missing never hides them. */
  list(opts: EventFilter & { limit: number }): StoredTicketEvent[] {
    const { where, args } = this.filter(opts);
    return (this.db.query(`${SELECT} WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT $limit`).all({ ...args, limit: opts.limit }) as Row[]).map(toEvent);
  }

  /** How many events `list` would find across every page (`before` and `limit` aside). */
  count(opts: Omit<EventFilter, "before">): number {
    const { where, args } = this.filter(opts);
    return (this.db.query(`SELECT COUNT(*) AS n FROM ticket_events e LEFT JOIN tickets t ON t.id = e.ticket_id WHERE ${where}`).get(args) as { n: number }).n;
  }

  /** Whether the ticket has an event its Events tab shows (the `hasEvents` it carries). */
  hasEvents(targetId: string): boolean {
    return !!this.db.query("SELECT 1 FROM ticket_events WHERE target_id = $targetId AND verdict <> 'filtered' LIMIT 1").get({ targetId });
  }

  /**
   * Called with a ticket's id when its `hasEvents` differs from before a change (an insert, a row re-pointed or filtered, a prune):
   * the ticket is then pushed again. It runs once the change's transaction is over (a microtask), so a rolled-back insert pushes nothing.
   */
  onHasEventsChange: ((targetId: string) => void) | null = null;

  /** Each touched target's `hasEvents` from before the change, until the flush compares it with now. */
  private touched = new Map<string, boolean>();

  private touch(targetId: string | null | undefined) {
    if (!targetId || this.touched.has(targetId)) return;
    this.touched.set(targetId, this.hasEvents(targetId));
    if (this.touched.size === 1) queueMicrotask(() => this.flushTouched());
  }

  private flushTouched() {
    const touched = this.touched;
    this.touched = new Map();
    for (const [id, was] of touched) if (this.hasEvents(id) !== was) this.onHasEventsChange?.(id);
  }

  /** Events with a status, oldest first; `cosId` null for the unassigned ones, undefined for every owner. */
  byStatus(status: TicketEventStatus, cosId?: string | null, scope: EventScope = "chief"): StoredTicketEvent[] {
    const owner = cosId === undefined ? "" : cosId === null ? "AND e.cos_id IS NULL" : "AND e.cos_id = $cosId";
    const args: Record<string, string> = { status };
    if (typeof cosId === "string") args.cosId = cosId;
    return (this.db.query(`${SELECT} WHERE e.status = $status AND ${scopeSql(scope)} ${owner} ORDER BY e.created_at, e.rowid`).all(args) as Row[]).map(toEvent);
  }

  /** Events with a status that wake one ticket, oldest first. */
  byTarget(status: TicketEventStatus, targetId: string, scope: EventScope = "chief"): StoredTicketEvent[] {
    return (this.db.query(`${SELECT} WHERE e.status = $status AND e.target_id = $targetId AND ${scopeSql(scope)} ORDER BY e.created_at, e.rowid`).all({ status, targetId }) as Row[]).map(toEvent);
  }

  byWake(wakeId: string): StoredTicketEvent[] {
    return (this.db.query(`${SELECT} WHERE e.wake_id = $wakeId ORDER BY e.created_at, e.rowid`).all({ wakeId }) as Row[]).map(toEvent);
  }

  byRun(runId: string, status: TicketEventStatus, scope: EventScope = "chief"): StoredTicketEvent[] {
    return (this.db.query(`${SELECT} WHERE e.consuming_run_id = $runId AND e.status = $status AND ${scopeSql(scope)}`).all({ runId, status }) as Row[]).map(toEvent);
  }

  update(id: string, patch: EventPatch): StoredTicketEvent | null {
    const sets = Object.keys(patch)
      .filter((k) => patch[k as keyof EventPatch] !== undefined)
      .map((k) => `${COLUMNS[k as keyof EventPatch]} = $${k}`);
    if (!sets.length) return this.get(id);
    const args: Record<string, string | number | null> = { id, t: this.now() };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) args[k] = k === "payload" ? JSON.stringify(v) : (v as string | null);
    // A chief taking over a row is the row's target too, but a row aimed at another ticket keeps its target (DESIGN.md "Events")
    if (patch.cosId !== undefined) sets.push("target_id = CASE WHEN target_id IS cos_id THEN $cosId ELSE target_id END");
    if (patch.cosId !== undefined || patch.verdict !== undefined) {
      this.touch(this.get(id)?.targetId);
      this.touch(patch.cosId);
    }
    this.db.query(`UPDATE ticket_events SET ${sets.join(", ")}, updated_at = $t WHERE id = $id`).run(args);
    return this.get(id);
  }

  /** Open events (pending → handling) per chief, plus the unassigned ones. */
  badge(): CosBadge {
    const marks = COS_OPEN_STATUSES.map((_, i) => `$s${i}`).join(", ");
    const args = Object.fromEntries(COS_OPEN_STATUSES.map((s, i) => [`s${i}`, s]));
    const rows = this.db.query(`SELECT cos_id, COUNT(*) AS n FROM ticket_events WHERE status IN (${marks}) AND source_kind NOT IN (${TICKET_KINDS_SQL}) GROUP BY cos_id`).all(args) as { cos_id: string | null; n: number }[];
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
    return this.db.query("UPDATE ticket_events SET status = 'pending', wake_id = NULL, updated_at = $t WHERE status = 'triaging'").run({ t: this.now() }).changes;
  }

  /** What was ignored for a chief since `since` (the digest an escalation brief ends with), newest first. */
  ignoredSince(cosId: string, since: number): { reason: string | null; title: string }[] {
    return this.db
      .query("SELECT reason, title FROM ticket_events WHERE cos_id = $cosId AND status = 'ignored' AND verdict <> 'filtered' AND updated_at > $since ORDER BY updated_at DESC")
      .all({ cosId, since }) as { reason: string | null; title: string }[];
  }

  /** Delete settled events (ignored, handled) last touched before `before`, and the wake log from before it. */
  prune(before: number): number {
    this.db.query("DELETE FROM event_wakes WHERE started_at < $before").run({ before });
    return this.deleteWhere("status IN ('ignored', 'handled') AND updated_at < $before", { before });
  }

  /** Delete rows; `onHasEventsChange` hears of each target whose `hasEvents` that flipped. */
  private deleteWhere(where: string, args: Record<string, string | number>): number {
    const targets = (this.db.query(`SELECT DISTINCT target_id FROM ticket_events WHERE target_id IS NOT NULL AND ${where}`).all(args) as { target_id: string }[]).map((r) => r.target_id);
    for (const id of targets) this.touch(id);
    return this.db.query(`DELETE FROM ticket_events WHERE ${where}`).run(args).changes;
  }

  /** Delete unowned events still waiting (pending, escalated) that are older than `before`, and all but the newest `keep` of the rest. */
  pruneUnassigned(before: number, keep: number): number {
    // Open items converted from the old Inbox (migration 49) wait for the All chief; they are never pruned.
    const open = `cos_id IS NULL AND status IN ('pending', 'escalated') AND source_ref NOT LIKE 'triage:%' AND source_kind NOT IN (${TICKET_KINDS_SQL})`;
    const old = this.deleteWhere(`${open} AND created_at < $before`, { before });
    const over = this.deleteWhere(`${open} AND id IN (SELECT id FROM ticket_events WHERE ${open} ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET $keep)`, { keep });
    return old + over;
  }

  addWake(log: WakeLog): string {
    const id = newId();
    this.db
      .query("INSERT INTO event_wakes (id, target_id, event_class, kind, started_at, event_count, digest, model, tokens_in, tokens_out, run_id) VALUES ($id, $targetId, $eventClass, $kind, $t, $n, $digest, $model, $tin, $tout, $runId)")
      .run({
        id,
        targetId: log.targetId,
        eventClass: log.eventClass ?? "",
        kind: log.kind,
        t: this.now(),
        n: log.eventCount,
        digest: log.digest ?? null,
        model: log.model ?? null,
        tin: log.tokensIn ?? null,
        tout: log.tokensOut ?? null,
        runId: log.runId ?? null,
      });
    return id;
  }

  /** Full wakes whose run hasn't been seen to end. */
  openWakes(scope: EventScope = "chief"): { id: string; targetId: string; runId: string | null; startedAt: number; eventCount: number; digest: string }[] {
    return (this.db.query(`SELECT id, target_id, run_id, started_at, event_count, digest FROM event_wakes WHERE kind = 'wake' AND outcome IS NULL AND event_class ${scope === "ticket" ? "<>" : "="} ''`).all() as { id: string; target_id: string; run_id: string | null; started_at: number; event_count: number; digest: string | null }[]).map((r) => ({
      id: r.id,
      targetId: r.target_id,
      runId: r.run_id,
      startedAt: r.started_at,
      eventCount: r.event_count,
      digest: r.digest ?? "",
    }));
  }

  setWakeOutcome(id: string, outcome: WakeOutcome) {
    this.db.query("UPDATE event_wakes SET outcome = $outcome WHERE id = $id").run({ id, outcome });
  }

  /** Token counts of a full wake, known once its run reports them. */
  setWakeTokens(id: string, tokensIn: number, tokensOut: number) {
    this.db.query("UPDATE event_wakes SET tokens_in = $tokensIn, tokens_out = $tokensOut WHERE id = $id").run({ id, tokensIn, tokensOut });
  }

  wakeTimes(targetId: string, kind: "wake" | "triage", since: number, eventClass = ""): number[] {
    return (this.db.query("SELECT started_at FROM event_wakes WHERE target_id = $targetId AND kind = $kind AND event_class = $eventClass AND started_at > $since ORDER BY started_at").all({ targetId, kind, since, eventClass }) as { started_at: number }[]).map(
      (r) => r.started_at,
    );
  }

  lastWakeAt(cosId: string): number {
    return (this.db.query("SELECT MAX(started_at) AS t FROM event_wakes WHERE target_id = $cosId AND kind = 'wake' AND event_class = ''").get({ cosId }) as { t: number | null }).t ?? 0;
  }

  wake(id: string): { id: string; cosId: string; kind: string; startedAt: number; eventCount: number; model: string | null; tokensIn: number | null; tokensOut: number | null } | null {
    const r = this.db.query("SELECT * FROM event_wakes WHERE id = $id").get({ id }) as Record<string, unknown> | null;
    return r
      ? {
          id: r.id as string,
          cosId: r.target_id as string,
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
          `SELECT id, started_at, digest FROM event_wakes WHERE target_id = $cosId AND kind = 'wake' AND event_class = '' AND event_count > 0 AND (outcome IS NULL OR outcome <> 'quiet')
           AND ($bt IS NULL OR started_at < $bt OR (started_at = $bt AND ('wake:' || id) < $bid)) ORDER BY started_at DESC, id DESC LIMIT $limit`,
        )
        .all({ cosId, bt: before?.createdAt ?? null, bid: before?.id ?? "", limit }) as { id: string; started_at: number; digest: string | null }[]
    ).map((r) => ({ id: r.id, startedAt: r.started_at, digest: r.digest ?? "" }));
  }
}
