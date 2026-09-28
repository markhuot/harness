// Which pane a component renders in, so links inside a ticket pane (child rows, the parent crumb,
// dependency links, a plugin's "open ticket") navigate that pane instead of opening another.

import { createContext, useCallback, useContext } from "react";
import type { TicketTab } from "@harness/shared/state";
import { replaceContent, updatePanes } from "../state/panes";
import { useStore } from "../state/store";

export interface PaneInfo {
  paneId: string;
}

export const PaneContext = createContext<PaneInfo | null>(null);

export const usePane = () => useContext(PaneContext);

/**
 * Open a ticket from inside a pane: it replaces this pane's content (or focuses the pane it's
 * already open in). Outside a pane it's an ordinary link to the ticket.
 */
export function useOpenTicket(): (key: string, tab?: TicketTab) => void {
  const pane = usePane();
  const paneId = pane?.paneId ?? null;
  const { navigate, route } = useStore();
  const projectId = route.view === "board" ? route.projectId : null;
  return useCallback(
    (key: string, tab: TicketTab = "summaries") => {
      if (paneId) updatePanes((s) => replaceContent(s, paneId, { kind: "ticket", ticketKey: key, tab }));
      else navigate({ view: "board", projectId, ticketKey: key, tab });
    },
    [paneId, navigate, projectId],
  );
}
