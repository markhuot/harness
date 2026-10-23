// Chief of staff (CoS) presentation logic shared by the clients: tabs, badges, the chat and Inbox
// merges, and the tri-state of a project's CoS settings. Pure; the wire shapes are in ../cos.

import type { Cos, CosBadge, CosChatEntry, CosEvent } from "../cos";
import { COS_OPEN_STATUSES } from "../cos";

/** A chief's pane has these three tabs and no others (no Spec, Activity or Tickets). */
export const COS_TABS = ["chat", "inbox", "listeners"] as const;
export type CosTab = (typeof COS_TABS)[number];

export const COS_TAB_LABEL: Record<CosTab, string> = { chat: "Chat", inbox: "Inbox", listeners: "Listeners" };

export function isCosTab(v: unknown): v is CosTab {
  return v === "chat" || v === "inbox" || v === "listeners";
}

/** Events awaiting a verdict or being handled by one chief (0 when the badge hasn't loaded or names nobody). */
export function cosBadgeCount(badge: CosBadge | null | undefined, cosId: string): number {
  return badge?.byCos[cosId] ?? 0;
}

/** What a chief's sidebar row is called: "All projects", or the group's name. */
export function cosTitle(cos: Pick<Cos, "scope">, groupName: string | null): string {
  return cos.scope === "all" ? "All projects" : (groupName ?? "Group");
}

/** Open (badge-counting) events from a list of loaded ones: the client-side twin of the service's badge. */
export function openEventCount(events: readonly CosEvent[], cosId: string): number {
  return events.filter((e) => e.cosId === cosId && COS_OPEN_STATUSES.includes(e.status)).length;
}

const chatOrder = (a: CosChatEntry, b: CosChatEntry) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A chat's entries, oldest first, with `incoming` merged in. An id seen twice (a page loaded after
 * the same entry arrived live, or the reverse) is kept once, the incoming copy winning. Returns the
 * same array when nothing changed.
 */
export function mergeChat(existing: readonly CosChatEntry[], incoming: readonly CosChatEntry[]): CosChatEntry[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  let changed = false;
  for (const e of incoming) {
    const had = byId.get(e.id);
    if (had && JSON.stringify(had) === JSON.stringify(e)) continue;
    byId.set(e.id, e);
    changed = true;
  }
  return changed ? [...byId.values()].sort(chatOrder) : (existing as CosChatEntry[]);
}

/** The Inbox's rows: newest first, each id once. */
export function mergeEvents(existing: readonly CosEvent[], incoming: readonly CosEvent[]): CosEvent[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** What an Inbox row says happened to the event, in a word. */
export type InboxState = "waiting" | "ignored" | "escalated" | "handling" | "acted" | "no_action" | "needs_user" | "reviewed" | "filtered";

/** A handled event shows what the chief recorded for it; one it recorded nothing for is only "reviewed" (its run ended, nothing says it did anything). */
export function inboxState(e: Pick<CosEvent, "status" | "verdict" | "outcome">): InboxState {
  if (e.verdict === "filtered") return "filtered";
  switch (e.status) {
    case "pending":
    case "triaging":
      return "waiting";
    case "ignored":
      return "ignored";
    case "escalated":
      return "escalated";
    case "handling":
      return "handling";
    case "handled":
      return e.outcome?.kind ?? "reviewed";
  }
}

/** Ignored events (and only those) can be escalated by hand. */
export function canEscalate(e: Pick<CosEvent, "status" | "verdict">): boolean {
  return e.status === "ignored" && e.verdict !== "filtered";
}

/** A project's value for a CoS switch: inherit the app's (null), or its own on or off. */
export type TriState = "inherit" | "on" | "off";

export function triStateOf(v: boolean | null | undefined): TriState {
  return v === true ? "on" : v === false ? "off" : "inherit";
}

/** The `Project.cosEnabled`/`cosCanUnblock` a choice saves: null clears the override. */
export function triStateValue(t: TriState): boolean | null {
  return t === "on" ? true : t === "off" ? false : null;
}

/** What "Inherit" resolves to, for its label ("Inherit (on)"). */
export function inheritedLabel(app: boolean): string {
  return `Inherit (${app ? "on" : "off"})`;
}

/** The chiefs worth a sidebar row, All projects first and then groups by name. */
export function sortChiefs(chiefs: readonly Cos[], groupName: (groupId: string) => string): Cos[] {
  return [...chiefs].sort((a, b) => {
    if (a.scope === "all" || b.scope === "all") return a.scope === "all" ? -1 : 1;
    return groupName(a.groupId ?? "").localeCompare(groupName(b.groupId ?? ""));
  });
}

/**
 * Where a scroller sits after older entries were prepended above what it showed: the same content
 * stays under the same pixel, so the page that loaded doesn't throw the reader to its top.
 */
export function anchoredScrollTop(before: { scrollTop: number; scrollHeight: number }, scrollHeight: number): number {
  return Math.max(0, before.scrollTop + (scrollHeight - before.scrollHeight));
}

/** Whether a chat scroller is near enough its top to ask for the next older page. */
export function nearTop(scrollTop: number, threshold = 80): boolean {
  return scrollTop <= threshold;
}
