// Hash routing: the whole UI state that's worth linking to (and screenshotting) lives in the URL.
//   #/board[/<projectId>][/ticket/<KEY>[/<tab>]]
//   #/inbox[/<sessionId>]
//   #/settings[/<section>]
//   #/project/<projectId>/settings

/** "children" is the conductor-only Tickets tab (listed right after Summaries). */
export type BuiltinTicketTab = "summaries" | "children" | "transcript" | "browser" | "details";
/** Built-in tabs, or a plugin tab as "plugin:<pluginId>:<tabId>" (DESIGN.md "Plugins"). */
export type TicketTab = BuiltinTicketTab | `plugin:${string}:${string}`;
export const TICKET_TABS: BuiltinTicketTab[] = ["summaries", "children", "transcript", "browser", "details"];

const PLUGIN_TAB = /^plugin:([a-z0-9][a-z0-9_-]*):([a-z0-9][a-z0-9_-]*)$/;
export function pluginTabRoute(pluginId: string, tabId: string): TicketTab {
  return `plugin:${pluginId}:${tabId}`;
}
/** "plugin:git:changes" → { pluginId: "git", tabId: "changes" }; null for built-in tabs. */
export function parsePluginTab(tab: string): { pluginId: string; tabId: string } | null {
  const m = PLUGIN_TAB.exec(tab);
  return m ? { pluginId: m[1]!, tabId: m[2]! } : null;
}
function isTicketTab(t: string | undefined): t is TicketTab {
  return !!t && ((TICKET_TABS as string[]).includes(t) || PLUGIN_TAB.test(t));
}

export type Route =
  | { view: "board"; projectId: string | null; ticketKey: string | null; tab: TicketTab }
  | { view: "inbox"; sessionId: string | null }
  | { view: "settings"; section: string | null }
  | { view: "project"; projectId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [view, ...rest] = parts;
  if (view === "inbox") return { view: "inbox", sessionId: rest[0] ?? null };
  if (view === "settings") return { view: "settings", section: rest[0] ?? null };
  if (view === "project" && rest[0]) return { view: "project", projectId: rest[0] };
  let projectId: string | null = null;
  let i = 0;
  if (rest[0] && rest[0] !== "ticket") {
    projectId = rest[0] === "all" ? null : rest[0];
    i = 1;
  }
  let ticketKey: string | null = null;
  let tab: TicketTab = "summaries";
  if (rest[i] === "ticket" && rest[i + 1]) {
    ticketKey = rest[i + 1]!;
    const t = rest[i + 2] as TicketTab | undefined;
    if (isTicketTab(t)) tab = t;
  }
  return { view: "board", projectId, ticketKey, tab };
}

export function formatRoute(r: Route): string {
  const e = encodeURIComponent;
  switch (r.view) {
    case "inbox":
      return r.sessionId ? `#/inbox/${e(r.sessionId)}` : "#/inbox";
    case "settings":
      return r.section ? `#/settings/${e(r.section)}` : "#/settings";
    case "project":
      return `#/project/${e(r.projectId)}/settings`;
    case "board": {
      let s = `#/board/${r.projectId ? e(r.projectId) : "all"}`;
      if (r.ticketKey) s += `/ticket/${e(r.ticketKey)}` + (r.tab !== "summaries" ? `/${r.tab}` : "");
      return s;
    }
  }
}
