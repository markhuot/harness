// Seen and unseen (DESIGN.md "Seen and unseen"): the flag is kept in every column, but only cards in
// Blocked and Review show it. HarnessKit's BoardScreenRules.showsUnseen is the same rule.

import type { Ticket } from "../protocol";

/** Whether the board card shows the New pill and tint. */
export function showsUnseen(t: Pick<Ticket, "status" | "unseen" | "draft">): boolean {
  return !!t.unseen && !t.draft && (t.status === "blocked" || t.status === "review");
}
