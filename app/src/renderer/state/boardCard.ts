// When a board card needs to re-render.

import { isConductor, type Ticket } from "@harness/shared";
import type { State } from "@harness/shared/state";

export type CardSelection = "focused" | "open" | null;
export type CardProps = { ticket: Ticket; state: State; selected: CardSelection; isCursor: boolean; showProject: boolean; related: boolean };
/** Whether a card can skip re-rendering: only what it shows (its ticket, the state slices it reads) changed. */
export function cardPropsEqual(a: CardProps, b: CardProps) {
  if (a.ticket !== b.ticket || a.selected !== b.selected || a.isCursor !== b.isCursor || a.showProject !== b.showProject || a.related !== b.related) return false;
  const s1 = a.state;
  const s2 = b.state;
  if (s1.activity[a.ticket.sessionId] !== s2.activity[b.ticket.sessionId]) return false;
  if (s1.projects !== s2.projects || s1.settings !== s2.settings) return false;
  if (s1.keyAliases !== s2.keyAliases || s1.missingKeys !== s2.missingKeys) return false;
  // Deps, children and the parent live in the tickets map.
  if (s1.tickets !== s2.tickets && (a.ticket.dependsOn.length || isConductor(a.ticket) || a.ticket.parentId)) return false;
  return true;
}
