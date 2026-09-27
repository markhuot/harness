import type { Database } from "bun:sqlite";
import type { TranscriptContent, TranscriptEntry, TranscriptRole } from "@harness/shared";
import { fromJson, newId, now } from "./util";

interface EntryRow {
  id: string;
  session_id: string;
  run_id: string | null;
  seq: number;
  role: string;
  content: string;
  created_at: number;
}

const toEntry = (r: EntryRow): TranscriptEntry => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  seq: r.seq,
  role: r.role as TranscriptRole,
  content: fromJson<TranscriptContent>(r.content, { type: "text", text: "" }),
  createdAt: r.created_at,
});

export class TranscriptRepo {
  constructor(private db: Database) {}

  /** Append an entry with the session's next monotonic seq (1, 2, 3, ...). */
  append(sessionId: string, runId: string | null, role: TranscriptRole, content: TranscriptContent): TranscriptEntry {
    const id = newId();
    this.db.transaction(() => {
      const row = this.db.query("SELECT next_seq FROM sessions WHERE id = $sessionId").get({ sessionId }) as { next_seq: number } | null;
      if (!row) throw new Error(`Unknown session ${sessionId}`);
      this.db.query("UPDATE sessions SET next_seq = next_seq + 1 WHERE id = $sessionId").run({ sessionId });
      this.db
        .query("INSERT INTO transcript (id, session_id, run_id, seq, role, content, created_at) VALUES ($id, $sessionId, $runId, $seq, $role, $content, $t)")
        .run({ id, sessionId, runId, seq: row.next_seq, role, content: JSON.stringify(content), t: now() });
    })();
    return toEntry(this.db.query("SELECT * FROM transcript WHERE id = $id").get({ id }) as EntryRow);
  }

  list(sessionId: string, afterSeq = 0, limit = 5000): TranscriptEntry[] {
    return (
      this.db
        .query("SELECT * FROM transcript WHERE session_id = $sessionId AND seq > $afterSeq ORDER BY seq LIMIT $limit")
        .all({ sessionId, afterSeq, limit }) as EntryRow[]
    ).map(toEntry);
  }
}
