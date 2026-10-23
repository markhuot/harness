// Chief of staff (CoS) shapes shared by the service and its clients (DESIGN.md "Chief of staff").

import type { HarnessEvent, PhaseChoice, Project, Settings } from "./protocol";
import { settingsPhaseChoice } from "./phases";

/** The two settings a project may override of the app's (Project.cosEnabled, Project.cosCanUnblock). */
export type CosSettingKey = "cosEnabled" | "cosCanUnblock";

/** What the app's settings say when nothing was saved. */
export const COS_SETTING_DEFAULTS: Readonly<Record<CosSettingKey, boolean>> = { cosEnabled: true, cosCanUnblock: false };

/**
 * A CoS setting for one project: the project's own value, else the app's, else the default. The one
 * place that resolves it: ownership of a project's events and the unblock tools both read it.
 */
export function resolveCosSetting(project: Pick<Project, "cosEnabled" | "cosCanUnblock"> | null | undefined, settings: Pick<Settings, "cosEnabled" | "cosCanUnblock">, key: CosSettingKey): boolean {
  return project?.[key] ?? settings[key] ?? COS_SETTING_DEFAULTS[key];
}

/**
 * The driver and model a chief of staff runs on: the project's own choice (the project its wake is
 * about), else the app's CoS choice, else the app's Work choice, so an install that never chose one
 * runs as before. The one place that resolves it: every chief run (wake, chat, hand-off) reads it.
 */
export function resolveCosChoice(project: Pick<Project, "cosModel"> | null | undefined, settings: Pick<Settings, "cosModel" | "phaseModels">): PhaseChoice {
  return project?.cosModel ?? settings.cosModel ?? settingsPhaseChoice(settings.phaseModels, "work");
}

/** The drivers a CoS model picker offers: those that can run a chief, and `keep` (the driver already picked) so a saved choice never vanishes. */
export function cosDrivers<T extends { id: string; runsCos?: boolean }>(drivers: readonly T[], keep?: string | null): T[] {
  return drivers.filter((d) => d.runsCos !== false || d.id === keep);
}

/** What a CoS sees and may act on: every project (`all`) or the projects of one group. */
export type CosScope = "all" | { group: string };

/** The scope as stored and sent: "all" or "group:<group id>". */
export type CosScopeKey = "all" | `group:${string}`;

export function cosScopeKey(scope: CosScope): CosScopeKey {
  return scope === "all" ? "all" : `group:${scope.group}`;
}

/** The scope a key names, or null for anything that isn't one. */
export function parseCosScopeKey(key: unknown): CosScope | null {
  if (key === "all") return "all";
  if (typeof key === "string" && key.startsWith("group:") && key.length > "group:".length) return { group: key.slice("group:".length) };
  return null;
}

/**
 * A chief of staff (GET /cos). `ticketId` and `key` identify its ticket (kind "cos"), which carries
 * its transcript, notes and queue; `enabled` is its own on/off switch, so the All CoS can be turned off.
 */
export interface Cos {
  ticketId: string;
  key: string;
  scope: CosScopeKey;
  /** The group it covers; null for the All CoS */
  groupId: string | null;
  enabled: boolean;
  createdAt: number;
  /** Why the Haiku triage in front of it can't run (its events escalate instead); absent or null when it can */
  triageUnavailable?: string | null;
}

// ---------------------------------------------------------------------------
// Events: what wakes a chief of staff (DESIGN.md "Chief of staff", "Events")
// ---------------------------------------------------------------------------

export type CosEventSource = "activity" | "watcher" | "schedule";

/** Where an event is: pending (waiting for triage), triaging, escalated (for the next wake), handling (in a run), handled, or ignored. */
export type CosEventStatus = "pending" | "triaging" | "escalated" | "handling" | "handled" | "ignored";

/** What triage said: not yet, ignore, escalate, or dropped by a coded rule (a chief's own activity, a net-zero move). */
export type CosEventVerdict = "pending" | "ignore" | "escalate" | "filtered";

/** Statuses that count toward the Inbox badge (an event somebody still has to see to). */
export const COS_OPEN_STATUSES: readonly CosEventStatus[] = ["pending", "triaging", "escalated", "handling"];

/** What the chief did about an event it was woken for: acted, found nothing to do, or needs the user to do something. */
export const COS_OUTCOME_KINDS = ["acted", "no_action", "needs_user"] as const;
export type CosOutcomeKind = (typeof COS_OUTCOME_KINDS)[number];

/** The chief's own account of one event, recorded with record_event_outcomes. */
export interface CosOutcome {
  kind: CosOutcomeKind;
  text: string;
}

/** One row of a chief of staff's Inbox (GET /cos/:id/events). */
export interface CosEvent {
  id: string;
  /** The chief that owns it; null while no chief qualifies (unassigned) */
  cosId: string | null;
  projectKey: string | null;
  sourceKind: CosEventSource;
  title: string;
  summary: string;
  /** Who caused it: "human", "agent", "system", "watcher:<name>", or "cos:<chief id>" */
  actor: string;
  status: CosEventStatus;
  verdict: CosEventVerdict;
  reason: string | null;
  /** The model that triaged it; null when none did (filtered, or a fail-open escalation) */
  model: string | null;
  ticketKey: string | null;
  wakeId: string | null;
  /** The run that handled it */
  handledBy: string | null;
  /** What the chief recorded for it; null when its run ended without recording one (and for events handled before outcomes existed) */
  outcome: CosOutcome | null;
  /** The session whose transcript shows what triage looked up for it; null when a one-shot call (or no model) judged it */
  triageSessionId?: string | null;
  createdAt: number;
}

/** GET /cos/:id/events */
export interface CosEventPage {
  items: CosEvent[];
  nextCursor: string | null;
}

/** GET /cos/events/badge */
export interface CosBadge {
  total: number;
  byCos: Record<string, number>;
}

interface CosChatBase {
  id: string;
  cosId: string;
  createdAt: number;
}

/** One entry of a chief's chat (GET /cos/:id/transcript). */
export type CosChatEntry =
  | (CosChatBase & { kind: "message"; role: "user" | "assistant"; text: string })
  | (CosChatBase & { kind: "ticket_created"; key: string; title: string; status: string })
  | (CosChatBase & { kind: "ticket_moved"; key: string; title: string; from: string; to: string })
  | (CosChatBase & { kind: "event_batch"; wakeId: string; eventIds: string[]; digest: string });

/** GET /cos/:id/transcript, newest page first */
export interface CosChatPage {
  entries: CosChatEntry[];
  nextCursor: string | null;
}

/** Bus events for the Inbox and chat (not part of protocol.ts's HarnessEvent: clients that don't know them ignore them). */
export type CosBusEvent =
  | { kind: "cos.event.upserted"; event: CosEvent }
  | { kind: "cos.badge"; total: number; byCos: Record<string, number> }
  | { kind: "cos.transcript.appended"; cosId: string; entry: CosChatEntry };

/** Everything a client's socket may deliver: the protocol's events and the chiefs'. */
export type ClientEvent = HarnessEvent | CosBusEvent;

// ---------------------------------------------------------------------------
// Schedules: a chief of staff's reminders and wake-ups (DESIGN.md "Schedules")
// ---------------------------------------------------------------------------

/** A reminder notifies the human and starts no run; a wake becomes an event for the chief. */
export type ScheduleKind = "reminder" | "wake";

/** When it fires: once at a time (ms since the epoch), every N ms, or on a 5-field cron expression in the Mac's timezone. */
export type ScheduleSpec = { type: "at"; at: number } | { type: "every"; everyMs: number } | { type: "cron"; cron: string };

/** active: will fire; done: a one-shot that fired; missed: a one-shot found long past its time; cancelled. */
export type ScheduleStatus = "active" | "done" | "missed" | "cancelled";

/** What the last fire did: fired, or skipped because its chief was off. */
export type ScheduleOutcome = "fired" | "skipped" | "missed";

/** One schedule (GET /schedules, schedule_list). */
export interface Schedule {
  id: string;
  /** The chief of staff that made it and that a wake goes to */
  cosId: string;
  kind: ScheduleKind;
  title: string;
  message: string;
  spec: ScheduleSpec;
  projectKey: string | null;
  status: ScheduleStatus;
  /** When it fires next; null once it can't */
  nextFireAt: number | null;
  lastFireAt: number | null;
  lastOutcome: ScheduleOutcome | null;
  createdAt: number;
}

/** The fewest ms between two fires of a repeating schedule, so a wake that makes schedules can't feed back on itself. */
export const SCHEDULE_MIN_INTERVAL_MS = 5 * 60_000;
/** Active schedules per chief. */
export const SCHEDULE_MAX_ACTIVE = 50;
/** A one-shot found this late (the Mac was off) is marked missed instead of fired. */
export const SCHEDULE_STALE_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** Quiet time before a batch is triaged, and the longest an event waits however busy it is. */
export const COS_QUIET_MS = 45_000;
export const COS_CEILING_MS = 5 * 60_000;
/** Full wakes per chief per hour; more join one later wake. */
export const COS_WAKES_PER_HOUR = 6;
export const COS_HOUR_MS = 60 * 60_000;

/** A chief as ownership sees it. */
export type CosChief = Pick<Cos, "ticketId" | "scope" | "groupId" | "enabled">;

/**
 * The one chief that owns an event: the project's group's chief when it is on and the project has
 * chiefs enabled, otherwise the All chief under the same conditions, otherwise null (unassigned
 * until one qualifies). `project` null (an event with no project yet) is judged on the app's setting alone.
 */
export function ownerOf(
  project: (Pick<Project, "cosEnabled"> & { groupId?: string | null }) | null,
  settings: Pick<Settings, "cosEnabled">,
  chiefs: readonly CosChief[],
): string | null {
  if (!resolveCosSetting(project, { ...settings, cosCanUnblock: false }, "cosEnabled")) return null;
  const group = project?.groupId ? chiefs.find((c) => c.enabled && c.scope === `group:${project.groupId}`) : undefined;
  return (group ?? chiefs.find((c) => c.enabled && c.scope === "all"))?.ticketId ?? null;
}

/** When a batch is due: 45s after its last event, but never later than 5 minutes after its first. Null for an empty batch. */
export function nextWakeAt(createdAts: readonly number[]): number | null {
  if (!createdAts.length) return null;
  return Math.min(Math.max(...createdAts) + COS_QUIET_MS, Math.min(...createdAts) + COS_CEILING_MS);
}

/** When a chief may be woken again: now, or once the oldest wake of the last hour ages out when `cap` are already in it. */
export function nextWakeAllowedAt(wakeTimes: readonly number[], now: number, cap = COS_WAKES_PER_HOUR): number {
  const recent = wakeTimes.filter((t) => t > now - COS_HOUR_MS).sort((a, b) => a - b);
  return recent.length < cap ? now : recent[recent.length - cap]! + COS_HOUR_MS;
}

export interface CollapsibleEvent {
  id: string;
  ticketId: string | null;
  /** The activity kind; only "moved" events are collapsed */
  kind: string;
  from?: string | null;
  to?: string | null;
  createdAt: number;
}

/**
 * Per-ticket net state: a ticket's status moves in one batch become one move from where it started
 * to where it ended, or none when it ended where it started. Returns the ids to drop with the id
 * they merged into (null when they cancelled out), and the net move of the surviving event.
 */
export function collapseMoves(events: readonly CollapsibleEvent[]): { dropped: { id: string; into: string | null }[]; net: Map<string, { from: string; to: string }> } {
  const byTicket = new Map<string, CollapsibleEvent[]>();
  for (const e of events) {
    if (e.kind !== "moved" || !e.ticketId || !e.from || !e.to) continue;
    byTicket.set(e.ticketId, [...(byTicket.get(e.ticketId) ?? []), e]);
  }
  const dropped: { id: string; into: string | null }[] = [];
  const net = new Map<string, { from: string; to: string }>();
  for (const moves of byTicket.values()) {
    if (moves.length < 2) continue;
    const sorted = [...moves].sort((a, b) => a.createdAt - b.createdAt);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    if (first.from === last.to) {
      for (const m of sorted) dropped.push({ id: m.id, into: null });
      continue;
    }
    for (const m of sorted.slice(0, -1)) dropped.push({ id: m.id, into: last.id });
    net.set(last.id, { from: first.from!, to: last.to! });
  }
  return { dropped, net };
}

/** Every CosEventStatus, for validating ?status= */
export const COS_EVENT_STATUSES: readonly CosEventStatus[] = ["pending", "triaging", "escalated", "handling", "handled", "ignored"];

/** A chief of staff's memory (GET /tickets/:key/memory): one markdown document, and the revision a write is checked against. */
export interface CosMemory {
  text: string;
  revision: string;
}

/** PUT /tickets/:key/memory: the whole document, written by the human. */
export interface PutCosMemoryBody {
  text: string;
  /** The revision the editor opened (CosMemory.revision). A memory that changed since answers 409 with a MemoryConflict. */
  baseRevision: string;
}

/** The `data` of PUT /tickets/:key/memory's 409 when baseRevision isn't the current revision. */
export interface MemoryConflict {
  currentRevision: string;
  text: string;
}

/**
 * Activity that never needs a chief, so it is recorded as filtered instead of sent to triage: an agent review's approval of a
 * ticket that still waits on a human, and a ticket that completed as planned (a human's approval, or a move into done from review).
 * Blocks, failures, answers, conflicts and requested changes are not here: they stay with triage.
 */
export function routineActivityReason(e: { kind: string; to: string | null; from: string | null }, ticketStatus: string): string | null {
  if (e.kind === "review_approved" && ticketStatus === "review") return "routine: the agent review approved it and it waits for a human";
  if (e.kind === "approved" || (e.kind === "moved" && e.to === "done" && e.from === "review")) return "routine: it completed as planned";
  return null;
}
