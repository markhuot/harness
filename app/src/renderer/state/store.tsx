// React wiring for the store: connection → HarnessClient + HarnessSocket → reducer.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { HarnessClient, type HarnessEvent, type HarnessSocket } from "@harness/shared";
import {
  canLoadMoreDone,
  canLoadMoreSearch,
  conductorsNeedingChildren,
  DONE_PAGE_SIZE,
  initialState,
  LIVE_STATUSES,
  needsFirstDonePage,
  reducer,
  scopeOf,
  scopeProject,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PAGE_SIZE,
  unresolvedKeys,
  type Action,
  type Snapshot,
  type State,
} from "@harness/shared/state";
import { formatRoute, mirrorRoute, parseRoute, type Route } from "./route";
import { focusedTicket, getPanes, openTicket, updatePanes, usePanes } from "./panes";
import type { HarnessBridge } from "../../main/types";

declare global {
  interface Window {
    harness?: HarnessBridge;
  }
}

type EventListener = (e: HarnessEvent) => void;

export interface Store {
  state: State;
  dispatch: (a: Action) => void;
  client: HarnessClient;
  socket: HarnessSocket;
  /** Subscribe to raw events (browser frames etc. that don't go through the reducer). */
  onEvent: (fn: EventListener) => () => void;
  /** Bumped on every (re)connect so views can refetch what they own. */
  epoch: number;
  route: Route;
  navigate: (r: Route) => void;
  refresh: () => Promise<void>;
  toast: (message: string, kind?: "error" | "info") => void;
  /** After POST /token/rotate: switch to the new token (the client and socket are rebuilt). */
  reconnect: (rotatedToken: string) => Promise<void>;
  /** The board's project scope (null = all projects), validated against loaded projects */
  boardProjectId: string | null;
  /** Next page of the Done column for the current board scope (no-op while one is in flight) */
  loadMoreDone: () => void;
  /** Board filter box: instant local matches, then a debounced server search ("" clears) */
  setSearch: (q: string) => void;
  /** Next page of search results */
  loadMoreSearch: () => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

/** Arriving at a board link to a ticket opens it in a pane (or focuses the pane it's already in). */
function openFromRoute(r: Route) {
  if (r.view === "board" && r.ticketKey) updatePanes((s) => openTicket(s, r.ticketKey!, r.tab));
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  // The route the app launched with opens its ticket once mounted (not during render: that would
  // update the pane store mid-render). Later hash changes open theirs as they arrive.
  const initial = useRef(route);
  useEffect(() => openFromRoute(initial.current), []);
  useEffect(() => {
    const on = () => {
      const r = parseRoute(location.hash);
      openFromRoute(r);
      setRoute(r);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // On the board the hash mirrors the focused ticket pane. replaceState adds no history entry and
  // fires no hashchange, and opening the focused ticket again is a no-op, so the two never fight.
  const focused = focusedTicket(usePanes());
  const mirror = route.view === "board" ? formatRoute(mirrorRoute(route, focused)) : null;
  useEffect(() => {
    if (!mirror || location.hash === mirror) return;
    // The panes changed after this render (the initial open above runs in the same commit): the
    // re-render that's coming mirrors them, so don't drop the ticket from the hash in between.
    if (formatRoute(mirrorRoute(route, focusedTicket(getPanes()))) !== mirror) return;
    history.replaceState(history.state, "", mirror);
    setRoute(parseRoute(mirror));
  }, [mirror]);
  const navigate = useCallback((r: Route) => {
    const h = formatRoute(r);
    if (location.hash !== h) location.hash = h;
  }, []);
  return [route, navigate] as const;
}

/**
 * Every non-done ticket plus the first Done page for the board's scope. A service without
 * paging (404 on /tickets/page) gets the old full list and no paging state.
 */
async function loadSnapshot(client: HarnessClient, scope: string): Promise<Snapshot> {
  const [projects, board, sessions, watchers, settings, drivers] = await Promise.all([
    client.listProjects(),
    Promise.all([
      client.listTickets(undefined, { status: LIVE_STATUSES }),
      client.ticketPage({ status: "done", projectId: scopeProject(scope), limit: DONE_PAGE_SIZE }),
    ]).then(
      ([tickets, page]) => ({ tickets, donePage: { scope, page } }),
      async () => ({ tickets: await client.listTickets(), donePage: undefined }),
    ),
    client.listSessions(),
    client.listWatchers().catch(() => []),
    client.getSettings().catch(() => null),
    client.listDrivers().catch(() => []),
  ]);
  return { projects, ...board, sessions, watchers, settings, drivers };
}

/** The board's project filter, once it names a project that exists (else all projects). */
export function boardProjectOf(state: State, route: Route): string | null {
  return route.view === "board" && route.projectId && state.projects[route.projectId] ? route.projectId : null;
}

/** Run async jobs with bounded concurrency. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!).catch(() => {});
  }));
}

export function StoreProvider({
  baseUrl,
  token,
  children,
  toast,
  onTokenRotated,
}: {
  baseUrl: string;
  token: string;
  children: ReactNode;
  toast: Store["toast"];
  /** Resolves once the connection carries the new token (Root re-reads the token file in Electron). */
  onTokenRotated?: (rotatedToken: string) => Promise<void>;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [epoch, setEpoch] = useState(0);
  const [route, navigate] = useRoute();
  const listeners = useRef(new Set<EventListener>());
  const client = useMemo(() => new HarnessClient({ baseUrl, token }), [baseUrl, token]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const boardProjectId = boardProjectOf(state, route);
  const boardRef = useRef(boardProjectId);
  boardRef.current = boardProjectId;
  // Which Done scope a snapshot pages: the board's (the last one seen while elsewhere). Before
  // projects load the route's project can't be validated yet, so trust it.
  const scopeRef = useRef(scopeOf(route.view === "board" ? route.projectId : null));
  if (route.view === "board") scopeRef.current = state.ready ? scopeOf(boardProjectId) : scopeOf(route.projectId);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await loadSnapshot(client, scopeRef.current);
      dispatch({ type: "snapshot", snapshot });
      // Board cards show the latest summary; backfill for tickets that are still moving
      // (and the most recent done ones). Live summary.added events keep them fresh after.
      const done = snapshot.donePage?.page.tickets.slice(0, 12) ?? snapshot.tickets.filter((t) => t.status === "done").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
      const wanted = [...snapshot.tickets.filter((t) => t.status !== "done"), ...done];
      void pool(wanted, 6, async (t) => {
        const summaries = await client.listSummaries(t.key);
        dispatch({ type: "summaries", sessionId: t.sessionId, summaries });
      });
    } catch (e) {
      toast(`Couldn't load from the service: ${(e as Error).message}`, "error");
    }
  }, [client, toast]);

  const socket = useMemo(() => {
    let first = true;
    return client.connect({
      onEvent: (e) => {
        if (e.kind !== "browser.frame" && e.kind !== "browser.state") dispatch({ type: "event", event: e });
        for (const fn of listeners.current) fn(e);
      },
      onStatus: (connected) => {
        dispatch({ type: "connected", connected });
        if (connected) {
          // Initial load and every reconnect: refetch everything we might have missed. Views
          // refetch what they own (details, transcripts) after the snapshot lands, so a detail
          // isn't overwritten by the snapshot that follows it.
          const again = !first;
          first = false;
          void refresh().then(() => again && setEpoch((n) => n + 1));
        }
      },
    });
  }, [client, refresh]);

  useEffect(() => () => socket.close(), [socket]);

  // Show whatever we can even before the socket connects (e.g. WS blocked but REST fine).
  useEffect(() => {
    const t = setTimeout(() => {
      if (!stateRef.current.ready) void refresh();
    }, 1500);
    return () => clearTimeout(t);
  }, [refresh]);

  // --- Done paging -------------------------------------------------------------------------
  const pageDone = useCallback(
    async (scope: string, append: boolean) => {
      const cursor = append ? stateRef.current.donePaging[scope]?.nextCursor : null;
      if (append && !cursor) return;
      dispatch({ type: "donePage.request", scope });
      try {
        const page = await client.ticketPage({ status: "done", projectId: scopeProject(scope), limit: DONE_PAGE_SIZE, cursor });
        dispatch({ type: "donePage", scope, page, append, cursor });
      } catch (e) {
        dispatch({ type: "donePage.error", scope, error: (e as Error).message });
      }
    },
    [client],
  );
  const loadMoreDone = useCallback(() => {
    if (stateRef.current.search) return;
    const projectId = boardRef.current;
    if (canLoadMoreDone(stateRef.current, projectId)) void pageDone(scopeOf(projectId), true);
  }, [pageDone]);
  // A scope we haven't paged yet (switching projects, or after a reconnect reset) gets its first page.
  const pagedOnce = !!state.donePaging[scopeOf(boardProjectId)];
  useEffect(() => {
    if (route.view !== "board" || !needsFirstDonePage(stateRef.current, boardProjectId)) return;
    // Only services with paging: the snapshot's own donePage tells us (none → the old full list).
    if (Object.keys(stateRef.current.donePaging).length === 0) return;
    void pageDone(scopeOf(boardProjectId), false);
  }, [route.view, boardProjectId, state.ready, pagedOnce, pageDone]);

  // --- Search --------------------------------------------------------------------------------
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSearch = useCallback(
    async (q: string, scope: string, append: boolean) => {
      const s = stateRef.current.search;
      const cursor = append ? s?.nextCursor : null;
      if (append && !cursor) return;
      dispatch({ type: "search.request", q, scope });
      try {
        const page = await client.searchTickets({ q, projectId: scopeProject(scope), limit: SEARCH_PAGE_SIZE, cursor });
        dispatch({ type: "search.results", q, scope, page, append });
      } catch (e) {
        dispatch({ type: "search.error", q, scope, error: (e as Error).message });
      }
    },
    [client],
  );
  const setSearch = useCallback(
    (raw: string) => {
      const q = raw.trim();
      const scope = scopeOf(boardRef.current);
      const cur = stateRef.current.search;
      if (cur && cur.q === q && cur.scope === scope && cur.ids !== null) return;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = null;
      dispatch({ type: "search.set", q, scope });
      if (!q) return;
      searchTimer.current = setTimeout(() => {
        searchTimer.current = null;
        void runSearch(q, scope, false);
      }, SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );
  const loadMoreSearch = useCallback(() => {
    const s = stateRef.current.search;
    if (s && canLoadMoreSearch(s)) void runSearch(s.q, s.scope, true);
  }, [runSearch]);
  // A reconnect snapshot re-arms the search (ids → null): run it again.
  const rearmed = !!state.search && state.search.ids === null && state.ready;
  useEffect(() => {
    const s = stateRef.current.search;
    if (!rearmed || !s || searchTimer.current) return;
    void runSearch(s.q, s.scope, false);
  }, [rearmed, runSearch]);
  useEffect(() => () => void (searchTimer.current && clearTimeout(searchTimer.current)), []);

  // --- Tickets the UI names but the store doesn't have ---------------------------------------
  // Dependencies, dependents and triage outcomes that aren't loaded (usually older done tickets,
  // or old keys from before a rename) and conductors whose full child list we haven't fetched.
  const inflight = useRef(new Set<string>());
  const wantedKeys = useMemo(() => unresolvedKeys(state), [state.ready, state.tickets, state.sessions, state.dependents, state.keyAliases, state.missingKeys]);
  const partialConductors = useMemo(() => conductorsNeedingChildren(state).map((t) => t.key), [state.ready, state.tickets, state.childrenLoaded]);
  useEffect(() => {
    const todo = [...wantedKeys, ...partialConductors].filter((k) => !inflight.current.has(k));
    if (!todo.length) return;
    for (const k of todo) inflight.current.add(k);
    void pool(todo, 4, async (key) => {
      try {
        const detail = await client.getTicket(key);
        dispatch({ type: "detail", detail, requestedKey: key });
      } catch (e) {
        if ((e as { status?: number }).status === 404) dispatch({ type: "missingKeys", keys: [key] });
      } finally {
        inflight.current.delete(key);
      }
    });
  }, [wantedKeys, partialConductors, client]);
  useEffect(() => inflight.current.clear(), [epoch]);

  const onEvent = useCallback((fn: EventListener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const reconnect = useCallback(async (rotated: string) => {
    if (!onTokenRotated) throw new Error("This window can't switch tokens; reload it.");
    await onTokenRotated(rotated);
  }, [onTokenRotated]);

  const value = useMemo<Store>(
    () => ({ state, dispatch, client, socket, onEvent, epoch, route, navigate, refresh, toast, reconnect, boardProjectId, loadMoreDone, setSearch, loadMoreSearch }),
    [state, client, socket, onEvent, epoch, route, navigate, refresh, toast, reconnect, boardProjectId, loadMoreDone, setSearch, loadMoreSearch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Wrap a mutation: surfaces errors as a toast, returns undefined on failure. */
export function useAction() {
  const { toast } = useStore();
  return useCallback(
    async <T,>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> => {
      try {
        const out = await fn();
        if (okMessage) toast(okMessage, "info");
        return out;
      } catch (e) {
        toast((e as Error).message || String(e), "error");
        return undefined;
      }
    },
    [toast],
  );
}
