// The watcher form's editable draft and the request body it saves (kept free of React Native so it
// can be unit tested).
import { watcherCommandLine, type Watcher } from "@harness/shared";

export interface WatcherDraft {
  name: string;
  /** One shell command line (legacy direct-exec watchers are shown quoted and joined) */
  command: string;
  prompt: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: string;
  enabled: boolean;
  driver: string;
}

export const toDraft = (w?: Watcher): WatcherDraft =>
  w
    ? { name: w.name, command: watcherCommandLine(w), prompt: w.prompt ?? "", cwd: w.cwd ?? "", mode: w.mode, intervalSec: String(w.intervalSec), enabled: w.enabled, driver: w.driver ?? "" }
    : { name: "", command: "", prompt: "", cwd: "", mode: "loop", intervalSec: "300", enabled: true, driver: "" };

/**
 * The create/update body for a draft. Always sends `args: []`, so saving a legacy direct-exec
 * watcher turns it into a shell watcher running the (quoted) command line shown in the form.
 */
export function watcherBody(d: WatcherDraft): Partial<Watcher> & { name: string; command: string } {
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
  };
}
