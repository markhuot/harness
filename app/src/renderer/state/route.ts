// Hash routing: the UI state that's worth linking to (and screenshotting) lives in the URL.
//   #/board[/<projectId>|/group/<name>][/ticket/<KEY>[/<tab>]]
// On the board, the ticket part is an entry point into the pane workspace (state/panes.ts):
// arriving at it opens the ticket in a pane, and afterwards the hash mirrors the focused ticket
// pane (see mirrorRoute) without adding history entries.
//   #/inbox[/<sessionId>]
//   #/settings[/<section>]
//   #/project/<projectId>/settings
//   #/popout/<id>/<fromScope>   a pop-out window's one pane (components/PopoutWindow.tsx), which
//                               goes back to the board of `fromScope` when popped back in

import { ALL_SCOPE, groupScope, scopeGroup, scopeOf, scopeProject, ticketTabWithChanges, type TicketTab } from "@harness/shared/state";

// Ticket tabs are shared with the iOS app (@harness/shared/state "tabs").
export { parsePluginTab, pluginTabRoute, TICKET_TABS, type BuiltinTicketTab, type TicketTab } from "@harness/shared/state";

export type Route =
  /** `group` set: a project group's board (projectId is null then); else a project's, or All projects */
  | { view: "board"; projectId: string | null; group?: string | null; ticketKey: string | null; tab: TicketTab }
  | { view: "inbox"; sessionId: string | null }
  | { view: "settings"; section: string | null }
  | { view: "project"; projectId: string }
  | { view: "popout"; id: string; fromScope: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [view, ...rest] = parts;
  if (view === "inbox") return { view: "inbox", sessionId: rest[0] ?? null };
  if (view === "settings") return { view: "settings", section: rest[0] ?? null };
  if (view === "project" && rest[0]) return { view: "project", projectId: rest[0] };
  if (view === "popout" && rest[0]) return { view: "popout", id: rest[0], fromScope: rest[1] ?? ALL_SCOPE };
  let projectId: string | null = null;
  let group: string | null = null;
  let i = 0;
  if (rest[0] === "group" && rest[1]) {
    group = rest[1];
    i = 2;
  } else if (rest[0] && rest[0] !== "ticket") {
    projectId = rest[0] === "all" ? null : rest[0];
    i = 1;
  }
  let ticketKey: string | null = null;
  let tab: TicketTab = "spec";
  if (rest[i] === "ticket" && rest[i + 1]) {
    ticketKey = rest[i + 1]!;
    // Older links may name a renamed tab (".../summaries" is now the Spec, ".../plugin:git:changes"
    // the built-in Changes).
    tab = ticketTabWithChanges(rest[i + 2]) ?? "spec";
  }
  return group !== null ? { view: "board", projectId: null, group, ticketKey, tab } : { view: "board", projectId, ticketKey, tab };
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
    case "popout":
      return `#/popout/${e(r.id)}/${e(r.fromScope)}`;
    case "board": {
      let s = `#/board/${r.group ? `group/${e(r.group)}` : r.projectId ? e(r.projectId) : "all"}`;
      if (r.ticketKey) s += `/ticket/${e(r.ticketKey)}` + (r.tab !== "spec" ? `/${r.tab}` : "");
      return s;
    }
  }
}

/**
 * Which board scope's panes (state/panes.ts) the route shows: the board's project, its group's
 * scope, or ALL_SCOPE for All projects; null off the board. The route's project id is taken as it
 * is, so a link to a project that's gone still has one scope throughout (its board shows every
 * project).
 */
export const paneScopeOf = (r: Route): string | null => (r.view === "board" ? (r.group ? groupScope(r.group) : scopeOf(r.projectId)) : null);

/** The board of a pane scope (a project's, a group's, or All projects), optionally on a ticket. */
export function boardRoute(scope: string, ticketKey: string | null = null, tab: TicketTab = "spec"): Route {
  const group = scopeGroup(scope);
  if (group !== null) return { view: "board", projectId: null, group, ticketKey, tab };
  return { view: "board", projectId: scopeProject(scope) ?? null, ticketKey, tab };
}

/** The board route the hash should show for the focused ticket pane (none focused = just the board). */
export function mirrorRoute(r: Route, focused: { ticketKey: string; tab: TicketTab } | null): Route {
  if (r.view !== "board") return r;
  const board = r.group ? { projectId: null, group: r.group } : { projectId: r.projectId };
  return { view: "board", ...board, ticketKey: focused?.ticketKey ?? null, tab: focused?.tab ?? "spec" };
}
