// The watcher form's editable draft and the request body it saves (kept free of React Native so it
// can be unit tested).
import { DEFAULT_TRIAGE_CHOICE, watcherChoice, watcherChoiceBody, watcherCommandLine, type Settings, type TriageChoice, type Watcher, type WatcherBody } from "@harness/shared";

export interface WatcherDraft {
  name: string;
  /** One shell command line (legacy direct-exec watchers are shown quoted and joined) */
  command: string;
  prompt: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: string;
  enabled: boolean;
  /** The combined Model pick: a driver plus a model on it (driver null → Default) */
  choice: TriageChoice;
}

type DriverSettings = Pick<Settings, "defaultDriver" | "watcherDriver">;

export const toDraft = (w: Watcher | undefined, settings: DriverSettings | null | undefined): WatcherDraft =>
  w
    ? {
        name: w.name,
        command: watcherCommandLine(w),
        prompt: w.prompt ?? "",
        cwd: w.cwd ?? "",
        mode: w.mode,
        intervalSec: String(w.intervalSec),
        enabled: w.enabled,
        choice: settings ? watcherChoice(w, settings) : w.driver ? { driver: w.driver, model: w.models?.[w.driver] || null } : DEFAULT_TRIAGE_CHOICE,
      }
    : { name: "", command: "", prompt: "", cwd: "", mode: "loop", intervalSec: "300", enabled: true, choice: DEFAULT_TRIAGE_CHOICE };

/**
 * The create/update body for a draft. Always sends `args: []`, so saving a legacy direct-exec
 * watcher turns it into a shell watcher running the (quoted) command line shown in the form. The
 * Model pick replaces the watcher's driver and models (other drivers' stored models are cleared).
 */
export function watcherBody(d: WatcherDraft, existing?: Pick<Watcher, "models"> | null): WatcherBody & { name: string; command: string } {
  return {
    name: d.name.trim(),
    command: d.command.trim(),
    args: [],
    prompt: d.prompt.trim(),
    cwd: d.cwd.trim() || null,
    mode: d.mode,
    intervalSec: Math.max(1, Math.round(Number(d.intervalSec)) || 60),
    enabled: d.enabled,
    ...watcherChoiceBody(d.choice, existing),
  };
}
