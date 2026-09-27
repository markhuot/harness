// Permission-mode resolution, shared by the service and the app (DESIGN.md "Permissions").

import type { PermissionMode } from "./protocol";

/** Where an effective permission mode came from. */
export type PermissionModeSource = "ticket" | "project" | "settings";

/** Resolve the effective mode: ticket override → project override → the global setting. */
export function resolvePermissionMode(
  ticket: { permissionMode: PermissionMode | null } | null | undefined,
  project: { permissionMode: PermissionMode | null } | null | undefined,
  settings: { permissionMode: PermissionMode },
): { mode: PermissionMode; source: PermissionModeSource } {
  if (ticket?.permissionMode) return { mode: ticket.permissionMode, source: "ticket" };
  if (project?.permissionMode) return { mode: project.permissionMode, source: "project" };
  return { mode: settings.permissionMode, source: "settings" };
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; description: string }> = {
  auto: { label: "Auto", description: "A classifier approves routine actions and asks you about risky ones." },
  ask: { label: "Ask", description: "Edits inside the working directory run; everything else asks you first." },
  read_only: { label: "Read only", description: "The agent can read and run read-only commands, but can't change anything." },
};
