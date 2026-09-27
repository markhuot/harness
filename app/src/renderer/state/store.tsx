// React wiring for the store: connection → HarnessClient + HarnessSocket → reducer.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { HarnessClient, type HarnessEvent, type HarnessSocket } from "@harness/shared";
import { initialState, reducer, type Action, type State } from "@harness/shared/state";
import { formatRoute, parseRoute, type Route } from "./route";
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
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const navigate = useCallback((r: Route) => {
    const h = formatRoute(r);
    if (location.hash !== h) location.hash = h;
  }, []);
  return [route, navigate] as const;
}

async function loadSnapshot(client: HarnessClient) {
  const [projects, tickets, sessions, watchers, mappings, settings, drivers] = await Promise.all([
    client.listProjects(),
    client.listTickets(),
    client.listSessions(),
    client.listWatchers().catch(() => []),
    client.listMappings().catch(() => []),
    client.getSettings().catch(() => null),
    client.listDrivers().catch(() => []),
  ]);
  return { projects, tickets, sessions, watchers, mappings, settings, drivers };
}

/** Run async jobs with bounded concurrency. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!).catch(() => {});
  }));
}

export function StoreProvider({ baseUrl, token, children, toast }: { baseUrl: string; token: string; children: ReactNode; toast: Store["toast"] }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [epoch, setEpoch] = useState(0);
  const [route, navigate] = useRoute();
  const listeners = useRef(new Set<EventListener>());
  const client = useMemo(() => new HarnessClient({ baseUrl, token }), [baseUrl, token]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    try {
      const snapshot = await loadSnapshot(client);
      dispatch({ type: "snapshot", snapshot });
      // Board cards show the latest summary; backfill for tickets that are still moving
      // (and the most recent done ones). Live summary.added events keep them fresh after.
      const done = snapshot.tickets.filter((t) => t.status === "done").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
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
          // Initial load and every reconnect: refetch everything we might have missed.
          void refresh();
          if (!first) setEpoch((n) => n + 1);
          first = false;
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

  const onEvent = useCallback((fn: EventListener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const value = useMemo<Store>(
    () => ({ state, dispatch, client, socket, onEvent, epoch, route, navigate, refresh, toast }),
    [state, client, socket, onEvent, epoch, route, navigate, refresh, toast],
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
