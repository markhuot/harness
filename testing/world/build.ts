// Strict builders for the world. Each fills every required wire field and nothing else, and
// returns the real protocol type with no cast, so a field added to protocol.ts without a default
// here fails typecheck instead of becoming a blank screen.

import type { ActivityEntry, Project, Run, Session, Ticket, TranscriptEntry, Watcher } from "@harness/shared";
import { NOW, minutesAgo } from "./time";

export function project(o: Pick<Project, "key" | "name" | "path"> & Partial<Project>): Project {
  return {
    id: `project-${o.key}`,
    nextSeq: 1,
    defaultDriver: null,
    defaultModels: {},
    useWorktrees: true,
    isGit: true,
    permissionMode: null,
    baseBranch: null,
    color: null,
    group: null,
    createdAt: minutesAgo(60 * 24 * 30),
    updatedAt: minutesAgo(60 * 24),
    ...o,
  };
}

export function ticket(o: Pick<Ticket, "key" | "projectId" | "title" | "status"> & Partial<Ticket>): Ticket {
  return {
    id: `ticket-${o.key}`,
    kind: "task",
    spec: `# Goal\n\n${o.title}.\n\n# Plan\n\n- Read the code\n- Change it\n\n# Status\n\nNot started`,
    specRevision: 1,
    specBaselineRevision: null,
    sessionId: `session-${o.key}`,
    driver: "claude-code",
    parentId: null,
    childCount: 0,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    pullRequests: [],
    blockedReason: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    permissionMode: null,
    model: null,
    position: 0,
    completedAt: null,
    createdAt: minutesAgo(60 * 48),
    updatedAt: minutesAgo(60),
    ...o,
  };
}

export function session(o: Pick<Session, "key" | "kind"> & Partial<Session>): Session {
  return {
    id: `session-${o.key}`,
    ticketId: o.kind === "ticket" ? `ticket-${o.key}` : null,
    driver: "claude-code",
    cwd: "/Users/dev/harness",
    title: "",
    triageStatus: null,
    outcome: null,
    busy: false,
    createdAt: minutesAgo(60 * 48),
    updatedAt: minutesAgo(60),
    ...o,
  };
}

export function run(o: Pick<Run, "id" | "sessionId" | "kind" | "status"> & Partial<Run>): Run {
  return {
    driver: "claude-code",
    prompt: "",
    error: null,
    createdAt: minutesAgo(120),
    startedAt: minutesAgo(119),
    endedAt: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    ...o,
  };
}

export function entry(o: Pick<TranscriptEntry, "id" | "sessionId" | "seq" | "role" | "content"> & Partial<TranscriptEntry>): TranscriptEntry {
  return { runId: null, subagentId: null, createdAt: NOW - (100 - o.seq) * 60_000, ...o };
}

export function activity(o: Pick<ActivityEntry, "id" | "ticketId" | "kind" | "body"> & Partial<ActivityEntry>): ActivityEntry {
  return {
    sessionId: o.ticketId ? o.ticketId.replace("ticket-", "session-") : "",
    author: "agent",
    meta: {},
    createdAt: minutesAgo(30),
    ...o,
  };
}

export function watcher(o: Pick<Watcher, "name" | "command"> & Partial<Watcher>): Watcher {
  return {
    id: `watcher-${o.name}`,
    args: [],
    prompt: "",
    cwd: null,
    env: {},
    mode: "interval",
    intervalSec: 300,
    enabled: true,
    driver: null,
    lastRunAt: minutesAgo(4),
    lastError: null,
    createdAt: minutesAgo(60 * 24 * 10),
    updatedAt: minutesAgo(60 * 24 * 2),
    ...o,
  };
}
