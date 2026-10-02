// Which pane a component renders in, so links inside a ticket pane (child rows, the parent crumb,
// dependency links, a plugin's "open ticket") navigate that pane instead of opening another. And
// which board scope's workspace it's in, since every board has its own panes (state/panes.ts).

import { createContext, useCallback, useContext } from "react";
import { ALL_SCOPE, type TicketTab } from "@harness/shared/state";
import { replaceContent, updatePanes } from "../state/panes";
import { useOptionalStore } from "../state/store";

export interface PaneInfo {
  paneId: string;
}

export const PaneContext = createContext<PaneInfo | null>(null);

export const usePane = () => useContext(PaneContext);

/** The scope the workspace shows (PaneWorkspace provides it; see paneScopeOf in state/route.ts). */
export const PaneScopeContext = createContext<string>(ALL_SCOPE);

export const usePaneScope = () => useContext(PaneScopeContext);

/** In a pop-out window (components/PopoutWindow.tsx): its id, and the board its pane goes back to. */
export interface PopoutInfo {
  id: string;
  fromScope: string;
}

/** Null in the main window. */
export const PopoutContext = createContext<PopoutInfo | null>(null);

export const usePopout = () => useContext(PopoutContext);

/**
 * Open a ticket from inside a pane: it replaces this pane's content (or focuses the pane it's
 * already open in). Outside a pane it's an ordinary link to the ticket, and without a store (Markdown
 * rendered on its own, as in tests) there's nowhere to go.
 */
export function useOpenTicket(): (key: string, tab?: TicketTab) => void {
  const pane = usePane();
  const paneId = pane?.paneId ?? null;
  const scope = usePaneScope();
  const store = useOptionalStore();
  const navigate = store?.navigate;
  const projectId = store?.route.view === "board" ? store.route.projectId : null;
  return useCallback(
    (key: string, tab: TicketTab = "spec") => {
      if (paneId) updatePanes(scope, (s) => replaceContent(s, paneId, { kind: "ticket", ticketKey: key, tab }));
      else navigate?.({ view: "board", projectId, ticketKey: key, tab });
    },
    [paneId, scope, navigate, projectId],
  );
}
