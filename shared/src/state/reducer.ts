// Pure client-side store: REST snapshots + live HarnessEvents → one normalized state tree.
// No I/O here; see store.tsx for the wiring.

import type {
  DriverInfo,
  HarnessEvent,
  Project,
  PublicSettings,
  Run,
  Session,
  Subagent,
  TaskOutput,
  ActivityEntry,
  SpecRevision,
  SpecRevisionInfo,
  Ticket,
  TicketDetail,
  TicketPage,
  TicketStatus,
  TranscriptEntry,
  Watcher,
} from "../index";
import { isConductor, reviewPassed } from "../protocol";
import type { DepState } from "./conductor";
import { dispatchedKey } from "./format";
import { adjustDoneTotals, doneColumn, mergeTickets, pagingFromPage, reducePaging, type DonePaging, type PagingAction, type SearchState } from "./paging";

export interface TranscriptState {
  entries: TranscriptEntry[];
  /** True once the REST backfill has been merged in */
  loaded: boolean;
}

export interface State {
  connected: boolean;
  /** True after the first full snapshot has been applied */
  ready: boolean;
  projects: Record<string, Project>;
  tickets: Record<string, Ticket>;
  sessions: Record<string, Session>;
  runs: Record<string, Run>;
  /** Activity per sessionId, sorted by createdAt, unique by id */
  activity: Record<string, ActivityEntry[]>;
  /**
   * Spec revision metadata per ticket id, oldest first: from GET …/spec/revisions ("specRevisions")
   * plus spec.revised events. approvedBaseline follows the ticket's specBaselineRevision.
   */
  specRevisions: Record<string, SpecRevisionInfo[]>;
  /** Revision bodies fetched so far, keyed by specBodyKey(ticketId, rev); revisions never change */
  specBodies: Record<string, string>;
  /**
   * Keyed by transcriptKey(sessionId, subagentId): the session agent's transcript under the
   * session id, each sub-agent's under "<sessionId>/<subagentId>". Sorted by seq, unique by id.
   */
  transcripts: Record<string, TranscriptState>;
  /** Sub-agents per sessionId, oldest first (from the ticket detail + subagent.upserted) */
  subagents: Record<string, Subagent[]>;
  /** Background tasks' output as polled so far, keyed by transcriptKey(sessionId, subagentId) */
  taskOutputs: Record<string, TaskOutputState>;
  /** In-flight streaming assistant text: deltas[sessionId][runId] */
  deltas: Record<string, Record<string, string>>;
  watchers: Record<string, Watcher>;
  settings: PublicSettings | null;
  drivers: DriverInfo[];
  /** Done paging per board scope (project id or ALL_SCOPE); see paging.ts */
  donePaging: Record<string, DonePaging>;
  /** The board's server-side search, when the filter box has a query */
  search: SearchState | null;
  /** Old ticket keys (upper-case, from before a project rename) → ticket id */
  keyAliases: Record<string, string>;
  /** Keys the service answered 404 for (so they aren't refetched until the next snapshot) */
  missingKeys: Record<string, true>;
  /** Conductors whose full child list came from the service (a detail); the rest may be partial */
  childrenLoaded: Record<string, true>;
  /** Dependents (ticket keys) from the latest detail, by ticket id; live changes are merged in selectors */
  dependents: Record<string, string[]>;
  /** Newest createdAt the last snapshot saw (null before one): tells new tickets from unloaded old ones */
  ticketsAsOf: number | null;
}

export const initialState: State = {
  connected: false,
  ready: false,
  projects: {},
  tickets: {},
  sessions: {},
  runs: {},
  activity: {},
  specRevisions: {},
  specBodies: {},
  transcripts: {},
  subagents: {},
  taskOutputs: {},
  deltas: {},
  watchers: {},
  settings: null,
  drivers: [],
  donePaging: {},
  search: null,
  keyAliases: {},
  missingKeys: {},
  childrenLoaded: {},
  dependents: {},
  ticketsAsOf: null,
};

export interface Snapshot {
  projects: Project[];
  tickets: Ticket[];
  sessions: Session[];
  watchers: Watcher[];
  settings: PublicSettings | null;
  drivers: DriverInfo[];
  /** The first done page for the board's current scope (tickets holds every non-done ticket) */
  donePage?: { scope: string; page: TicketPage };
}

export type Action =
  | { type: "event"; event: HarnessEvent }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "connected"; connected: boolean }
  /** `requestedKey`: the key the detail was fetched by (an old key records an alias) */
  | { type: "detail"; detail: TicketDetail; requestedKey?: string }
  /** Tickets fetched outside a snapshot/page (e.g. one project's full list): merged, newer live versions win */
  | { type: "tickets"; tickets: Ticket[] }
  /** The service has no ticket with these keys (404) */
  | { type: "missingKeys"; keys: string[] }
  /** A transcript backfill: the session agent's, or with `subagentId` one sub-agent's */
  | { type: "transcript"; sessionId: string; subagentId?: string | null; entries: TranscriptEntry[] }
  | { type: "subagents"; sessionId: string; subagents: Subagent[] }
  /** A slice of a background task's output (GET …/output), appended to what's loaded */
  | { type: "taskOutput"; sessionId: string; subagentId: string; output: TaskOutput }
  | { type: "activity"; sessionId: string; activity: ActivityEntry[] }
  /** GET /tickets/:key/spec/revisions: the ticket's whole list */
  | { type: "specRevisions"; ticketId: string; revisions: SpecRevisionInfo[] }
  /** GET /tickets/:key/spec/revisions/:rev: one revision's body */
  | { type: "specRevision"; ticketId: string; revision: SpecRevision }
  | { type: "drivers"; drivers: DriverInfo[] }
  | PagingAction;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[item.id] = item;
  return out;
}

function without<T>(rec: Record<string, T>, id: string): Record<string, T> {
  if (!(id in rec)) return rec;
  const next = { ...rec };
  delete next[id];
  return next;
}

/** Merge entries into a list: dedupe by id (newer wins), keep sorted by `order`. */
export function mergeById<T extends { id: string }>(existing: T[], incoming: T[], order: (x: T) => number): T[] {
  if (incoming.length === 0) return existing;
  const map = new Map<string, T>();
  for (const e of existing) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()].sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Snapshot entities win, except when a live event already delivered a strictly newer version
 * of the same entity while the REST request was in flight.
 */
function preferNewer<T extends { id: string; updatedAt: number }>(snap: Record<string, T>, live: Record<string, T>) {
  for (const id of Object.keys(snap)) {
    const current = live[id];
    if (current && current.updatedAt > snap[id]!.updatedAt) snap[id] = current;
  }
  return snap;
}

const entryOrder = (e: TranscriptEntry) => e.seq;
const activityOrder = (e: ActivityEntry) => e.createdAt;

/** Where a revision's body lives in State.specBodies. */
export function specBodyKey(ticketId: string, rev: number): string {
  return `${ticketId}#${rev}`;
}

/** A ticket's revision list with approvedBaseline set on `baseline` only (null: none). */
function withBaseline(list: SpecRevisionInfo[], baseline: number | null | undefined): SpecRevisionInfo[] {
  if (baseline === undefined) return list;
  return list.some((r) => r.approvedBaseline !== (r.rev === baseline)) ? list.map((r) => ({ ...r, approvedBaseline: r.rev === baseline })) : list;
}

/** Revisions merged by rev, oldest first. */
function mergeRevisions(prev: SpecRevisionInfo[], next: SpecRevisionInfo[]): SpecRevisionInfo[] {
  const byRev = new Map(prev.map((r) => [r.rev, r]));
  for (const r of next) byRev.set(r.rev, r);
  return [...byRev.values()].sort((a, b) => a.rev - b.rev);
}
const subagentOrder = (s: Subagent) => s.startedAt;

/** Where a transcript lives in State.transcripts: the session's own, or one sub-agent's. */
export function transcriptKey(sessionId: string, subagentId?: string | null): string {
  return subagentId ? `${sessionId}/${subagentId}` : sessionId;
}

function mergeTranscript(state: State, key: string, entries: TranscriptEntry[], loaded: boolean): State["transcripts"] {
  const prev = state.transcripts[key] ?? { entries: [], loaded: false };
  return {
    ...state.transcripts,
    [key]: { entries: mergeById(prev.entries, entries, entryOrder), loaded: prev.loaded || loaded },
  };
}

/** Merge sub-agents by id; a stale copy (older updatedAt) never replaces a newer one. */
function mergeSubagents(state: State, sessionId: string, incoming: Subagent[]): State["subagents"] {
  const prev = state.subagents[sessionId] ?? [];
  const current = new Map(prev.map((s) => [s.id, s]));
  const fresh = incoming.filter((s) => {
    const have = current.get(s.id);
    return !have || have.updatedAt <= s.updatedAt;
  });
  if (!fresh.length && prev.length) return state.subagents;
  return { ...state.subagents, [sessionId]: mergeById(prev, fresh, subagentOrder) };
}

/** A background task's output as loaded: the text so far and where to read on from. */
export interface TaskOutputState {
  text: string;
  /** Byte offset the text ends at: the next poll's `offset` */
  end: number;
  size: number;
  done: boolean;
  available: boolean;
  /** Earlier output isn't shown (the service sent only the tail, or the client trimmed it) */
  truncated: boolean;
}

/** The most output text a client keeps for one task; older lines are dropped past it. */
export const TASK_OUTPUT_KEEP_CHARS = 512 * 1024;

/**
 * Fold a slice into the task's output: a slice that starts where the loaded text ends is appended;
 * one that's already covered (a repeated poll) only updates `done`; anything else (the first read,
 * or a gap after a burst) replaces it.
 */
export function mergeTaskOutput(prev: TaskOutputState | undefined, out: TaskOutput): TaskOutputState {
  if (!out.available) {
    return prev ? { ...prev, done: out.done, available: prev.text !== "" } : { text: "", end: out.end, size: 0, done: out.done, available: false, truncated: false };
  }
  let next: TaskOutputState;
  if (prev?.available && out.start === prev.end) {
    next = { ...prev, text: prev.text + out.text, end: out.end, size: out.size, done: out.done };
  } else if (prev?.available && out.start < prev.end && out.end <= prev.end) {
    return prev.done === out.done ? prev : { ...prev, done: out.done };
  } else {
    next = { text: out.text, end: out.end, size: out.size, done: out.done, available: true, truncated: out.start > 0 };
  }
  if (next.text.length > TASK_OUTPUT_KEEP_CHARS) {
    const cut = next.text.length - TASK_OUTPUT_KEEP_CHARS;
    const nl = next.text.indexOf("\n", cut);
    next = { ...next, text: next.text.slice(nl >= 0 && nl - cut < 4096 ? nl + 1 : cut), truncated: true };
  }
  return next;
}

function clearDelta(deltas: State["deltas"], sessionId: string, runId: string | null): State["deltas"] {
  const forSession = deltas[sessionId];
  if (!forSession) return deltas;
  if (runId === null) return without(deltas, sessionId);
  if (!(runId in forSession)) return deltas;
  const rest = without(forSession, runId);
  return Object.keys(rest).length ? { ...deltas, [sessionId]: rest } : without(deltas, sessionId);
}

const TERMINAL_RUN: Run["status"][] = ["succeeded", "failed", "cancelled"];

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyEvent(state: State, event: HarnessEvent): State {
  switch (event.kind) {
    case "project.upserted":
      return { ...state, projects: { ...state.projects, [event.project.id]: event.project } };
    case "project.deleted": {
      const tickets: Record<string, Ticket> = {};
      for (const t of Object.values(state.tickets)) if (t.projectId !== event.id) tickets[t.id] = t;
      return { ...state, projects: without(state.projects, event.id), tickets };
    }
    case "ticket.upserted": {
      const list = state.specRevisions[event.ticket.id];
      const marked = list ? withBaseline(list, event.ticket.specBaselineRevision) : list;
      return {
        ...state,
        tickets: { ...state.tickets, [event.ticket.id]: event.ticket },
        donePaging: adjustDoneTotals(state, state.tickets[event.ticket.id], event.ticket),
        specRevisions: marked !== list ? { ...state.specRevisions, [event.ticket.id]: marked! } : state.specRevisions,
      };
    }
    case "ticket.deleted":
      return {
        ...state,
        tickets: without(state.tickets, event.id),
        donePaging: adjustDoneTotals(state, state.tickets[event.id], null),
      };
    case "session.upserted":
      return { ...state, sessions: { ...state.sessions, [event.session.id]: event.session } };
    case "run.upserted": {
      const run = event.run;
      const deltas = TERMINAL_RUN.includes(run.status) ? clearDelta(state.deltas, run.sessionId, run.id) : state.deltas;
      return { ...state, runs: { ...state.runs, [run.id]: run }, deltas };
    }
    case "transcript.appended": {
      const entry = event.entry;
      const transcripts = mergeTranscript(state, transcriptKey(entry.sessionId, entry.subagentId), [entry], false);
      // The persisted assistant text block replaces the streamed preview of the same run
      // (sub-agents don't stream, so their text leaves the agent's preview alone).
      const deltas =
        entry.role === "assistant" && entry.content.type === "text" && !entry.subagentId
          ? clearDelta(state.deltas, entry.sessionId, entry.runId)
          : state.deltas;
      return { ...state, transcripts, deltas };
    }
    case "transcript.delta": {
      const forSession = state.deltas[event.sessionId] ?? {};
      return {
        ...state,
        deltas: {
          ...state.deltas,
          [event.sessionId]: { ...forSession, [event.runId]: (forSession[event.runId] ?? "") + event.text },
        },
      };
    }
    case "subagent.upserted":
      return { ...state, subagents: mergeSubagents(state, event.subagent.sessionId, [event.subagent]) };
    case "activity.added": {
      const e = event.entry;
      return {
        ...state,
        activity: { ...state.activity, [e.sessionId]: mergeById(state.activity[e.sessionId] ?? [], [e], activityOrder) },
      };
    }
    case "spec.revised": {
      // Only a list that was loaded grows: an unknown one is fetched whole when it's shown.
      const list = state.specRevisions[event.ticketId];
      if (!list) return state;
      const info: SpecRevisionInfo = {
        rev: event.rev,
        author: event.author,
        note: event.note,
        runId: event.runId ?? null,
        runKind: event.runKind ?? null,
        approvedBaseline: false,
        createdAt: event.createdAt ?? 0,
      };
      return { ...state, specRevisions: { ...state.specRevisions, [event.ticketId]: mergeRevisions(list, [info]) } };
    }
    case "watcher.upserted":
      return { ...state, watchers: { ...state.watchers, [event.watcher.id]: event.watcher } };
    case "watcher.deleted":
      return { ...state, watchers: without(state.watchers, event.id) };
    case "settings.updated":
      return { ...state, settings: event.settings };
    case "browser.frame":
    case "browser.state":
      // High-frequency, view-local; the Browser tab consumes these directly.
      return state;
    default:
      return state;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "connected":
      return state.connected === action.connected ? state : { ...state, connected: action.connected };
    case "snapshot": {
      const s = action.snapshot;
      // A snapshot is authoritative for entity lists; transcripts/activity are kept (they are
      // merged by id, and views refetch them on reconnect). Paging restarts from its first page;
      // an active search is re-armed (ids → null) for the client to re-run.
      const all = s.donePage ? [...s.tickets, ...s.donePage.page.tickets] : s.tickets;
      const donePaging: State["donePaging"] = {};
      if (s.donePage) donePaging[s.donePage.scope] = pagingFromPage(s.donePage.page, undefined, false);
      return {
        ...state,
        ready: true,
        projects: preferNewer(byId(s.projects), state.projects),
        tickets: preferNewer(byId(all), state.tickets),
        donePaging,
        search: state.search ? { ...state.search, ids: null, nextCursor: null, total: 0, loading: true, error: null } : null,
        keyAliases: {},
        missingKeys: {},
        childrenLoaded: {},
        dependents: {},
        ticketsAsOf: all.reduce((n, t) => Math.max(n, t.createdAt), 0),
        sessions: preferNewer(byId(s.sessions), state.sessions),
        watchers: byId(s.watchers),
        settings: s.settings,
        drivers: s.drivers,
      };
    }
    case "detail": {
      const d = action.detail;
      // The parent rides along so a child's "Part of …" breadcrumb works when the conductor isn't loaded.
      const tickets = mergeTickets(state.tickets, [d.ticket, ...d.children, ...(d.parent ? [d.parent] : [])]);
      const asked = (d.resolvedFrom ?? action.requestedKey)?.toUpperCase();
      const keyAliases = asked && asked !== d.ticket.key.toUpperCase() ? { ...state.keyAliases, [asked]: d.ticket.id } : state.keyAliases;
      const runs = { ...state.runs };
      for (const r of d.runs) runs[r.id] = r;
      return {
        ...state,
        tickets,
        keyAliases,
        missingKeys: asked && state.missingKeys[asked] ? without(state.missingKeys, asked) : state.missingKeys,
        childrenLoaded: isConductor(d.ticket) ? { ...state.childrenLoaded, [d.ticket.id]: true } : state.childrenLoaded,
        dependents: { ...state.dependents, [d.ticket.id]: d.dependents },
        runs,
        sessions: { ...state.sessions, [d.session.id]: d.session },
        // Older services don't send sub-agents: leave the session's list unknown then.
        subagents: d.subagents ? mergeSubagents(state, d.session.id, d.subagents) : state.subagents,
        activity: {
          ...state.activity,
          [d.session.id]: mergeById(state.activity[d.session.id] ?? [], d.activity, activityOrder),
        },
      };
    }
    case "transcript":
      return { ...state, transcripts: mergeTranscript(state, transcriptKey(action.sessionId, action.subagentId), action.entries, true) };
    case "subagents":
      return { ...state, subagents: mergeSubagents(state, action.sessionId, action.subagents) };
    case "taskOutput": {
      const key = transcriptKey(action.sessionId, action.subagentId);
      const prev = state.taskOutputs[key];
      const next = mergeTaskOutput(prev, action.output);
      return next === prev ? state : { ...state, taskOutputs: { ...state.taskOutputs, [key]: next } };
    }
    case "activity":
      return {
        ...state,
        activity: {
          ...state.activity,
          [action.sessionId]: mergeById(state.activity[action.sessionId] ?? [], action.activity, activityOrder),
        },
      };
    case "specRevisions": {
      const baseline = state.tickets[action.ticketId]?.specBaselineRevision;
      const list = withBaseline(mergeRevisions(state.specRevisions[action.ticketId] ?? [], action.revisions), baseline);
      return { ...state, specRevisions: { ...state.specRevisions, [action.ticketId]: list } };
    }
    case "specRevision": {
      const { revision: r } = action;
      const { body: _body, ...info } = r;
      const prev = state.specRevisions[action.ticketId];
      return {
        ...state,
        specBodies: { ...state.specBodies, [specBodyKey(action.ticketId, r.rev)]: r.body },
        specRevisions: prev ? { ...state.specRevisions, [action.ticketId]: mergeRevisions(prev, [info]) } : state.specRevisions,
      };
    }
    case "drivers":
      return { ...state, drivers: action.drivers };
    case "tickets":
      return { ...state, tickets: mergeTickets(state.tickets, action.tickets) };
    case "missingKeys": {
      const missingKeys = { ...state.missingKeys };
      for (const k of action.keys) missingKeys[k.toUpperCase()] = true;
      return { ...state, missingKeys };
    }
    default:
      return reducePaging(state, action);
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function ticketsForProject(state: State, projectId: string | null): Ticket[] {
  return Object.values(state.tickets).filter((t) => projectId === null || t.projectId === projectId);
}

export function boardColumns(state: State, projectId: string | null): Record<TicketStatus, Ticket[]> {
  const cols: Record<TicketStatus, Ticket[]> = { planning: [], in_progress: [], blocked: [], review: [], done: [] };
  for (const t of ticketsForProject(state, projectId)) if (t.status !== "done") cols[t.status]?.push(t);
  for (const list of Object.values(cols)) {
    list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }
  // Done: newest-completed first, only the paged-in prefix (see paging.ts).
  cols.done = doneColumn(state, projectId);
  return cols;
}

/** By current key, else by an old key (from before a project rename) the service resolved for us. */
export function ticketByKey(state: State, key: string): Ticket | undefined {
  const upper = key.toUpperCase();
  const direct = Object.values(state.tickets).find((t) => t.key.toUpperCase() === upper);
  if (direct) return direct;
  const aliased = state.keyAliases[upper];
  return aliased ? state.tickets[aliased] : undefined;
}

/**
 * Whether markdown should link a ticket-shaped word (FOO-12) to the ticket: it's loaded, or its
 * prefix is a project's key (done tickets aren't all in memory; the detail fetches it). Keys the
 * service already 404'd, and look-alikes such as UTF-8, stay plain text.
 */
export function ticketLinkable(state: State, key: string): boolean {
  const upper = key.toUpperCase();
  if (state.missingKeys[upper]) return false;
  if (ticketByKey(state, upper)) return true;
  const prefix = upper.slice(0, upper.lastIndexOf("-"));
  return Object.values(state.projects).some((p) => p.key.toUpperCase() === prefix);
}

export function triageSessions(state: State): Session[] {
  return Object.values(state.sessions)
    .filter((s) => s.kind === "triage")
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** The driver new tickets in a project get: the project's own default, else the global one (null until settings load). */
export function defaultDriverOf(state: State, projectId: string): string | null {
  return state.projects[projectId]?.defaultDriver ?? state.settings?.defaultDriver ?? null;
}

/** Whether a ticket runs on something other than its project's default driver, i.e. worth labelling. */
export function hasCustomDriver(state: State, ticket: Ticket): boolean {
  const d = defaultDriverOf(state, ticket.projectId);
  return d !== null && ticket.driver !== d;
}

export function childrenOf(state: State, ticketId: string): Ticket[] {
  return Object.values(state.tickets)
    .filter((t) => t.parentId === ticketId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * A dependency is satisfied when the ticket it names is done. A key that isn't loaded is
 * "unknown" (not "pending"): done tickets aren't all in memory, so a missing ticket is most likely
 * an older done one. Clients fetch unresolved keys (unresolvedKeys) and the state settles.
 */
export function dependencyStates(state: State, ticket: Ticket): DepState[] {
  return ticket.dependsOn.map((key) => {
    const dep = ticketByKey(state, key);
    const status: DepState["state"] = !dep ? "unknown" : dep.status === "done" ? "done" : "pending";
    return { key, done: status === "done", state: status, ticket: dep, missing: !dep && !!state.missingKeys[key.toUpperCase()] };
  });
}

/**
 * Ticket keys the UI references but the store can't resolve yet: dependencies of loaded tickets,
 * dependents from details, and triage outcomes ("Dispatched to FOO-123"). Keys the service
 * already 404'd are left out. Fetch each with getTicket and dispatch "detail" (with requestedKey)
 * or "missingKeys".
 */
export function unresolvedKeys(state: State, extra: string[] = []): string[] {
  if (!state.ready) return [];
  const known = new Set<string>();
  for (const t of Object.values(state.tickets)) known.add(t.key.toUpperCase());
  for (const k of Object.keys(state.keyAliases)) known.add(k);
  const out = new Set<string>();
  const want = (k: string) => {
    const u = k.toUpperCase();
    if (!known.has(u) && !state.missingKeys[u]) out.add(u);
  };
  for (const t of Object.values(state.tickets)) t.dependsOn.forEach(want);
  for (const keys of Object.values(state.dependents)) keys.forEach(want);
  for (const s of Object.values(state.sessions)) {
    const k = s.kind === "triage" ? dispatchedKey(s) : null;
    if (k) want(k);
  }
  extra.forEach(want);
  return [...out];
}

/** Conductors on hand whose child list may be partial (no detail yet): fetch their details. */
export function conductorsNeedingChildren(state: State): Ticket[] {
  if (!state.ready) return [];
  return Object.values(state.tickets).filter((t) => isConductor(t) && !state.childrenLoaded[t.id]);
}

/**
 * Tickets that depend on this one: the detail's list (covers done ones that aren't loaded) merged
 * with a live scan of the store (covers ones added since). Unloaded keys come back as `{ key }`.
 */
export function dependentsOf(state: State, ticket: Ticket): { key: string; ticket?: Ticket }[] {
  const out = new Map<string, { key: string; ticket?: Ticket }>();
  for (const t of Object.values(state.tickets)) {
    if (t.dependsOn.some((k) => k.toUpperCase() === ticket.key.toUpperCase())) out.set(t.key.toUpperCase(), { key: t.key, ticket: t });
  }
  for (const k of state.dependents[ticket.id] ?? []) {
    const t = ticketByKey(state, k);
    if (t && !t.dependsOn.some((d) => d.toUpperCase() === ticket.key.toUpperCase())) continue; // no longer depends on it
    const key = (t?.key ?? k).toUpperCase();
    if (!out.has(key)) out.set(key, { key: t?.key ?? k, ticket: t });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** The session's newest Activity entry, or with `kinds` the newest of those kinds. */
export function latestActivity(state: State, sessionId: string, kinds?: readonly ActivityEntry["kind"][]): ActivityEntry | undefined {
  const list = state.activity[sessionId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (!kinds || kinds.includes(list[i]!.kind)) return list[i];
  return undefined;
}

/**
 * The body of a ticket's spec revision when it's known: the current one from the ticket itself,
 * an earlier one once fetched ("specRevision"). Undefined means fetch it.
 */
export function specBody(state: State, ticketId: string, rev: number): string | undefined {
  const t = state.tickets[ticketId];
  if (t && (t.specRevision ?? 1) === rev) return t.spec;
  return state.specBodies[specBodyKey(ticketId, rev)];
}

/** Concatenated in-flight text for a session (normally one run at a time). */
export function liveDelta(state: State, sessionId: string): { runId: string; text: string }[] {
  const d = state.deltas[sessionId];
  return d ? Object.entries(d).map(([runId, text]) => ({ runId, text })) : [];
}

export function isReady(t: Ticket): boolean {
  return t.status === "review" && reviewPassed(t.agentReview) && t.humanReview === "approved";
}

export function sortedProjects(state: State): Project[] {
  return Object.values(state.projects).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which project the composer should target: the current choice if it still exists, else the
 * first candidate (route project, last used) that exists, else the first project by name.
 * A <select> renders its first option even when its value matches nothing, so the composer must
 * never hold an id that isn't a real project — that left "Start session" silently disabled.
 */
export function composerProject(state: State, current: string, candidates: (string | null)[]): string {
  if (current && state.projects[current]) return current;
  return candidates.find((id): id is string => !!id && !!state.projects[id]) ?? sortedProjects(state)[0]?.id ?? "";
}

/**
 * Position for a ticket dropped at `index` in a column (`column` in display order, without the
 * dragged ticket). Positions are REALs server-side, so we take the midpoint of the neighbours.
 */
export function positionForDrop(column: Pick<Ticket, "position">[], index: number): number {
  const i = Math.max(0, Math.min(index, column.length));
  const before = column[i - 1]?.position;
  const after = column[i]?.position;
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  // Equal neighbours (legacy data) can't be split; nudge just above the earlier one.
  return after > before ? (before + after) / 2 : before + 1e-6;
}
