// Which driver and model a run uses (DESIGN.md "Model selection"). The run's kind picks a phase
// (plan, work, review, complete; conductor and chat runs use work), and the phase resolves on its
// own, most specific level first: the ticket's choice, the project's, then settings' (which always
// resolve: a phase settings don't choose uses their Work driver with its default model).
//
// The driver is fixed when the run is queued (the run row stores it); the model is resolved again
// when the run starts, so a change applies to the next run. A model chosen for another driver
// (the choice moved to a different driver after the run was queued) gives the driver's default.

import type { PhaseChoice, Project, RunKind, Settings, Ticket } from "@harness/shared";
import { resolvePhaseChoice, runPhase, settingsPhaseChoice } from "@harness/shared";

export interface RunChoiceInput {
  kind: RunKind;
  ticket: Pick<Ticket, "phaseModels"> | null;
  project: Pick<Project, "phaseModels"> | null;
  settings: Pick<Settings, "phaseModels">;
}

/** The driver + model for a ticket run of this kind (triage runs follow their watcher instead). */
export function resolveRunChoice({ kind, ticket, project, settings }: RunChoiceInput): PhaseChoice {
  const phase = runPhase(kind) ?? "work";
  if (!ticket) return settingsPhaseChoice(settings.phaseModels, phase);
  return resolvePhaseChoice(phase, { ticket: ticket.phaseModels, project: project?.phaseModels, settings: settings.phaseModels });
}

/**
 * The model a run starts with on `driver` (the driver it was queued on). Ticket runs take their
 * phase's model when the phase still resolves to that driver. A standalone session (no ticket)
 * keeps its own driver and takes the project's, then settings', Work model when it's on that driver.
 */
export function resolveRunModel(input: RunChoiceInput & { driver: string }): string | null {
  const { driver, ticket, project, settings } = input;
  if (ticket) {
    const choice = resolveRunChoice(input);
    return choice.driver === driver ? choice.model : null;
  }
  for (const choice of [project?.phaseModels?.work, settings.phaseModels?.work]) {
    if (choice) return choice.driver === driver ? choice.model : null;
  }
  return null;
}
