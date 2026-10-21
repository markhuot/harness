// Project groups: a human-readable name ("Work", "Personal") several projects share. Each group
// gets its own board in the apps, like All projects but with only its projects. A project is in at
// most one group; a group exists while a project carries it, and goes when its last one leaves.

/** The longest group name the service stores. */
export const PROJECT_GROUP_MAX = 60;

/**
 * A group name from a request or a settings field: trimmed, inner runs of whitespace made one
 * space. null or "" (or only spaces) means no group. undefined when the value can't be a group
 * name: not a string, or longer than PROJECT_GROUP_MAX.
 */
export function normalizeProjectGroup(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return null;
  return name.length > PROJECT_GROUP_MAX ? undefined : name;
}

/** Group names compare without case, so "work" finds "Work". Fixed to "en" so the machine's locale can't change which names clash. */
export const sameGroup = (a: string, b: string): boolean => a.localeCompare(b, "en", { sensitivity: "accent" }) === 0;

/**
 * The spelling a new group name should take: an existing group's when one matches it without case
 * (so typing "work" joins "Work" instead of starting a second group), else the name as typed.
 */
export function canonicalGroup(name: string, existing: Iterable<string>): string {
  for (const g of existing) if (sameGroup(g, name)) return g;
  return name;
}

/** A project group: a stable id and the name it shows under. Renaming changes only the name. */
export interface ProjectGroup {
  id: string;
  name: string;
}

/**
 * Every group the projects carry, once each (by id), in alphabetical order (as the sidebar lists
 * them). A group with no project isn't listed: the clients only learn groups from their projects.
 */
export function projectGroups(projects: Iterable<{ group?: string | null; groupId?: string | null }>): ProjectGroup[] {
  const out = new Map<string, ProjectGroup>();
  for (const p of projects) if (p.groupId && p.group && !out.has(p.groupId)) out.set(p.groupId, { id: p.groupId, name: p.group });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
}

/**
 * The id a saved group reference means: `key` itself when a group has that id, else the group
 * named `key` (without case). Scopes, routes and settings saved before groups had ids hold the name.
 * null when neither matches.
 */
export function resolveGroupKey(key: string, groups: readonly ProjectGroup[]): string | null {
  const byId = groups.find((g) => g.id === key);
  if (byId) return byId.id;
  return groups.find((g) => sameGroup(g.name, key))?.id ?? null;
}

/** The name of the group with this id among the projects', or null when no project is in it. */
export function groupNameOf(projects: Iterable<{ group?: string | null; groupId?: string | null }>, id: string): string | null {
  for (const p of projects) if (p.groupId === id && p.group) return p.group;
  return null;
}
