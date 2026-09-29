// Watcher helpers shared by the service and clients.

import type { Settings, Watcher, WatcherBody } from "./protocol";

const SAFE_WORD = /^[A-Za-z0-9_\-.,/:=@%+~]+$/;

/** Quote one word for a POSIX shell, leaving plain words (paths, flags) as they are. */
export function shellQuote(word: string): string {
  if (word !== "" && SAFE_WORD.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The watcher's command as one shell command line. Shell watchers (no args) already are one;
 * legacy direct-exec watchers get their executable and args quoted and joined. Forms edit this
 * line and save it back with `args: []`, which turns a legacy watcher into a shell watcher.
 */
export function watcherCommandLine(w: Pick<Watcher, "command" | "args">): string {
  if (!w.args?.length) return w.command;
  return [w.command, ...w.args].map(shellQuote).join(" ");
}

/** Longest title derived from watcher output */
export const OUTPUT_TITLE_MAX = 80;

/**
 * A readable Inbox title for raw watcher output: its first line with any letters or digits, collapsed and cut at
 * OUTPUT_TITLE_MAX characters with an ellipsis. Triage may replace it with a better one.
 */
export function outputTitle(text: string): string {
  // Skip lines with nothing readable, like the "{" that opens pretty-printed JSON.
  const line = text.split(/\r?\n/).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  if (!flat) return "Watcher output";
  return flat.length > OUTPUT_TITLE_MAX ? flat.slice(0, OUTPUT_TITLE_MAX - 1).trimEnd() + "…" : flat;
}

type TriageSettings = Pick<Settings, "defaultDriver" | "defaultModels" | "watcherDriver" | "watcherModels">;

/** The driver a watcher's triage sessions run on: its own, else settings.watcherDriver, else settings.defaultDriver. */
export function watcherDriver(w: Pick<Watcher, "driver"> | null | undefined, settings: Pick<Settings, "defaultDriver" | "watcherDriver">): string {
  return w?.driver || settings.watcherDriver || settings.defaultDriver;
}

/**
 * The model a watcher's triage sessions use on `driver`. Precedence (first set wins): the
 * watcher's models[driver], settings.watcherModels[driver], settings.defaultModels[driver];
 * null → the driver's own default. Pass `watcher: null` for what a watcher without its own
 * model falls back to (and for injected output, which has no watcher).
 */
export function watcherModel(driver: string, w: Pick<Watcher, "models"> | null | undefined, settings: Partial<TriageSettings> | null | undefined): string | null {
  return w?.models?.[driver] || settings?.watcherModels?.[driver] || settings?.defaultModels?.[driver] || null;
}

/**
 * One pick from the combined Model select: a driver plus a model on it. `driver: null` is the
 * Default option (inherit both); `model: null` with a driver means that driver's own default.
 */
export interface TriageChoice {
  driver: string | null;
  model: string | null;
}

export const DEFAULT_TRIAGE_CHOICE: TriageChoice = { driver: null, model: null };

/**
 * What a watcher's Model select shows as picked. A watcher with its own driver shows that driver
 * and its model there. One without a driver but with a model for the default watcher driver (set
 * through the tools) shows that pick; otherwise Default.
 */
export function watcherChoice(w: Pick<Watcher, "driver" | "models"> | null | undefined, settings: Pick<Settings, "defaultDriver" | "watcherDriver">): TriageChoice {
  if (!w) return DEFAULT_TRIAGE_CHOICE;
  if (w.driver) return { driver: w.driver, model: w.models?.[w.driver] || null };
  const driver = watcherDriver(null, settings);
  const model = w.models?.[driver];
  return model ? { driver, model } : DEFAULT_TRIAGE_CHOICE;
}

/** Every stored driver gets null (cleared); `keep` then sets one. */
function replaceModels(current: Record<string, string | null | undefined> | undefined, keep: TriageChoice): Record<string, string | null> {
  const out: Record<string, string | null> = Object.fromEntries(Object.keys(current ?? {}).map((k) => [k, null]));
  if (keep.driver) out[keep.driver] = keep.model;
  return out;
}

/**
 * The driver and models fields that save a pick on a watcher. The pick replaces whatever the
 * watcher had: other drivers' models are cleared, so Default really inherits both and a pinned
 * driver has exactly one model entry.
 */
export function watcherChoiceBody(choice: TriageChoice, current: Pick<Watcher, "models"> | null | undefined): Pick<WatcherBody, "driver" | "models"> {
  return { driver: choice.driver, models: replaceModels(current?.models, choice) };
}

/** What the settings-level watcher Model select shows as picked (Default follows defaultDriver/defaultModels). */
export function settingsWatcherChoice(settings: Pick<Settings, "defaultDriver" | "watcherDriver" | "watcherModels">): TriageChoice {
  const driver = settings.watcherDriver || settings.defaultDriver;
  const model = settings.watcherModels?.[driver] || null;
  if (settings.watcherDriver) return { driver, model };
  return model ? { driver, model } : DEFAULT_TRIAGE_CHOICE;
}

/** The PATCH /settings body that saves a pick as the default for watchers (other drivers' entries cleared). */
export function settingsWatcherChoicePatch(choice: TriageChoice, settings: Pick<Settings, "watcherModels">): Pick<Settings, "watcherDriver" | "watcherModels"> {
  return { watcherDriver: choice.driver, watcherModels: replaceModels(settings.watcherModels, choice) };
}
