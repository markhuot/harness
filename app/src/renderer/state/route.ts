// Hash routing: the whole UI state that's worth linking to (and screenshotting) lives in the URL.
//   #/board[/<projectId>][/ticket/<KEY>[/<tab>]]
//   #/inbox[/<sessionId>]
//   #/settings[/<section>]
//   #/project/<projectId>/settings

import { isTicketTab, type TicketTab } from "@harness/shared/state";

// Ticket tabs are shared with the iOS app (@harness/shared/state "tabs").
export { parsePluginTab, pluginTabRoute, TICKET_TABS, type BuiltinTicketTab, type TicketTab } from "@harness/shared/state";

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
    const t = rest[i + 2];
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
