import type { Ticket, TicketStatus } from "@harness/shared";

/** The columns the sidebar counts, in the order its pill shows them. */
export const COUNTED = ["in_progress", "blocked", "review"] as const satisfies readonly TicketStatus[];
export type CountedStatus = (typeof COUNTED)[number];
export type StatusCounts = Record<CountedStatus, number>;

const empty = (): StatusCounts => ({ in_progress: 0, blocked: 0, review: 0 });

/** In progress, blocked and review counts per project, plus `total` across every project. */
export function sidebarCounts(tickets: Iterable<Pick<Ticket, "projectId" | "status">>): { byProject: Record<string, StatusCounts>; total: StatusCounts } {
  const byProject: Record<string, StatusCounts> = {};
  const total = empty();
  for (const t of tickets) {
    if (!(COUNTED as readonly string[]).includes(t.status)) continue;
    const s = t.status as CountedStatus;
    (byProject[t.projectId] ??= empty())[s]++;
    total[s]++;
  }
  return { byProject, total };
}

/** The pill's segments: zero counts drop out, so an idle board shows nothing. */
export function countSegments(counts: StatusCounts | undefined): { status: CountedStatus; n: number }[] {
  if (!counts) return [];
  return COUNTED.filter((s) => counts[s] > 0).map((s) => ({ status: s, n: counts[s] }));
}
