import type { Database } from "bun:sqlite";
import type { Run, RunKind, RunStatus } from "@harness/shared";
import { newId, now } from "./util";

interface RunRow {
  id: string;
  session_id: string;
  kind: string;
  status: string;
  driver: string;
  prompt: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind as RunKind,
  status: r.status as RunStatus,
  driver: r.driver,
  prompt: r.prompt,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export class RunRepo {
  constructor(private db: Database) {}

  get(id: string): Run | null {
    const r = this.db.query("SELECT * FROM runs WHERE id = $id").get({ id }) as RunRow | null;
    return r ? toRun(r) : null;
  }

  listBySession(sessionId: string): Run[] {
    return (this.db.query("SELECT * FROM runs WHERE session_id = $sessionId ORDER BY created_at, rowid").all({ sessionId }) as RunRow[]).map(toRun);
  }

  /** Runs left queued/running (e.g. by a previous process). */
  listUnfinished(): Run[] {
    return (this.db.query("SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY created_at, rowid").all() as RunRow[]).map(toRun);
  }

  create(input: { sessionId: string; kind: RunKind; driver: string; prompt: string }): Run {
    const id = newId();
    this.db
      .query(
        `INSERT INTO runs (id, session_id, kind, status, driver, prompt, error, created_at, started_at, ended_at)
         VALUES ($id, $sessionId, $kind, 'queued', $driver, $prompt, NULL, $t, NULL, NULL)`,
      )
      .run({ id, ...input, t: now() });
    return this.get(id)!;
  }

  markRunning(id: string): Run {
    this.db.query("UPDATE runs SET status = 'running', started_at = $t WHERE id = $id").run({ id, t: now() });
    return this.get(id)!;
  }

  finish(id: string, status: Exclude<RunStatus, "queued" | "running">, error: string | null = null): Run {
    this.db.query("UPDATE runs SET status = $status, error = $error, ended_at = $t WHERE id = $id").run({ id, status, error, t: now() });
    return this.get(id)!;
  }
}
