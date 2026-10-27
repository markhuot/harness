// Chief of staff (CoS) shapes shared by the service and its clients (DESIGN.md "Chief of staff").

import type { Attachment, HarnessEvent, MessageDraft, PendingApproval, PhaseChoice, Project, Settings, TicketStatus, TriagePermissionMode } from "./protocol";
import { HAIKU_MODELS, settingsPhaseChoice } from "./phases";

/** The driver whose models triage runs on: the API's when the classifier uses the API, else Claude Code's. */
export function triageDriver(settings: Pick<Settings, "classifier">): string {
  return settings.classifier === "anthropic-api" ? "anthropic-api" : "claude-code";
}

/** The model triage runs on when settings.cosTriageModel is empty: that driver's Haiku. */
export function triageDefaultModel(settings: Pick<Settings, "classifier">): string {
  return HAIKU_MODELS[triageDriver(settings)]!;
}

/** The model triage runs on: settings.cosTriageModel, else the driver's Haiku. */
export function resolveTriageModel(settings: Pick<Settings, "classifier" | "cosTriageModel">): string {
  return settings.cosTriageModel?.trim() || triageDefaultModel(settings);
}

/** How triage's lookups are judged: settings.cosTriagePermissionMode, else read-only. */
export function resolveTriagePermissionMode(settings: Pick<Settings, "cosTriagePermissionMode">): TriagePermissionMode {
  return settings.cosTriagePermissionMode ?? "read_only";
}

/** The setting a project may override of the app's (Project.cosEnabled). */
export type CosSettingKey = "cosEnabled";

/** What the app's settings say when nothing was saved. */
export const COS_SETTING_DEFAULTS: Readonly<Record<CosSettingKey, boolean>> = { cosEnabled: true };

/** The columns whose events reach a chief when nothing was saved: none, so a person opts in to what their chief handles. */
export const COS_STATUS_DEFAULTS: readonly TicketStatus[] = [];

/**
 * A CoS setting for one project: the project's own value, else the app's, else the default. The one
 * place that resolves it: ownership of a project's events reads it.
 */
export function resolveCosSetting(project: Pick<Project, "cosEnabled"> | null | undefined, settings: Pick<Settings, "cosEnabled">, key: CosSettingKey): boolean {
  return project?.[key] ?? settings[key] ?? COS_SETTING_DEFAULTS[key];
}

/** The columns whose tickets a chief sees: the project's own set, else the app's, else none. */
export function resolveCosStatuses(project: Pick<Project, "cosStatuses"> | null | undefined, settings: Pick<Settings, "cosStatuses">): readonly TicketStatus[] {
  return project?.cosStatuses ?? settings.cosStatuses ?? COS_STATUS_DEFAULTS;
}

/**
 * Whether a chief sees events on a ticket in `status`. The one place that decides it: the event feed
 * drops what it says no to, and Blocked is also what lets a chief answer or move a blocked ticket.
 */
export function cosSeesStatus(project: Pick<Project, "cosStatuses"> | null | undefined, settings: Pick<Settings, "cosStatuses">, status: string): boolean {
  return (resolveCosStatuses(project, settings) as readonly string[]).includes(status);
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
  /** The message being written to it (the chief's ticket draft), so another device can finish it; null or absent when none */
  messageDraft?: MessageDraft | null;
  /** The tool call waiting for the human (the chief's ticket pendingApproval): answered through POST /tickets/:key/approval with this key; null or absent when none */
  pendingApproval?: PendingApproval | null;
}

// ---------------------------------------------------------------------------
// Events: what wakes a chief of staff (DESIGN.md "Chief of staff", "Events")
// ---------------------------------------------------------------------------

/** Every kind of event, in the order the filters list them. */
export const TICKET_EVENT_SOURCES = ["activity", "watcher", "schedule", "subscription", "child"] as const;
export type TicketEventSource = (typeof TICKET_EVENT_SOURCES)[number];

/** Where an event is: pending (waiting for triage), triaging, escalated (for the next wake), handling (in a run), handled, or ignored. */
export type TicketEventStatus = "pending" | "triaging" | "escalated" | "handling" | "handled" | "ignored";

/** What triage said: not yet, ignore, escalate, or dropped by a coded rule (a chief's own activity, a net-zero move). */
export type TicketEventVerdict = "pending" | "ignore" | "escalate" | "filtered";

/** Statuses that count toward the Inbox badge (an event somebody still has to see to). */
export const COS_OPEN_STATUSES: readonly TicketEventStatus[] = ["pending", "triaging", "escalated", "handling"];

/** What the chief did about an event it was woken for: acted, found nothing to do, or needs the user to do something. */
export const COS_OUTCOME_KINDS = ["acted", "no_action", "needs_user"] as const;
export type CosOutcomeKind = (typeof COS_OUTCOME_KINDS)[number];

/** The chief's own account of one event, recorded with record_event_outcomes. */
export interface CosOutcome {
  kind: CosOutcomeKind;
  text: string;
}

/** One event: a row of a ticket's Events tab, or of a chief of staff's Inbox (GET /tickets/:key/events). */
export interface TicketEvent {
  id: string;
  /** The ticket the event wakes (a chief's id for the chief's own rows); null while no chief qualifies (unassigned) */
  targetId: string | null;
  projectKey: string | null;
  sourceKind: TicketEventSource;
  title: string;
  summary: string;
  /** Who caused it: "human", "agent", "system", "watcher:<name>", or "cos:<chief id>" */
  actor: string;
  status: TicketEventStatus;
  verdict: TicketEventVerdict;
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

/** GET /tickets/:key/events */
export interface TicketEventPage {
  items: TicketEvent[];
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
  | (CosChatBase & { kind: "message"; role: "user" | "assistant"; text: string; attachments?: Attachment[] })
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
  | { kind: "ticket.event.upserted"; event: TicketEvent }
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

/** How long a burst of events waits so one triage call sees it whole. A fixed delay from the burst's first event, not a quiet window: triage only batches, delivery has its own cap. */
export const COS_TRIAGE_BATCH_MS = 10_000;

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
  if (!resolveCosSetting(project, settings, "cosEnabled")) return null;
  const group = project?.groupId ? chiefs.find((c) => c.enabled && c.scope === `group:${project.groupId}`) : undefined;
  return (group ?? chiefs.find((c) => c.enabled && c.scope === "all"))?.ticketId ?? null;
}

/** When a batch is due for triage: a fixed delay after its first event. Null for an empty batch. */
export function triageDueAt(createdAts: readonly number[]): number | null {
  if (!createdAts.length) return null;
  return Math.min(...createdAts) + COS_TRIAGE_BATCH_MS;
}

/**
 * When a target may be woken again under a cap: now, or once the oldest wake in the window ages out
 * when `limit` are already in it.
 */
export function nextWakeAllowedAt(wakeTimes: readonly number[], now: number, cap: WakeCap): number {
  const recent = wakeTimes.filter((t) => t > now - cap.windowMs).sort((a, b) => a - b);
  return recent.length < cap.limit ? now : recent[recent.length - cap.limit]! + cap.windowMs;
}

/** At most `limit` wakes of a target (per event class) in `windowMs`; events over it are held and go in one later wake. */
export interface WakeCap {
  limit: number;
  windowMs: number;
}

/** What every ticket that follows events (the chief of staff, a subscriber) is woken under: 8 wakes per 5 minutes. */
export const EVENT_WAKE_CAP: WakeCap = { limit: 8, windowMs: 5 * 60_000 };
/** A parent hearing about its children: generous, but finite so two tickets subscribed to each other can't ping-pong forever. */
export const CHILD_EVENT_WAKE_CAP: WakeCap = { limit: 60, windowMs: 5 * 60_000 };

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

/** Every TicketEventStatus, for validating ?status= */
export const TICKET_EVENT_STATUSES: readonly TicketEventStatus[] = ["pending", "triaging", "escalated", "handling", "handled", "ignored"];

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
