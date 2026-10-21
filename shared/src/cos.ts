// Chief of staff (CoS) shapes shared by the service and its clients (DESIGN.md "Chief of staff").

import type { Project, Settings } from "./protocol";

/** The two settings a project may override of the app's (Project.cosEnabled, Project.cosCanUnblock). */
export type CosSettingKey = "cosEnabled" | "cosCanUnblock";

/** What the app's settings say when nothing was saved. */
export const COS_SETTING_DEFAULTS: Readonly<Record<CosSettingKey, boolean>> = { cosEnabled: true, cosCanUnblock: false };

/**
 * A CoS setting for one project: the project's own value, else the app's, else the default. The one
 * place that resolves it: ownership of a project's events and the unblock tools both read it.
 */
export function resolveCosSetting(project: Pick<Project, "cosEnabled" | "cosCanUnblock"> | null | undefined, settings: Pick<Settings, "cosEnabled" | "cosCanUnblock">, key: CosSettingKey): boolean {
  return project?.[key] ?? settings[key] ?? COS_SETTING_DEFAULTS[key];
}

/** What a CoS sees and may act on: every project (`all`) or the projects of one group. */
export type CosScope = "all" | { group: string };

/** The scope as stored and sent: "all" or "group:<group id>". */
export type CosScopeKey = "all" | `group:${string}`;

export function cosScopeKey(scope: CosScope): CosScopeKey {
  return scope === "all" ? "all" : `group:${scope.group}`;
}

/** The scope a key names, or null for anything that isn't one. */
export function parseCosScopeKey(key: unknown): CosScope | null {
  if (key === "all") return "all";
  if (typeof key === "string" && key.startsWith("group:") && key.length > "group:".length) return { group: key.slice("group:".length) };
  return null;
}

/**
 * A chief of staff (GET /cos). `ticketId` and `key` identify its ticket (kind "cos"), which carries
 * its transcript, notes and queue; `enabled` is its own on/off switch, so the All CoS can be turned off.
 */
export interface Cos {
  ticketId: string;
  key: string;
  scope: CosScopeKey;
  /** The group it covers; null for the All CoS */
  groupId: string | null;
  enabled: boolean;
  createdAt: number;
}
