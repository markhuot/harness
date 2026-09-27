// The iPhone board's I/O for paged Done columns and server-side search. The state and selectors
// are shared with the desktop (@harness/shared/state paging.ts); this decides WHEN to ask the
// service for what, and drops answers that arrive too late. Pure (client, dispatch, state getter
// and timers are injected) so bun can test it.
//
// Two phone-specific problems it exists for:
// - FlatList fires onEndReached repeatedly (every scroll event near the end, again after the
//   data changes, and before React has re-rendered the "loading" state), so the gate remembers
//   which page it already asked for instead of trusting the state it was handed.
// - Every refetch (pull to refresh, reconnect, back from the background) starts paging over. A
//   page or search result requested before it must not be merged after it: it would carry the
//   old cursor into the new paging run, or older data over newer. A generation counter per
//   snapshot and per query rules those out.

import type { TicketPage } from "@harness/shared";
import {
  canLoadMoreDone,
  canLoadMoreSearch,
  DONE_PAGE_SIZE,
  needsFirstDonePage,
  scopeOf,
  scopeProject,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PAGE_SIZE,
  type Action,
  type State,
} from "@harness/shared/state";

/** Below this many visible Done cards (child tickets hidden) the column loads another page itself. */
export const AUTOFILL_MIN = 12;

export interface LoaderClient {
  ticketPage(opts: { status: "done"; projectId?: string; limit?: number; cursor?: string | null }): Promise<TicketPage>;
  searchTickets(opts: { q: string; projectId?: string; limit?: number; cursor?: string | null }): Promise<TicketPage>;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface BoardLoaderDeps {
  client: LoaderClient;
  dispatch: (a: Action) => void;
  /** The latest state the app has rendered (may lag the dispatches just made) */
  getState: () => State;
  describe?: (e: unknown) => string;
  timers?: Timers;
  debounceMs?: number;
}

/**
 * Hidden child tickets can leave a loaded Done page nearly empty, and FlatList only fires
 * onEndReached once there's something to scroll, so a short column asks for the next page itself.
 */
export const shouldAutoFill = (visibleCount: number, canLoad: boolean, min = AUTOFILL_MIN) => canLoad && visibleCount < min;

export class BoardLoader {
  private gen = 0;
  /** `${gen}|${scope}|${cursor}` of pages asked for in this generation (failed ones are removed) */
  private asked = new Set<string>();
  private searchGen = 0;
  private searchAsked = new Set<string>();
  private timer: unknown = null;
  private query = { q: "", scope: "" };
  /** The service predates paging (GET /tickets/page 404s): the snapshot carried every done ticket */
  legacy = false;

  constructor(private deps: BoardLoaderDeps) {}

  private get timers() {
    return this.deps.timers ?? realTimers;
  }
  private describe(e: unknown) {
    return this.deps.describe?.(e) ?? (e instanceof Error ? e.message : String(e));
  }

  /** A snapshot was just dispatched: everything in flight belongs to the old paging run. */
  snapshotApplied() {
    this.gen++;
    this.asked.clear();
    this.searchGen++;
    this.searchAsked.clear();
    if (this.query.q) void this.runSearch(this.searchGen, null);
  }

  /** The board shows `projectId`: fetch its first Done page unless it has one. */
  async ensureFirstPage(projectId: string | null): Promise<void> {
    if (this.legacy || !needsFirstDonePage(this.deps.getState(), projectId)) return;
    await this.fetchDone(projectId, null);
  }

  /** Is there a next Done page this gate would ask for right now? (drives the footer spinner / autofill) */
  canLoadMoreDone(projectId: string | null): boolean {
    const state = this.deps.getState();
    const p = state.donePaging[scopeOf(projectId)];
    // After a failure the column waits for Retry: a failing service would otherwise be hit by every scroll event.
    return !this.legacy && !!p && !p.error && canLoadMoreDone(state, projectId) && !this.asked.has(this.key(projectId, p.nextCursor));
  }

  /** The Done list scrolled near its end (or is too short to scroll). */
  async loadMoreDone(projectId: string | null): Promise<void> {
    if (!this.canLoadMoreDone(projectId)) return;
    await this.fetchDone(projectId, this.deps.getState().donePaging[scopeOf(projectId)]!.nextCursor);
  }

  /** Footer "Retry" after a failed page. */
  async retryDone(projectId: string | null): Promise<void> {
    const p = this.deps.getState().donePaging[scopeOf(projectId)];
    if (!p?.error || this.legacy) return;
    await this.fetchDone(projectId, p.nextCursor ?? null);
  }

  private key(projectId: string | null, cursor: string | null) {
    return `${this.gen}|${scopeOf(projectId)}|${cursor ?? ""}`;
  }

  private async fetchDone(projectId: string | null, cursor: string | null) {
    const key = this.key(projectId, cursor);
    if (this.asked.has(key)) return;
    this.asked.add(key);
    const gen = this.gen;
    const scope = scopeOf(projectId);
    this.deps.dispatch({ type: "donePage.request", scope });
    try {
      const page = await this.deps.client.ticketPage({ status: "done", projectId: scopeProject(scope), limit: DONE_PAGE_SIZE, cursor });
      if (gen !== this.gen) return;
      this.deps.dispatch({ type: "donePage", scope, page, append: cursor !== null });
    } catch (e) {
      if (gen !== this.gen) return;
      this.asked.delete(key);
      this.deps.dispatch({ type: "donePage.error", scope, error: this.describe(e) });
    }
  }

  // ------------------------------------------------------------------ search

  /**
   * Every keystroke in the search bar (and project switches while searching). The reducer shows
   * local matches at once; the server is asked after a pause, and only the newest ask may land.
   */
  setQuery(raw: string, projectId: string | null) {
    const q = raw.trim();
    const scope = scopeOf(projectId);
    if (q === this.query.q && scope === this.query.scope) return;
    this.query = { q, scope };
    this.searchGen++;
    this.searchAsked.clear();
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.deps.dispatch({ type: "search.set", q, scope });
    if (!q) return;
    const gen = this.searchGen;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.runSearch(gen, null);
    }, this.deps.debounceMs ?? SEARCH_DEBOUNCE_MS);
  }

  canLoadMoreSearch(): boolean {
    const s = this.deps.getState().search;
    return !!s && !s.error && canLoadMoreSearch(s) && s.q === this.query.q && !this.searchAsked.has(s.nextCursor ?? "");
  }

  /** Any column of the search results scrolled near its end: the next page of matches. */
  async loadMoreSearch(): Promise<void> {
    if (!this.canLoadMoreSearch()) return;
    await this.runSearch(this.searchGen, this.deps.getState().search!.nextCursor);
  }

  /** Footer "Retry" after a failed search request. */
  async retrySearch(): Promise<void> {
    const s = this.deps.getState().search;
    if (!s?.error || s.q !== this.query.q) return;
    await this.runSearch(this.searchGen, s.ids === null ? null : s.nextCursor);
  }

  private async runSearch(gen: number, cursor: string | null) {
    if (gen !== this.searchGen) return;
    const { q, scope } = this.query;
    if (!q) return;
    const askedKey = cursor ?? "";
    if (cursor !== null && this.searchAsked.has(askedKey)) return;
    this.searchAsked.add(askedKey);
    this.deps.dispatch({ type: "search.request", q, scope });
    try {
      const page = await this.deps.client.searchTickets({ q, projectId: scopeProject(scope), limit: SEARCH_PAGE_SIZE, cursor });
      if (gen !== this.searchGen) return;
      this.deps.dispatch({ type: "search.results", q, scope, page, append: cursor !== null });
    } catch (e) {
      if (gen !== this.searchGen) return;
      this.searchAsked.delete(askedKey);
      this.deps.dispatch({ type: "search.error", q, scope, error: this.describe(e) });
    }
  }

  /** The store is going away: nothing in flight may land. */
  dispose() {
    this.gen++;
    this.searchGen++;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
