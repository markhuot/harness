import type { Database } from "bun:sqlite";
import type { ActivityAuthor, ActivityEntry, ActivityKind, ActivityMeta } from "@harness/shared";
import { fromJson, newId, now } from "./util";

interface ActivityRow {
  id: string;
  session_id: string;
  ticket_id: string | null;
  kind: string;
  author: string;
  body: string;
  meta: string;
  created_at: number;
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
  constructor(private db: Database) {}

  add(input: { sessionId: string; ticketId: string | null; kind: ActivityKind; author: ActivityAuthor; body: string; meta?: ActivityMeta }): ActivityEntry {
    const id = newId();
    this.db
      .query(
        "INSERT INTO activity (id, session_id, ticket_id, kind, author, body, meta, created_at) VALUES ($id, $sessionId, $ticketId, $kind, $author, $body, $meta, $t)",
      )
      .run({
        id,
        sessionId: input.sessionId,
        ticketId: input.ticketId,
        kind: input.kind,
        author: input.author,
        body: input.body,
        meta: JSON.stringify(input.meta ?? {}),
        t: now(),
      });
    return toEntry(this.db.query("SELECT * FROM activity WHERE id = $id").get({ id }) as ActivityRow);
  }

  listBySession(sessionId: string): ActivityEntry[] {
    return (this.db.query("SELECT * FROM activity WHERE session_id = $sessionId ORDER BY created_at, rowid").all({ sessionId }) as ActivityRow[]).map(toEntry);
  }
}
