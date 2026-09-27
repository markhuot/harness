// Which model a run uses. Precedence (first set wins):
//   review runs only: settings.reviewModels[driver]
//   ticket.model (when the ticket runs on this driver)
//   project.defaultModels[driver]
//   settings.defaultModels[driver]
//   null → the driver's own default
// Resolved when the run starts (not when it's queued), so a change applies to the next run.

import type { Project, RunKind, Settings, Ticket } from "@harness/shared";

export interface ModelResolutionInput {
  driver: string;
  kind: RunKind;
  ticket: Pick<Ticket, "model" | "driver"> | null;
  project: Pick<Project, "defaultModels"> | null;
  settings: Pick<Settings, "defaultModels" | "reviewModels">;
}

export function resolveRunModel({ driver, kind, ticket, project, settings }: ModelResolutionInput): string | null {
  if (kind === "review") {
    const review = settings.reviewModels?.[driver];
    if (review) return review;
  }
  if (ticket?.model && ticket.driver === driver) return ticket.model;
  const fromProject = project?.defaultModels?.[driver];
  if (fromProject) return fromProject;
  return settings.defaultModels?.[driver] || null;
}
