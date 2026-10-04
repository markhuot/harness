import type { Database } from "bun:sqlite";
import type { MessageAnnotation, PromptAttachment, Run, RunKind, RunStatus } from "@harness/shared";
import { fromJson, newId, now } from "./util";

interface RunRow {
  id: string;
  session_id: string;
  kind: string;
  status: string;
  driver: string;
  prompt: string;
  attachments: string;
  annotations: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const toRun = (r: RunRow): Run => {
  const attachments = fromJson<PromptAttachment[]>(r.attachments, []);
  const annotations = fromJson<MessageAnnotation[]>(r.annotations, []);
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as RunKind,
    status: r.status as RunStatus,
    driver: r.driver,
    prompt: r.prompt,
    ...(attachments.length ? { attachments } : {}),
    ...(annotations.length ? { annotations } : {}),
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
};

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

  /** `attachments`: the files the human attached to the message the run answers; `annotations`: their notes on those images. */
  create(input: {
    sessionId: string;
    kind: RunKind;
    driver: string;
    prompt: string;
    attachments?: readonly PromptAttachment[];
    annotations?: readonly MessageAnnotation[];
  }): Run {
    const id = newId();
    const { attachments, annotations, ...rest } = input;
    this.db
      .query(
        `INSERT INTO runs (id, session_id, kind, status, driver, prompt, attachments, annotations, error, created_at, started_at, ended_at)
         VALUES ($id, $sessionId, $kind, 'queued', $driver, $prompt, $attachments, $annotations, NULL, $t, NULL, NULL)`,
      )
      .run({ id, ...rest, attachments: JSON.stringify(attachments ?? []), annotations: JSON.stringify(annotations ?? []), t: now() });
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
