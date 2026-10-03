// Activity entries in the apps (DESIGN.md "Activity"). An entry's body is one line; when the
// author wrote more, the whole text is in meta.detail, behind Show details.

import type { ActivityEntry } from "../protocol";

/** A line as an Activity body shows it (the service's activityLine): markers dropped, whitespace collapsed. */
function bodyLine(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, "").replace(/\s+/g, " ").trim();
}

/**
 * What Show details reveals: the rest of meta.detail after the line the body already shows, or
 * the whole detail when it doesn't start with that line (the classifier's reason under a
 * permission entry). Undefined when there's nothing more to show.
 */
export function activityDetail(e: Pick<ActivityEntry, "body" | "meta">): string | undefined {
  const detail = e.meta?.detail?.trim();
  if (!detail) return undefined;
  const lines = detail.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  const rest = first >= 0 && bodyLine(lines[first]!) === bodyLine(e.body) ? lines.slice(first + 1).join("\n").trim() : detail;
  return rest || undefined;
}
