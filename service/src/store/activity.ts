import type { Database } from "bun:sqlite";
import type { ActivityAuthor, ActivityEntry, ActivityKind, ActivityMeta } from "@harness/shared";
import { fromJson, newId } from "./util";
import { type Clock, systemClock } from "../clock";

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
    this.db
      .query(
        "INSERT INTO activity (id, session_id, ticket_id, kind, author, body, meta, actor, created_at) VALUES ($id, $sessionId, $ticketId, $kind, $author, $body, $meta, $actor, $t)",
      )
      .run({
        id,
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

  /** Entries after activity row `seq` (SQLite rowid, which only grows), oldest first, each with its row's seq and actor. The chief-of-staff event feed reads these. */
  listAfter(seq: number, limit: number): { seq: number; actor: string | null; entry: ActivityEntry }[] {
    const rows = this.db.query("SELECT rowid AS seq, * FROM activity WHERE rowid > $seq ORDER BY rowid LIMIT $limit").all({ seq, limit }) as (ActivityRow & { seq: number })[];
    return rows.map((r) => ({ seq: r.seq, actor: r.actor, entry: toEntry(r) }));
  }

  /** Entries a chief of staff caused (actor "cos:<id>") older than the cursor, newest first (ties by id). */
  listByActor(actor: string, before: { createdAt: number; id: string } | null, limit: number): ActivityEntry[] {
    return (
      this.db
        .query("SELECT * FROM activity WHERE actor = $actor AND ($bt IS NULL OR created_at < $bt OR (created_at = $bt AND id < $bid)) ORDER BY created_at DESC, id DESC LIMIT $limit")
        .all({ actor, bt: before?.createdAt ?? null, bid: before?.id ?? "", limit }) as ActivityRow[]
    ).map(toEntry);
  }
}
