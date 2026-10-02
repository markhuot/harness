// Pure helpers for the Browser pane's tabs (BrowserView), kept apart so they can be tested.

import type { BrowserState, BrowserTab } from "@harness/shared";

/**
 * The tab a Browser pane shows: a tab id, `undefined` before the service has said (or when it
 * predates tabs), or `"pending"` after asking for a new tab whose id the next browser.state brings.
 */
export type ViewTab = number | undefined | "pending";

/** A chip's label: the page title, else the URL's host, else "New tab" for a blank page. */
export function tabLabel(tab: Pick<BrowserTab, "url" | "title">): string {
  const title = tab.title.trim();
  if (title) return title;
  const url = tab.url.trim();
  if (!url || url === "about:blank") return "New tab";
  try {
    const host = new URL(url).host;
    if (host) return host;
  } catch {
    // Not a URL; show it as it is.
  }
  return url;
}

/** A chip's tooltip: its label, the URL when that adds something, and whether its page is suspended. */
export function tabTooltip(tab: Pick<BrowserTab, "url" | "title" | "suspended">): string {
  const label = tabLabel(tab);
  const lines = [label];
  if (tab.url && tab.url !== label) lines.push(tab.url);
  if (tab.suspended) lines.push("Suspended to save memory. Reloads when you open it.");
  return lines.join("\n");
}

/**
 * Whether a frame belongs on screen. Frames without a tabId come from services before tabs (always
 * shown); otherwise only the shown tab's frames are, so in-flight frames from the tab just left
 * (or, while a new tab is pending, from any tab) are dropped.
 */
export function frameIsForView(frameTab: number | undefined, view: ViewTab): boolean {
  if (frameTab === undefined) return true;
  if (view === "pending") return false;
  return view === undefined || view === frameTab;
}

// After the view asks for another tab, browser.states still in flight from the old one would undo
// the switch. Each of these says which state confirms the request; the view drops others until then.

/** Switching to `tabId`: that tab's state, or a move elsewhere when it closed meanwhile. */
export const confirmsSwitch = (tabId: number) => (s: BrowserState) => s.tabId === tabId || !s.tabs?.some((t) => t.id === tabId);

/** Opening a tab: ids only count up, so the new tab's is above every tab open when it was asked for. */
export function confirmsNewTab(open: Pick<BrowserTab, "id">[]) {
  const highest = Math.max(0, ...open.map((t) => t.id));
  return (s: BrowserState) => s.tabId !== undefined && s.tabId > highest;
}

/** Closing the shown tab `tabId`: any state that isn't that tab's. */
export const confirmsClose = (tabId: number) => (s: BrowserState) => s.tabId !== tabId;
