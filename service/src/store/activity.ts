import type { Database } from "bun:sqlite";
import type { ActivityAuthor, ActivityEntry, ActivityKind, ActivityMeta } from "@harness/shared";
import { fromJson, newId } from "./util";
import { type Clock, systemClock } from "../clock";
import { clampLimit, decodeCursor, encodeCursor } from "./search";

/** One row of a scoped activity query: the entry, the ticket it belongs to, and for a blocked entry the human's replies. */
export interface ActivityHit {
  entry: ActivityEntry;
  ticketKey: string;
  ticketTitle: string;
  projectKey: string;
  /** blocked entries only: the `answered` entries that reply to it, oldest first */
  answers: ActivityEntry[];
}

export interface ActivityQuery {
  /** The covered group's id, or null for everything (the internal project and chiefs' own tickets are never covered). */
  groupId: string | null;
  /** createdAt >= from */
  from?: number;
  /** createdAt < to */
  to?: number;
  projectKeys?: string[];
  ticketKey?: string;
  kinds?: ActivityKind[];
  cursor?: string;
  limit?: number;
}

export const ACTIVITY_QUERY_DEFAULT_LIMIT = 25;

interface ActivityRow {
  id: string;
  session_id: string;
  ticket_id: string | null;
  kind: string;
  author: string;
  body: string;
  meta: string;
  created_at: number;
  actor: string | null;
}

const toEntry = (r: ActivityRow): ActivityEntry => ({
  id: r.id,
  sessionId: r.session_id,
  ticketId: r.ticket_id,
  kind: r.kind as ActivityKind,
  author: r.author as ActivityAuthor,
  body: r.body,
  meta: fromJson<ActivityMeta>(r.meta, {}),
  createdAt: r.created_at,
});

/** A ticket's Activity (DESIGN.md "Activity"): typed entries, oldest first. */
export class ActivityRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  add(input: { sessionId: string; ticketId: string | null; kind: ActivityKind; author: ActivityAuthor; body: string; meta?: ActivityMeta; actor?: string | null }): ActivityEntry {
    const id = newId();
    const seq = (this.db.query("UPDATE cos_state SET value = value + 1 WHERE key = 'activity_counter' RETURNING value").get() as { value: number }).value;
    this.db
      .query(
        "INSERT INTO activity (id, session_id, ticket_id, kind, author, body, meta, actor, seq, created_at) VALUES ($id, $sessionId, $ticketId, $kind, $author, $body, $meta, $actor, $seq, $t)",
      )
      .run({
        id,
        seq,
        sessionId: input.sessionId,
        ticketId: input.ticketId,
        kind: input.kind,
        author: input.author,
        body: input.body,
        meta: JSON.stringify(input.meta ?? {}),
        actor: input.actor ?? null,
        t: this.now(),
      });
    return toEntry(this.db.query("SELECT * FROM activity WHERE id = $id").get({ id }) as ActivityRow);
  }

  listBySession(sessionId: string): ActivityEntry[] {
    return (this.db.query("SELECT * FROM activity WHERE session_id = $sessionId ORDER BY created_at, rowid").all({ sessionId }) as ActivityRow[]).map(toEntry);
  }

  /** Entries after activity row `seq` (a monotonic counter, not the rowid, which SQLite reuses after deletes), oldest first, each with its row's seq and actor. The chief-of-staff event feed reads these. */
  listAfter(seq: number, limit: number): { seq: number; actor: string | null; entry: ActivityEntry }[] {
    const rows = this.db.query("SELECT * FROM activity WHERE seq > $seq ORDER BY seq LIMIT $limit").all({ seq, limit }) as (ActivityRow & { seq: number })[];
    return rows.map((r) => ({ seq: r.seq, actor: r.actor, entry: toEntry(r) }));
  }

  /** The newest entry of `kind` in a ticket's session, or null. */
  latestOfKind(sessionId: string, kind: ActivityKind): ActivityEntry | null {
    const r = this.db.query("SELECT * FROM activity WHERE session_id = $sessionId AND kind = $kind ORDER BY created_at DESC, rowid DESC LIMIT 1").get({ sessionId, kind }) as ActivityRow | null;
    return r ? toEntry(r) : null;
  }

  /**
   * Entries across tickets, newest first, as one scope sees them. The scope, project and ticket
   * filters are one WHERE over the ticket's own row, so a ticket outside the scope matches nothing
   * (an empty page, never a refusal that would say it exists). Entries with no ticket, those of a
   * chief's own ticket and those of the hidden internal project are never returned. Keyset paging
   * on (created_at, id).
   */
  query(q: ActivityQuery): { hits: ActivityHit[]; nextCursor: string | null } {
    const limit = clampLimit(q.limit, ACTIVITY_QUERY_DEFAULT_LIMIT);
    const where = ["t.kind <> 'cos'", "p.internal = 0"];
    const args: Record<string, string | number | null> = {};
    if (q.groupId) {
      where.push("p.group_id = $groupId");
      args.groupId = q.groupId;
    }
    if (q.from !== undefined) (where.push("a.created_at >= $from"), (args.from = q.from));
    if (q.to !== undefined) (where.push("a.created_at < $to"), (args.to = q.to));
    if (q.projectKeys) {
      const names = q.projectKeys.map((k, i) => ((args[`pk${i}`] = k), `$pk${i}`));
      where.push(`p.key IN (${names.length ? names.join(", ") : "NULL"})`);
    }
    if (q.ticketKey) (where.push("t.key = $ticketKey"), (args.ticketKey = q.ticketKey));
    if (q.kinds) {
      const names = q.kinds.map((k, i) => ((args[`k${i}`] = k), `$k${i}`));
      where.push(`a.kind IN (${names.length ? names.join(", ") : "NULL"})`);
    }
    if (q.cursor) {
      const [at, id] = decodeCursor(q.cursor, "a", ["n", "s"]);
      where.push("(a.created_at < $cAt OR (a.created_at = $cAt AND a.id < $cId))");
      args.cAt = at as number;
      args.cId = id as string;
    }
    const rows = this.db
      .query(
        `SELECT a.*, t.key AS ticket_key, t.title AS ticket_title, p.key AS project_key FROM activity a
           JOIN tickets t ON t.id = a.ticket_id JOIN projects p ON p.id = t.project_id
          WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT $limit`,
      )
      .all({ ...args, limit: limit + 1 }) as (ActivityRow & { ticket_key: string; ticket_title: string; project_key: string })[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const blocked = page.filter((r) => r.kind === "blocked").map((r) => r.id);
    const answers = new Map<string, ActivityEntry[]>();
    if (blocked.length) {
      const names = blocked.map((id, i) => `$b${i}`);
      const named = Object.fromEntries(blocked.map((id, i) => [`b${i}`, id]));
      const replies = this.db
        .query(`SELECT * FROM activity WHERE kind = 'answered' AND json_extract(meta, '$.answers') IN (${names.join(", ")}) ORDER BY created_at, rowid`)
        .all(named) as ActivityRow[];
      for (const r of replies) {
        const to = fromJson<ActivityMeta>(r.meta, {}).answers!;
        answers.set(to, [...(answers.get(to) ?? []), toEntry(r)]);
      }
    }
    return {
      hits: page.map((r) => ({ entry: toEntry(r), ticketKey: r.ticket_key, ticketTitle: r.ticket_title, projectKey: r.project_key, answers: answers.get(r.id) ?? [] })),
      nextCursor: rows.length > limit && last ? encodeCursor("a", [last.created_at, last.id]) : null,
    };
  }

  /** Entries a chief of staff caused (actor "cos:<id>") that its chat shows (a ticket's move, or a ticket it created) older than the cursor, newest first (ties by id). Filtered in the query so a page never comes up short. */
  listByActor(actor: string, before: { createdAt: number; id: string } | null, limit: number): ActivityEntry[] {
    return (
      this.db
        .query(`SELECT * FROM activity WHERE actor = $actor AND ticket_id IN (SELECT id FROM tickets)
           AND ((kind = 'moved' AND json_extract(meta, '$.from') IS NOT NULL AND json_extract(meta, '$.to') IS NOT NULL) OR (kind = 'note' AND body LIKE 'Chief of staff (%) created it'))
           AND ($bt IS NULL OR created_at < $bt OR (created_at = $bt AND id < $bid)) ORDER BY created_at DESC, id DESC LIMIT $limit`)
        .all({ actor, bt: before?.createdAt ?? null, bid: before?.id ?? "", limit }) as ActivityRow[]
    ).map(toEntry);
  }

  /** When the ticket last moved into `status`, or null if the activity has no such move. */
  lastMoveInto(ticketId: string, status: string): number | null {
    const r = this.db.query("SELECT created_at FROM activity WHERE ticket_id = $ticketId AND kind = 'moved' AND json_extract(meta, '$.to') = $status ORDER BY created_at DESC LIMIT 1").get({ ticketId, status }) as { created_at: number } | null;
    return r?.created_at ?? null;
  }
}
