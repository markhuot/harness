import type { Database } from "bun:sqlite";
import type { Summary, SummaryAuthor } from "@harness/shared";
import { newId, now } from "./util";

interface SummaryRow {
  id: string;
  session_id: string;
  ticket_id: string | null;
  author: string;
  body: string;
  created_at: number;
}

const toSummary = (r: SummaryRow): Summary => ({
  id: r.id,
  sessionId: r.session_id,
  ticketId: r.ticket_id,
  author: r.author as SummaryAuthor,
  body: r.body,
  createdAt: r.created_at,
});

export class SummaryRepo {
  constructor(private db: Database) {}

  add(input: { sessionId: string; ticketId: string | null; author: SummaryAuthor; body: string }): Summary {
    const id = newId();
    this.db
      .query("INSERT INTO summaries (id, session_id, ticket_id, author, body, created_at) VALUES ($id, $sessionId, $ticketId, $author, $body, $t)")
      .run({ id, ...input, t: now() });
    return toSummary(this.db.query("SELECT * FROM summaries WHERE id = $id").get({ id }) as SummaryRow);
  }

  listBySession(sessionId: string): Summary[] {
    return (this.db.query("SELECT * FROM summaries WHERE session_id = $sessionId ORDER BY created_at, rowid").all({ sessionId }) as SummaryRow[]).map(
      toSummary,
    );
  }
}
