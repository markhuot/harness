// Permission-mode resolution, shared by the service and the app (DESIGN.md "Permissions").

import type { PermissionMode, TriagePermissionMode } from "./protocol";

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

/** The triage permission modes as Settings shows them: there is no human to ask, so a call neither allows makes triage escalate. */
export const TRIAGE_PERMISSION_MODE_LABELS: Record<TriagePermissionMode, { label: string; description: string }> = {
  read_only: { label: "Read only", description: "Triage may run gh reads and read-only tools from a fixed list. Anything else is refused, and triage escalates the event instead." },
  auto: {
    label: "Auto",
    description: "A classifier judges each lookup: Claude Code's own when the triage model supports auto mode, Harness's when it doesn't (Haiku). Anything it won't allow is refused, and triage escalates the event instead.",
  },
};
