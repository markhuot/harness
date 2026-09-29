// Watcher helpers shared by the service and clients.

import type { Settings, Watcher } from "./protocol";

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
