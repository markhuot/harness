import type { Database } from "bun:sqlite";
import type { RunKind, SpecRevision, SpecRevisionAuthor, SpecRevisionInfo } from "@harness/shared";
import { bool, newId, now } from "./util";

interface RevisionRow {
  id: string;
  ticket_id: string;
  rev: number;
  body: string;
  author: string;
  run_id: string | null;
  run_kind: string | null;
  note: string;
  approved_baseline: number;
  created_at: number;
}

const toInfo = (r: Omit<RevisionRow, "body">): SpecRevisionInfo => ({
  rev: r.rev,
  author: r.author as SpecRevisionAuthor,
  runId: r.run_id,
  runKind: (r.run_kind as RunKind | null) ?? null,
  note: r.note,
  approvedBaseline: bool(r.approved_baseline),
  createdAt: r.created_at,
});

/** The spec moved on since `baseRevision`: the write was refused. */
export class SpecConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly currentBody: string,
    readonly baseRevision: number,
  ) {
    super(`The spec is at revision ${currentRevision}, not ${baseRevision}: it changed since you read it.`);
  }
}

export interface SpecWrite {
  body: string;
  author: SpecRevisionAuthor;
  runId?: string | null;
  runKind?: RunKind | null;
  note: string;
  /** The revision the write started from; undefined skips the check (the service's own writes) */
  baseRevision?: number;
}

/**
 * Spec revisions (DESIGN.md "Spec revisions and attachments"). tickets.spec / spec_revision cache
 * the newest revision; every write goes through revise(), which checks the base revision and adds
 * the next one in a single transaction.
 */
export class SpecRepo {
  constructor(private db: Database) {}

  // Revision 1 is written by TicketRepo.create with the ticket.

  current(ticketId: string): { rev: number; body: string } | null {
    const r = this.db.query("SELECT spec_revision AS rev, spec AS body FROM tickets WHERE id = $ticketId").get({ ticketId }) as { rev: number; body: string } | null;
    return r ?? null;
  }

  /**
   * Add the next revision and make it current. Throws SpecConflictError when `baseRevision` isn't
   * the current revision. A body equal to the current one adds nothing (returns null).
   */
  revise(ticketId: string, write: SpecWrite): SpecRevisionInfo | null {
    return this.db.transaction(() => {
      const cur = this.current(ticketId);
      if (!cur) throw new Error(`Unknown ticket ${ticketId}`);
      if (write.baseRevision !== undefined && write.baseRevision !== cur.rev) throw new SpecConflictError(cur.rev, cur.body, write.baseRevision);
      if (write.body === cur.body) return null;
      const rev = cur.rev + 1;
      const t = now();
      this.db
        .query(
          `INSERT INTO spec_revisions (id, ticket_id, rev, body, author, run_id, run_kind, note, approved_baseline, created_at)
           VALUES ($id, $ticketId, $rev, $body, $author, $runId, $runKind, $note, 0, $t)`,
        )
        .run({ id: newId(), ticketId, rev, body: write.body, author: write.author, runId: write.runId ?? null, runKind: write.runKind ?? null, note: write.note, t });
      this.db.query("UPDATE tickets SET spec = $body, spec_revision = $rev, updated_at = $t WHERE id = $ticketId").run({ ticketId, body: write.body, rev, t });
      return this.info(ticketId, rev);
    })();
  }

  /** A draft's text isn't history yet: it rewrites revision 1 in place (rev stays 1). */
  replaceDraft(ticketId: string, body: string) {
    const t = now();
    this.db.transaction(() => {
      this.db.query("UPDATE spec_revisions SET body = $body, created_at = $t WHERE ticket_id = $ticketId AND rev = 1").run({ ticketId, body, t });
      this.db.query("UPDATE tickets SET spec = $body, spec_revision = 1, updated_at = $t WHERE id = $ticketId").run({ ticketId, body, t });
    })();
  }

  /** The current revision becomes the approved baseline (the human pressed Start); returns it. */
  markBaseline(ticketId: string): number {
    return this.db.transaction(() => {
      const cur = this.current(ticketId)!;
      this.db.query("UPDATE spec_revisions SET approved_baseline = (rev = $rev) WHERE ticket_id = $ticketId").run({ ticketId, rev: cur.rev });
      this.db.query("UPDATE tickets SET spec_baseline_revision = $rev WHERE id = $ticketId").run({ ticketId, rev: cur.rev });
      return cur.rev;
    })();
  }

  list(ticketId: string): SpecRevisionInfo[] {
    const rows = this.db
      .query("SELECT id, ticket_id, rev, author, run_id, run_kind, note, approved_baseline, created_at FROM spec_revisions WHERE ticket_id = $ticketId ORDER BY rev")
      .all({ ticketId }) as Omit<RevisionRow, "body">[];
    return rows.map(toInfo);
  }

  get(ticketId: string, rev: number): SpecRevision | null {
    const r = this.db.query("SELECT * FROM spec_revisions WHERE ticket_id = $ticketId AND rev = $rev").get({ ticketId, rev }) as RevisionRow | null;
    return r ? { ...toInfo(r), body: r.body } : null;
  }

  private info(ticketId: string, rev: number): SpecRevisionInfo {
    const { body: _body, ...info } = this.get(ticketId, rev)!;
    return info;
  }
}
