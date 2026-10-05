// Paged Done columns and server-side board search: pure state + selectors shared by the desktop
// and iOS apps. The reducer (reducer.ts) delegates here; the I/O (which request to send when)
// lives in each app's store. See "How a client drives this" at the bottom.
//
// Model
// - The snapshot loads every non-done ticket, plus the first page of done for the current board
//   scope. Other done tickets arrive by paging, search, ticket details (children, deps) and live
//   events, so `state.tickets` holds an arbitrary subset of done.
// - Paging is per scope (a project id, groupScope(name) for a project group's board, or ALL_SCOPE
//   for "All projects"). The Done column shows a contiguous prefix of the server's ordering
//   (completedAt desc): done tickets at or after the scope's `frontier` (the oldest completedAt
//   paged in so far). Older done tickets that happen to be loaded (a dependency, a search hit)
//   stay out of the column until paging reaches them, so "Load more" never reshuffles what's
//   already on screen.
// - `total` is the server's count, kept current by live ticket.upserted / ticket.deleted events.
//   A project joining or leaving a group changes which tickets that group's board counts, so the
//   reducer drops the paging of both groups and the board pages them afresh.

import type { Ticket, TicketPage, TicketStatus } from "../index";
import type { State } from "./reducer";

export const DONE_PAGE_SIZE = 50;
export const SEARCH_PAGE_SIZE = 50;
/** Search requests wait this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 200;

/** Paging scope key for "All projects". */
export const ALL_SCOPE = "*";
const GROUP_PREFIX = "group:";
/** The scope of a project group's board (projectGroups.ts). Project ids never contain a colon. */
export const groupScope = (group: string): string => GROUP_PREFIX + group;
/** The group a scope is the board of, or null for All projects and project scopes. */
export const scopeGroup = (scope: string): string | null => (scope.startsWith(GROUP_PREFIX) ? scope.slice(GROUP_PREFIX.length) : null);
/**
 * A board's scope. Selectors that take a board (`board: string | null`) take a project id, a
 * scope (ALL_SCOPE, groupScope(name)) or null for All projects, so this is the identity on scopes.
 */
export const scopeOf = (board: string | null | undefined): string => board || ALL_SCOPE;
/** The projectId to send for a scope (undefined = all projects, or a group: see scopeQuery). */
export const scopeProject = (scope: string): string | undefined => (scope === ALL_SCOPE || scopeGroup(scope) !== null ? undefined : scope);
/** The ticket page and search filter for a scope: one project, one group's projects, or none. */
export function scopeQuery(scope: string): { projectId?: string; group?: string } {
  const group = scopeGroup(scope);
  if (group !== null) return { group };
  return scope === ALL_SCOPE ? {} : { projectId: scope };
}
/** Whether a ticket shows on a scope's board: every ticket on All projects, its group's, or its project's. */
export function inScope(state: Pick<State, "projects">, t: Ticket, scope: string): boolean {
  if (scope === ALL_SCOPE) return true;
  const group = scopeGroup(scope);
  if (group !== null) return state.projects[t.projectId]?.group === group;
  return t.projectId === scope;
}

/** Every status the snapshot lists in full (all but done). */
export const LIVE_STATUSES: TicketStatus[] = ["planning", "in_progress", "blocked", "review"];

/** When the ticket entered done; falls back to updatedAt for payloads without completedAt. */
export function completedAtOf(t: Ticket): number {
  return t.completedAt ?? t.updatedAt;
}

export interface DonePaging {
  /** Server count of done tickets in this scope, adjusted by live events since */
  total: number;
  /** Cursor for the next page; null once every done ticket in the scope is loaded */
  nextCursor: string | null;
  /** A page request is in flight */
  loading: boolean;
  /** completedAt of the oldest paged-in ticket; null = no lower bound (everything is loaded) */
  frontier: number | null;
  /**
   * completedAt of the newest ticket in the first page (null when the scope had none). A done
   * ticket we haven't seen, completed after this, was finished after the count was taken.
   */
  newest: number | null;
  error: string | null;
}

export interface SearchState {
  /** The trimmed query */
  q: string;
  scope: string;
  /** Matching ticket ids in server order; null until the first page for this q/scope lands */
  ids: string[] | null;
  nextCursor: string | null;
  total: number;
  loading: boolean;
  error: string | null;
}

export type PagingAction =
  /** A done page request for `scope` went out (first page when `cursor` is null) */
  | { type: "donePage.request"; scope: string }
  /** `cursor` is the cursor the page was requested with (null for a first page). An appended page
   *  only applies while it still matches the scope's nextCursor, so a "Load more" that was in flight
   *  when a refresh re-seeded the scope can't splice a stale page (and cursor) into the new run. */
  | { type: "donePage"; scope: string; page: TicketPage; append: boolean; cursor?: string | null }
  | { type: "donePage.error"; scope: string; error: string }
  /** The board's filter box changed ("" clears the search) */
  | { type: "search.set"; q: string; scope: string }
  /** A search request went out for the current q/scope (first page or more) */
  | { type: "search.request"; q: string; scope: string }
  | { type: "search.results"; q: string; scope: string; page: TicketPage; append: boolean }
  | { type: "search.error"; q: string; scope: string; error: string };

// ---------------------------------------------------------------------------
// Reducer pieces
// ---------------------------------------------------------------------------

/**
 * Merge fetched tickets into the map. A live event may have delivered a strictly newer version
 * while the request was in flight; that one wins.
 */
export function mergeTickets(existing: Record<string, Ticket>, incoming: Ticket[]): Record<string, Ticket> {
  if (incoming.length === 0) return existing;
  const next = { ...existing };
  for (const t of incoming) {
    const cur = next[t.id];
    if (!cur || cur.updatedAt <= t.updatedAt) next[t.id] = t;
  }
  return next;
}

/** Paging state after a done page arrives (append = a "Load more" page). */
export function pagingFromPage(page: TicketPage, prev: DonePaging | undefined, append: boolean): DonePaging {
  const times = page.tickets.map(completedAtOf);
  const oldest = times.length ? Math.min(...times) : null;
  const newestInPage = times.length ? Math.max(...times) : null;
  // Frontier only moves back: a later page's oldest ticket, or the previous one if it came back empty.
  const lower = append && prev?.frontier != null ? (oldest === null ? prev.frontier : Math.min(prev.frontier, oldest)) : oldest;
  return {
    total: page.total,
    nextCursor: page.nextCursor,
    loading: false,
    frontier: page.nextCursor === null ? null : lower,
    newest: append && prev ? prev.newest : newestInPage,
    error: null,
  };
}

export function reducePaging(state: State, action: PagingAction): State {
  switch (action.type) {
    case "donePage.request": {
      const prev = state.donePaging[action.scope];
      const next: DonePaging = prev
        ? { ...prev, loading: true, error: null }
        : { total: 0, nextCursor: null, loading: true, frontier: null, newest: null, error: null };
      return { ...state, donePaging: { ...state.donePaging, [action.scope]: next } };
    }
    case "donePage": {
      const prev = state.donePaging[action.scope];
      // A "Load more" page for a scope that was reset (reconnect snapshot) in the meantime is stale.
      if (action.append && !prev) return state;
      if (action.append && action.cursor !== undefined && prev && prev.nextCursor !== action.cursor) return state;
      return {
        ...state,
        tickets: mergeTickets(state.tickets, action.page.tickets),
        donePaging: { ...state.donePaging, [action.scope]: pagingFromPage(action.page, prev, action.append) },
      };
    }
    case "donePage.error": {
      const prev = state.donePaging[action.scope];
      if (!prev) return state;
      return { ...state, donePaging: { ...state.donePaging, [action.scope]: { ...prev, loading: false, error: action.error } } };
    }
    case "search.set": {
      const q = action.q.trim();
      if (!q) return state.search ? { ...state, search: null } : state;
      if (state.search && state.search.q === q && state.search.scope === action.scope) return state;
      return { ...state, search: { q, scope: action.scope, ids: null, nextCursor: null, total: 0, loading: true, error: null } };
    }
    case "search.request": {
      const s = state.search;
      if (!s || s.q !== action.q.trim() || s.scope !== action.scope) return state;
      return { ...state, search: { ...s, loading: true, error: null } };
    }
    case "search.results": {
      const s = state.search;
      // Out-of-order responses: only the current query's results count.
      if (!s || s.q !== action.q.trim() || s.scope !== action.scope) return state;
      if (action.append && s.ids === null) return state;
      const fresh = action.page.tickets.map((t) => t.id);
      const ids = action.append ? [...s.ids!, ...fresh.filter((id) => !s.ids!.includes(id))] : fresh;
      return {
        ...state,
        tickets: mergeTickets(state.tickets, action.page.tickets),
        search: { ...s, ids, nextCursor: action.page.nextCursor, total: action.page.total, loading: false, error: null },
      };
    }
    case "search.error": {
      const s = state.search;
      if (!s || s.q !== action.q.trim() || s.scope !== action.scope) return state;
      return { ...state, search: { ...s, loading: false, error: action.error } };
    }
  }
}

/**
 * Keep done totals right across a live upsert (`next`) or delete (`next` = null) of a ticket
 * that was `prev` in the store (undefined = not loaded).
 *
 * Unloaded tickets are the ambiguous case, resolved from what the snapshot guarantees (every
 * non-done ticket is loaded):
 * - unloaded and now done: already counted iff it was completed before the first page's newest
 *   ticket (else it finished after the count and adds one);
 * - unloaded and now not done: it existed at snapshot time (created no later than the newest
 *   ticket the snapshot saw) so it must have been an unloaded done ticket that was reopened;
 *   created later, it's brand new and was never counted.
 */
export function adjustDoneTotals(state: State, prev: Ticket | undefined, next: Ticket | null): State["donePaging"] {
  const scopes = Object.keys(state.donePaging);
  if (scopes.length === 0) return state.donePaging;
  const subject = next ?? prev;
  if (!subject) return state.donePaging;
  let out: State["donePaging"] | null = null;
  for (const scope of scopes) {
    if (!inScope(state, subject, scope)) continue;
    const p = state.donePaging[scope]!;
    let delta = 0;
    const isDone = next?.status === "done";
    if (prev) {
      const wasDone = prev.status === "done";
      if (wasDone && !isDone) delta = -1;
      else if (!wasDone && isDone) delta = 1;
    } else if (next) {
      if (isDone) delta = p.newest === null || completedAtOf(next) > p.newest ? 1 : 0;
      else if (state.ticketsAsOf !== null && next.createdAt <= state.ticketsAsOf) delta = -1;
    }
    if (delta === 0) continue;
    out ??= { ...state.donePaging };
    out[scope] = { ...p, total: Math.max(0, p.total + delta) };
  }
  return out ?? state.donePaging;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * The Done column for a scope: loaded done tickets in the paged-in prefix, newest completed
 * first. Without paging state (an older service, or before the first page) every loaded done
 * ticket in scope shows.
 */
export function doneColumn(state: State, board: string | null): Ticket[] {
  const scope = scopeOf(board);
  const frontier = state.donePaging[scope]?.frontier ?? null;
  return Object.values(state.tickets)
    .filter((t) => t.status === "done" && inScope(state, t, scope) && (frontier === null || completedAtOf(t) >= frontier))
    .sort((a, b) => completedAtOf(b) - completedAtOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Done count for the column header: the server's total when paging, else what's loaded. */
export function doneCount(state: State, board: string | null, loaded: number): number {
  return state.donePaging[scopeOf(board)]?.total ?? loaded;
}

/** Whether the Done column has more to load (and isn't already loading it). */
export function canLoadMoreDone(state: State, board: string | null): boolean {
  const p = state.donePaging[scopeOf(board)];
  return !!p && p.nextCursor !== null && !p.loading;
}

/** True when the scope needs its first done page (never requested, or reset by a snapshot). */
export function needsFirstDonePage(state: State, board: string | null): boolean {
  return state.ready && !state.donePaging[scopeOf(board)];
}

/** Instant local match while the server search is in flight: key (current or old), remote ID or title. */
export function matchesQuery(t: Ticket, q: string, aliases: Record<string, string> = {}): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (t.key.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle)) return true;
  if (t.externalRef?.key.toLowerCase().includes(needle)) return true;
  for (const [alias, id] of Object.entries(aliases)) if (id === t.id && alias.toLowerCase().includes(needle)) return true;
  return false;
}

export type Columns = Record<TicketStatus, Ticket[]>;
const emptyColumns = (): Columns => ({ planning: [], in_progress: [], blocked: [], review: [], done: [] });
function sortColumns(cols: Columns): Columns {
  for (const [status, list] of Object.entries(cols) as [TicketStatus, Ticket[]][]) {
    if (status === "done") list.sort((a, b) => completedAtOf(b) - completedAtOf(a));
    else list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }
  return cols;
}

/**
 * Board columns while a search is active. Server results once they land (each result in the
 * column of its current status, so live moves still apply); until then, the loaded tickets that
 * match locally. Search shows every match, child tickets included: the user is looking for
 * something specific, and hiding a match would read as "not found".
 */
export function searchColumns(state: State, board: string | null): { columns: Columns; pending: boolean } {
  const s = state.search;
  const cols = emptyColumns();
  if (!s) return { columns: cols, pending: false };
  if (s.ids === null) {
    const scope = scopeOf(board);
    for (const t of Object.values(state.tickets)) if (inScope(state, t, scope) && matchesQuery(t, s.q, state.keyAliases)) cols[t.status].push(t);
    return { columns: sortColumns(cols), pending: true };
  }
  for (const id of s.ids) {
    const t = state.tickets[id];
    if (t) cols[t.status].push(t);
  }
  return { columns: sortColumns(cols), pending: false };
}

/** "Searching…", "No matches", "12 matches", "Showing 50 of 132 matches". */
export function searchStatusText(s: SearchState): string {
  if (s.error) return `Search failed: ${s.error}`;
  if (s.ids === null) return "Searching…";
  if (s.total === 0) return "No matches";
  if (s.ids.length < s.total) return `Showing ${s.ids.length} of ${s.total} matches`;
  return `${s.total} match${s.total === 1 ? "" : "es"}`;
}

export const canLoadMoreSearch = (s: SearchState | null): boolean => !!s && s.ids !== null && s.nextCursor !== null && !s.loading;

// ---------------------------------------------------------------------------
// How a client drives this (desktop: app/src/renderer/state/store.tsx)
// ---------------------------------------------------------------------------
//
// Snapshot / reconnect:
//   listTickets(undefined, { status: LIVE_STATUSES }) + ticketPage({ status: "done",
//   ...scopeQuery(scope), limit: DONE_PAGE_SIZE }) → dispatch({ type: "snapshot", snapshot: {
//   ..., tickets, donePage: { scope, page } } }). The snapshot drops every other scope's paging
//   and re-arms an active search (ids → null) so the client re-runs it.
// Scope change: if needsFirstDonePage(state, board): "donePage.request" then the page with
//   append: false.
// Load more (button or an IntersectionObserver near the column's end): if canLoadMoreDone,
//   "donePage.request" then ticketPage({ cursor: nextCursor }) with append: true.
// Search: on every keystroke "search.set" (instant local matches); after SEARCH_DEBOUNCE_MS
//   "search.request" + searchTickets({ q, ...scopeQuery(scope), limit: SEARCH_PAGE_SIZE }) → "search.results"
//   (stale responses are ignored). More: canLoadMoreSearch → searchTickets({ cursor }) with
//   append: true. An empty query clears it.
