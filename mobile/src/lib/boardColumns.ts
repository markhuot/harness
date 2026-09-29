// What the board shows and sends, apart from the screen: the columns once "Show child tickets" is
// applied, each column header's count, and the update a card move makes.

import { TICKET_STATUSES, type Ticket, type TicketStatus } from "@harness/shared";
import { doneCount, hideOnBoard, positionForDrop, type State } from "@harness/shared/state";

export type Columns = Record<TicketStatus, Ticket[]>;

/** The board's columns as shown: children hidden while the pref says so (never one that needs the human). */
export function visibleColumns(board: Columns, hideChildren: boolean): Columns {
  return Object.fromEntries(TICKET_STATUSES.map((s) => [s, board[s].filter((t) => !hideOnBoard(t, hideChildren))])) as Columns;
}

/**
 * A column header's count. Done shows the server's total when it's paged, hidden children
 * included, since the rest of the history isn't loaded to filter; search results count what's shown.
 */
export function columnCount(state: State, projectId: string | null, shown: Columns, status: TicketStatus, searching: boolean): number {
  return !searching && status === "done" ? doneCount(state, projectId, shown.done.length) : shown[status].length;
}

export interface Move {
  /** The PATCH body: the new status and/or position. */
  body: { status?: TicketStatus; position?: number };
  /** The optimistic completedAt: a card dropped into Done is the newest completion. */
  completedAt: Ticket["completedAt"];
}

/**
 * The update for moving `t` to the top or bottom of `status` (`cols` is the unfiltered board), or
 * null when nothing would change. Done is ordered by completion, so a move there sends no position.
 */
export function moveBody(t: Ticket, status: TicketStatus, where: "top" | "bottom", cols: Columns, now = Date.now()): Move | null {
  const others = cols[status].filter((x) => x.id !== t.id);
  const position = status === "done" ? undefined : positionForDrop(others, where === "top" ? 0 : others.length);
  const body = { ...(t.status !== status ? { status } : {}), ...(position !== undefined ? { position } : {}) };
  if (!Object.keys(body).length) return null;
  const completedAt = t.status === status ? t.completedAt : status === "done" ? now : null;
  return { body, completedAt };
}
