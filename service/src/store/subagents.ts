import type { Database } from "bun:sqlite";
import type { Subagent, SubagentStatus } from "@harness/shared";
import type { SubagentReport } from "../drivers/types";
import { now } from "./util";

interface SubagentRow {
  session_id: string;
  id: string;
  run_id: string | null;
  parent_id: string | null;
  description: string;
  agent_type: string | null;
  prompt: string;
  status: string;
  result: string | null;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
}

const toSubagent = (r: SubagentRow): Subagent => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  parentId: r.parent_id,
  description: r.description,
  agentType: r.agent_type,
  prompt: r.prompt,
  status: r.status as SubagentStatus,
  result: r.result,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  updatedAt: r.updated_at,
});

/** What a driver reports about a sub-agent; absent fields keep their stored value. */
export type SubagentPatch = SubagentReport;

const FINISHED: SubagentStatus[] = ["succeeded", "failed", "stopped"];

export class SubagentRepo {
  constructor(private db: Database) {}

  get(sessionId: string, id: string): Subagent | null {
    const r = this.db.query("SELECT * FROM subagents WHERE session_id = $sessionId AND id = $id").get({ sessionId, id }) as SubagentRow | null;
    return r ? toSubagent(r) : null;
  }

  listBySession(sessionId: string): Subagent[] {
    return (this.db.query("SELECT * FROM subagents WHERE session_id = $sessionId ORDER BY started_at, rowid").all({ sessionId }) as SubagentRow[]).map(toSubagent);
  }

  /**
   * Create or update a sub-agent. The first report creates it (running unless it says
   * otherwise); later ones fill in what they carry. A finished sub-agent stays finished: a late
   * "running" report (e.g. the CLI's task_started after the result) doesn't revive it.
   * Returns the stored sub-agent, or null when nothing changed.
   */
  upsert(sessionId: string, runId: string | null, patch: SubagentPatch): Subagent | null {
    const prev = this.get(sessionId, patch.id);
    const t = now();
    if (!prev) {
      const status = patch.status ?? "running";
      this.db
        .query(
          `INSERT INTO subagents (session_id, id, run_id, parent_id, description, agent_type, prompt, status, result, started_at, ended_at, updated_at)
           VALUES ($sessionId, $id, $runId, $parentId, $description, $agentType, $prompt, $status, $result, $t, $endedAt, $t)`,
        )
        .run({
          sessionId,
          id: patch.id,
          runId,
          parentId: patch.parentId ?? null,
          description: patch.description ?? "",
          agentType: patch.agentType ?? null,
          prompt: patch.prompt ?? "",
          status,
          result: patch.result ?? null,
          t,
          endedAt: FINISHED.includes(status) ? t : null,
        });
      return this.get(sessionId, patch.id);
    }
    const finished = FINISHED.includes(prev.status);
    const status = finished || !patch.status ? prev.status : patch.status;
    const next: Subagent = {
      ...prev,
      parentId: patch.parentId !== undefined && prev.parentId === null ? patch.parentId : prev.parentId,
      description: patch.description || prev.description,
      agentType: patch.agentType ?? prev.agentType,
      prompt: patch.prompt || prev.prompt,
      status,
      result: patch.result !== undefined && patch.result !== null && (!finished || prev.result === null) ? patch.result : prev.result,
      endedAt: prev.endedAt ?? (FINISHED.includes(status) ? t : null),
    };
    const same = (["parentId", "description", "agentType", "prompt", "status", "result", "endedAt"] as const).every((k) => next[k] === prev[k]);
    if (same) return null;
    this.db
      .query(
        `UPDATE subagents SET parent_id = $parentId, description = $description, agent_type = $agentType, prompt = $prompt,
           status = $status, result = $result, ended_at = $endedAt, updated_at = $t WHERE session_id = $sessionId AND id = $id`,
      )
      .run({
        sessionId,
        id: prev.id,
        parentId: next.parentId,
        description: next.description,
        agentType: next.agentType,
        prompt: next.prompt,
        status: next.status,
        result: next.result,
        endedAt: next.endedAt,
        t,
      });
    return this.get(sessionId, prev.id);
  }

  /** Mark a run's sub-agents that are still running as stopped (the run ended); returns them. */
  stopRunning(runId: string): Subagent[] {
    const rows = this.db.query("SELECT * FROM subagents WHERE run_id = $runId AND status = 'running'").all({ runId }) as SubagentRow[];
    const t = now();
    this.db.query("UPDATE subagents SET status = 'stopped', ended_at = $t, updated_at = $t WHERE run_id = $runId AND status = 'running'").run({ runId, t });
    return rows.map((r) => toSubagent({ ...r, status: "stopped", ended_at: t, updated_at: t }));
  }
}
