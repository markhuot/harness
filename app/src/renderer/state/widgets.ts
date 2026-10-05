// The board's state as the Mac desktop widget sees it (main/widgets.ts): the renderer sends this
// signature to the main process, which reloads the widget only when it changes.

/**
 * Every ticket that isn't done or a draft: a superset of what the widget shows
 * (WidgetFeed.isActive in HarnessKit), so a change it shows is never missed. Order doesn't matter.
 */
export function widgetSignature(tickets: Iterable<{ key: string; status: string; busy: boolean; title: string; updatedAt: number; draft?: boolean }>): string {
  const parts: string[] = [];
  for (const t of tickets) {
    if (t.status === "done" || t.draft) continue;
    parts.push(`${t.key}\u0000${t.status}\u0000${t.busy ? 1 : 0}\u0000${t.updatedAt}\u0000${t.title}`);
  }
  return parts.sort().join("\u0001");
}
