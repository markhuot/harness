// Per-phase driver + model choices (DESIGN.md "Model selection"): how a run kind maps to a phase,
// how a phase resolves across ticket → project → settings, and how the legacy single-choice fields
// (driver/model, defaultDriver/defaultModels, reviewModels) read from and write to the choices.
// Pure functions shared by the service and every client.

import { PHASES, type Phase, type PhaseChoice, type PhaseModels, type PhaseModelsPatch, type RunKind } from "./protocol";

export const PHASE_LABELS: Record<Phase, string> = { plan: "Planning", work: "Work", review: "Review", complete: "Complete" };

/** The driver settings use when they don't choose a Work driver. */
export const FALLBACK_DRIVER = "claude-code";

/** The phases the legacy single driver/model fields stand for. Complete is never set by them. */
export const LEGACY_PHASES: readonly Phase[] = ["plan", "work", "review"];

/** Haiku 5.5 per driver: the built-in Complete model, on the drivers that have it. */
export const HAIKU_MODELS: Readonly<Record<string, string>> = { "claude-code": "haiku", "anthropic-api": "claude-haiku-5-5" };

/** The built-in Complete choice for an app default driver, or null when the driver has no Haiku. */
export function builtinCompleteChoice(driver: string): PhaseChoice | null {
  const model = HAIKU_MODELS[driver];
  return model ? { driver, model } : null;
}

/** The phase a run kind's driver and model come from (null: triage, which follows its watcher). */
export function runPhase(kind: RunKind): Phase | null {
  switch (kind) {
    case "plan":
    case "review":
    case "complete":
      return kind;
    case "triage":
      return null;
    default:
      return "work"; // work, conductor, chat
  }
}

export function samePhaseChoice(a: PhaseChoice | null | undefined, b: PhaseChoice | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.driver === b.driver && (a.model || null) === (b.model || null);
}

/** The app's Work driver: its own, else claude-code. */
export function settingsWorkDriver(settings: PhaseModels | null | undefined): string {
  return settings?.work?.driver || FALLBACK_DRIVER;
}

/** App settings always resolve: a phase they don't choose uses the Work driver with its default model. */
export function settingsPhaseChoice(settings: PhaseModels | null | undefined, phase: Phase): PhaseChoice {
  return settings?.[phase] ?? { driver: settingsWorkDriver(settings), model: null };
}

export interface PhaseLevels {
  ticket?: PhaseModels | null;
  project?: PhaseModels | null;
  settings: PhaseModels | null | undefined;
}

/** A phase's choice, most specific level first: ticket → project → settings. */
export function resolvePhaseChoice(phase: Phase, levels: PhaseLevels): PhaseChoice {
  return levels.ticket?.[phase] ?? levels.project?.[phase] ?? settingsPhaseChoice(levels.settings, phase);
}

/** Every phase resolved (see resolvePhaseChoice). */
export function resolvePhaseModels(levels: PhaseLevels): Record<Phase, PhaseChoice> {
  return Object.fromEntries(PHASES.map((p) => [p, resolvePhaseChoice(p, levels)])) as Record<Phase, PhaseChoice>;
}

/** What a level inherits for each phase: the resolution one level up (settings have no level above). */
export function inheritedPhaseModels(
  level: "ticket" | "project" | "settings",
  project: PhaseModels | null | undefined,
  settings: PhaseModels | null | undefined,
): Record<Phase, PhaseChoice> | null {
  if (level === "settings") return null;
  return resolvePhaseModels({ project: level === "ticket" ? project : null, settings });
}

/** Merge a per-phase patch over a level's choices; null (or a choice without a driver) clears a phase. */
export function mergePhaseModels(current: PhaseModels | null | undefined, patch: PhaseModelsPatch): PhaseModels {
  const out: PhaseModels = { ...current };
  for (const p of PHASES) {
    if (!(p in patch)) continue;
    const c = patch[p];
    if (c && c.driver) out[p] = { driver: c.driver, model: c.model || null };
    else delete out[p];
  }
  return out;
}

/** Set Planning, Work and Review to one choice, or clear them (null), as the legacy fields do. */
export function withLegacyChoice(current: PhaseModels | null | undefined, choice: PhaseChoice | null): PhaseModels {
  const out: PhaseModels = { ...current };
  for (const p of LEGACY_PHASES) {
    if (choice) out[p] = { driver: choice.driver, model: choice.model || null };
    else delete out[p];
  }
  return out;
}

/** A level's legacy driver + per-driver model map, from its own Work choice. */
export function legacyWork(own: PhaseModels | null | undefined): { driver: string | null; models: Record<string, string> } {
  const w = own?.work;
  return { driver: w?.driver ?? null, models: w?.model ? { [w.driver]: w.model } : {} };
}

/**
 * A ticket's legacy driver + model write (an older client, or the create_ticket shorthand). A
 * driver the ticket would inherit anyway with no model of its own means "follow the project": the
 * three phases are cleared rather than pinned.
 */
export function ticketLegacyChoice(current: PhaseModels | null | undefined, choice: PhaseChoice, inheritedWork: PhaseChoice): PhaseModels {
  const follow = !choice.model && choice.driver === inheritedWork.driver;
  return withLegacyChoice(current, follow ? null : choice);
}

/** The legacy settings fields: defaultDriver / defaultModels from Work, reviewModels from Review. */
export function legacySettingsFields(pm: PhaseModels | null | undefined): { defaultDriver: string; defaultModels: Record<string, string>; reviewModels: Record<string, string> } {
  const work = settingsPhaseChoice(pm, "work");
  const review = pm?.review;
  return {
    defaultDriver: work.driver,
    defaultModels: work.model ? { [work.driver]: work.model } : {},
    reviewModels: review?.model && !samePhaseChoice(review, work) ? { [review.driver]: review.model } : {},
  };
}

/**
 * Apply legacy settings fields to the app's choices:
 * - defaultDriver (with defaultModels' entry for it) sets Planning, Work and Review. A Complete
 *   choice on another driver moves to the new driver's Haiku, or is cleared when it has none, so an
 *   older client switching drivers doesn't leave completion runs on the old one.
 * - defaultModels alone sets the three phases' model when it names the Work driver.
 * - reviewModels sets Review (its entry for the Work driver first); null puts Review back on Work.
 */
export function applyLegacySettings(
  current: PhaseModels | null | undefined,
  legacy: { defaultDriver?: string | null; defaultModels?: Record<string, string | null> | null; reviewModels?: Record<string, string | null> | null },
): PhaseModels {
  let out: PhaseModels = { ...current };
  const curWork = settingsPhaseChoice(out, "work");
  const models = legacy.defaultModels ?? {};
  if (legacy.defaultDriver) {
    const driver = legacy.defaultDriver;
    const model = driver in models ? models[driver] || null : driver === curWork.driver ? curWork.model : null;
    out = withLegacyChoice(out, { driver, model });
    if (out.complete && out.complete.driver !== driver) {
      const builtin = builtinCompleteChoice(driver);
      if (builtin) out.complete = builtin;
      else delete out.complete;
    }
  } else if (curWork.driver in models) {
    out = withLegacyChoice(out, { driver: curWork.driver, model: models[curWork.driver] || null });
  }
  const review = legacy.reviewModels;
  if (review && Object.keys(review).length) {
    const work = settingsPhaseChoice(out, "work");
    const driver = work.driver in review ? work.driver : Object.keys(review).find((d) => review[d]);
    if (driver) {
      const model = review[driver] || null;
      if (model) out.review = { driver, model };
      else if (driver === work.driver) out.review = { ...work };
    }
  }
  return out;
}

/**
 * Apply a project's legacy defaultDriver / defaultModels write. A driver sets Planning, Work and
 * Review (null clears them, so the project follows settings again); a models map alone changes the
 * model of the driver the project works on.
 */
export function applyLegacyProject(
  current: PhaseModels | null | undefined,
  legacy: { defaultDriver?: string | null; defaultModels?: Record<string, string | null> | null },
  settings: PhaseModels | null | undefined,
): PhaseModels {
  const models = legacy.defaultModels ?? {};
  const own = current?.work;
  if (legacy.defaultDriver !== undefined) {
    const driver = legacy.defaultDriver;
    if (!driver) return withLegacyChoice(current, null);
    const model = driver in models ? models[driver] || null : own?.driver === driver ? own.model : null;
    return withLegacyChoice(current, { driver, model });
  }
  const driver = own?.driver ?? settingsWorkDriver(settings);
  if (!(driver in models)) return { ...current };
  const model = models[driver] || null;
  if (!own && !model) return { ...current };
  return withLegacyChoice(current, { driver, model });
}
