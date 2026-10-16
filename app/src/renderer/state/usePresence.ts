// Reports what this window shows over its socket (a `presence` message, DESIGN.md
// "Notifications"), so the service holds back notifications for tickets already on screen.

import { useEffect, useRef, useState } from "react";
import type { HarnessSocket } from "@harness/shared";
import { readHideChildren, type State } from "@harness/shared/state";
import { getPanes, getPopoutPanes, usePaneStore } from "./panes";
import { reportedPresence } from "./presenceReport";
import { presenceTerminals, presenceTickets } from "./presence";
import { paneScopeOf, type Route } from "./route";

export { reportedPresence };

/** Board.tsx's "Hide child tickets" toggle fires this on its window when it changes. */
export const HIDE_CHILDREN_CHANGED = "harness:hide-children-changed";

const DEVICE_ID_KEY = "harness.deviceId";

/** Outside Electron (no bridge), an id kept in this origin's storage. */
function storedDeviceId(): string {
  try {
    const id = localStorage.getItem(DEVICE_ID_KEY);
    if (id) return id;
    const next = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

/** This install's device id, for the terminals it creates and attaches (the same one presence reports). */
export function deviceIdNow(): Promise<string> {
  return window.harness?.deviceId ? window.harness.deviceId().catch(() => storedDeviceId()) : Promise.resolve(storedDeviceId());
}

/** The install's device id: the main process's (shared by every window), else this origin's. */
function useDeviceId(): string | null {
  const [id, setId] = useState<string | null>(() => (window.harness?.deviceId ? null : storedDeviceId()));
  useEffect(() => {
    if (!window.harness?.deviceId) return;
    let live = true;
    window.harness.deviceId().then(
      (v) => live && setId(v),
      () => live && setId(storedDeviceId()),
    );
    return () => {
      live = false;
    };
  }, []);
  return id;
}

/** Whether the page is showing: hidden while the window is minimized, covered or the app hidden. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Whether the person is away from the Mac (locked, asleep, idle); always false outside Electron. */
function useAway(): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const bridge = window.harness;
    if (!bridge?.onAwayChange) return;
    let live = true;
    const off = bridge.onAwayChange(setAway);
    bridge.isAway().then(
      (v) => live && setAway(v),
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  return away;
}

function useHideChildrenSetting(): boolean {
  const [hide, setHide] = useState(() => readHideChildren());
  useEffect(() => {
    const on = () => setHide(readHideChildren());
    addEventListener(HIDE_CHILDREN_CHANGED, on);
    addEventListener("storage", on); // another window toggled it
    return () => {
      removeEventListener(HIDE_CHILDREN_CHANGED, on);
      removeEventListener("storage", on);
    };
  }, []);
  return hide;
}

/** The panes this window shows: the board's, the pop-out's, or none off the board. */
function panesFor(route: Route) {
  if (route.view === "popout") return getPopoutPanes(route.id);
  const scope = paneScopeOf(route);
  return scope ? getPanes(scope) : null;
}

/**
 * Keep this window's presence current: re-sent (lightly debounced; the socket drops an unchanged
 * one) whenever the route, the panes, the tickets or the window's visibility change, and by the
 * socket itself after each reconnect.
 */
export function usePresence(socket: HarnessSocket, state: State, route: Route, boardScope: string) {
  const deviceId = useDeviceId();
  const visible = useVisible();
  const away = useAway();
  const hideChildren = useHideChildrenSetting();
  const paneStore = usePaneStore();
  const latest = useRef({ state, route, boardScope });
  latest.current = { state, route, boardScope };
  const lastAway = useRef(false);
  useEffect(() => {
    if (!deviceId) return;
    const send = () => {
      const { state, route, boardScope } = latest.current;
      const panes = panesFor(route);
      const tickets = presenceTickets({ route, state, boardScope, panes, hideChildren });
      const terminals = presenceTerminals({ route, panes });
      socket.setPresence({ deviceId, platform: "mac", ...reportedPresence(visible, away, tickets, terminals) });
    };
    // Going away or coming back is sent at once; other changes are lightly debounced.
    const t = setTimeout(send, away === lastAway.current ? 100 : 0);
    lastAway.current = away;
    return () => clearTimeout(t);
  }, [socket, deviceId, visible, away, hideChildren, paneStore, state.tickets, state.search, state.donePaging, state.projects, route, boardScope]);
}
