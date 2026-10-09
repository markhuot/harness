// Sub-agents an agent started inside its session, and the background tasks it left running
// (DESIGN.md "Sub-agents", "Background tasks"): selectors and labels for the ticket's Agents & tasks
// tab, the sub-agent transcript view and the task output view, shared by every client.

import type { Subagent, SubagentKind, SubagentStatus } from "../index";
import { formatDuration } from "./format";
import { transcriptKey, type State, type TaskOutputState, type TranscriptState } from "./reducer";

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

export const TASK_KIND_LABEL: Record<Exclude<SubagentKind, "agent">, string> = {
  bash: "Bash",
  monitor: "Monitor",
};

/** A background task (a Bash command, a Monitor), not an agent. */
export function isTask(s: Pick<Subagent, "kind">): boolean {
  return s.kind === "bash" || s.kind === "monitor";
}

type Titled = Pick<Subagent, "description" | "agentType"> & Partial<Pick<Subagent, "kind" | "command">>;

/** What a row is called: its task description, else its command (a task) or agent type. */
export function subagentTitle(s: Titled): string {
  if (isTask(s)) return s.description.trim() || s.command?.trim() || "Background task";
  return s.description.trim() || s.agentType || "Sub-agent";
}

/** "Explore" · "general-purpose" · "Bash" chip text; null when it would just repeat the title. */
export function subagentTypeLabel(s: Titled): string | null {
  if (isTask(s)) return TASK_KIND_LABEL[s.kind as "bash" | "monitor"];
  return s.agentType && s.description.trim() ? s.agentType : null;
}

/**
 * A sub-agent's model as a chip: "claude-haiku-4-5-20251001" → "Haiku 4.5", the older
 * "claude-3-5-sonnet-20241022" → "Sonnet 3.5", an alias "haiku" → "Haiku", a "[1m]" context
 * suffix → "… 1M". Any other id shows as is; null while unknown.
 */
export function subagentModelLabel(model: string | null | undefined): string | null {
  const id = model?.trim();
  if (!id) return null;
  const long = /\[1m\]$/i.test(id) ? " 1M" : "";
  const base = id.replace(/\[1m\]$/i, "");
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const version = (major: string, minor?: string) => (minor ? `${major}.${minor}` : major);
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base);
  if (m) return `${cap(m[1]!)} ${version(m[2]!, m[3])}${long}`;
  m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(base);
  if (m) return `${cap(m[3]!)} ${version(m[1]!, m[2])}${long}`;
  if (/^[a-z]+$/.test(base)) return `${cap(base)}${long}`;
  return id;
}

/** The transcript link on the tool row that started it. */
export function subagentOpenLabel(s: Pick<Subagent, "kind">): string {
  return isTask(s) ? "Open output" : "Open transcript";
}

/** A background task's output as loaded so far (undefined before the first read). */
export function taskOutputOf(state: State, sessionId: string, id: string): TaskOutputState | undefined {
  return state.taskOutputs[transcriptKey(sessionId, id)];
}

/** How often a client polls a running task's output while its view is open. */
export const TASK_OUTPUT_POLL_MS = 1000;

/** 42s, 3m 5s, 1h 2m: how long it ran (so far, while running). */
export function subagentDuration(s: Pick<Subagent, "startedAt" | "endedAt">, now = Date.now()): string {
  return formatDuration((s.endedAt ?? now) - s.startedAt);
}

/** The Agents & tasks list: sub-agents and tasks together, the latest updated first. */
export function sortSubagents(list: Subagent[]): Subagent[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt);
}

/** The Agents & tasks filter's two toggles. Both on, or both off, shows everything. */
export interface SubagentFilter {
  agents: boolean;
  tasks: boolean;
}

export const NO_SUBAGENT_FILTER: SubagentFilter = { agents: false, tasks: false };

/** The rows the filter shows: only agents, only tasks, or (both or neither toggled) all of them. */
export function filterSubagents(list: Subagent[], filter: SubagentFilter): Subagent[] {
  if (filter.agents === filter.tasks) return list;
  return list.filter((s) => isTask(s) === filter.tasks);
}

/** How many of each kind, for the filter's toggles. */
export function subagentCounts(list: Pick<Subagent, "kind">[]): { agents: number; tasks: number } {
  const tasks = list.filter(isTask).length;
  return { agents: list.length - tasks, tasks };
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
