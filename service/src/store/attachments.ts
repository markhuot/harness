import type { Database } from "bun:sqlite";
import type { Attachment, AttachmentKind, AttachmentSource } from "@harness/shared";
import { now } from "./util";

interface AttachmentRow {
  id: string;
  ticket_id: string | null;
  path: string;
  name: string;
  source: string;
  kind: string;
  mime_type: string;
  size: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
}

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  path: r.path,
  name: r.name,
  source: r.source as AttachmentSource,
  kind: r.kind as AttachmentKind,
  mimeType: r.mime_type,
  ...(r.size !== null ? { size: r.size } : {}),
  ...(r.width !== null && r.height !== null ? { width: r.width, height: r.height } : {}),
});

/** A registered attachment and when it was registered (the startup sweep spares young ones). */
export interface AttachmentRecord extends Attachment {
  ticketId: string | null;
  createdAt: number;
}

/**
 * Every attachment the service knows (DESIGN.md "Attachments"), one row per file it registered:
 * a spec's media (ticket_id set, source "spec": rows go with the ticket by ON DELETE CASCADE and
 * the orchestrator removes the files), uploads and registered files (ticket_id NULL, shared by id
 * between drafts, messages and runs). Lists that use one (Ticket.promptAttachments, a message's
 * attachments) store a full copy of the record, with that use's annotation.
 */
export class AttachmentRepo {
  constructor(private db: Database) {}

  /** Register attachments as they are (their ids are given); spec media pass their ticket. */
  add(ticketId: string | null, attachments: readonly Attachment[]) {
    const insert = this.db.query(
      `INSERT INTO attachments (id, ticket_id, path, name, source, kind, mime_type, size, width, height, created_at)
       VALUES ($id, $ticketId, $path, $name, $source, $kind, $mimeType, $size, $width, $height, $t)`,
    );
    const t = now();
    this.db.transaction(() => {
      for (const a of attachments) {
        insert.run({
          id: a.id,
          ticketId,
          path: a.path,
          name: a.name,
          source: a.source,
          kind: a.kind,
          mimeType: a.mimeType,
          size: a.size ?? null,
          width: a.width ?? null,
          height: a.height ?? null,
          t,
        });
      }
    })();
  }

  get(id: string): Attachment | null {
    const r = this.db.query("SELECT * FROM attachments WHERE id = $id").get({ id }) as AttachmentRow | null;
    return r ? toAttachment(r) : null;
  }

  /** The registered attachment for a file, oldest first when several share it. */
  getByPath(path: string, source: AttachmentSource): Attachment | null {
    const r = this.db.query("SELECT * FROM attachments WHERE path = $path AND source = $source ORDER BY created_at, rowid LIMIT 1").get({ path, source }) as AttachmentRow | null;
    return r ? toAttachment(r) : null;
  }

  /** A ticket's spec media, in the order they were stored. */
  listByTicket(ticketId: string): Attachment[] {
    return (this.db.query("SELECT * FROM attachments WHERE ticket_id = $ticketId ORDER BY created_at, rowid").all({ ticketId }) as AttachmentRow[]).map(toAttachment);
  }

  /** Attachments no ticket owns: uploads and registered files. */
  listUnowned(): AttachmentRecord[] {
    return (this.db.query("SELECT * FROM attachments WHERE ticket_id IS NULL ORDER BY created_at, rowid").all() as AttachmentRow[]).map((r) => ({
      ...toAttachment(r),
      ticketId: null,
      createdAt: r.created_at,
    }));
  }

  delete(ids: readonly string[]) {
    const del = this.db.query("DELETE FROM attachments WHERE id = $id");
    this.db.transaction(() => {
      for (const id of ids) del.run({ id });
    })();
  }
}
