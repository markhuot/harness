import type { Database } from "bun:sqlite";
import type { ActivityAuthor, ActivityEntry, ActivityKind, ActivityMeta, Attachment, AttachmentKind } from "@harness/shared";
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

interface AttachmentRow {
  id: string;
  ticket_id: string;
  kind: string;
  mime_type: string;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  kind: r.kind as AttachmentKind,
  mimeType: r.mime_type,
  name: r.name,
  size: r.size,
  ...(r.width !== null && r.height !== null ? { width: r.width, height: r.height } : {}),
});

/**
 * A ticket's images and videos (ticket_attachments), referenced from its spec as attachment:<id>.
 * Rows go with the ticket (ON DELETE CASCADE); the orchestrator removes the files.
 */
export class AttachmentRepo {
  constructor(private db: Database) {}

  /** Attachments carry their ids: the stored files are named after them. */
  add(ticketId: string, attachments: Attachment[]) {
    const insert = this.db.query(
      `INSERT INTO ticket_attachments (id, ticket_id, kind, mime_type, name, size, width, height, created_at)
       VALUES ($id, $ticketId, $kind, $mimeType, $name, $size, $width, $height, $t)`,
    );
    const t = now();
    this.db.transaction(() => {
      for (const a of attachments) {
        insert.run({ id: a.id, ticketId, kind: a.kind, mimeType: a.mimeType, name: a.name, size: a.size, width: a.width ?? null, height: a.height ?? null, t });
      }
    })();
  }

  get(id: string): Attachment | null {
    const r = this.db.query("SELECT * FROM ticket_attachments WHERE id = $id").get({ id }) as AttachmentRow | null;
    return r ? toAttachment(r) : null;
  }

  listByTicket(ticketId: string): Attachment[] {
    return (this.db.query("SELECT * FROM ticket_attachments WHERE ticket_id = $ticketId ORDER BY created_at, rowid").all({ ticketId }) as AttachmentRow[]).map(
      toAttachment,
    );
  }
}
