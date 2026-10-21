// Which project or group the board shows, given the route.

import { projectGroups, resolveGroupKey } from "@harness/shared";
import { groupScope, scopeOf, type State } from "@harness/shared/state";
import type { Route } from "./route";

/** The board's project filter, once it names a project that exists (else all projects). */
export function boardProjectOf(state: State, route: Route): string | null {
  return route.view === "board" && !route.group && route.projectId && state.projects[route.projectId] ? route.projectId : null;
}

/**
 * The group id a route's group names: the id itself, or the id of the group a link saved before
 * groups had ids names (its name); else the route's value, a group no project is in.
 */
export function routeGroupId(state: Pick<State, "projects">, group: string): string {
  return resolveGroupKey(group, projectGroups(Object.values(state.projects))) ?? group;
}

/**
 * The board's scope: a group's (even one no project carries any more: its board is empty, not
 * every ticket), else the validated project's, else All projects.
 */
export function boardScopeOf(state: State, route: Route): string {
  if (route.view === "board" && route.group) return groupScope(routeGroupId(state, route.group));
  return scopeOf(boardProjectOf(state, route));
}
