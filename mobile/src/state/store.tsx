// Connection → HarnessClient + HarnessSocket → the shared reducer, like the desktop store
// (app/src/renderer/state/store.tsx): a full snapshot on connect and on every reconnect (views
// refetch what they own when `epoch` bumps), raw event fan-out for the Browser tab, and toasts.
// Phone-specific: iOS suspends the socket in the background, so returning to the foreground
// rebuilds it and refetches; a 401 (token rotated on the Mac) is surfaced for re-pairing.
// Paging: the snapshot is every non-done ticket plus the first Done page for the board's project
// filter; BoardLoader pages Done and runs the board search, DetailFetcher fills in the tickets
// the UI references that aren't loaded (older done dependencies, conductors' done children).

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { HarnessApiError, HarnessClient, type HarnessEvent, type HarnessSocket, type TicketDetail, type TicketPage } from "@harness/shared";
import { DONE_PAGE_SIZE, initialState, LIVE_STATUSES, reducer, scopeOf, scopeProject, type Action, type State } from "@harness/shared/state";
import { describeError, isUnauthorized } from "../lib/connection";
import { BoardLoader } from "../lib/boardLoader";
import { DetailFetcher } from "../lib/details";
import { useApp } from "./app";
import { haptic } from "../ui/haptics";

type EventListener = (e: HarnessEvent) => void;
export type ToastKind = "error" | "info";

export interface Store {
  state: State;
  dispatch: (a: Action) => void;
  client: HarnessClient;
  socket: HarnessSocket;
  onEvent: (fn: EventListener) => () => void;
  /** Bumped on every reconnect so views can refetch what they own. */
  epoch: number;
  refresh: () => Promise<void>;
  /** Set when the service rejects the token; the UI offers re-pairing. */
  authError: string | null;
  /** Last snapshot failure (host unreachable etc.), cleared by the next success. */
  loadError: string | null;
  toast: (message: string, kind?: ToastKind) => void;
  baseUrl: string;
  /** Done paging + board search requests (state lives in state.donePaging / state.search) */
  loader: BoardLoader;
  /** The board's project filter changed: snapshots page Done for it; fetches its first page. */
  setBoardScope: (projectId: string | null) => void;
  /** A ticket's detail merged into the store (shared with the background fetches for that key). */
  loadDetail: (key: string) => Promise<TicketDetail>;
  /** Keep this key resolved while mounted (a screen showing a ticket that may not be loaded). */
  watchKey: (key: string) => () => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

export const useMaybeStore = () => useContext(Ctx);

/** A service from before paging answers 404 here (and ignores ?status=, sending every ticket). */
const legacyPage = (e: unknown) => (e instanceof HarnessApiError && e.status === 404 ? null : Promise.reject(e));

async function loadSnapshot(client: HarnessClient, scope: string) {
  const [projects, tickets, donePage, sessions, watchers, settings, drivers] = await Promise.all([
    client.listProjects(),
    client.listTickets(undefined, { status: LIVE_STATUSES }),
    client.ticketPage({ status: "done", projectId: scopeProject(scope), limit: DONE_PAGE_SIZE }).catch(legacyPage) as Promise<TicketPage | null>,
    client.listSessions(),
    client.listWatchers().catch(() => []),
    client.getSettings().catch(() => null),
    client.listDrivers().catch(() => []),
  ]);
  return { projects, tickets, sessions, watchers, settings, drivers, ...(donePage ? { donePage: { scope, page: donePage } } : {}) };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!).catch(() => {});
    }),
  );
}

export function StoreProvider({ baseUrl, token, toast, children }: { baseUrl: string; token: string; toast: Store["toast"]; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [epoch, setEpoch] = useState(0);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socketNonce, setSocketNonce] = useState(0);
  const listeners = useRef(new Set<EventListener>());
  const client = useMemo(() => new HarnessClient({ baseUrl, token }), [baseUrl, token]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const { prefs } = useApp();
  const scopeRef = useRef(scopeOf(prefs.boardProject));
  const loader = useMemo(() => new BoardLoader({ client, dispatch, getState: () => stateRef.current, describe: (e) => describeError(e, baseUrl) }), [client, baseUrl]);
  const details = useMemo(() => new DetailFetcher({ client, dispatch }), [client]);
  useEffect(() => () => loader.dispose(), [loader]);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await loadSnapshot(client, scopeRef.current);
      dispatch({ type: "snapshot", snapshot });
      loader.legacy = !snapshot.donePage;
      loader.snapshotApplied();
      details.reset();
      setAuthError(null);
      setLoadError(null);
      const done = (snapshot.donePage?.page.tickets ?? snapshot.tickets.filter((t) => t.status === "done").sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))).slice(0, 12);
      const wanted = [...snapshot.tickets.filter((t) => t.status !== "done"), ...done];
      void pool(wanted, 6, async (t) => {
        const summaries = await client.listSummaries(t.key);
        dispatch({ type: "summaries", sessionId: t.sessionId, summaries });
      });
    } catch (e) {
      if (isUnauthorized(e)) setAuthError(describeError(e));
      else setLoadError(describeError(e, baseUrl));
    }
  }, [client, baseUrl, loader, details]);

  const setBoardScope = useCallback(
    (projectId: string | null) => {
      scopeRef.current = scopeOf(projectId);
      void loader.ensureFirstPage(projectId);
    },
    [loader],
  );

  // Fill in what the UI references but the snapshot didn't carry (see DetailFetcher).
  const [watched, setWatched] = useState<Record<string, number>>({});
  const watchKey = useCallback((key: string) => {
    setWatched((w) => ({ ...w, [key]: (w[key] ?? 0) + 1 }));
    return () =>
      setWatched((w) => {
        const next = { ...w };
        if ((next[key] ?? 0) <= 1) delete next[key];
        else next[key]!--;
        return next;
      });
  }, []);
  useEffect(() => {
    details.sync(state, Object.keys(watched));
  }, [details, state.ready, state.tickets, state.dependents, state.sessions, state.keyAliases, state.missingKeys, state.childrenLoaded, watched]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadDetail = useCallback((key: string) => details.load(key), [details]);

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
          void refresh();
          if (!first) setEpoch((n) => n + 1);
          first = false;
        }
      },
    });
    // socketNonce: foregrounding rebuilds the socket
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refresh, socketNonce]);

  useEffect(() => () => socket.close(), [socket]);

  // REST can work while the socket can't (or before it connects): show what we can.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!stateRef.current.ready) void refresh();
    }, 1500);
    return () => clearTimeout(t);
  }, [refresh]);

  // Back from the background: the OS dropped the socket (or it's mid-backoff). Rebuild it now.
  useEffect(() => {
    let backgroundedAt = 0;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background") backgroundedAt = Date.now();
      if (s === "active" && backgroundedAt) {
        backgroundedAt = 0;
        if (!stateRef.current.connected) setSocketNonce((n) => n + 1);
        else void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh]);

  // While disconnected, poll the snapshot slowly so a 401 (rotated token) is noticed: the
  // socket just keeps reconnecting and never says why.
  useEffect(() => {
    if (state.connected) return;
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [state.connected, refresh]);

  const onEvent = useCallback((fn: EventListener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const value = useMemo<Store>(
    () => ({ state, dispatch, client, socket, onEvent, epoch, refresh, authError, loadError, toast, baseUrl, loader, setBoardScope, loadDetail, watchKey }),
    [state, client, socket, onEvent, epoch, refresh, authError, loadError, toast, baseUrl, loader, setBoardScope, loadDetail, watchKey],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Wrap a mutation: errors become a toast (and an error haptic); returns undefined on failure. */
export function useAction() {
  const { toast, baseUrl } = useStore();
  return useCallback(
    async <T,>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> => {
      try {
        const out = await fn();
        if (okMessage) toast(okMessage, "info");
        return out;
      } catch (e) {
        haptic("error");
        toast(describeError(e, baseUrl), "error");
        return undefined;
      }
    },
    [toast, baseUrl],
  );
}
