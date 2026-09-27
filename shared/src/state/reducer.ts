// Pure client-side store: REST snapshots + live HarnessEvents → one normalized state tree.
// No I/O here; see store.tsx for the wiring.

import type {
  DriverInfo,
  HarnessEvent,
  Mapping,
  Project,
  PublicSettings,
  Run,
  Session,
  Summary,
  Ticket,
  TicketDetail,
  TicketPage,
  TicketStatus,
  TranscriptEntry,
  Watcher,
} from "../index";
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
  /** Keyed by sessionId, sorted by createdAt, unique by id */
  summaries: Record<string, Summary[]>;
  /** Keyed by sessionId, sorted by seq, unique by id */
  transcripts: Record<string, TranscriptState>;
  /** In-flight streaming assistant text: deltas[sessionId][runId] */
  deltas: Record<string, Record<string, string>>;
  watchers: Record<string, Watcher>;
  mappings: Record<string, Mapping>;
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
  summaries: {},
  transcripts: {},
  deltas: {},
  watchers: {},
  mappings: {},
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
  mappings: Mapping[];
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
  | { type: "transcript"; sessionId: string; entries: TranscriptEntry[] }
  | { type: "summaries"; sessionId: string; summaries: Summary[] }
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
const summaryOrder = (s: Summary) => s.createdAt;

function mergeTranscript(state: State, sessionId: string, entries: TranscriptEntry[], loaded: boolean): State["transcripts"] {
  const prev = state.transcripts[sessionId] ?? { entries: [], loaded: false };
  return {
    ...state.transcripts,
    [sessionId]: { entries: mergeById(prev.entries, entries, entryOrder), loaded: prev.loaded || loaded },
  };
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
      const mappings: Record<string, Mapping> = {};
      for (const m of Object.values(state.mappings)) if (m.projectId !== event.id) mappings[m.id] = m;
      return { ...state, projects: without(state.projects, event.id), tickets, mappings };
    }
    case "ticket.upserted":
      return {
        ...state,
        tickets: { ...state.tickets, [event.ticket.id]: event.ticket },
        donePaging: adjustDoneTotals(state, state.tickets[event.ticket.id], event.ticket),
      };
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
      const transcripts = mergeTranscript(state, entry.sessionId, [entry], false);
      // The persisted assistant text block replaces the streamed preview of the same run.
      const deltas =
        entry.role === "assistant" && entry.content.type === "text"
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
    case "summary.added": {
      const s = event.summary;
      return {
        ...state,
        summaries: { ...state.summaries, [s.sessionId]: mergeById(state.summaries[s.sessionId] ?? [], [s], summaryOrder) },
      };
    }
    case "watcher.upserted":
      return { ...state, watchers: { ...state.watchers, [event.watcher.id]: event.watcher } };
    case "watcher.deleted":
      return { ...state, watchers: without(state.watchers, event.id) };
    case "mapping.upserted":
      return { ...state, mappings: { ...state.mappings, [event.mapping.id]: event.mapping } };
    case "mapping.deleted":
      return { ...state, mappings: without(state.mappings, event.id) };
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
      // A snapshot is authoritative for entity lists; transcripts/summaries are kept (they are
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
        mappings: byId(s.mappings),
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
        childrenLoaded: d.ticket.kind === "conductor" ? { ...state.childrenLoaded, [d.ticket.id]: true } : state.childrenLoaded,
        dependents: { ...state.dependents, [d.ticket.id]: d.dependents },
        runs,
        sessions: { ...state.sessions, [d.session.id]: d.session },
        summaries: {
          ...state.summaries,
          [d.session.id]: mergeById(state.summaries[d.session.id] ?? [], d.summaries, summaryOrder),
        },
      };
    }
    case "transcript":
      return { ...state, transcripts: mergeTranscript(state, action.sessionId, action.entries, true) };
    case "summaries":
      return {
        ...state,
        summaries: {
          ...state.summaries,
          [action.sessionId]: mergeById(state.summaries[action.sessionId] ?? [], action.summaries, summaryOrder),
        },
      };
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
  return Object.values(state.tickets).filter((t) => t.kind === "conductor" && !state.childrenLoaded[t.id]);
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

export function latestSummary(state: State, sessionId: string): Summary | undefined {
  const list = state.summaries[sessionId];
  return list?.[list.length - 1];
}

/** Concatenated in-flight text for a session (normally one run at a time). */
export function liveDelta(state: State, sessionId: string): { runId: string; text: string }[] {
  const d = state.deltas[sessionId];
  return d ? Object.entries(d).map(([runId, text]) => ({ runId, text })) : [];
}

export function isReady(t: Ticket): boolean {
  return t.status === "review" && t.agentReview === "approved" && t.humanReview === "approved";
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
