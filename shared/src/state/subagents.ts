// Sub-agents an agent started inside its session (DESIGN.md "Sub-agents"): selectors and labels
// for the ticket's Agents tab and the sub-agent transcript view, shared by every client.

import type { Subagent, SubagentStatus } from "../index";
import { transcriptKey, type State, type TranscriptState } from "./reducer";

export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** The session's sub-agents, oldest first; null while unknown (no ticket detail yet, or an older service). */
export function subagentsOf(state: State, sessionId: string): Subagent[] | null {
  return state.subagents[sessionId] ?? null;
}

export function subagentById(state: State, sessionId: string, id: string): Subagent | null {
  return state.subagents[sessionId]?.find((s) => s.id === id) ?? null;
}

/** A sub-agent's transcript as loaded so far (undefined before its backfill or first entry). */
export function subagentTranscript(state: State, sessionId: string, id: string): TranscriptState | undefined {
  return state.transcripts[transcriptKey(sessionId, id)];
}

/** What a sub-agent row is called: its task description, else its agent type. */
export function subagentTitle(s: Pick<Subagent, "description" | "agentType">): string {
  return s.description.trim() || s.agentType || "Sub-agent";
}

/** "Explore" · "general-purpose" chip text; null when it would just repeat the title. */
export function subagentTypeLabel(s: Pick<Subagent, "description" | "agentType">): string | null {
  return s.agentType && s.description.trim() ? s.agentType : null;
}

/** 42s, 3m 5s, 1h 2m: how long it ran (so far, while running). */
export function subagentDuration(s: Pick<Subagent, "startedAt" | "endedAt">, now = Date.now()): string {
  const total = Math.max(0, Math.round(((s.endedAt ?? now) - s.startedAt) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${total % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface SubagentGroups {
  running: Subagent[];
  finished: Subagent[];
}

/** Running sub-agents first (oldest first), then finished ones, newest first. */
export function groupSubagents(list: Subagent[]): SubagentGroups {
  const running = list.filter((s) => s.status === "running");
  const finished = list.filter((s) => s.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return { running, finished };
}

/** The chain of sub-agents from the top down to `id` (for a nested agent's breadcrumb). */
export function subagentPath(state: State, sessionId: string, id: string): Subagent[] {
  const path: Subagent[] = [];
  const seen = new Set<string>();
  let cur = subagentById(state, sessionId, id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? subagentById(state, sessionId, cur.parentId) : null;
  }
  return path;
}
