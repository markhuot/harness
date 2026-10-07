// What a window shows, for the service's notification presence (DESIGN.md "Notifications"): every
// ticket key on screen. The service holds back a notification for a ticket any visible window
// lists, so this mirrors what the board and the panes actually render.

import { TICKET_STATUSES } from "@harness/shared";
import { boardColumns, hideOnBoard, searchColumns, type State } from "@harness/shared/state";
import { layoutPanes, paneTicket, type PaneState } from "./panes";
import type { Route } from "./route";

/**
 * The cards board `scope` shows, as Board.tsx renders them: while the filter box searches, every
 * match (children included, as the board shows them); otherwise every column, the Done column's
 * loaded pages included, less the children "Hide child tickets" hides.
 */
export function boardCardKeys(state: State, scope: string, hideChildren: boolean): string[] {
  if (state.search) {
    const { columns } = searchColumns(state, scope);
    return TICKET_STATUSES.flatMap((s) => columns[s].map((t) => t.key));
  }
  const columns = boardColumns(state, scope);
  return TICKET_STATUSES.flatMap((s) => columns[s].filter((t) => !hideOnBoard(t, hideChildren)).map((t) => t.key));
}

export interface PresenceInput {
  route: Route;
  state: State;
  /** The board's scope (store.boardScope) */
  boardScope: string;
  /**
   * The panes this window shows: the route's board's on the board, the pop-out's in a pop-out
   * window, null elsewhere (Settings, Inbox, a project's settings), which shows no ticket.
   */
  panes: PaneState | null;
  hideChildren: boolean;
}

/**
 * Every ticket key on screen in this window: the ticket of each pane that isn't covered by a
 * zoomed one (ticket panes, torn-off tabs, file panes resolved in a ticket), and the board's cards
 * while the board pane itself is showing. Sorted and without repeats.
 */
export function presenceTickets({ route, state, boardScope, panes, hideChildren }: PresenceInput): string[] {
  if (!panes || (route.view !== "board" && route.view !== "popout")) return [];
  const keys = new Set<string>();
  for (const { leaf, hidden } of layoutPanes(panes).leaves) {
    if (hidden) continue;
    const key = paneTicket(leaf.content);
    if (key) keys.add(key);
    if (leaf.content.kind === "board" && route.view === "board") for (const k of boardCardKeys(state, boardScope, hideChildren)) keys.add(k);
  }
  return [...keys].sort();
}
