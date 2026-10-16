// Which project or group the board shows, given the route.

import { groupScope, scopeOf, type State } from "@harness/shared/state";
import type { Route } from "./route";

/** The board's project filter, once it names a project that exists (else all projects). */
export function boardProjectOf(state: State, route: Route): string | null {
  return route.view === "board" && !route.group && route.projectId && state.projects[route.projectId] ? route.projectId : null;
}

/**
 * The board's scope: a group's (even one no project carries any more: its board is empty, not
 * every ticket), else the validated project's, else All projects.
 */
export function boardScopeOf(state: State, route: Route): string {
  if (route.view === "board" && route.group) return groupScope(route.group);
  return scopeOf(boardProjectOf(state, route));
}
