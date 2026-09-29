// The watcher form's editable draft and the request body it saves (kept free of React Native so it
// can be unit tested).
import { watcherCommandLine, watcherDriver, type Settings, type Watcher, type WatcherBody } from "@harness/shared";

export interface WatcherDraft {
  name: string;
  /** One shell command line (legacy direct-exec watchers are shown quoted and joined) */
  command: string;
  prompt: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: string;
  enabled: boolean;
  /** "" → the app-wide triage driver */
  driver: string;
  /**
   * Model per driver id ("" or missing → inherit). Kept per driver so flipping the driver picker
   * back and forth doesn't lose a choice; only the effective driver's entry is saved.
   */
  models: Record<string, string>;
}

type DriverSettings = Pick<Settings, "defaultDriver" | "watcherDriver">;

export const toDraft = (w?: Watcher): WatcherDraft =>
  w
    ? {
        name: w.name,
        command: watcherCommandLine(w),
        prompt: w.prompt ?? "",
        cwd: w.cwd ?? "",
        mode: w.mode,
        intervalSec: String(w.intervalSec),
        enabled: w.enabled,
        driver: w.driver ?? "",
        models: { ...(w.models ?? {}) },
      }
    : { name: "", command: "", prompt: "", cwd: "", mode: "loop", intervalSec: "300", enabled: true, driver: "", models: {} };

/** The driver the draft's triage sessions would run on (its own pick, else the app-wide one). */
export const draftDriver = (d: Pick<WatcherDraft, "driver">, settings: DriverSettings | null | undefined): string =>
  d.driver || (settings ? watcherDriver(null, settings) : "");

/**
 * The create/update body for a draft. Always sends `args: []`, so saving a legacy direct-exec
 * watcher turns it into a shell watcher running the (quoted) command line shown in the form.
 * `models` carries only the effective driver's entry (null → inherit), since that's the one the
 * form shows; entries for other drivers stay as they are on the service.
 */
export function watcherBody(d: WatcherDraft, settings: DriverSettings | null | undefined): WatcherBody & { name: string; command: string } {
  const driver = draftDriver(d, settings);
  return {
    name: d.name.trim(),
    command: d.command.trim(),
    args: [],
    prompt: d.prompt.trim(),
    cwd: d.cwd.trim() || null,
    mode: d.mode,
    intervalSec: Math.max(1, Math.round(Number(d.intervalSec)) || 60),
    enabled: d.enabled,
    driver: d.driver || null,
    ...(driver ? { models: { [driver]: d.models[driver] || null } } : {}),
  };
}
