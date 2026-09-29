// The watcher form's draft: conversion from a stored watcher and back to a save body.

import type { PublicSettings, Watcher, WatcherBody } from "@harness/shared";
import { watcherCommandLine, watcherDriver } from "@harness/shared";

export interface WatcherDraft {
  name: string;
  command: string;
  prompt: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: number;
  enabled: boolean;
  /** "" → the watcher default (settings.watcherDriver, then settings.defaultDriver) */
  driver: string;
  /** Model picks per driver, kept while the form is open so switching drivers doesn't lose them; null → inherit */
  models: Record<string, string | null>;
}

export type TriageSettings = Pick<PublicSettings, "defaultDriver" | "defaultModels" | "watcherDriver" | "watcherModels">;
export const noSettings: TriageSettings = { defaultDriver: "", defaultModels: {} };

export const emptyWatcher: WatcherDraft = { name: "", command: "", prompt: "", cwd: "", mode: "loop", intervalSec: 300, enabled: true, driver: "", models: {} };

export function toDraft(w: Watcher): WatcherDraft {
  return {
    name: w.name,
    command: watcherCommandLine(w),
    prompt: w.prompt ?? "",
    cwd: w.cwd ?? "",
    mode: w.mode,
    intervalSec: w.intervalSec,
    enabled: w.enabled,
    driver: w.driver ?? "",
    models: { ...(w.models ?? {}) },
  };
}

/** The driver the draft's triage sessions would run on. */
export function draftDriver(d: Pick<WatcherDraft, "driver">, settings: TriageSettings): string {
  return d.driver || watcherDriver(null, settings);
}

/** The save body. Only the effective driver's model is sent (null clears it); other drivers' stored picks are left alone. */
export function fromDraft(d: WatcherDraft, settings: TriageSettings): WatcherBody & { name: string; command: string } {
  const driver = draftDriver(d, settings);
  return {
    name: d.name.trim(),
    // Always saved as a shell command line, which converts legacy direct-exec watchers
    command: d.command.trim(),
    args: [],
    prompt: d.prompt.trim(),
    cwd: d.cwd.trim() || null,
    mode: d.mode,
    intervalSec: Math.max(1, Math.round(d.intervalSec) || 60),
    enabled: d.enabled,
    driver: d.driver || null,
    ...(driver ? { models: { [driver]: d.models[driver] ?? null } } : {}),
  };
}

