import type { Database } from "bun:sqlite";
import type { Attachment, TranscriptContent, TranscriptEntry, TranscriptRole } from "@harness/shared";
import { fromJson, newId } from "./util";
import { type Clock, systemClock } from "../clock";

interface EntryRow {
  id: string;
  session_id: string;
  run_id: string | null;
  subagent_id: string | null;
  seq: number;
  role: string;
  content: string;
  created_at: number;
}

const toEntry = (r: EntryRow): TranscriptEntry => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  subagentId: r.subagent_id ?? null,
  seq: r.seq,
  role: r.role as TranscriptRole,
  content: fromJson<TranscriptContent>(r.content, { type: "text", text: "" }),
  createdAt: r.created_at,
});

export class TranscriptRepo {
  constructor(private db: Database, private now: Clock = systemClock) {}

  /**
   * Append an entry with the session's next monotonic seq (1, 2, 3, ...). Seqs are shared by the
   * session's agent and its sub-agents (`subagentId`), so `after` paging works for either view.
   */
  append(sessionId: string, runId: string | null, role: TranscriptRole, content: TranscriptContent, subagentId: string | null = null): TranscriptEntry {
    const id = newId();
    this.db.transaction(() => {
      const row = this.db.query("SELECT next_seq FROM sessions WHERE id = $sessionId").get({ sessionId }) as { next_seq: number } | null;
      if (!row) throw new Error(`Unknown session ${sessionId}`);
      this.db.query("UPDATE sessions SET next_seq = next_seq + 1 WHERE id = $sessionId").run({ sessionId });
      this.db
        .query("INSERT INTO transcript (id, session_id, run_id, subagent_id, seq, role, content, created_at) VALUES ($id, $sessionId, $runId, $subagentId, $seq, $role, $content, $t)")
        .run({ id, sessionId, runId, subagentId, seq: row.next_seq, role, content: JSON.stringify(content), t: this.now() });
    })();
    return toEntry(this.db.query("SELECT * FROM transcript WHERE id = $id").get({ id }) as EntryRow);
  }

  get(id: string): TranscriptEntry | null {
    const r = this.db.query("SELECT * FROM transcript WHERE id = $id").get({ id }) as EntryRow | null;
    return r ? toEntry(r) : null;
  }

  /**
   * The files attached to human messages (a user entry's `attachments`), with the session each
   * was sent in. The upload sweep keeps these, and deleting a ticket removes its own.
   */
  messageAttachments(sessionId?: string): { sessionId: string; attachment: Attachment }[] {
    const where = "role = 'user' AND json_extract(content, '$.attachments') IS NOT NULL" + (sessionId ? " AND session_id = $sessionId" : "");
    const rows = this.db.query(`SELECT session_id, content FROM transcript WHERE ${where}`).all(sessionId ? { sessionId } : {}) as { session_id: string; content: string }[];
    return rows.flatMap((r) => {
      const c = fromJson<TranscriptContent>(r.content, { type: "text", text: "" });
      return c.type === "text" && c.attachments ? c.attachments.map((attachment) => ({ sessionId: r.session_id, attachment })) : [];
    });
  }

  /** The seq of a session's newest entry (0 when empty). */
  lastSeq(sessionId: string): number {
    return (this.db.query("SELECT MAX(seq) AS seq FROM transcript WHERE session_id = $sessionId").get({ sessionId }) as { seq: number | null }).seq ?? 0;
  }

  /** The session agent's entries, or with `subagentId` that sub-agent's. */
  list(sessionId: string, afterSeq = 0, limit = 5000, subagentId: string | null = null): TranscriptEntry[] {
    return (
      this.db
        .query("SELECT * FROM transcript WHERE session_id = $sessionId AND subagent_id IS $subagentId AND seq > $afterSeq ORDER BY seq LIMIT $limit")
        .all({ sessionId, subagentId, afterSeq, limit }) as EntryRow[]
    ).map(toEntry);
  }

  /** A session's plain-text user and assistant messages (its own agent's) older than the cursor, newest first (ties by id): the chief's chat. `skipUserPrefix`: user messages starting with it are left out in the query, so a page never comes up short. */
  messagesBefore(sessionId: string, before: { createdAt: number; id: string } | null, limit: number, skipUserPrefix = ""): TranscriptEntry[] {
    return (
      this.db
        .query(
          `SELECT * FROM transcript WHERE session_id = $sessionId AND subagent_id IS NULL AND role IN ('user', 'assistant') AND json_extract(content, '$.type') = 'text'
           AND ($skip = '' OR role <> 'user' OR substr(json_extract(content, '$.text'), 1, length($skip)) <> $skip)
           AND ($bt IS NULL OR created_at < $bt OR (created_at = $bt AND id < $bid)) ORDER BY created_at DESC, id DESC LIMIT $limit`,
        )
        .all({ sessionId, bt: before?.createdAt ?? null, bid: before?.id ?? "", limit, skip: skipUserPrefix }) as EntryRow[]
    ).map(toEntry);
  }

  /** The plain-text assistant replies a run wrote (its own agent's) from `since` on, oldest first. */
  assistantTexts(runId: string, since: number): string[] {
    const rows = this.db
      .query("SELECT content FROM transcript WHERE run_id = $runId AND subagent_id IS NULL AND role = 'assistant' AND json_extract(content, '$.type') = 'text' AND created_at >= $since ORDER BY seq")
      .all({ runId, since }) as { content: string }[];
    return rows.map((r) => (JSON.parse(r.content) as { text: string }).text);
  }

  /**
   * The session agent's last `limit` entries whose content type is in `types`, oldest first; with
   * `subagentId`, that sub-agent's.
   */
  tail(sessionId: string, limit: number, types: TranscriptContent["type"][], subagentId: string | null = null): TranscriptEntry[] {
    if (limit <= 0 || !types.length) return [];
    const params: Record<string, string | number | null> = { sessionId, limit, subagentId };
    types.forEach((t, i) => (params[`type${i}`] = t));
    const inTypes = types.map((_, i) => `$type${i}`).join(", ");
    return (
      this.db
        .query(`SELECT * FROM transcript WHERE session_id = $sessionId AND subagent_id IS $subagentId AND json_extract(content, '$.type') IN (${inTypes}) ORDER BY seq DESC LIMIT $limit`)
        .all(params) as EntryRow[]
    )
      .reverse()
      .map(toEntry);
  }
}
