// Project groups: a human-readable name ("Work", "Personal") several projects share. Each group
// gets its own board in the apps, like All projects but with only its projects. A project is in at
// most one group; the name is all there is to a group, so it exists while a project carries it.

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

/** Group names compare without case, so "work" finds "Work". */
export const sameGroup = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/**
 * The spelling a new group name should take: an existing group's when one matches it without case
 * (so typing "work" joins "Work" instead of starting a second group), else the name as typed.
 */
export function canonicalGroup(name: string, existing: Iterable<string>): string {
  for (const g of existing) if (sameGroup(g, name)) return g;
  return name;
}

/** Every group the projects carry, once each, in alphabetical order (as the sidebar lists them). */
export function projectGroups(projects: Iterable<{ group?: string | null }>): string[] {
  const out: string[] = [];
  for (const p of projects) if (p.group && !out.includes(p.group)) out.push(p.group);
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0));
}
