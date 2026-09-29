// The watcher form's draft: conversion from a stored watcher and back to a save body.

import type { PublicSettings, TriageChoice, Watcher, WatcherBody } from "@harness/shared";
import { DEFAULT_TRIAGE_CHOICE, watcherChoice, watcherChoiceBody, watcherCommandLine, watcherDriver, watcherModel } from "@harness/shared";

export interface WatcherDraft {
  name: string;
  command: string;
  prompt: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: number;
  enabled: boolean;
  /** The combined Model select's pick (driver null → Default) */
  choice: TriageChoice;
  /** The stored models map, so saving can clear entries the new pick replaces */
  originalModels: Watcher["models"];
}

export type TriageSettings = Pick<PublicSettings, "defaultDriver" | "defaultModels" | "watcherDriver" | "watcherModels">;
export const noSettings: TriageSettings = { defaultDriver: "", defaultModels: {} };

export const emptyWatcher: WatcherDraft = { name: "", command: "", prompt: "", cwd: "", mode: "loop", intervalSec: 300, enabled: true, choice: DEFAULT_TRIAGE_CHOICE, originalModels: {} };

export function toDraft(w: Watcher, settings: TriageSettings): WatcherDraft {
  return {
    name: w.name,
    command: watcherCommandLine(w),
    prompt: w.prompt ?? "",
    cwd: w.cwd ?? "",
    mode: w.mode,
    intervalSec: w.intervalSec,
    enabled: w.enabled,
    choice: watcherChoice(w, settings),
    originalModels: { ...(w.models ?? {}) },
  };
}

/** What the watcher form's Default option falls back to: the watcher default driver and its model. */
export function watcherDefaultChoice(settings: TriageSettings): TriageChoice {
  const driver = watcherDriver(null, settings);
  return { driver: driver || null, model: driver ? watcherModel(driver, null, settings) : null };
}

/** The save body. The pick replaces the watcher's driver and every stored model (watcherChoiceBody). */
export function fromDraft(d: WatcherDraft): WatcherBody & { name: string; command: string } {
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
    ...watcherChoiceBody(d.choice, { models: d.originalModels }),
  };
}
