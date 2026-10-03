// How the Activity tab labels each kind of entry (views/ActivityTab.tsx).

import type { ActivityEntry, ActivityKind } from "@harness/shared";
import { STATUS_LABEL, type IconName } from "@harness/shared/state";

export const ACTIVITY_KIND: Record<ActivityKind, { icon: IconName; label: string }> = {
  note: { icon: "sparkle", label: "Note" },
  submitted: { icon: "send", label: "Submitted for review" },
  blocked: { icon: "alert", label: "Asked you" },
  unblocked: { icon: "play", label: "Picked back up" },
  review_approved: { icon: "checkCircle", label: "Review approved" },
  changes_requested: { icon: "edit", label: "Changes requested" },
  approved: { icon: "check", label: "Approved" },
  message: { icon: "user", label: "You" },
  answer: { icon: "bot", label: "Agent" },
  reopened: { icon: "refresh", label: "Re-opened" },
  moved: { icon: "chevronRight", label: "Moved" },
  failed: { icon: "x", label: "Failed" },
  permission: { icon: "shield", label: "Permission" },
  system: { icon: "zap", label: "Harness" },
};

const BY_LABEL = { agent: "agent", human: "you", conductor: "conductor" } as const;

/**
 * An entry's heading: "Review approved · round 2 · 1a2b3c4 · by agent", "Submitted for review ·
 * spec rev 7 → Review". An entry that moved the ticket ends with the column it went to.
 */
export function activityHeading(e: Pick<ActivityEntry, "kind" | "meta">): string {
  const parts = [ACTIVITY_KIND[e.kind]?.label ?? e.kind];
  const m = e.meta ?? {};
  const review = e.kind === "review_approved" || e.kind === "changes_requested";
  if (review && m.round) parts.push(`round ${m.round}`);
  if (review && m.commit) parts.push(m.commit.slice(0, 7));
  if ((review || e.kind === "approved") && m.by) parts.push(`by ${BY_LABEL[m.by]}`);
  if (e.kind === "submitted" && m.specRevision) parts.push(`spec rev ${m.specRevision}`);
  const heading = parts.join(" · ");
  return m.to && STATUS_LABEL[m.to] ? `${heading} → ${STATUS_LABEL[m.to]}` : heading;
}

/** The blocked entry the ticket is waiting on now: the newest one, while the ticket is blocked. */
export function openQuestionId(list: readonly Pick<ActivityEntry, "id" | "kind">[], status: string): string | undefined {
  if (status !== "blocked") return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.kind === "blocked") return list[i]!.id;
  return undefined;
}
