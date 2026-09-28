import type { Database } from "bun:sqlite";
import type { AttachmentKind, Summary, SummaryAttachment, SummaryAuthor } from "@harness/shared";
import { newId, now } from "./util";

interface SummaryRow {
  id: string;
  session_id: string;
  ticket_id: string | null;
  author: string;
  body: string;
  created_at: number;
}

interface AttachmentRow {
  id: string;
  summary_id: string;
  ord: number;
  kind: string;
  mime_type: string;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

const toAttachment = (r: AttachmentRow): SummaryAttachment => ({
  id: r.id,
  kind: r.kind as AttachmentKind,
  mimeType: r.mime_type,
  name: r.name,
  size: r.size,
  ...(r.width !== null && r.height !== null ? { width: r.width, height: r.height } : {}),
});

const toSummary = (r: SummaryRow, attachments: SummaryAttachment[] = []): Summary => ({
  id: r.id,
  sessionId: r.session_id,
  ticketId: r.ticket_id,
  author: r.author as SummaryAuthor,
  body: r.body,
  createdAt: r.created_at,
  attachments,
});

export class SummaryRepo {
  constructor(private db: Database) {}

  /** Attachments carry their ids (the stored files are named after them) and are kept in the given order. */
  add(input: { sessionId: string; ticketId: string | null; author: SummaryAuthor; body: string; attachments?: SummaryAttachment[] }): Summary {
    const id = newId();
    const t = now();
    const { attachments = [], ...fields } = input;
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES ($id, $sessionId, $ticketId, $author, $body, $t)")
        .run({ id, ...fields, t });
      const insert = this.db.query(
        `INSERT INTO summary_attachments (id, summary_id, ord, kind, mime_type, name, size, width, height, created_at)
         VALUES ($id, $summaryId, $ord, $kind, $mimeType, $name, $size, $width, $height, $t)`,
      );
      attachments.forEach((a, ord) =>
        insert.run({ id: a.id, summaryId: id, ord, kind: a.kind, mimeType: a.mimeType, name: a.name, size: a.size, width: a.width ?? null, height: a.height ?? null, t }),
      );
    })();
    return toSummary(this.db.query("SELECT * FROM summaries WHERE id = $id").get({ id }) as SummaryRow, this.attachmentsOf(id));
  }

  listBySession(sessionId: string): Summary[] {
    const rows = this.db.query("SELECT * FROM summaries WHERE session_id = $sessionId ORDER BY created_at, rowid").all({ sessionId }) as SummaryRow[];
    const bySummary = new Map<string, SummaryAttachment[]>();
    for (const a of this.attachmentRowsBySession(sessionId)) {
      const list = bySummary.get(a.summary_id) ?? [];
      list.push(toAttachment(a));
      bySummary.set(a.summary_id, list);
    }
    return rows.map((r) => toSummary(r, bySummary.get(r.id)));
  }

  /** One attachment by id, or null. */
  attachment(id: string): SummaryAttachment | null {
    const r = this.db.query("SELECT * FROM summary_attachments WHERE id = $id").get({ id }) as AttachmentRow | null;
    return r ? toAttachment(r) : null;
  }

  /** Every attachment on a session's summaries (to remove their files along with the session). */
  attachmentsBySession(sessionId: string): SummaryAttachment[] {
    return this.attachmentRowsBySession(sessionId).map(toAttachment);
  }

  private attachmentsOf(summaryId: string): SummaryAttachment[] {
    return (this.db.query("SELECT * FROM summary_attachments WHERE summary_id = $summaryId ORDER BY ord").all({ summaryId }) as AttachmentRow[]).map(toAttachment);
  }

  private attachmentRowsBySession(sessionId: string): AttachmentRow[] {
    return this.db
      .query("SELECT a.* FROM summary_attachments a JOIN summaries s ON s.id = a.summary_id WHERE s.session_id = $sessionId ORDER BY a.summary_id, a.ord")
      .all({ sessionId }) as AttachmentRow[];
  }
}
