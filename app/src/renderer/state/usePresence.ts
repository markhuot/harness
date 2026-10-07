// Reports what this window shows over its socket (a `presence` message, DESIGN.md
// "Notifications"), so the service holds back notifications for tickets already on screen.

import { useEffect, useRef, useState } from "react";
import type { HarnessSocket } from "@harness/shared";
import { readHideChildren, type State } from "@harness/shared/state";
import { getPanes, getPopoutPanes, usePaneStore } from "./panes";
import { presenceTickets } from "./presence";
import { paneScopeOf, type Route } from "./route";

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
  const hideChildren = useHideChildrenSetting();
  const paneStore = usePaneStore();
  const latest = useRef({ state, route, boardScope });
  latest.current = { state, route, boardScope };
  useEffect(() => {
    if (!deviceId) return;
    const send = () => {
      const { state, route, boardScope } = latest.current;
      const tickets = presenceTickets({ route, state, boardScope, panes: panesFor(route), hideChildren });
      socket.setPresence({ deviceId, platform: "mac", visible, tickets });
    };
    const t = setTimeout(send, 100);
    return () => clearTimeout(t);
  }, [socket, deviceId, visible, hideChildren, paneStore, state.tickets, state.search, state.donePaging, state.projects, route, boardScope]);
}
